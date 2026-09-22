import assert from "node:assert/strict";
import test from "node:test";

import {
  NavigationTracker, NAVIGATION_AVAILABILITY, createPositionState,
  applyNavigationSnapshot, assessTrackedNavigation,
} from "../src/background/navigation-tracker.js";
import {
  evaluatePositionalBackDecision, markLinkOpenedByNavigationTarget,
  performPositionalBackAction,
  POSITION_ACTIONS, POSITION_DECISIONS,
} from "../src/background/positional-back.js";

function browser(ids = [1, 2, 3]) {
  const stored = new Map();
  const tracker = new NavigationTracker({
    async get(key) { return stored.has(key) ? { [key]: structuredClone(stored.get(key)) } : {}; },
    async set(items) { for (const [key, value] of Object.entries(items)) stored.set(key, structuredClone(value)); },
    async remove(key) { stored.delete(key); },
  });
  const tabs = new Map(ids.map((id, index) => [id, {
    id, index, windowId: 9, active: index === ids.length - 1,
    pinned: false, discarded: false, incognito: false,
  }]));
  const removed = [];
  let windowClosed = false;
  const tabsApi = {
    async get(id) {
      if (!tabs.has(id)) throw new Error("Missing tab");
      return structuredClone(tabs.get(id));
    },
    async query({ windowId }) {
      return [...tabs.values()].filter(tab => tab.windowId === windowId)
        .map(tab => structuredClone(tab));
    },
    async update(id, patch) {
      if (!tabs.has(id)) throw new Error("Missing tab");
      if (patch.active) {
        for (const tab of tabs.values()) {
          if (tab.windowId === tabs.get(id).windowId) tab.active = tab.id === id;
        }
      }
      return this.get(id);
    },
    async remove(id) {
      if (!tabs.has(id)) throw new Error("Missing tab");
      tabs.delete(id);
      removed.push(id);
      await tracker.remove(id);
    },
  };
  const windowsApi = {
    async get(id) { return { id, type: "normal", focused: true }; },
    async remove(id) {
      if (id !== 9) throw new Error("Wrong window");
      windowClosed = true;
      tabs.clear();
    },
  };
  const snapshot = (id, key = `entry-${id}`, historyLength = 1, navigationType = "push") => ({
    apiAvailable: true, currentEntryKey: key, historyLength, navigationType,
    sameOriginCanGoBack: false, transitionActive: false,
  });
  async function track(id) {
    await tracker.beginPosition(tabs.get(id));
    await tracker.recordSnapshot(id, snapshot(id));
  }
  async function back(id, liveSnapshot = snapshot(id)) {
    return performPositionalBackAction(
      await tabsApi.get(id), liveSnapshot, tabsApi, windowsApi, tracker,
    );
  }
  return { tabs, tabsApi, windowsApi, tracker, snapshot, track, back, removed,
    get windowClosed() { return windowClosed; } };
}

test("three unrelated tabs close from right to left, then only their window closes", async () => {
  const b = browser();
  for (const id of [1, 2, 3]) await b.track(id);
  assert.equal((await b.back(3)).action, POSITION_ACTIONS.CLOSED_TAB_TO_LEFT);
  assert.equal(b.tabs.get(2).active, true);
  assert.equal((await b.back(2)).action, POSITION_ACTIONS.CLOSED_TAB_TO_LEFT);
  assert.equal(b.tabs.get(1).active, true);
  assert.equal((await b.back(1)).action, POSITION_ACTIONS.CLOSED_WINDOW);
  assert.deepEqual(b.removed, [3, 2]);
  assert.equal(b.windowClosed, true);
});

test("nested link-opened tabs with missing opener IDs still close C then B", async () => {
  const b = browser([1, 2, 3]);
  await b.track(1);
  for (const [sourceTabId, tabId] of [[1, 2], [2, 3]]) {
    await b.tracker.beginPosition(b.tabs.get(tabId));
    assert.equal((await markLinkOpenedByNavigationTarget(
      { sourceTabId, tabId }, b.tabsApi, b.tracker,
    )).ok, true);
    await b.tracker.recordSnapshot(tabId, b.snapshot(tabId, `entry-${tabId}`, 2));
  }
  assert.equal((await b.back(3, b.snapshot(3, "entry-3", 2))).action,
    POSITION_ACTIONS.CLOSED_TAB_TO_LEFT);
  assert.equal(b.tabs.get(2).active, true);
  assert.equal((await b.back(2, b.snapshot(2, "entry-2", 2))).action,
    POSITION_ACTIONS.CLOSED_TAB_TO_LEFT);
  assert.equal(b.tabs.get(1).active, true);
});

