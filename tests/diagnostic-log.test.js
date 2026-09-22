import assert from "node:assert/strict";
import test from "node:test";

import {
  DIAGNOSTIC_LOG_KEY,
  DiagnosticLog,
  sanitizeDiagnosticEntry,
  diagnosticOrigin,
  navigationDiagnostic,
} from "../src/background/diagnostic-log.js";
import { createNavigationMessageListener } from "../src/background/navigation-message-handler.js";
import { MESSAGE_TYPES } from "../src/shared/messages.js";

class MemoryStorageArea {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.has(key)
      ? { [key]: structuredClone(this.values.get(key)) }
      : {};
  }

  async set(values) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(key) {
    this.values.delete(key);
  }
}

test("persistent diagnostics discard URLs, titles, raw input, and arbitrary fields", () => {
  const entry = sanitizeDiagnosticEntry({
    kind: "GESTURE_SESSION",
    recordedAtMs: 1234.4,
    tabId: 7,
    windowId: 2,
    classification: "HORIZONTAL_NEGATIVE_X",
    semanticDirection: "BACK_GESTURE",
    blockers: ["TOO_FEW_EVENTS", "TOO_FEW_EVENTS", "https://private.example"],
    netHorizontalDistancePx: 345.678,
    rawEvents: [{ deltaX: -999 }],
    url: "https://private.example/secret",
    title: "Sensitive title",
    pageText: "Sensitive page content",
  }, 1);

  assert.deepEqual(entry, {
    schemaVersion: 2,
    recordedAtMs: 1234,
    kind: "GESTURE_SESSION",
    tabId: 7,
    windowId: 2,
    origin: null,
    version: null,
    documentId: null,
    endReason: null,
    classification: "HORIZONTAL_NEGATIVE_X",
    semanticDirection: "BACK_GESTURE",
    blockers: ["TOO_FEW_EVENTS"],
    netHorizontalDistancePx: 345.68,
    horizontalDominanceRatio: null,
    directionConsistency: null,
    eventCount: null,
    peakHorizontalDeltaPx: null,
    freshStrokeEvidence: null,
    automaticActionRequested: null,
    automaticActionTrigger: null,
    actionRequestedAfterMs: null,
  });
  assert.equal("url" in entry, false);
  assert.equal("title" in entry, false);
  assert.equal("rawEvents" in entry, false);
});

test("persistent diagnostics are serialized, bounded, and clearable", async () => {
  const storage = new MemoryStorageArea();
  let now = 100;
  const log = new DiagnosticLog(storage, 3, () => ++now);

  await Promise.all([
    log.record({ kind: "BACK_ACTION", action: "RETURNED_TO_OPENER", reason: "RETURNED_TO_OPENER" }),
    log.record({ kind: "BACK_ACTION", action: "USE_INTERNAL_HISTORY", reason: "INTERNAL_HISTORY_AVAILABLE" }),
    log.record({ kind: "GESTURE_OWNERSHIP", owner: "BROWSER", reason: "NO_OPENER" }),
    log.record({ kind: "BACK_ACTION", action: "NO_SPECIAL_ACTION", reason: "GESTURE_DEDUPLICATED" }),
  ]);

  const entries = await log.list();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.kind), [
    "BACK_ACTION",
    "GESTURE_OWNERSHIP",
    "BACK_ACTION",
  ]);
  assert.equal((await storage.get(DIAGNOSTIC_LOG_KEY))[DIAGNOSTIC_LOG_KEY].entries.length, 3);
  assert.equal(await log.clear(), true);
  assert.deepEqual(await log.list(), []);
});

test("the message handler stores diagnostics under the actual sender tab and serves clear/list", async () => {
  const recorded = [];
  const diagnosticLog = {
    async record(value) { recorded.push(structuredClone(value)); },
    async list() { return [{ kind: "BACK_ACTION" }]; },
    async clear() { return true; },
  };
  const listener = createNavigationMessageListener({}, {}, null, diagnosticLog);
  const sender = { tab: { id: 22, windowId: 4 } };
  const request = (message) => new Promise((resolve) => {
    assert.equal(listener(message, sender, resolve), true);
  });

  assert.deepEqual(await request({
    type: MESSAGE_TYPES.RECORD_GESTURE_DIAGNOSTIC,
    diagnostic: { kind: "GESTURE_SESSION", tabId: 99, url: "https://never.store" },
  }), { ok: true });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].tabId, 22);
  assert.equal(recorded[0].windowId, 4);
  assert.equal(recorded[0].url, "https://never.store");
  // Sanitization is deliberately owned by DiagnosticLog, not a message caller.

  assert.deepEqual(await request({ type: MESSAGE_TYPES.GET_DIAGNOSTIC_LOG }), {
    entries: [{ kind: "BACK_ACTION" }],
  });
  assert.deepEqual(await request({ type: MESSAGE_TYPES.CLEAR_DIAGNOSTIC_LOG }), {
    cleared: true,
  });
});

