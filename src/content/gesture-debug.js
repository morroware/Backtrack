// @ts-check

(() => {
  "use strict";

  const API_NAME = "BacktrackGestureDebug";

  if (Object.prototype.hasOwnProperty.call(globalThis, API_NAME)) {
    return;
  }

  const VERSION = "0.7.3";
  const LOG_PREFIX = "[Backtrack:Gesture]";
  const SESSION_SUMMARY_PREFIX = "[Backtrack:Gesture:SessionJSON]";
  const THRESHOLD_SUMMARY_PREFIX = "[Backtrack:Gesture:ThresholdJSON]";
  const BUFFER_LIMIT = 2500;
  const DELTA_MODE_NAMES = Object.freeze({
    0: "PIXEL",
    1: "LINE",
    2: "PAGE",
  });
  const PREVENT_DEFAULT_MODES = new Set(["off", "horizontal", "all"]);
  const ROOT_OVERSCROLL_MODES = new Set(["unchanged", "contain", "none"]);
  const GESTURE_SETTINGS_KEY = "backtrack.gesture.settings";
  const GESTURE_SETTINGS_SCHEMA_VERSION = 2;
  const DIAGNOSTIC_MESSAGE_TYPES = Object.freeze({
    RECORD: "BACKTRACK_RECORD_GESTURE_DIAGNOSTIC",
    GET: "BACKTRACK_GET_DIAGNOSTIC_LOG",
    CLEAR: "BACKTRACK_CLEAR_DIAGNOSTIC_LOG",
  });
  const ACTION_FINISH_REASONS = new Set(["settled", "gap-before-next-event", "native-momentum"]);

  const classifier = globalThis.BacktrackGestureClassifier;
  const strokeBoundary = globalThis.BacktrackGestureStrokeBoundary;
  const visualPolicy = globalThis.BacktrackGestureVisualPolicy;
  const gestureIndicator = globalThis.BacktrackGestureIndicator ?? null;
  if (
    !classifier ||
    !strokeBoundary ||
    !visualPolicy ||
    (window === window.top && !gestureIndicator)
  ) {
    console.info(LOG_PREFIX, {
      kind: "initialization-error",
      reason: !classifier
        ? "GESTURE_CLASSIFIER_UNAVAILABLE"
        : !strokeBoundary
            ? "GESTURE_STROKE_BOUNDARY_UNAVAILABLE"
            : !visualPolicy
              ? "GESTURE_VISUAL_POLICY_UNAVAILABLE"
              : "GESTURE_INDICATOR_UNAVAILABLE",
    });
    return;
  }

  const DEFAULT_CONFIG = Object.freeze({
    settleMs: 220,
    minHorizontalDistancePx: 240,
    minHorizontalDominanceRatio: 4,
    minDirectionConsistency: 0.9,
    minEventCount: 8,
    minPeakHorizontalDeltaPx: 8,
    preventDefaultMode: "off",
    preventDefaultEventDominanceRatio: 1.25,
    logEveryWheelEvent: true,
  });

  /** @type {typeof DEFAULT_CONFIG} */
  let config = { ...DEFAULT_CONFIG };
  /** @type {Array<Record<string, unknown>>} */
  const logBuffer = [];
  /** @type {ReturnType<typeof createSession> | null} */
  let activeSession = null;
  /** @type {number | null} */
  let settleTimer = null;
  let logSequence = 0;
  let sessionSequence = 0;
  let listening = false;
  let automaticActionInFlight = false;
  let nativeMomentumSupported = strokeBoundary.supported(globalThis.WheelEvent);
  let lastInputPhase = null;
  let nativeRootBack = false;
  let pendingNativeRootBack = null;
  let lastRecordedGestureOwner = null;
  let ownershipRequestSequence = 0;
  let semanticSettingsLoaded = false;
  let lastCompletedSession = null;
  let semanticSettings = {
    schemaVersion: GESTURE_SETTINGS_SCHEMA_VERSION,
    backDirection: null,
    automaticActionsEnabled: false,
  };
  let requestedRootOverscrollMode = "unchanged";
  let appliedRootOverscrollMode = null;
  /** @type {{ value: string, priority: string } | null} */
  let rootOverscrollBackup = null;

  const frameContext = Object.freeze({
    instance: createFrameInstanceId(),
    kind: window === window.top ? "TOP" : "CHILD",
  });

  function createFrameInstanceId() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().slice(0, 8);
    }

    return Math.random().toString(36).slice(2, 10);
  }

  function round(value, digits = 2) {
    if (!Number.isFinite(value)) {
      return null;
    }

    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function record(kind, details = {}, level = "debug") {
    const entry = {
      schemaVersion: 1,
      sequence: ++logSequence,
      capturedAtMs: round(performance.now()),
      kind,
      frame: frameContext,
      ...details,
    };

    logBuffer.push(entry);
    if (logBuffer.length > BUFFER_LIMIT) {
      logBuffer.shift();
    }

    const logger = level === "info" ? console.info : console.debug;
    logger(LOG_PREFIX, entry);

    // Keep the detailed object log for interactive inspection, but also emit
    // completed sessions as plain JSON. DevTools shows this line in every
    // JavaScript context, so collecting a result does not depend on selecting
    // the extension's isolated execution context after a navigation.
    if (kind === "session-end") {
      console.info(SESSION_SUMMARY_PREFIX, JSON.stringify(entry));
    }

    // Native browser navigation can destroy the page before a gesture session
    // reaches its normal end. Persist the threshold snapshot as plain JSON as
    // well, so DevTools "Preserve log" keeps its scroll-context evidence.
    if (kind === "threshold-crossed") {
      console.info(THRESHOLD_SUMMARY_PREFIX, JSON.stringify(entry));
    }

    return entry;
  }

  function sendDiagnosticMessage(type, details = {}) {
    if (frameContext.kind !== "TOP") {
      return null;
    }
    try {
      const request = chrome.runtime.sendMessage({ type, ...details });
      if (request && typeof request.catch === "function") {
        request.catch(() => undefined);
      }
      return request;
    } catch {
      return null;
    }
  }

  function persistGestureSummary(summary) {
    const evaluation = summary?.evaluation;
    const measurements = evaluation?.measurements;
    // Do not retain ordinary vertical scrolling in the persistent diagnostic
    // ring. A small horizontal amount is enough to investigate a missed back
    // candidate without turning it into a record of every scroll.
    if (
      !summary?.actionTiming?.requested &&
      (!Number.isFinite(measurements?.netHorizontalDistancePx) ||
        measurements.netHorizontalDistancePx < 80)
    ) {
      return;
    }
    sendDiagnosticMessage(DIAGNOSTIC_MESSAGE_TYPES.RECORD, {
      diagnostic: {
        kind: "GESTURE_SESSION",
        gestureId: summary?.sessionId,
        endReason: summary?.reason?.toUpperCase().replaceAll("-", "_"),
        classification: evaluation?.classification,
        semanticDirection: evaluation?.semanticNavigationDirection,
        blockers: evaluation?.automaticAction?.blockers,
        netHorizontalDistancePx: measurements?.netHorizontalDistancePx,
        horizontalDominanceRatio: measurements?.horizontalDominanceRatio,
        directionConsistency: measurements?.directionConsistency,
        eventCount: measurements?.eventCount,
        peakHorizontalDeltaPx: measurements?.peakHorizontalDeltaPx,
        nativeMomentumSupported,
        physicalEventCount: summary?.eventCount,
        automaticActionRequested: summary?.actionTiming?.requested,
        automaticActionTrigger: summary?.actionTiming?.trigger,
        actionRequestedAfterMs: summary?.actionTiming?.requestedAfterMs,
      },
    });
  }

  function normalizeDeltas(event) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return {
        x: event.deltaX * 16,
        y: event.deltaY * 16,
        z: event.deltaZ * 16,
        approximate: true,
        factorDescription: "16px-per-line research approximation",
      };
    }

    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return {
        x: event.deltaX * window.innerWidth,
        y: event.deltaY * window.innerHeight,
        z: event.deltaZ * window.innerHeight,
        approximate: true,
        factorDescription: "viewport-per-page research approximation",
      };
    }

    return {
      x: event.deltaX,
      y: event.deltaY,
      z: event.deltaZ,
      approximate: false,
      factorDescription: "native CSS pixels",
    };
  }

  function describeElement(value) {
    let element = value;
    if (element instanceof Text) {
      element = element.parentElement;
    }

    if (!(element instanceof Element)) {
      return null;
    }

    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      direction: getComputedStyle(element).direction,
    };
  }

  function inspectHorizontalScroller(element, deltaX) {
    if (!(element instanceof Element)) {
      return null;
    }

    const style = getComputedStyle(element);
    const isViewportScroller = element === document.scrollingElement;
    const permitsUserScrolling =
      isViewportScroller || /^(auto|scroll|overlay)$/.test(style.overflowX);
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);

    if (!permitsUserScrolling || maxScrollLeft <= 1) {
      return null;
    }

    let canConsumeInDeltaDirection = null;
    if (style.direction === "ltr") {
      canConsumeInDeltaDirection =
        deltaX > 0
          ? element.scrollLeft < maxScrollLeft - 1
          : deltaX < 0
            ? element.scrollLeft > 1
            : false;
    }

    return {
      ...describeElement(element),
      isViewportScroller,
      overflowX: style.overflowX,
      scrollLeft: round(element.scrollLeft),
      maxScrollLeft: round(maxScrollLeft),
      canConsumeInDeltaDirection,
      safetyPolicy:
        canConsumeInDeltaDirection === true
          ? "BLOCK_SCROLL_CAN_CONSUME"
          : canConsumeInDeltaDirection === null
            ? "BLOCK_UNKNOWN_SCROLL_DIRECTION"
            : isViewportScroller
              ? "ALLOW_VIEWPORT_BOUNDARY"
              : "BLOCK_INNER_SCROLL_EDGE",
    };
  }

  function findHorizontalScrollContext(event, deltaX) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const visited = new Set();

    for (const item of path) {
      if (!(item instanceof Element) || visited.has(item)) {
        continue;
      }

      visited.add(item);
      const result = inspectHorizontalScroller(item, deltaX);
      if (result) {
        return result;
      }
    }

    const viewportScroller = document.scrollingElement;
    if (viewportScroller && !visited.has(viewportScroller)) {
      return inspectHorizontalScroller(viewportScroller, deltaX);
    }

    return null;
  }

  function readOptionalEventValue(event, propertyName) {
    if (!(propertyName in event)) {
      return null;
    }

    const value = Reflect.get(event, propertyName);
    if (["string", "number", "boolean"].includes(typeof value)) {
      return value;
    }

    return value == null ? null : String(value);
  }

  function createSession(now) {
    return {
      id: `${frameContext.instance}-${++sessionSequence}`,
      startedAtMs: now,
      startedAtEpochMs: Date.now(),
      lastEventAtMs: now,
      eventCount: 0,
      netX: 0,
      netY: 0,
      absoluteX: 0,
      absoluteY: 0,
      maxAbsoluteX: 0,
      maxAbsoluteY: 0,
      positiveX: 0,
      negativeX: 0,
      deltaModes: new Set(),
      cancelableCount: 0,
      nonCancelableCount: 0,
      preventDefaultAttemptCount: 0,
      preventDefaultSuccessCount: 0,
      downstreamPreventedCount: 0,
      nonPixelDeltaModeEventCount: 0,
      horizontalScrollerEventCount: 0,
      horizontalScrollerConsumableEventCount: 0,
      horizontalScrollerBoundaryEventCount: 0,
      horizontalScrollerUnknownEventCount: 0,
      innerScrollerBoundaryEventCount: 0,
      horizontalScrollerTags: new Set(),
      modifierEventCount: 0,
      untrustedEventCount: 0,
      thresholdReported: false,
      automaticActionRequested: false,
      automaticActionTrigger: null,
      automaticActionRequestedAtMs: null,
      startPosition: null,
      visualIndicatorShown: false,
      visualIndicatorPhase: "hidden",
    };
  }

  function directionFor(value) {
    return classifier.directionFor(value);
  }

  function candidateEvaluation(session) {
    return classifier.evaluate(session, {
      thresholds: config,
      backDirection: semanticSettings.backDirection,
      automaticActionsEnabled:
        semanticSettingsLoaded && semanticSettings.automaticActionsEnabled,
    });
  }

  function visualEvaluation(session) {
    return visualPolicy.evaluate(session, {
      backDirection: semanticSettings.backDirection,
      automaticActionsEnabled:
        semanticSettingsLoaded && semanticSettings.automaticActionsEnabled,
    });
  }

  function updateGestureIndicator(session, requestedPhase = null) {
    if (frameContext.kind !== "TOP" || !gestureIndicator) {
      return false;
    }

    const evaluation = visualEvaluation(session);
    if (!evaluation.eligible) {
      if (session.visualIndicatorShown) {
        gestureIndicator.hide();
        session.visualIndicatorShown = false;
        session.visualIndicatorPhase = "cancelled";
        record("gesture-indicator-hidden", {
          sessionId: session.id,
          blockers: evaluation.classification.automaticAction.blockers,
        });
      }
      return false;
    }

    const phase =
      requestedPhase === "armed" || candidateEvaluation(session).automaticAction.eligible
        ? "armed"
        : "tracking";
    const firstAppearance = !session.visualIndicatorShown;
    const phaseChanged = session.visualIndicatorPhase !== phase;
    gestureIndicator.update({
      progress: evaluation.progress,
      clientY: session.startPosition?.clientY,
      phase,
    });
    session.visualIndicatorShown = true;
    session.visualIndicatorPhase = phase;

    if (firstAppearance || phaseChanged) {
      record(firstAppearance ? "gesture-indicator-shown" : "gesture-indicator-phase", {
        sessionId: session.id,
        phase,
        progress: round(evaluation.progress),
      });
    }
    return true;
  }

  function createSessionSummary(
    session,
    reason,
    evaluation = candidateEvaluation(session),
  ) {
    return {
      sessionId: session.id,
      startedAtEpochMs: session.startedAtEpochMs,
      reason,
      durationMs: round(session.lastEventAtMs - session.startedAtMs),
      eventCount: session.eventCount,
      deltas: {
        netX: round(session.netX),
        netY: round(session.netY),
        absoluteX: round(session.absoluteX),
        absoluteY: round(session.absoluteY),
        maxAbsoluteX: round(session.maxAbsoluteX),
        maxAbsoluteY: round(session.maxAbsoluteY),
        positiveX: round(session.positiveX),
        negativeX: round(session.negativeX),
        modes: [...session.deltaModes],
      },
      cancellation: {
        cancelableCount: session.cancelableCount,
        nonCancelableCount: session.nonCancelableCount,
        preventDefaultMode: config.preventDefaultMode,
        attemptedCount: session.preventDefaultAttemptCount,
        successfulCount: session.preventDefaultSuccessCount,
        downstreamPreventedCount: session.downstreamPreventedCount,
      },
      context: {
        horizontalScrollerEventCount: session.horizontalScrollerEventCount,
        horizontalScrollerConsumableEventCount:
          session.horizontalScrollerConsumableEventCount,
        horizontalScrollerBoundaryEventCount:
          session.horizontalScrollerBoundaryEventCount,
        horizontalScrollerUnknownEventCount:
          session.horizontalScrollerUnknownEventCount,
        innerScrollerBoundaryEventCount:
          session.innerScrollerBoundaryEventCount,
        horizontalScrollerTags: [...session.horizontalScrollerTags],
        modifierEventCount: session.modifierEventCount,
        untrustedEventCount: session.untrustedEventCount,
        startPosition: session.startPosition,
      },
      momentum: {
        nativeMomentumSupported,
        physicalEventCount: session.eventCount,
      },
      nativeInput: {
        endReason: reason === "native-momentum" ? "NATIVE_MOMENTUM" :
          ["settled", "gap-before-next-event"].includes(reason) ? "INPUT_IDLE" : null,
        endedAtMs: Date.now(),
        physicalEventCount: session.eventCount,
      },
      actionTiming: {
        requested: session.automaticActionRequested,
        trigger: session.automaticActionTrigger,
        requestedAfterMs:
          session.automaticActionRequestedAtMs === null
            ? null
            : round(
                session.automaticActionRequestedAtMs - session.startedAtMs,
              ),
      },
      evaluation,
    };
  }

  function finishSession(reason = "manual") {
    if (!activeSession) {
      return null;
    }

    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    const session = activeSession;
    activeSession = null;
    const evaluation = candidateEvaluation(session);
    let summary = createSessionSummary(session, reason, evaluation);
    const shouldAttemptAutomaticAction =
      ACTION_FINISH_REASONS.has(reason) &&
      !session.automaticActionRequested &&
      summary.evaluation.automaticAction.eligible;

    // Mark the request before persisting, including release/idle commits.
    if (shouldAttemptAutomaticAction) {
      void maybePerformAutomaticAction(summary, session, "PHYSICAL_END");
      summary = createSessionSummary(session, reason, evaluation);
    }
    lastCompletedSession = summary;
    record("session-end", summary, "info");
    persistGestureSummary(summary);
    if (
      !shouldAttemptAutomaticAction &&
      !session.automaticActionRequested &&
      session.visualIndicatorShown
    ) {
      gestureIndicator?.hide();
      session.visualIndicatorShown = false;
      session.visualIndicatorPhase = "cancelled";
    }
    if (!shouldAttemptAutomaticAction) {
      applyPendingGestureOwnership();
    }
    return summary;
  }

  async function maybePerformAutomaticAction(summary, session, trigger) {
    if (
      frameContext.kind !== "TOP" ||
      !summary?.evaluation?.automaticAction?.eligible ||
      session?.automaticActionRequested ||
      automaticActionInFlight
    ) {
      return;
    }

    const root = document.documentElement;
    const computedRootMode = root
      ? getComputedStyle(root).overscrollBehaviorX
      : null;
    if (
      requestedRootOverscrollMode !== "contain" ||
      computedRootMode !== "contain"
    ) {
      record(
        "automatic-back-action-blocked",
        {
          sessionId: summary.sessionId,
          reason: "ROOT_OVERSCROLL_CONTAINMENT_NOT_CONFIRMED",
          requestedRootOverscrollMode,
          computedRootMode,
        },
        "info",
      );
      gestureIndicator?.hide();
      return;
    }

    const navigationStateApi = globalThis.BacktrackNavigationState;
    if (typeof navigationStateApi?.requestAutomaticBackAction !== "function") {
      record(
        "automatic-back-action-blocked",
        {
          sessionId: summary.sessionId,
          reason: "NAVIGATION_STATE_NOT_AVAILABLE",
        },
        "info",
      );
      gestureIndicator?.hide();
      return;
    }

    if (session) {
      session.automaticActionRequested = true;
      session.automaticActionTrigger = trigger;
      session.automaticActionRequestedAtMs = performance.now();
    }
    automaticActionInFlight = true;
    gestureIndicator?.commit();
    try {
      const response = await navigationStateApi.requestAutomaticBackAction({
        id: summary.sessionId,
        observedAtMs: summary.startedAtEpochMs,
        nativeInput: summary.nativeInput,
      });
      record(
        "automatic-back-action",
        { sessionId: summary.sessionId, response },
        "info",
      );
      if (
        response?.action !== "USE_INTERNAL_HISTORY" &&
        response?.action !== "USE_BROWSER_HISTORY" &&
        response?.action !== "CLOSED_TAB_TO_LEFT" &&
        response?.action !== "CLOSED_WINDOW"
      ) {
        gestureIndicator?.hide({ delayMs: 0 });
      }
    } catch {
      record(
        "automatic-back-action",
        {
          sessionId: summary.sessionId,
          response: {
            action: "NO_SPECIAL_ACTION",
            reason: "INTERNAL_ERROR",
          },
        },
        "info",
      );
      gestureIndicator?.hide({ delayMs: 0 });
    } finally {
      automaticActionInFlight = false;
      applyPendingGestureOwnership();
    }
  }

  function scheduleSessionFinish() {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
    }

    settleTimer = window.setTimeout(() => {
      finishSession("settled");
    }, config.settleMs);
  }

  function shouldPreventDefault(normalized) {
    if (config.preventDefaultMode === "all") {
      return true;
    }

    return (
      config.preventDefaultMode === "horizontal" &&
      Math.abs(normalized.x) > 0 &&
      Math.abs(normalized.x) >=
        Math.abs(normalized.y) * config.preventDefaultEventDominanceRatio
    );
  }

  function handleWheel(event) {
    // Leave input to Chromium only when browser-owned navigation is active.
    if (nativeRootBack) {
      return;
    }
    const now = performance.now();
    const normalized = normalizeDeltas(event);
    const phase = strokeBoundary.phase(event);
    if (phase === "UNTRUSTED") return;
    if (phase !== lastInputPhase) {
      lastInputPhase = phase;
      record("native-input-phase", { phase }, "info");
      sendDiagnosticMessage(DIAGNOSTIC_MESSAGE_TYPES.RECORD, {
        diagnostic: { kind: "GESTURE_INPUT", phase, nativeMomentumSupported },
      });
    }
    if (phase === "UNSUPPORTED") {
      nativeMomentumSupported = false;
      finishSession("unsupported-input");
      void refreshGestureOwnership();
      return;
    }
    if (phase === "MOMENTUM") {
      finishSession("native-momentum");
      return;
    }

    if (
      activeSession &&
      now - activeSession.lastEventAtMs >= config.settleMs
    ) {
      finishSession("gap-before-next-event");
    }

    if (nativeRootBack) {
      return;
    }

    if (!activeSession) {
      activeSession = createSession(now);
      record(
        "session-start",
        {
          sessionId: activeSession.id,
          config: { ...config },
        },
        "info",
      );
    }

    const session = activeSession;
    const previousEventAtMs =
      session.eventCount === 0 ? null : session.lastEventAtMs;
    const defaultPreventedBefore = event.defaultPrevented;
    if (defaultPreventedBefore) session.downstreamPreventedCount += 1;
    const preventDefaultAttempted = shouldPreventDefault(normalized);
    if (preventDefaultAttempted) {
      session.preventDefaultAttemptCount += 1;
      event.preventDefault();
      if (event.defaultPrevented) {
        session.preventDefaultSuccessCount += 1;
      }
    }

    const horizontalScrollContext = findHorizontalScrollContext(
      event,
      normalized.x,
    );
    const absoluteX = Math.abs(normalized.x);
    const absoluteY = Math.abs(normalized.y);

    session.eventCount += 1;
    session.lastEventAtMs = now;
    session.netX += normalized.x;
    session.netY += normalized.y;
    session.absoluteX += absoluteX;
    session.absoluteY += absoluteY;
    session.maxAbsoluteX = Math.max(session.maxAbsoluteX, absoluteX);
    session.maxAbsoluteY = Math.max(session.maxAbsoluteY, absoluteY);
    session.positiveX += Math.max(0, normalized.x);
    session.negativeX += Math.min(0, normalized.x);
    session.deltaModes.add(
      DELTA_MODE_NAMES[event.deltaMode] ?? `UNKNOWN_${event.deltaMode}`,
    );
    if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
      session.nonPixelDeltaModeEventCount += 1;
    }
    session.cancelableCount += event.cancelable ? 1 : 0;
    session.nonCancelableCount += event.cancelable ? 0 : 1;

    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
      session.modifierEventCount += 1;
    }
    if (!event.isTrusted) {
      session.untrustedEventCount += 1;
    }

    if (horizontalScrollContext) {
      session.horizontalScrollerEventCount += 1;
      session.horizontalScrollerTags.add(horizontalScrollContext.tag);
      if (horizontalScrollContext.canConsumeInDeltaDirection === true) {
        session.horizontalScrollerConsumableEventCount += 1;
      } else if (horizontalScrollContext.canConsumeInDeltaDirection === false) {
        session.horizontalScrollerBoundaryEventCount += 1;
        if (!horizontalScrollContext.isViewportScroller) {
          session.innerScrollerBoundaryEventCount += 1;
        }
      } else {
        session.horizontalScrollerUnknownEventCount += 1;
      }
    }

    if (!session.startPosition) {
      session.startPosition = {
        clientX: round(event.clientX),
        clientY: round(event.clientY),
        distanceFromLeftPx: round(event.clientX),
        distanceFromRightPx: round(window.innerWidth - event.clientX),
      };
    }

    const nativePhaseFields = {
      momentum: event.momentum,
      phase: readOptionalEventValue(event, "phase"),
      momentumPhase: readOptionalEventValue(event, "momentumPhase"),
      webkitMomentumPhase: readOptionalEventValue(event, "webkitMomentumPhase"),
    };

    const eventDetails = {
      sessionId: session.id,
      eventIndex: session.eventCount,
      sincePreviousEventMs:
        previousEventAtMs === null ? null : round(now - previousEventAtMs),
      raw: {
        deltaX: round(event.deltaX),
        deltaY: round(event.deltaY),
        deltaZ: round(event.deltaZ),
        deltaMode: event.deltaMode,
        deltaModeName: DELTA_MODE_NAMES[event.deltaMode] ?? "UNKNOWN",
      },
      normalized: {
        deltaX: round(normalized.x),
        deltaY: round(normalized.y),
        deltaZ: round(normalized.z),
        approximate: normalized.approximate,
        factorDescription: normalized.factorDescription,
      },
      shape: {
        dominantAxis:
          absoluteX > absoluteY ? "HORIZONTAL" : absoluteY > absoluteX ? "VERTICAL" : "EVEN",
        horizontalDirection: directionFor(normalized.x),
        horizontalToVerticalRatio:
          absoluteY === 0 ? null : round(absoluteX / absoluteY),
      },
      timing: {
        eventTimeStamp: round(event.timeStamp),
        nativePhaseFields,
        phaseNotice:
          "Native momentum events are excluded before gesture classification.",
      },
      cancellation: {
        cancelable: event.cancelable,
        defaultPreventedBefore,
        preventDefaultMode: config.preventDefaultMode,
        attempted: preventDefaultAttempted,
        defaultPreventedAfterOwnHandler: event.defaultPrevented,
      },
      input: {
        isTrusted: event.isTrusted,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      },
      position: {
        clientX: round(event.clientX),
        clientY: round(event.clientY),
        distanceFromLeftPx: round(event.clientX),
        distanceFromRightPx: round(window.innerWidth - event.clientX),
      },
      target: describeElement(event.target),
      horizontalScrollContext,
      legacyProbe: {
        wheelDelta: readOptionalEventValue(event, "wheelDelta"),
        wheelDeltaX: readOptionalEventValue(event, "wheelDeltaX"),
        wheelDeltaY: readOptionalEventValue(event, "wheelDeltaY"),
        webkitDirectionInvertedFromDevice: readOptionalEventValue(
          event,
          "webkitDirectionInvertedFromDevice",
        ),
      },
    };

    if (config.logEveryWheelEvent) {
      record("wheel", eventDetails);
    }

    const evaluation = candidateEvaluation(session);
    const thresholdOnlyBlockers = evaluation.blockers.filter((blocker) =>
      [
        "BELOW_MIN_HORIZONTAL_DISTANCE",
        "INSUFFICIENT_HORIZONTAL_DOMINANCE",
        "INCONSISTENT_HORIZONTAL_DIRECTION",
        "TOO_FEW_EVENTS",
        "PEAK_HORIZONTAL_DELTA_TOO_SMALL",
      ].includes(blocker),
    );
    if (!session.thresholdReported && thresholdOnlyBlockers.length === 0) {
      session.thresholdReported = true;
      const navigationStateApi = globalThis.BacktrackNavigationState;
      record(
        "threshold-crossed",
        {
          sessionId: session.id,
          provisionalDirection: directionFor(session.netX),
          semanticNavigationDirection:
            evaluation.semanticNavigationDirection,
          notice:
            "Physical input reached the threshold. Action waits for native momentum or input idle.",
          evaluation,
          navigationState:
            navigationStateApi?.getDiagnosticSnapshot?.() ?? {
              apiAvailable: false,
              reason: "NAVIGATION_STATE_NOT_AVAILABLE_IN_THIS_FRAME",
            },
        },
        "info",
      );
    }

    queueMicrotask(() => {
      const preventedBySomethingElse =
        event.defaultPrevented &&
        !defaultPreventedBefore &&
        !preventDefaultAttempted;

      if (preventedBySomethingElse) {
        session.downstreamPreventedCount += 1;
        record("post-dispatch-default-prevented", {
          sessionId: session.id,
          eventIndex: session.eventCount,
          notice: "A later page listener appears to have canceled this event.",
        });
      }
      if (activeSession === session && !session.automaticActionRequested) {
        updateGestureIndicator(session);
      }
    });

    scheduleSessionFinish();
  }

  function validateConfigPatch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("configure() expects an object.");
    }

    const next = { ...config };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_CONFIG)) {
        throw new TypeError(`Unknown configuration key: ${key}`);
      }

      if (key === "preventDefaultMode") {
        if (typeof value !== "string" || !PREVENT_DEFAULT_MODES.has(value)) {
          throw new TypeError(
            'preventDefaultMode must be "off", "horizontal", or "all".',
          );
        }
      } else if (key === "logEveryWheelEvent") {
        if (typeof value !== "boolean") {
          throw new TypeError("logEveryWheelEvent must be a boolean.");
        }
      } else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${key} must be a positive finite number.`);
      }

      Object.assign(next, { [key]: value });
    }

    return next;
  }

  function configure(patch) {
    finishSession("configuration-change");
    config = validateConfigPatch(patch);
    record("config-change", { config: { ...config } }, "info");
    return { ...config };
  }

  function applyRootOverscrollBehavior(mode) {
    if (!ROOT_OVERSCROLL_MODES.has(mode)) {
      throw new TypeError(
        'Root overscroll mode must be "unchanged", "contain", or "none".',
      );
    }

    const root = document.documentElement;
    requestedRootOverscrollMode = mode;
    if (!root) {
      document.addEventListener(
        "DOMContentLoaded",
        () => applyRootOverscrollBehavior(requestedRootOverscrollMode),
        { once: true },
      );
      return mode;
    }

    if (!rootOverscrollBackup) {
      rootOverscrollBackup = {
        value: root.style.getPropertyValue("overscroll-behavior-x"),
        priority: root.style.getPropertyPriority("overscroll-behavior-x"),
      };
    }

    if (mode === "unchanged") {
      const stillOwnsInlineValue =
        appliedRootOverscrollMode !== null &&
        root.style.getPropertyValue("overscroll-behavior-x") ===
          appliedRootOverscrollMode &&
        root.style.getPropertyPriority("overscroll-behavior-x") === "important";
      if (stillOwnsInlineValue) {
        if (rootOverscrollBackup.value) {
          root.style.setProperty(
            "overscroll-behavior-x",
            rootOverscrollBackup.value,
            rootOverscrollBackup.priority,
          );
        } else {
          root.style.removeProperty("overscroll-behavior-x");
        }
      }
      rootOverscrollBackup = null;
      appliedRootOverscrollMode = null;
    } else {
      root.style.setProperty("overscroll-behavior-x", mode, "important");
      appliedRootOverscrollMode = mode;
    }

    record(
      "root-overscroll-change",
      {
        requestedMode: mode,
        computedMode: getComputedStyle(root).overscrollBehaviorX,
        warning: "Controlled research toggle; restore with mode=unchanged.",
      },
      "info",
    );
    return mode;
  }

  function normalizeSemanticSettings(value) {
    const backDirection =
      value?.schemaVersion === GESTURE_SETTINGS_SCHEMA_VERSION &&
      (value?.backDirection === classifier.DIRECTIONS.POSITIVE_X ||
        value?.backDirection === classifier.DIRECTIONS.NEGATIVE_X)
        ? value.backDirection
        : null;
    return {
      schemaVersion: GESTURE_SETTINGS_SCHEMA_VERSION,
      backDirection,
      automaticActionsEnabled:
        backDirection !== null && value?.automaticActionsEnabled === true,
    };
  }

  function applyPendingGestureOwnership() {
    // Never release containment halfway through a movement or an action: that
    // could let Chromium and Backtrack act on the same movement.
    if (pendingNativeRootBack === null || activeSession || automaticActionInFlight) {
      return;
    }
    nativeRootBack = pendingNativeRootBack;
    pendingNativeRootBack = null;
    applyRootOverscrollBehavior(
      semanticSettings.automaticActionsEnabled && !nativeRootBack
        ? "contain"
        : "unchanged",
    );
    if (nativeRootBack) {
      gestureIndicator?.hide({ delayMs: 0 });
    }
    const owner = nativeRootBack ? "BROWSER" : "BACKTRACK";
    // Pages can become visible or emit a Navigation API update repeatedly.
    // One ownership record is useful; identical records would crowd out the
    // gesture that we actually need to diagnose.
    if (owner !== lastRecordedGestureOwner) {
      lastRecordedGestureOwner = owner;
      const reason = nativeRootBack ? "NATIVE_MOMENTUM_UNAVAILABLE" : "POSITIONAL_BACK";
      record("gesture-ownership", { owner, reason }, "info");
      sendDiagnosticMessage(DIAGNOSTIC_MESSAGE_TYPES.RECORD, {
        diagnostic: {
          kind: "GESTURE_OWNERSHIP",
          owner,
          reason,
        },
      });
    }
  }

  function refreshGestureOwnership() {
    if (frameContext.kind !== "TOP" || !semanticSettings.automaticActionsEnabled) {
      return;
    }
    // Backtrack owns Back on every ordinary page, including root tabs.
    // The background still refuses a close when the history boundary is unclear.
    ++ownershipRequestSequence;
    pendingNativeRootBack = !nativeMomentumSupported;
    applyPendingGestureOwnership();
  }

  function applySemanticSettings(value, source) {
    ++ownershipRequestSequence;
    pendingNativeRootBack = null;
    semanticSettings = normalizeSemanticSettings(value);
    semanticSettingsLoaded = true;
    if (frameContext.kind === "TOP") {
      nativeRootBack = semanticSettings.automaticActionsEnabled && !nativeMomentumSupported;
      applyRootOverscrollBehavior(
        semanticSettings.automaticActionsEnabled && !nativeRootBack ? "contain" : "unchanged",
      );
      void refreshGestureOwnership();
    }
    record(
      "semantic-settings-change",
      {
        source,
        settings: { ...semanticSettings },
        notice:
          semanticSettings.automaticActionsEnabled
            ? "Automatic back actions are enabled for the calibrated direction."
            : "Automatic back actions remain disabled.",
      },
      "info",
    );
    return { ...semanticSettings };
  }

  async function loadSemanticSettings() {
    try {
      const stored = await chrome.storage.local.get(GESTURE_SETTINGS_KEY);
      return applySemanticSettings(
        stored?.[GESTURE_SETTINGS_KEY],
        "storage-load",
      );
    } catch {
      return applySemanticSettings(null, "storage-load-failed");
    }
  }

  async function calibrateBackDirection(direction) {
    if (
      direction !== classifier.DIRECTIONS.POSITIVE_X &&
      direction !== classifier.DIRECTIONS.NEGATIVE_X
    ) {
      throw new TypeError(
        'Back direction must be "POSITIVE_X" or "NEGATIVE_X".',
      );
    }
    const next = normalizeSemanticSettings({
      schemaVersion: GESTURE_SETTINGS_SCHEMA_VERSION,
      backDirection: direction,
      automaticActionsEnabled: true,
    });
    await chrome.storage.local.set({ [GESTURE_SETTINGS_KEY]: next });
    return applySemanticSettings(next, "manual-calibration");
  }

  async function disableAutomaticActions() {
    const next = normalizeSemanticSettings({
      ...semanticSettings,
      automaticActionsEnabled: false,
    });
    await chrome.storage.local.set({ [GESTURE_SETTINGS_KEY]: next });
    return applySemanticSettings(next, "manual-disable");
  }

  async function clearCalibration() {
    await chrome.storage.local.remove(GESTURE_SETTINGS_KEY);
    return applySemanticSettings(null, "manual-calibration-clear");
  }

  function start() {
    if (listening) {
      return false;
    }

    window.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });
    listening = true;
    record(
      "listener-start",
      {
        version: VERSION,
        listener: { target: "window", capture: true, passive: false },
        config: { ...config },
        notice:
          "Automatic actions are disabled until a back direction is explicitly calibrated.",
      },
      "info",
    );
    return true;
  }

  function stop() {
    if (!listening) {
      return false;
    }

    finishSession("listener-stop");
    window.removeEventListener("wheel", handleWheel, { capture: true });
    listening = false;
    record("listener-stop", {}, "info");
    return true;
  }

  function clearLog() {
    finishSession("log-clear");
    logBuffer.length = 0;
    logSequence = 0;
    console.clear();
    record("log-cleared", {}, "info");
  }

  function previewIndicator(progress = 0.65, phase = "tracking") {
    if (frameContext.kind !== "TOP" || !gestureIndicator) {
      return false;
    }
    if (phase !== "tracking" && phase !== "armed") {
      throw new TypeError('Indicator phase must be "tracking" or "armed".');
    }
    return gestureIndicator.update({
      progress,
      clientY: window.innerHeight / 2,
      phase,
    });
  }

  function hideIndicator() {
    return gestureIndicator?.hide({ delayMs: 0 }) ?? false;
  }

  const api = Object.freeze({
    version: VERSION,
    getConfig: () => ({ ...config }),
    configure,
    getStatus: () => ({
      listening,
      frame: { ...frameContext },
      activeSessionId: activeSession?.id ?? null,
      lastCompletedSessionId: lastCompletedSession?.sessionId ?? null,
      automaticActionInFlight,
      nativeMomentumSupported,
      navigationOwner: nativeRootBack ? "BROWSER" : "BACKTRACK",
      semanticSettingsLoaded,
      semanticSettings: { ...semanticSettings },
      bufferedEntries: logBuffer.length,
      rootOverscrollMode: requestedRootOverscrollMode,
      gestureIndicator: gestureIndicator?.getStatus?.() ?? null,
    }),
    getSnapshot: () => structuredClone(logBuffer),
    exportJson: () => JSON.stringify(logBuffer, null, 2),
    finishSession,
    clearLog,
    getSemanticSettings: () => ({ ...semanticSettings }),
    getPersistentDiagnosticLog: async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: DIAGNOSTIC_MESSAGE_TYPES.GET,
        });
        return Array.isArray(response?.entries) ? response.entries : [];
      } catch {
        return [];
      }
    },
    clearPersistentDiagnosticLog: async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: DIAGNOSTIC_MESSAGE_TYPES.CLEAR,
        });
        return response?.cleared === true;
      } catch {
        return false;
      }
    },
    getPersistentDiagnosticReport: async () => {
      try {
        return await chrome.runtime.sendMessage({ type: "BACKTRACK_GET_DIAGNOSTIC_REPORT" });
      } catch {
        return { ok: false, reason: "EXTENSION_UNAVAILABLE" };
      }
    },
    calibrateBackDirection,
    disableAutomaticActions,
    clearCalibration,
    setRootOverscrollBehavior: applyRootOverscrollBehavior,
    previewIndicator,
    hideIndicator,
    start,
    stop,
  });

  Object.defineProperty(globalThis, API_NAME, {
    value: api,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  window.addEventListener(
    "pagehide",
    () => {
      finishSession("pagehide");
      gestureIndicator?.destroy();
    },
    { capture: true },
  );

  window.addEventListener("pageshow", () => void refreshGestureOwnership());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshGestureOwnership();
    } else {
      finishSession("tab-hidden");
      gestureIndicator?.hide({ delayMs: 0 });
    }
  });
  globalThis.navigation?.addEventListener("currententrychange", () => {
    void refreshGestureOwnership();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(GESTURE_SETTINGS_KEY in changes)) {
      return;
    }
    applySemanticSettings(
      changes[GESTURE_SETTINGS_KEY].newValue,
      "storage-change",
    );
  });

  start();
  void loadSemanticSettings();
})();
