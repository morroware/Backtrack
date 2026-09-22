import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

import { GestureActionGate } from "../src/background/gesture-action-gate.js";
import { createNavigationMessageListener } from "../src/background/navigation-message-handler.js";
import { NavigationTracker } from "../src/background/navigation-tracker.js";

const contentSources = [
  "../src/shared/navigation-snapshot.js",
  "../src/content/navigation-state.js",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

function createBrowser() {
  const stored = new Map();
  const storage = {
    async get(key) {
      return stored.has(key) ? { [key]: structuredClone(stored.get(key)) } : {};
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) {
        stored.set(key, structuredClone(value));
      }
    },
    async remove(key) { stored.delete(key); },
  };
  const tracker = new NavigationTracker(storage);
  const gate = new GestureActionGate(storage);
  const tabs = new Map();
  const closed = [];
  const pending = new Set();
  let now = 10_000;
  const tabsApi = {
    async get(id) {
      if (!tabs.has(id)) throw new Error("Missing tab");
      return structuredClone(tabs.get(id));
    },
    async update(id, patch) {
      if (patch.active) {
        for (const tab of tabs.values()) tab.active = tab.id === id;
      }
      Object.assign(tabs.get(id), patch);
      return this.get(id);
    },
    async remove(id) {
      tabs.delete(id);
      closed.push(id);
      await tracker.remove(id);
      await gate.remove(id);
    },
  };
  const listener = createNavigationMessageListener(tabsApi, tracker, {
    claim: (tabId, windowId, gesture) => gate.claim(tabId, windowId, gesture, now),
  });

  async function open(id, { openerTabId, depth = 0, sameOrigin = true, apiAvailable = true } = {}) {
    for (const tab of tabs.values()) tab.active = false;
    const tab = { id, windowId: 1, openerTabId, active: true, pinned: false, incognito: false };
    tabs.set(id, tab);
    if (openerTabId !== undefined) {
      await tracker.beginCandidate(tab);
      await tracker.confirmCandidate(id, openerTabId);
    }
    const entries = Array.from({ length: depth + 1 }, (_, index) => ({ key: `${id}-${index}` }));
    let index = depth;
    let backCalls = 0;
    const listeners = new Map();
    const navigation = {
      get currentEntry() { return entries[index]; },
      get canGoBack() { return sameOrigin && index > 0; },
      get canGoForward() { return sameOrigin && index < entries.length - 1; },
      entries: () => sameOrigin ? entries : [entries[index]],
      activation: { navigationType: "push" },
      transition: null,
      addEventListener(name, handler) { listeners.set(name, handler); },
    };
    const context = vm.createContext({
      structuredClone,
      console: { info() {}, debug() {} },
      document: { readyState: "complete" },
      navigation: apiAvailable ? navigation : undefined,
      history: {
        length: entries.length,
        back() {
          backCalls++;
          if (index === 0) return;
          index--;
          listeners.get("currententrychange")?.({ navigationType: "traverse" });
        },
      },
      addEventListener() {},
      chrome: { runtime: { sendMessage(message) {
        const reply = new Promise((resolve) => {
          listener(message, { tab: structuredClone(tabs.get(id)), frameId: 0 }, resolve);
        });
        pending.add(reply);
        void reply.finally(() => pending.delete(reply));
        return reply;
      } } },
    });
    vm.runInContext("window = globalThis; top = window;", context);
    for (const source of contentSources) vm.runInContext(source, context);
    await Promise.all([...pending]);
    return {
      get index() { return index; },
      get backCalls() { return backCalls; },
      get navigation() { return navigation; },
      back: async (gestureId, freshStrokeEvidence = true) => {
        const result = await context.BacktrackNavigationState.requestAutomaticBackAction({
          id: gestureId, observedAtMs: now, freshStrokeEvidence,
        });
        await Promise.all([...pending]);
        return result;
      },
      manual: () => context.BacktrackNavigationState.performConfirmedBackAction(),
    };
  }
  return { open, tabs, closed, tracker, advance: () => { now += 2_000; } };
}

for (const sameOrigin of [true, false]) {
  test(`close child, reject momentum, then traverse the untracked opener (${sameOrigin ? "same" : "cross"}-origin)`, async () => {
    const browser = createBrowser();
    const parent = await browser.open(10, { depth: 2, sameOrigin });
    const child = await browser.open(20, { openerTabId: 10 });
    assert.equal((await child.back("child-close")).action, "RETURNED_TO_OPENER");
    assert.equal(browser.tabs.get(10).active, true);
    assert.deepEqual(browser.closed, [20]);

    assert.equal((await parent.back("momentum-tail", false)).reason, "MOMENTUM_CONTINUATION");
    assert.equal(parent.backCalls, 0);
    const back = await parent.back("parent-back-1");
    assert.equal(back.internalNavigationRequested, true);
    assert.equal(parent.index, 1);
    assert.equal(parent.backCalls, 1);

    assert.equal((await parent.back("parent-back-1")).reason, "GESTURE_DEDUPLICATED");
    assert.equal(parent.backCalls, 1);
    await parent.back("parent-back-2");
    assert.equal(parent.index, 0);
    await parent.back("parent-empty-history");
    assert.equal(parent.index, 0);
    assert.equal(browser.tabs.has(10), true);
    assert.deepEqual(browser.closed, [20]);
  });
}

test("an untracked tab can go back when the Navigation API is unavailable", async () => {
  const browser = createBrowser();
  const page = await browser.open(10, { depth: 1, apiAvailable: false });
  assert.equal((await page.back("ordinary-back")).internalNavigationRequested, true);
  assert.equal(page.index, 0);
  assert.deepEqual(browser.closed, []);
});

test("a lost child baseline allows ordinary back without inventing closure eligibility", async () => {
  const browser = createBrowser();
  await browser.open(10);
  const child = await browser.open(20, { openerTabId: 10, depth: 1 });
  await browser.tracker.remove(20);
  assert.equal((await child.back("after-reload")).internalNavigationRequested, true);
  assert.equal(child.index, 0);
  browser.advance();
  await child.back("empty-after-reload");
  assert.equal((await browser.tracker.assess(20)).reason, "NOT_TRACKED");
  assert.deepEqual(browser.closed, []);
});

test("manual development action only reports ordinary back without executing it", async () => {
  const browser = createBrowser();
  const page = await browser.open(10, { depth: 1 });
  assert.equal((await page.manual()).internalNavigationRequested, false);
  assert.equal(page.backCalls, 0);
  assert.deepEqual(browser.closed, []);
});
