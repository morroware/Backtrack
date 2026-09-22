import assert from "node:assert/strict";
import test from "node:test";

import {
  GESTURE_GATE_REASONS,
  GestureActionGate,
} from "../src/background/gesture-action-gate.js";

class MemoryStorageArea {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.has(key)
      ? { [key]: structuredClone(this.values.get(key)) }
      : {};
  }

  async set(items) {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(key) {
    this.values.delete(key);
  }
}

function gesture(id, observedAtMs, freshStrokeEvidence = false) {
  return { id, observedAtMs, freshStrokeEvidence };
}

test("one gesture can be claimed only once", async () => {
  const gate = new GestureActionGate(new MemoryStorageArea(), 10_000);

  const first = await gate.claim(20, 2, gesture("gesture-a", 10_000), 10_100);
  const duplicate = await gate.claim(
    20,
    2,
    gesture("gesture-a", 10_000),
    10_200,
  );

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, GESTURE_GATE_REASONS.DUPLICATE_GESTURE);
});

test("a decaying momentum continuation is blocked without a fixed cooldown", async () => {
  const gate = new GestureActionGate(new MemoryStorageArea(), 10_000);

  await gate.claim(20, 2, gesture("gesture-a", 10_000), 10_100);
  const tail = await gate.claim(
    20,
    2,
    gesture("gesture-tail", 10_400),
    10_500,
  );

  assert.equal(tail.ok, false);
  assert.equal(tail.reason, GESTURE_GATE_REASONS.MOMENTUM_CONTINUATION);
  assert.equal(tail.scope, "TAB");
  const muchLaterTail = await gate.claim(
    20,
    2,
    gesture("gesture-late-tail", 15_000),
    15_100,
  );
  assert.equal(muchLaterTail.reason, GESTURE_GATE_REASONS.MOMENTUM_CONTINUATION);
});

test("a newly accelerating physical gesture is accepted immediately", async () => {
  const gate = new GestureActionGate(new MemoryStorageArea(), 10_000);

  await gate.claim(20, 2, gesture("gesture-a", 10_000), 10_100);
  const later = await gate.claim(
    20,
    2,
    gesture("gesture-b", 10_250, true),
    10_300,
  );

  assert.equal(later.ok, true);
});

test("momentum is blocked across a tab switch but renewed acceleration is accepted", async () => {
  const storage = new MemoryStorageArea();
  const gate = new GestureActionGate(storage, 10_000);

  await gate.claim(20, 2, gesture("gesture-a", 10_000), 10_100);
  const openerTail = await gate.claim(
    10,
    2,
    gesture("gesture-tail", 10_100),
    10_200,
  );

  assert.equal(openerTail.ok, false);
  assert.equal(openerTail.reason, GESTURE_GATE_REASONS.MOMENTUM_CONTINUATION);
  assert.equal(openerTail.scope, "WINDOW");

  assert.equal(
    (await gate.claim(10, 2, gesture("gesture-b", 10_300, true), 10_400)).ok,
    true,
  );
});

test("gesture state is independent across windows and removable", async () => {
  const storage = new MemoryStorageArea();
  const gate = new GestureActionGate(storage, 10_000);

  await gate.claim(20, 2, gesture("gesture-a", 10_000), 10_100);
  assert.equal(
    (await gate.claim(21, 3, gesture("gesture-b", 10_100), 10_200)).ok,
    true,
  );
  await gate.remove(20);
  await gate.removeWindow(2);
  assert.equal(
    (await gate.claim(20, 2, gesture("gesture-c", 10_300), 10_400)).ok,
    true,
  );
});

test("stale protection state eventually expires as a recovery fallback", async () => {
  const gate = new GestureActionGate(new MemoryStorageArea(), 10_000);
  await gate.claim(20, 2, gesture("gesture-a", 10_000), 10_100);
  assert.equal(
    (await gate.claim(20, 2, gesture("gesture-b", 20_200), 20_201)).ok,
    true,
  );
});

test("stale, future, malformed, and tabless requests are rejected", async () => {
  const gate = new GestureActionGate(new MemoryStorageArea(), 10_000);

  for (const [tabId, windowId, request, now] of [
    [null, 2, gesture("a", 10_000), 10_100],
    [20, null, gesture("a", 10_000), 10_100],
    [20, 2, gesture("", 10_000), 10_100],
    [20, 2, gesture("a", -1), 10_100],
    [20, 2, gesture("a", 20_000), 10_100],
    [20, 2, gesture("a", 1), 20_000],
  ]) {
    const result = await gate.claim(tabId, windowId, request, now);
    assert.equal(result.ok, false);
    assert.equal(result.reason, GESTURE_GATE_REASONS.INVALID_REQUEST);
  }
});
