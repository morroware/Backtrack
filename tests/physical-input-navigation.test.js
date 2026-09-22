import assert from "node:assert/strict";
import test from "node:test";
import { createPage } from "./helpers/gesture-page.js";
import { GestureActionGate } from "../src/background/gesture-action-gate.js";
import { NavigationTracker } from "../src/background/navigation-tracker.js";
import { createNavigationMessageListener } from "../src/background/navigation-message-handler.js";
import { evaluatePositionalBackDecision, performPositionalBackAction } from "../src/background/positional-back.js";

// Real content scripts, message handler, gate, tracker and positional strategy.
// Only browser APIs and time are simulated. No preclassified gesture is supplied.
async function browser() {
  const clock = { now: 0 };
  const stored = new Map();
  const storage = {
    async get(key) { return { [key]: structuredClone(stored.get(key)) }; },
    async set(items) { for (const [key, value] of Object.entries(items)) stored.set(key, structuredClone(value)); },
    async remove(key) { stored.delete(key); },
  };
  const tracker = new NavigationTracker(storage);
  const gate = new GestureActionGate(storage);
  const tabs = new Map();
  const pages = new Map();
  const actions = [];
  const removed = [];
  let windowClosed = false;
  const tabsApi = {
    async get(id) { if (!tabs.has(id)) throw new Error("Missing tab"); return structuredClone(tabs.get(id)); },
    async query() { return [...tabs.values()].map(tab => structuredClone(tab)); },
    async update(id, patch) {
      if (patch.active) for (const tab of tabs.values()) tab.active = tab.id === id;
      return this.get(id);
    },
    async remove(id) { tabs.delete(id); removed.push(id); await tracker.remove(id); await gate.remove(id); },
  };
  const windowsApi = {
    async get(id) { return { id, type: "normal", focused: true }; },
    async remove() { windowClosed = true; tabs.clear(); },
  };
  const listener = createNavigationMessageListener(tabsApi, tracker, {
    claim: (tabId, windowId, gesture) => gate.claim(tabId, windowId, gesture, 100_000 + clock.now),
  }, null, null, {
    evaluate: (tab, snapshot) => evaluatePositionalBackDecision(tab, snapshot, tracker),
    perform: async (tab, snapshot) => {
      const result = await performPositionalBackAction(tab, snapshot, tabsApi, windowsApi, tracker);
      actions.push(result.action);
      return result;
    },
  });
  async function open(id, depth = 0) {
    for (const tab of tabs.values()) tab.active = false;
    tabs.set(id, { id, index: tabs.size, windowId: 1, active: true });
    await tracker.beginPosition(tabs.get(id));
    const entries = Array.from({ length: depth + 1 }, (_, i) => ({ key: `${id}-${i}` }));
    let index = 0;
    let page;
    const navigation = {
      get currentEntry() { return entries[index]; },
      get canGoBack() { return index > 0; },
      get canGoForward() { return index < entries.length - 1; },
      entries: () => entries,
      activation: { navigationType: "push" }, transition: null,
    };
    const history = {
      get length() { return index === 0 && !page ? 1 : entries.length; },
      back() { if (index > 0) { index--; page.emit("currententrychange", { navigationType: "traverse" }); } },
    };
    page = await createPage(undefined, "", {
      clock, frameId: `${id.toString(16).padStart(8, "0")}-1234-4321-9876-123456789abc`, navigation, history,
      sendMessage: message => new Promise(resolve => {
        if (!tabs.has(id)) { resolve({ ok: false }); return; }
        listener(message, { tab: structuredClone(tabs.get(id)), frameId: 0, documentId: `doc-${id}` }, resolve);
      }),
    });
    for (let i = 1; i <= depth; i++) {
      index = i;
      page.emit("currententrychange", { navigationType: "push" });
      await page.advance(0);
    }
    pages.set(id, page);
    return { page, get index() { return index; } };
  }
  return { open, tabs, actions, removed, get windowClosed() { return windowClosed; } };
}

const profiles = {
  abrupt: [-70, -72, -69, -70, -68, -71, -70, -70, -69, -70, -68, -70],
  gradual: [-10, -20, -30, -40, -50, -60, -70, -80, -70, -50, -30, -20],
  modest: Array(16).fill(-20),
};
async function swipe(page, profile = profiles.abrupt, momentum = true) {
  for (const delta of profile) await page.wheelDelta(delta);
  if (momentum) await page.wheelDelta(-40, { momentum: true });
  else await page.advance(220);
}

for (const [name, profile] of Object.entries(profiles)) {
  test(`raw ${name} strokes: close child, ignore inherited inertia, immediately traverse parent twice`, async () => {
    const b = await browser();
    const parent = await b.open(1, 2);
    const child = await b.open(2);
    await swipe(child.page, profile);
    assert.deepEqual(b.removed, [2]);
    assert.equal(b.tabs.get(1).active, true);
    for (const delta of [-60, -40, -70, -20, -10]) {
      await parent.page.wheelDelta(delta, { momentum: true });
    }
    assert.equal(parent.index, 2);
    await swipe(parent.page, profile);
    assert.equal(parent.index, 1);
    await swipe(parent.page, profile);
    assert.equal(parent.index, 0);
    assert.deepEqual(b.actions, ["CLOSED_TAB_TO_LEFT", "USE_INTERNAL_HISTORY", "USE_INTERNAL_HISTORY"]);
    assert.equal(b.windowClosed, false);
  });
}

test("raw strokes close C, B, then A's window without a cooldown", async () => {
  const b = await browser();
  const a = await b.open(1);
  const mid = await b.open(2);
  const c = await b.open(3);
  await swipe(c.page);
  for (let i = 0; i < 40; i++) await mid.page.wheelDelta(-30, { momentum: true });
  await swipe(mid.page);
  await a.page.wheelDelta(-80, { momentum: true });
  await swipe(a.page);
  assert.deepEqual(b.removed, [3, 2]);
  assert.equal(b.windowClosed, true);
  assert.deepEqual(b.actions, ["CLOSED_TAB_TO_LEFT", "CLOSED_TAB_TO_LEFT", "CLOSED_WINDOW"]);
});

test("non-inertial physical strokes use input silence and the next stroke is not locked out", async () => {
  const b = await browser();
  const parent = await b.open(1, 1);
  const child = await b.open(2);
  await swipe(child.page, profiles.modest, false);
  await swipe(parent.page, profiles.modest, false);
  assert.deepEqual(b.removed, [2]);
  assert.equal(parent.index, 0);
  assert.deepEqual(b.actions, ["CLOSED_TAB_TO_LEFT", "USE_INTERNAL_HISTORY"]);
});
