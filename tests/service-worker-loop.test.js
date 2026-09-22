import assert from "node:assert/strict";
import test from "node:test";

import { DIAGNOSTIC_LOG_KEY } from "../src/background/diagnostic-log.js";
import { MESSAGE_TYPES } from "../src/shared/messages.js";

function event() {
  return {
    listeners: [],
    addListener(listener) { this.listeners.push(listener); },
    fire(...args) { for (const listener of this.listeners) listener(...args); },
  };
}

function storage() {
  const values = new Map();
  return {
    async get(key) {
      return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(key) { values.delete(key); },
  };
}

const ids = {
  source: "00000000-0000-0000-0000-000000000001",
  sourceEntry: "00000000-0000-0000-0000-000000000002",
  github: "00000000-0000-0000-0000-000000000003",
  githubEntry: "00000000-0000-0000-0000-000000000004",
  bouncedGithub: "00000000-0000-0000-0000-000000000005",
  bouncedGithubEntry: "00000000-0000-0000-0000-000000000006",
};

const snapshot = (entry, navigationType, hasUserActivation = true) => ({
  apiAvailable: true,
  currentEntryKey: entry,
  navigationType,
  sameOriginCanGoBack: false,
  historyLength: 2,
  transitionActive: false,
  hasUserActivation,
});

async function assertWorkerRecovery(t, navigationType) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const opener = {
    id: 10, index: 0, windowId: 1, active: false, pinned: false, discarded: false,
    incognito: false, groupId: -1,
  };
  const child = {
    id: 20, index: 1, openerTabId: 10, windowId: 1, active: true, pinned: false,
    discarded: false, incognito: false, groupId: -1,
  };
  const tabs = new Map([[10, opener], [20, child]]);
  const chrome = {
    storage: { session: storage(), local: storage() },
    runtime: {
      getManifest: () => ({ version: "0.7.3" }),
      onMessage: event(), onStartup: event(), onInstalled: event(),
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error("Missing tab");
        return structuredClone(tabs.get(id));
      },
      async update(id, patch) {
        if (!tabs.has(id)) throw new Error("Missing tab");
        if (patch.active) {
          for (const tab of tabs.values()) tab.active = tab.id === id;
        }
        Object.assign(tabs.get(id), patch);
        return this.get(id);
      },
      async remove(id) { tabs.delete(id); },
      async query({ windowId }) {
        return [...tabs.values()].filter(tab => tab.windowId === windowId)
          .map(tab => structuredClone(tab));
      },
      onCreated: event(), onRemoved: event(), onReplaced: event(),
      onActivated: event(), onAttached: event(), onDetached: event(),
    },
    webNavigation: { onCreatedNavigationTarget: event(), onCommitted: event() },
    windows: {
      onRemoved: event(),
      async get(id) { return { id, type: "normal", focused: true }; },
      async remove() { throw new Error("Only a child tab should close here"); },
    },
  };
  globalThis.chrome = chrome;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const send = (message, sender) => new Promise((resolve, reject) => {
    for (const listener of chrome.runtime.onMessage.listeners) {
      if (listener(message, sender, resolve)) return;
    }
    reject(new Error(`Unhandled message: ${message.type}`));
  });
  const commit = (documentId, url, transitionType, transitionQualifiers) => {
    chrome.webNavigation.onCommitted.fire({
      tabId: 20,
      frameId: 0,
      documentId,
      documentLifecycle: "active",
      url,
      transitionType,
      transitionQualifiers,
    });
  };
  const sender = (documentId, url) => ({
    tab: structuredClone(tabs.get(20)),
    frameId: 0,
    documentId,
    origin: new URL(url).origin,
    url,
  });

  try {
    await import(`../src/background/service-worker.js?loop=${navigationType}`);
    chrome.tabs.onCreated.fire(child);
    await settle();
    await settle();

    const sourceUrl = "https://source.example/entry";
    commit(ids.source, sourceUrl, "link", []);
    await settle();
    await send({
      type: MESSAGE_TYPES.NAVIGATION_SNAPSHOT,
      snapshot: snapshot(ids.sourceEntry, "replace", false),
    }, sender(ids.source, sourceUrl));

    await send({ type: MESSAGE_TYPES.NAVIGATION_INTERACTION },
      sender(ids.source, sourceUrl));
    const githubUrl = "https://github.com/example/repository?tab=readme";
    commit(ids.github, githubUrl, "form_submit", ["server_redirect"]);
    await settle();
    const githubSnapshot = snapshot(ids.githubEntry, "push", false);
    await send({
      type: MESSAGE_TYPES.NAVIGATION_SNAPSHOT,
      snapshot: githubSnapshot,
    }, sender(ids.github, githubUrl));

    const first = await send({
      type: MESSAGE_TYPES.PERFORM_CONFIRMED_BACK_ACTION,
      snapshot: githubSnapshot,
      gesture: {
        source: "AUTOMATIC",
        id: "redirect-loop-gesture",
        observedAtMs: Date.now(),
        nativeInput: { endReason: "NATIVE_MOMENTUM", endedAtMs: now, physicalEventCount: 12 },
      },
    }, sender(ids.github, githubUrl));
    assert.equal(first.action, "USE_INTERNAL_HISTORY");

    commit(ids.bouncedGithub, githubUrl, "link", [
      "server_redirect",
      "forward_back",
    ]);
    await settle();
    const bouncedSnapshot = snapshot(ids.bouncedGithubEntry, navigationType);
    await send({
      type: MESSAGE_TYPES.NAVIGATION_SNAPSHOT,
      snapshot: bouncedSnapshot,
    }, sender(ids.bouncedGithub, githubUrl));
    await settle();
    await settle();
    const diagnosticState = await chrome.storage.local.get(DIAGNOSTIC_LOG_KEY);
    assert.ok(diagnosticState[DIAGNOSTIC_LOG_KEY].entries.some(entry =>
      entry.kind === "NAVIGATION_COMMIT" &&
      entry.event === "BACK_REDIRECT_LOOP_DETECTED" &&
      entry.navigation.backRedirectLoopPending === true,
    ));

    // The real incident then alternated replace/traverse without changing entry.
    for (const type of ["replace", navigationType, "replace", navigationType]) {
      await send({
        type: MESSAGE_TYPES.NAVIGATION_SNAPSHOT,
        snapshot: snapshot(ids.bouncedGithubEntry, type),
      }, sender(ids.bouncedGithub, githubUrl));
    }

    now += 1622;
    const tooSoon = await send({
      type: MESSAGE_TYPES.PERFORM_CONFIRMED_BACK_ACTION,
      snapshot: bouncedSnapshot,
      gesture: {
        source: "AUTOMATIC", id: "rapid-follow-up", observedAtMs: now,
      },
    }, sender(ids.bouncedGithub, githubUrl));
    assert.equal(tooSoon.reason, "NATIVE_INPUT_REQUIRED");
    assert.equal(tooSoon.gestureGate.reason, "NATIVE_INPUT_REQUIRED");
    assert.equal(tabs.has(20), true);
    assert.equal(tabs.get(10).active, false);

    now += 50;
    const recovered = await send({
      type: MESSAGE_TYPES.PERFORM_CONFIRMED_BACK_ACTION,
      snapshot: bouncedSnapshot,
      gesture: {
        source: "AUTOMATIC", id: "next-deliberate-gesture", observedAtMs: now,
        nativeInput: { endReason: "NATIVE_MOMENTUM", endedAtMs: now, physicalEventCount: 12 },
      },
    }, sender(ids.bouncedGithub, githubUrl));
    assert.equal(recovered.action, "CLOSED_TAB_TO_LEFT");
    assert.equal(recovered.decision.reason, "TRACKED_BACK_REDIRECT_LOOP_ENTRY_POINT");
    assert.equal(tabs.has(20), false);
    assert.equal(tabs.get(10).active, true);

    const report = await send({ type: MESSAGE_TYPES.GET_DIAGNOSTIC_REPORT }, {});
    assert.equal(report.ok, true);
    assert.ok(report.entries.some(entry =>
      entry.kind === "NAVIGATION_STATE" &&
      entry.navigation.entryKey === ids.bouncedGithubEntry &&
      entry.navigation.backRedirectLoopPending === false &&
      entry.navigation.backRedirectLoopEntry === true,
    ));
    assert.ok(report.entries.some(entry =>
      entry.kind === "BACK_ACTION" && entry.source === "AUTOMATIC" &&
      entry.action === "CLOSED_TAB_TO_LEFT" &&
      entry.decisionReason === "TRACKED_BACK_REDIRECT_LOOP_ENTRY_POINT",
    ));
  } finally {
    delete globalThis.chrome;
  }
}

for (const navigationType of ["push", "replace", "traverse"]) {
  test(`the real worker recovers a redirected-Back ${navigationType} loop on completed physical input`,
    async (t) => assertWorkerRecovery(t, navigationType));
}