test("development origins exclude credentials, paths, queries and fragments", () => {
  assert.equal(diagnosticOrigin("https://user:password@example.test/private?token=secret#secret"), "https://example.test");
  assert.equal(diagnosticOrigin("http://10.0.0.5:5000/private"), "http://10.0.0.5:5000");
  for (const url of ["brave://extensions", "file:///private", "not a URL", null]) {
    assert.equal(diagnosticOrigin(url), null);
  }
  const entry = sanitizeDiagnosticEntry({
    kind: "NAVIGATION_STATE", origin: "https://example.test/private?secret=1",
    documentId: "not-an-opaque-key", cookies: "secret", title: "secret",
    navigation: { entryKey: "https://example.test/private", historyLength: 2, title: "secret" },
  });
  assert.equal(entry.origin, "https://example.test");
  assert.equal(entry.navigation.entryKey, null);
  assert.equal(entry.navigation.historyLength, 2);
  assert.equal(JSON.stringify(entry).includes("secret"), false);
});

test("redirect-loop diagnostics retain only boolean state, never compared URLs", () => {
  const navigation = navigationDiagnostic({
    currentEntryKey: "00000000-0000-0000-0000-000000000002",
  }, {
    currentEntryKey: "00000000-0000-0000-0000-000000000002",
    backRedirectLoopEntryKey: "00000000-0000-0000-0000-000000000002",
    pendingBackRedirectLoopDocumentId:
      "00000000-0000-0000-0000-000000000003",
    comparedUrl: "https://example.test/private?token=secret",
  });
  const entry = sanitizeDiagnosticEntry({
    kind: "NAVIGATION_STATE",
    navigation,
    comparedUrl: "https://example.test/private?token=secret",
  });

  assert.equal(entry.navigation.backRedirectLoopEntry, true);
  assert.equal(entry.navigation.backRedirectLoopPending, true);
  assert.equal(JSON.stringify(entry).includes("example.test"), false);
  assert.equal(JSON.stringify(entry).includes("secret"), false);
});

test("400 actions survive independently of 1600 context records and worker restart", async () => {
  const storage = new MemoryStorageArea();
  const actions = Array.from({ length: 450 }, (_, i) => ({
    kind: "BACK_ACTION", recordedAtMs: i + 1, tabId: i, action: "USE_INTERNAL_HISTORY",
  }));
  const context = Array.from({ length: 1800 }, (_, i) => ({
    kind: "TAB_EVENT", event: "ACTIVATED", recordedAtMs: i + 1000,
  }));
  await storage.set({ [DIAGNOSTIC_LOG_KEY]: { schemaVersion: 1, entries: [...actions, ...context] } });
  const first = new DiagnosticLog(storage);
  await first.record({ kind: "RUNTIME_EVENT", event: "WORKER_STARTED" });
  const restarted = new DiagnosticLog(storage);
  const entries = await restarted.list();
  assert.equal(entries.length, 2000);
  assert.equal(entries.filter(entry => entry.kind === "BACK_ACTION").length, 400);
  assert.equal(entries[0].tabId, 50);
  assert.equal(entries.at(-1).event, "WORKER_STARTED");
  assert.ok(JSON.stringify(entries).length < 4_000_000);
  await restarted.clear();
  assert.deepEqual(await first.list(), []);
});

test("identical passive snapshots do not flood the context ring", async () => {
  const log = new DiagnosticLog(new MemoryStorageArea());
  const navigation = navigationDiagnostic({ apiAvailable: true, sameOriginCanGoBack: false });
  const value = { kind: "NAVIGATION_STATE", tabId: 20, navigation };
  await log.record(value);
  await log.record({ kind: "TAB_EVENT", event: "ACTIVATED", tabId: 20 });
  assert.equal(await log.record(value), null);
  await log.record({ ...value, navigation: { ...navigation, canGoBack: true } });
  assert.equal((await log.list()).length, 3);
});

test("diagnostic storage failure is surfaced and later writes recover", async () => {
  const area = new MemoryStorageArea();
  const log = new DiagnosticLog(area);
  const realSet = area.set.bind(area);
  area.set = async () => { throw new Error("quota"); };
  await assert.rejects(log.record({ kind: "TAB_EVENT", event: "CREATED" }));
  assert.equal(log.lastError, "STORAGE_UNAVAILABLE");
  area.set = realSet;
  await log.record({ kind: "TAB_EVENT", event: "CREATED" });
  assert.equal(log.lastError, null);
  assert.equal((await log.list()).length, 1);
});

test("navigation answers never await a slow diagnostic write", async () => {
  let recorded = false;
  const listener = createNavigationMessageListener({}, {}, null, {
    record() { recorded = true; return new Promise(() => {}); },
  });
  const result = await new Promise(resolve => listener({
    type: MESSAGE_TYPES.PERFORM_CONFIRMED_BACK_ACTION, gesture: { source: "AUTOMATIC" },
  }, { tab: { id: 20 }, frameId: 0 }, resolve));
  assert.equal(result.reason, "GESTURE_GATE_UNAVAILABLE");
  assert.equal(recorded, true);
});

test("later report returns retention, evidence and hints without changing the log", async () => {
  const log = new DiagnosticLog(new MemoryStorageArea());
  await log.record({ kind: "BACK_ACTION", reason: "CHILD_CLOSE_FAILED" });
  const listener = createNavigationMessageListener({}, {}, null, log);
  const response = await new Promise(resolve => listener({
    type: MESSAGE_TYPES.GET_DIAGNOSTIC_REPORT,
  }, {}, resolve));
  assert.equal(response.ok, true);
  assert.deepEqual(response.retention, { actions: 400, context: 1600 });
  assert.equal(response.review.hints[0].code, "ACTION_ERROR");
  assert.deepEqual(response.entries, await log.list());
});