test("internal navigation wins before the current tab closes", async () => {
  const b = browser([1, 2]);
  await b.track(1);
  await b.track(2);
  const page2 = b.snapshot(2, "page-2", 2);
  await b.tracker.recordSnapshot(2, page2);
  assert.equal((await b.back(2, page2)).action, POSITION_ACTIONS.USE_INTERNAL_HISTORY);
  assert.deepEqual(b.removed, []);

  const returned = b.snapshot(2, "entry-2", 2, "traverse");
  await b.tracker.recordSnapshot(2, returned);
  assert.equal((await b.back(2, returned)).action, POSITION_ACTIONS.CLOSED_TAB_TO_LEFT);
  assert.equal(b.tabs.get(1).active, true);
});

test("an unknown multi-entry history never authorizes a close", async () => {
  const b = browser([1, 2]);
  const uncertain = b.snapshot(2, "unknown-entry", 3);
  assert.equal((await b.back(2, uncertain)).action, POSITION_ACTIONS.USE_BROWSER_HISTORY);
  assert.deepEqual(b.removed, []);
});

test("an untracked single entry needs independent browser-history evidence", async () => {
  const b = browser([1, 2]);
  const current = await b.tabsApi.get(2);
  const definite = await evaluatePositionalBackDecision(current, b.snapshot(2), b.tracker);
  assert.equal(definite.decision, POSITION_DECISIONS.CLOSE_POSITION_ELIGIBLE);
  assert.equal(definite.reason, "UNTRACKED_SINGLE_ENTRY");
  const unknown = await evaluatePositionalBackDecision(current, {
    ...b.snapshot(2), sameOriginCanGoBack: null,
  }, b.tracker);
  assert.equal(unknown.decision, POSITION_DECISIONS.NO_SPECIAL_ACTION);
});

test("a tab whose first observed page already had earlier history remains open", async () => {
  const b = browser([1, 2]);
  await b.tracker.beginPosition(b.tabs.get(2));
  await b.tracker.recordSnapshot(2, b.snapshot(2, "entry-2", 2));
  const assessment = await b.tracker.assess(2);
  assert.equal(assessment.availability, NAVIGATION_AVAILABILITY.UNKNOWN);
  assert.equal((await b.back(2, b.snapshot(2, "entry-2", 2))).action,
    POSITION_ACTIONS.USE_BROWSER_HISTORY);
});

test("a link-opened tab may use browser-reported opening evidence without using its opener as the target", async () => {
  const b = browser([1, 2]);
  b.tabs.get(2).openerTabId = 99;
  await b.tracker.beginPosition(b.tabs.get(2));
  const entry = b.snapshot(2, "entry-2", 2);
  await b.tracker.recordSnapshot(2, entry);
  assert.equal((await b.back(2, entry)).action, POSITION_ACTIONS.CLOSED_TAB_TO_LEFT);
  assert.equal(b.tabs.get(1).active, true);
});

test("a navigation-target event proves a missing opener without making it the destination", async () => {
  const b = browser([1, 2]);
  await b.tracker.beginPosition(b.tabs.get(2));
  const confirmation = await markLinkOpenedByNavigationTarget(
    { sourceTabId: 1, tabId: 2 }, b.tabsApi, b.tracker,
  );
  assert.equal(confirmation.ok, true);
  const entry = b.snapshot(2, "entry-2", 2);
  await b.tracker.recordSnapshot(2, entry);
  assert.equal((await b.back(2, entry)).action, POSITION_ACTIONS.CLOSED_TAB_TO_LEFT);
  assert.equal(b.tabs.get(1).active, true);
});

