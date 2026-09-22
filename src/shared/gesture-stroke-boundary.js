// @ts-check

(() => {
  "use strict";

  const API_NAME = "BacktrackGestureStrokeBoundary";
  if (Object.prototype.hasOwnProperty.call(globalThis, API_NAME)) return;

  function supported(WheelEventType) {
    return typeof WheelEventType === "function" &&
      "momentum" in WheelEventType.prototype;
  }

  function phase(event) {
    if (event.isTrusted !== true) return "UNTRUSTED";
    if (typeof event.momentum !== "boolean") return "UNSUPPORTED";
    return event.momentum ? "MOMENTUM" : "PHYSICAL";
  }

  // Rising deltas alone are not evidence of a new physical gesture.
  Object.defineProperty(globalThis, API_NAME, {
    value: Object.freeze({ supported, phase }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
