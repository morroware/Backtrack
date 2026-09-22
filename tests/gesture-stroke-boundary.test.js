import assert from "node:assert/strict";
import test from "node:test";
await import("../src/shared/gesture-stroke-boundary.js");
const boundary = globalThis.BacktrackGestureStrokeBoundary;

test("native phase does not depend on a low-to-high ramp", () => {
  for (const deltaX of [-8, -80, -300, -30]) {
    assert.equal(boundary.phase({ deltaX, isTrusted: true, momentum: false }), "PHYSICAL");
    assert.equal(boundary.phase({ deltaX, isTrusted: true, momentum: true }), "MOMENTUM");
  }
});
test("missing or malformed native evidence cannot authorize automatic navigation", () => {
  for (const momentum of [undefined, null, 0, 1, "false"]) {
    assert.equal(boundary.phase({ isTrusted: true, momentum }), "UNSUPPORTED");
  }
});
test("synthetic input cannot provide physical evidence", () => {
  assert.equal(boundary.phase({ isTrusted: false, momentum: false }), "UNTRUSTED");
});
test("feature detection does not mistake absent support for physical input", () => {
  class ModernWheel {}
  Object.defineProperty(ModernWheel.prototype, "momentum", { value: false });
  assert.equal(boundary.supported(ModernWheel), true);
  assert.equal(boundary.supported(class OldWheel {}), false);
  assert.equal(boundary.supported(undefined), false);
});