test("a conflicting or cross-window navigation target never proves link opening", async () => {
  const b = browser([1, 2]);
  b.tabs.get(2).openerTabId = 3;
  assert.equal((await markLinkOpenedByNavigationTarget(
    { sourceTabId: 1, tabId: 2 }, b.tabsApi, b.tracker,
  )).ok, false);
  b.tabs.get(2).openerTabId = undefined;
  b.tabs.get(1).windowId = 8;
  assert.equal((await markLinkOpenedByNavigationTarget(
    { sourceTabId: 1, tabId: 2 }, b.tabsApi, b.tracker,
  )).ok, false);
});

test("a redirected-Back loop cannot erase history predating a root baseline", () => {
  const initial = createPositionState({ id: 1 });
  const baseline = applyNavigationSnapshot(initial, {
    apiAvailable: true, currentEntryKey: "entry", historyLength: 2,
    sameOriginCanGoBack: false, transitionActive: false,
  });
  const later = applyNavigationSnapshot(baseline, {
    apiAvailable: true, currentEntryKey: "later", historyLength: 3,
    navigationType: "push", sameOriginCanGoBack: false, transitionActive: false,
  });
  const assessment = assessTrackedNavigation({
    ...later, backRedirectLoopEntryKey: "later",
  }, { currentEntryKey: "later", sameOriginCanGoBack: false });
  assert.equal(assessment.availability, NAVIGATION_AVAILABILITY.INTERNAL_BACK_AVAILABLE);
  assert.equal(assessTrackedNavigation({
    ...baseline, baselineFromInitialRedirect: true,
  }).availability, NAVIGATION_AVAILABILITY.UNKNOWN);
});

test("a pinned tab, missing left neighbor, or unfocused window never closes", async () => {
  const b = browser([1, 2]);
  await b.track(1);
  await b.track(2);
  b.tabs.get(2).pinned = true;
  assert.equal((await b.back(2)).reason, "CURRENT_TAB_PINNED");
  b.tabs.get(2).pinned = false;
  b.tabs.get(1).active = true;
  b.tabs.get(2).active = false;
  assert.equal((await b.back(1)).reason, "NO_LEFT_TAB");
  b.tabs.get(1).active = false;
  b.tabs.get(2).active = true;
  b.windowsApi.get = async id => ({ id, type: "normal", focused: false });
  assert.equal((await b.back(2)).reason, "WINDOW_CHANGED");
  assert.deepEqual(b.removed, []);
  assert.equal(b.windowClosed, false);
});

test("a failed left-tab activation or close leaves the current tab open", async () => {
  const b = browser([1, 2]);
  await b.track(2);
  const update = b.tabsApi.update.bind(b.tabsApi);
  b.tabsApi.update = async () => { throw new Error("focus blocked"); };
  assert.equal((await b.back(2)).reason, "LEFT_TAB_ACTIVATION_FAILED");
  assert.equal(b.tabs.has(2), true);
  b.tabsApi.update = update;
  b.tabsApi.remove = async () => { throw new Error("close blocked"); };
  assert.equal((await b.back(2)).reason, "TAB_CLOSE_FAILED");
  assert.equal(b.tabs.has(2), true);
  assert.equal(b.tabs.get(2).active, true);
});

test("a navigation during left-tab activation cancels closure and restores focus", async () => {
  const b = browser([1, 2]);
  await b.track(2);
  const update = b.tabsApi.update.bind(b.tabsApi);
  b.tabsApi.update = async (id, patch) => {
    const result = await update(id, patch);
    if (id === 1) {
      await b.tracker.recordSnapshot(2, b.snapshot(2, "new-page", 2));
    }
    return result;
  };
  const result = await b.back(2);
  assert.equal(result.reason, "ENTRY_CHANGED_BEFORE_CLOSE");
  assert.equal(result.focusRestored, true);
  assert.equal(b.tabs.has(2), true);
  assert.equal(b.tabs.get(2).active, true);
});

test("a navigation before the last-window close leaves the window open", async () => {
  const b = browser([1]);
  await b.track(1);
  const getWindow = b.windowsApi.get.bind(b.windowsApi);
  let reads = 0;
  b.windowsApi.get = async id => {
    reads += 1;
    if (reads === 2) {
      await b.tracker.recordSnapshot(1, b.snapshot(1, "new-page", 2));
    }
    return getWindow(id);
  };
  assert.equal((await b.back(1)).reason, "ENTRY_CHANGED_BEFORE_CLOSE");
  assert.equal(b.windowClosed, false);
});
