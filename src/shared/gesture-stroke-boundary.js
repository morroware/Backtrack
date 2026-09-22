// @ts-check

(() => {
  "use strict";

  const API_NAME = "BacktrackGestureStrokeBoundary";
  if (Object.prototype.hasOwnProperty.call(globalThis, API_NAME)) return;

  const VALLEY_MAX_PX = 18;
  const RENEWED_PEAK_MIN_PX = 55;
  const MIN_RISE_PX = 6;
  const MIN_RISE_RATIO = 1.35;
  const REQUIRED_RISE_EVENTS = 3;

  function create() {
    return { valleySeen: false, previousMagnitude: null, risingEvents: 0 };
  }

  function observe(state, { deltaX, deltaY, eligibleInput }) {
    if (!eligibleInput || !Number.isFinite(deltaX) || !Number.isFinite(deltaY) ||
        Math.abs(deltaX) < Math.abs(deltaY) * 4) {
      state.risingEvents = 0;
      state.previousMagnitude = null;
      return false;
    }
    const magnitude = Math.abs(deltaX);
    if (magnitude <= VALLEY_MAX_PX) {
      state.valleySeen = true;
      state.previousMagnitude = magnitude;
      state.risingEvents = 0;
      return false;
    }
    if (!state.valleySeen) {
      state.previousMagnitude = magnitude;
      return false;
    }
    const previous = state.previousMagnitude;
    const rising = previous !== null &&
      magnitude - previous >= MIN_RISE_PX &&
      magnitude >= previous * MIN_RISE_RATIO;
    state.risingEvents = rising ? state.risingEvents + 1 : 0;
    state.previousMagnitude = magnitude;
    const confirmed = state.risingEvents >= REQUIRED_RISE_EVENTS &&
      magnitude >= RENEWED_PEAK_MIN_PX;
    if (confirmed) {
      state.valleySeen = false;
      state.previousMagnitude = magnitude;
      state.risingEvents = 0;
    }
    return confirmed;
  }

  Object.defineProperty(globalThis, API_NAME, {
    value: Object.freeze({ create, observe }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
