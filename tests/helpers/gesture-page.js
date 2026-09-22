import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sources = [
  "shared/gesture-classifier.js",
  "shared/gesture-stroke-boundary.js",
  "shared/gesture-visual-policy.js",
  "content/gesture-debug.js",
].map((path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8"));
const navigationSources = ["shared/navigation-snapshot.js", "content/navigation-state.js"]
  .map(path => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8"));

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const rootDecision = { decision: "NO_SPECIAL_ACTION", reason: "NO_OPENER" };
const childDecision = { decision: "RETURN_TO_OPENER_ELIGIBLE", reason: "TRACKED_ENTRY_POINT" };

export async function createPage(initialDecision = rootDecision, originalStyle = "", options = {}) {
  let decision = initialDecision;
  const clock = options.clock ?? { now: 0 };
  let timerId = 0;
  let calls = 0;
  const requestedGestures = [];
  let previews = 0;
  const timers = new Map();
  const listeners = new Map();
  const changed = [];
  const properties = new Map(originalStyle ? [["overscroll-behavior-x", [originalStyle, ""]]] : []);
  class Element {
    tagName = "HTML";
    scrollWidth = options.scrollable ? 1600 : 800;
    scrollLeft = 20;
    clientWidth = 800;
    style = {
      getPropertyValue: (key) => properties.get(key)?.[0] ?? "",
      getPropertyPriority: (key) => properties.get(key)?.[1] ?? "",
      setProperty: (key, value, priority = "") => properties.set(key, [value, priority]),
      removeProperty: (key) => properties.delete(key),
    };
    getAttribute() { return null; }
  }
  const root = new Element();
  class WheelEventType {}
  Object.assign(WheelEventType, { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  if (options.nativeSupport !== false) Object.defineProperty(WheelEventType.prototype, "momentum", { value: false });
  const addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  };
  const settings = {
    schemaVersion: 2, backDirection: "NEGATIVE_X", automaticActionsEnabled: true,
  };
  const context = vm.createContext({
    Element, Text: class {}, structuredClone, queueMicrotask,
    console: { info() {}, debug() {} },
    crypto: { randomUUID: () => options.frameId ?? "12345678-1234-4321-9876-123456789abc" },
    Date: class extends Date { static now() { return 100_000 + clock.now; } },
    performance: { now: () => clock.now },
    document: { documentElement: root, scrollingElement: root, visibilityState: "visible", readyState: "complete", addEventListener },
    getComputedStyle: () => ({ overscrollBehaviorX: root.style.getPropertyValue("overscroll-behavior-x") || "auto", overflowX: options.scrollable ? "auto" : "visible", direction: "ltr" }),
    addEventListener,
    navigation: options.navigation ? { ...options.navigation, addEventListener } : { addEventListener },
    history: options.history,
    innerWidth: 800, innerHeight: 600,
    WheelEvent: WheelEventType,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { at: clock.now + delay, callback }); return id; },
    clearTimeout: (id) => timers.delete(id),
    chrome: { runtime: options.sendMessage ? { sendMessage: options.sendMessage } : undefined, storage: {
      local: { async get() { return { "backtrack.gesture.settings": settings }; } },
      onChanged: { addListener: (listener) => changed.push(listener) },
    } },
    BacktrackNavigationState: {
      async requestBackDecision() { return typeof decision === "function" ? decision() : decision; },
      getDiagnosticSnapshot: () => ({}),
      async requestAutomaticBackAction(gesture) {
        calls++;
        requestedGestures.push(structuredClone(gesture));
        return options.onAction ? await options.onAction(gesture) : { action: "USE_BROWSER_HISTORY" };
      },
    },
    BacktrackGestureIndicator: {
      update() { previews++; }, hide() {}, commit() {}, destroy() {}, getStatus: () => ({}),
    },
  });
  if (options.navigation) Object.defineProperties(context.navigation,
    Object.getOwnPropertyDescriptors(options.navigation));
  vm.runInContext("window = globalThis; top = window;", context);
  if (options.sendMessage) {
    delete context.BacktrackNavigationState;
    for (const source of navigationSources) vm.runInContext(source, context);
  }
  for (const source of sources) vm.runInContext(source, context);
  await flush();
  const emit = (type, event = {}) => listeners.get(type)?.forEach(handler => handler(event));
  async function advance(ms) {
    const end = clock.now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock.now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    clock.now = end;
    await flush();
  }
  return {
    api: context.BacktrackGestureDebug, root,
    async visibility(value) { context.document.visibilityState = value; emit("visibilitychange"); await flush(); },
    get calls() { return calls; }, get previews() { return previews; },
    get requestedGestures() { return structuredClone(requestedGestures); },
    emit, advance,
    async decide(next) { decision = next; emit("visibilitychange"); await flush(); },
    async disable() { changed.forEach(fn => fn({ "backtrack.gesture.settings": { newValue: { ...settings, automaticActionsEnabled: false } } }, "local")); await flush(); },
    async wheel(count = 12) {
      for (let i = 0; i < count; i++) {
        await this.wheelDelta(-70);
      }
    },
    async wheelDelta(deltaX, extra = {}) {
      const event = {
        deltaX, deltaY: 0, deltaZ: 0, deltaMode: 0, isTrusted: true, momentum: false,
        cancelable: true, defaultPrevented: false, clientX: 400, clientY: 300,
        composedPath: () => [root], target: root,
        preventDefault() { assert.fail("Do not cancel ordinary wheel input"); },
        ...extra,
      };
      emit("wheel", event);
      options.afterWheelEvent?.(event);
      await advance(10);
    },
  };
}
