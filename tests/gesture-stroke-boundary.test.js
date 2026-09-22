import assert from "node:assert/strict";
import test from "node:test";

await import("../src/shared/gesture-stroke-boundary.js");

const boundary = globalThis.BacktrackGestureStrokeBoundary;
const sample = (state, magnitude, eligibleInput = true) =>
  boundary.observe(state, {
    deltaX: -magnitude, deltaY: 0, eligibleInput,
  });

test("decaying momentum never creates another gesture", () => {
  const state = boundary.create();
  for (const magnitude of [180, 130, 90, 55, 35, 18, 12, 9, 7, 5, 3, 1]) {
    assert.equal(sample(state, magnitude), false);
  }
});

test("a sustained new acceleration after a valley creates one boundary", () => {
  const state = boundary.create();
  for (const magnitude of [100, 50, 18, 12, 21, 35]) {
    assert.equal(sample(state, magnitude), false);
  }
  assert.equal(sample(state, 60), true);
});

test("noisy or page-owned movement cannot rearm the gesture", () => {
  const noisy = boundary.create();
  for (const magnitude of [12, 24, 20, 38, 55, 47, 65]) {
    assert.equal(sample(noisy, magnitude), false);
  }
  const pageOwned = boundary.create();
  for (const magnitude of [12, 21, 35, 60]) {
    assert.equal(sample(pageOwned, magnitude, false), false);
  }
});

test("one confirmed rise resets before another rise can be confirmed", () => {
  const state = boundary.create();
  for (const magnitude of [12, 21, 35]) assert.equal(sample(state, magnitude), false);
  assert.equal(sample(state, 60), true);
  for (const magnitude of [70, 90, 120]) assert.equal(sample(state, magnitude), false);
  for (const magnitude of [15, 25, 40]) assert.equal(sample(state, magnitude), false);
  assert.equal(sample(state, 70), true);
});
