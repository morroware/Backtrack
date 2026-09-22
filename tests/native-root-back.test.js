import assert from "node:assert/strict";
import test from "node:test";
import { createPage } from "./helpers/gesture-page.js";
const rootDecision = { decision: "NO_SPECIAL_ACTION", reason: "NO_OPENER" };
const childDecision = { decision: "RETURN_TO_OPENER_ELIGIBLE", reason: "TRACKED_ENTRY_POINT" };

test("native release commits once; renewed physical input needs no acceleration ramp", async () => {
  const page = await createPage();
  await page.wheel();
  await page.advance(100);
  assert.equal(page.calls, 0);
  for (const magnitude of [60, 45, 30, 18, 12, ...Array(40).fill(9)]) {
    await page.wheelDelta(-magnitude, { momentum: true });
  }
  assert.equal(page.calls, 1);
  for (const magnitude of [80, 100, 90, ...Array(15).fill(70)]) {
    await page.wheelDelta(-magnitude);
  }
  await page.wheelDelta(-60, { momentum: true });
  assert.equal(page.calls, 2);
  assert.equal(page.requestedGestures[1].nativeInput.endReason, "NATIVE_MOMENTUM");
});

test("an opener-free tab now sends a confirmed Back gesture through Backtrack", async () => {
  const page = await createPage();
  assert.equal(page.api.getStatus().navigationOwner, "BACKTRACK");
  assert.equal(page.root.style.getPropertyValue("overscroll-behavior-x"), "contain");
  await page.wheel();
  await page.wheelDelta(-60, { momentum: true });
  assert.equal(page.calls, 1);
});

test("disabling positional navigation restores site-supplied overscroll styles", async () => {
  const page = await createPage(rootDecision, "none");
  assert.equal(page.root.style.getPropertyValue("overscroll-behavior-x"), "contain");
  await page.disable();
  assert.equal(page.root.style.getPropertyValue("overscroll-behavior-x"), "none");
  assert.equal(page.root.style.getPropertyPriority("overscroll-behavior-x"), "");
});

test("a child still requires the existing classifier and commits only once", async () => {
  const page = await createPage(childDecision);
  assert.equal(page.api.getStatus().navigationOwner, "BACKTRACK");
  assert.equal(page.root.style.getPropertyValue("overscroll-behavior-x"), "contain");
  await page.wheel();
  await page.advance(100);
  assert.equal(page.calls, 0);
  await page.wheel(60);
  await page.wheelDelta(-60, { momentum: true });
  assert.equal(page.calls, 1);
});

test("a slow stroke without inertia commits after 220 ms of input idle", async () => {
  const page = await createPage();
  await page.wheel();
  await page.advance(209);
  assert.equal(page.calls, 0);
  await page.advance(1);
  assert.equal(page.calls, 1);
  assert.equal(page.requestedGestures[0].nativeInput.endReason, "INPUT_IDLE");
  await page.wheel();
  await page.advance(220);
  assert.equal(page.calls, 2);
});

test("a huge momentum tail cannot turn an insufficient physical stroke into Back", async () => {
  const page = await createPage();
  await page.wheel(2);
  for (let i = 0; i < 300; i++) await page.wheelDelta(-300, { momentum: true });
  await page.advance(500);
  assert.equal(page.calls, 0);
});

test("unsupported browsers keep native navigation and site styles", async () => {
  const page = await createPage(rootDecision, "none", { nativeSupport: false });
  assert.equal(page.api.getStatus().navigationOwner, "BROWSER");
  assert.equal(page.root.style.getPropertyValue("overscroll-behavior-x"), "none");
  await page.wheel();
  await page.advance(500);
  assert.equal(page.calls, 0);
});

test("missing per-event momentum evidence aborts the stroke and restores native Back", async () => {
  const page = await createPage();
  await page.wheel();
  await page.wheelDelta(-70, { momentum: undefined });
  await page.advance(500);
  assert.equal(page.calls, 0);
  assert.equal(page.api.getStatus().navigationOwner, "BROWSER");
});

test("tab hiding cancels partial input rather than leaving a stale session on return", async () => {
  const page = await createPage();
  await page.wheel();
  await page.visibility("hidden");
  await page.advance(500);
  await page.visibility("visible");
  await page.wheelDelta(-60, { momentum: true });
  assert.equal(page.calls, 0);
  await page.wheel();
  await page.wheelDelta(-60, { momentum: true });
  assert.equal(page.calls, 1);
});

test("rejected requests do not swallow the next completed physical stroke", async () => {
  const page = await createPage(rootDecision, "", {
    onAction: async () => ({ action: "NO_SPECIAL_ACTION", reason: "NAVIGATION_IN_PROGRESS" }),
  });
  for (let i = 0; i < 2; i++) {
    await page.wheel();
    await page.wheelDelta(-60, { momentum: true });
  }
  assert.equal(page.calls, 2);
});

for (const [name, extras] of Object.entries({
  vertical: { deltaY: 300 }, zoom: { ctrlKey: true },
  untrusted: { isTrusted: false }, nonPixel: { deltaMode: 1 },
  pageCancelled: { defaultPrevented: true },
})) {
  test(`${name} input never produces a native Back request`, async () => {
    const page = await createPage();
    for (let i = 0; i < 20; i++) await page.wheelDelta(-70, extras);
    await page.wheelDelta(-60, { momentum: true });
    assert.equal(page.calls, 0);
  });
}

test("a horizontal scroll container retains its native interaction", async () => {
  const page = await createPage(rootDecision, "", { scrollable: true });
  await page.wheel();
  await page.wheelDelta(-60, { momentum: true });
  assert.equal(page.calls, 0);
});

test("a page listener cancelling after the capture listener blocks the whole stroke", async () => {
  const page = await createPage(rootDecision, "", {
    afterWheelEvent: event => { event.defaultPrevented = true; },
  });
  await page.wheel();
  await page.wheelDelta(-60, { momentum: true });
  assert.equal(page.calls, 0);
});

test("missing child history or a closed opener is not proof of a root", async () => {
  for (const reason of ["NOT_TRACKED", "OPENER_UNAVAILABLE", "INTERNAL_ERROR", "NAVIGATION_IN_PROGRESS"]) {
    const page = await createPage({ decision: "NO_SPECIAL_ACTION", reason });
    assert.equal(page.api.getStatus().navigationOwner, "BACKTRACK", reason);
  }
});

test("opener decisions do not release containment midway through a gesture", async () => {
  const page = await createPage(childDecision);
  await page.wheel(2);
  await page.decide(rootDecision);
  assert.equal(page.api.getStatus().navigationOwner, "BACKTRACK");
  await page.advance(250);
  assert.equal(page.api.getStatus().navigationOwner, "BACKTRACK");
  assert.equal(page.calls, 0);
});

test("a failed decision query does not remove positional ownership", async () => {
  const page = await createPage(childDecision);
  await page.decide(() => { throw new Error("Worker temporarily unavailable"); });
  assert.equal(page.api.getStatus().navigationOwner, "BACKTRACK");
});

test("disabling positional actions removes root containment", async () => {
  const page = await createPage();
  await page.disable();
  assert.equal(page.root.style.getPropertyValue("overscroll-behavior-x"), "");
  assert.equal(page.api.getStatus().semanticSettings.automaticActionsEnabled, false);
});
