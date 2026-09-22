import assert from "node:assert/strict";
import test from "node:test";
import { GestureActionGate } from "../src/background/gesture-action-gate.js";

function storage() {
  const data = new Map();
  return {
    async get(key) { return { [key]: data.get(key) }; },
    async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
    async remove(key) { data.delete(key); },
  };
}
function gesture(id, start, end = start + 100, endReason = "NATIVE_MOMENTUM") {
  return { id, observedAtMs: start,
    nativeInput: { endReason, endedAtMs: end, physicalEventCount: 12 } };
}

test("one physical stroke can be claimed only once", async () => {
  const gate = new GestureActionGate(storage());
  assert.equal((await gate.claim(20, 2, gesture("a", 10000), 10100)).ok, true);
  assert.equal((await gate.claim(20, 2, gesture("a", 10000), 10200)).reason, "DUPLICATE_GESTURE");
});
test("completed new strokes work immediately, including in the previous tab", async () => {
  const gate = new GestureActionGate(storage());
  await gate.claim(20, 2, gesture("close", 10000), 10100);
  await gate.remove(20);
  assert.equal((await gate.claim(10, 2, gesture("back", 10110, 10200), 10200)).ok, true);
  assert.equal((await gate.claim(10, 2, gesture("back-again", 10210, 10300), 10300)).ok, true);
});
test("a stroke overlapping the consumed input is blocked across tab switches", async () => {
  const gate = new GestureActionGate(storage());
  await gate.claim(20, 2, gesture("close", 10000, 10300), 10300);
  const result = await gate.claim(10, 2, gesture("overlap", 10200, 10400), 10400);
  assert.equal(result.reason, "MOMENTUM_CONTINUATION");
  assert.equal(result.scope, "WINDOW");
});
test("there is no ten-second cooldown after a successful or rejected action", async () => {
  const gate = new GestureActionGate(storage());
  await gate.claim(20, 2, gesture("a", 10000), 10100);
  const missing = { id: "legacy", observedAtMs: 10300, freshStrokeEvidence: true };
  assert.equal((await gate.claim(20, 2, missing, 10300)).reason, "NATIVE_INPUT_REQUIRED");
  assert.equal((await gate.claim(20, 2, gesture("b", 10400), 10500)).ok, true);
});
test("idle-ended physical strokes also require no cooldown", async () => {
  const gate = new GestureActionGate(storage());
  await gate.claim(20, 2, gesture("a", 10000, 10400, "INPUT_IDLE"), 10400);
  assert.equal((await gate.claim(20, 2, gesture("b", 10410, 10800, "INPUT_IDLE"), 10800)).ok, true);
});
test("window claims are serialized and survive worker recreation", async () => {
  const area = storage(), gate = new GestureActionGate(area);
  const [a, b] = await Promise.all([
    gate.claim(20, 2, gesture("a", 10000, 10300), 10300),
    gate.claim(10, 2, gesture("b", 10100, 10400), 10400),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  const restarted = new GestureActionGate(area);
  assert.equal((await restarted.claim(10, 2, gesture("c", 10410), 10510)).ok, true);
});
test("windows are independent and removable", async () => {
  const gate = new GestureActionGate(storage());
  await gate.claim(20, 2, gesture("a", 10000), 10100);
  assert.equal((await gate.claim(21, 3, gesture("b", 10000), 10100)).ok, true);
  await gate.remove(20);
  await gate.removeWindow(2);
  assert.equal((await gate.claim(20, 2, gesture("c", 10000), 10100)).ok, true);
});
test("old 0.7.2 retention state cannot recreate its ten-second lockout", async () => {
  const area = storage();
  await area.set({ "backtrack.gesture.action-gate.window.2": {
    schemaVersion: 1, gestureId: "old", claimedAtMs: 10000,
  } });
  const gate = new GestureActionGate(area);
  assert.equal((await gate.claim(10, 2, gesture("new", 10100), 10200)).ok, true);
});
test("stale, future, malformed and tabless requests fail closed", async () => {
  const gate = new GestureActionGate(storage());
  for (const [tab, window, input, now] of [
    [null, 2, gesture("a", 10000), 10100],
    [20, null, gesture("a", 10000), 10100],
    [20, 2, gesture("", 10000), 10100],
    [20, 2, gesture("a", 20000), 10000],
    [20, 2, gesture("a", 1), 20000],
    [20, 2, gesture("a", 10000, 9000), 10100],
    [20, 2, gesture("a", 10000, 20000), 10100],
    [20, 2, gesture("a", 10000, 10100, "UNSUPPORTED"), 10100],
    [20, 2, { ...gesture("a", 10000), nativeInput: { physicalEventCount: 0 } }, 10100],
  ]) assert.equal((await gate.claim(tab, window, input, now)).ok, false);
});
