export const DIAGNOSTIC_LOG_KEY = "backtrack.diagnostic.log";
export const DIAGNOSTIC_LOG_SCHEMA_VERSION = 2;
export const DEFAULT_DIAGNOSTIC_LOG_LIMIT = 2000;
export const DEFAULT_ACTION_LIMIT = 400;

const DIAGNOSTIC_KINDS = new Set([
  "GESTURE_SESSION",
  "GESTURE_INPUT",
  "BACK_ACTION",
  "GESTURE_OWNERSHIP",
  "NAVIGATION_STATE",
  "NAVIGATION_COMMIT",
  "NAVIGATION_RESULT",
  "TAB_EVENT",
  "RUNTIME_EVENT",
]);
const MAX_REASON_COUNT = 12;
const MAX_REASON_LENGTH = 96;

function usableId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function usableTime(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function roundedNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeToken(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REASON_LENGTH ||
    !/^[A-Z0-9_:-]+$/.test(value)
  ) {
    return null;
  }
  return value;
}

function safeTokens(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map(safeToken).filter(Boolean))].slice(
    0,
    MAX_REASON_COUNT,
  );
}

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function gestureId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[1-9][0-9]*$/.test(value)
    ? value : null;
}

export function diagnosticOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function opaqueKey(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

export function navigationDiagnostic(snapshot, state = null) {
  return {
    documentId: opaqueKey(state?.documentId),
    entryKey: opaqueKey(snapshot?.currentEntryKey),
    trackedEntryKey: opaqueKey(state?.currentEntryKey),
    baselineEntryKey: opaqueKey(state?.baselineEntryKey),
    openerTabId: usableId(state?.openerTabId),
    atBaseline: state?.baselineEntryKey && state?.currentEntryKey
      ? state.baselineEntryKey === state.currentEntryKey : null,
    trackingStatus: safeToken(state?.status),
    uncertaintyReason: safeToken(state?.uncertaintyReason),
    redirectPending: state ? Boolean(state.pendingRedirectDocumentId) : null,
    redirectEntry: optionalBoolean(state?.baselineFromInitialRedirect),
    initialRedirectChainOpen: optionalBoolean(state?.initialRedirectChainOpen),
    backRedirectLoopPending: state
      ? Boolean(state.pendingBackRedirectLoopDocumentId)
      : null,
    backRedirectLoopEntry: state
      ? Boolean(
        state.backRedirectLoopEntryKey &&
        state.backRedirectLoopEntryKey === state.currentEntryKey,
      )
      : null,
    apiAvailable: optionalBoolean(snapshot?.apiAvailable),
    canGoBack: optionalBoolean(snapshot?.sameOriginCanGoBack),
    historyLength: usableId(snapshot?.historyLength),
    navigationType: safeToken(snapshot?.navigationType?.toUpperCase?.()),
    transitionActive: optionalBoolean(snapshot?.transitionActive),
    hasUserActivation: optionalBoolean(snapshot?.hasUserActivation),
  };
}

function sanitizeNavigation(value) {
  if (!value || typeof value !== "object") return null;
  return {
    documentId: opaqueKey(value.documentId),
    entryKey: opaqueKey(value.entryKey),
    trackedEntryKey: opaqueKey(value.trackedEntryKey),
    baselineEntryKey: opaqueKey(value.baselineEntryKey),
    openerTabId: usableId(value.openerTabId),
    atBaseline: optionalBoolean(value.atBaseline),
    trackingStatus: safeToken(value.trackingStatus),
    uncertaintyReason: safeToken(value.uncertaintyReason),
    redirectPending: optionalBoolean(value.redirectPending),
    redirectEntry: optionalBoolean(value.redirectEntry),
    initialRedirectChainOpen: optionalBoolean(value.initialRedirectChainOpen),
    backRedirectLoopPending: optionalBoolean(value.backRedirectLoopPending),
    backRedirectLoopEntry: optionalBoolean(value.backRedirectLoopEntry),
    apiAvailable: optionalBoolean(value.apiAvailable),
    canGoBack: optionalBoolean(value.canGoBack),
    historyLength: usableId(value.historyLength),
    navigationType: safeToken(value.navigationType),
    transitionActive: optionalBoolean(value.transitionActive),
    hasUserActivation: optionalBoolean(value.hasUserActivation),
  };
}

/**
 * Keep the persistent development log intentionally incapable of containing
 * full page URLs, titles, text, raw input, or arbitrary page-provided data.
 * Development logging includes origins and opaque history/document UUIDs.
 */
export function sanitizeDiagnosticEntry(value, fallbackTime = Date.now()) {
  const kind = safeToken(value?.kind);
  if (!DIAGNOSTIC_KINDS.has(kind)) {
    return null;
  }

  const entry = {
    schemaVersion: DIAGNOSTIC_LOG_SCHEMA_VERSION,
    recordedAtMs: usableTime(value?.recordedAtMs, fallbackTime),
    kind,
    tabId: usableId(value?.tabId),
    windowId: usableId(value?.windowId),
    origin: diagnosticOrigin(value?.origin),
    version: typeof value?.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version)
      ? value.version : null,
    documentId: opaqueKey(value?.documentId),
  };

  if (kind === "GESTURE_SESSION") {
    return {
      ...entry,
      gestureId: gestureId(value?.gestureId),
      endReason: safeToken(value?.endReason),
      classification: safeToken(value?.classification),
      semanticDirection: safeToken(value?.semanticDirection),
      blockers: safeTokens(value?.blockers),
      netHorizontalDistancePx: roundedNumber(value?.netHorizontalDistancePx),
      horizontalDominanceRatio: roundedNumber(value?.horizontalDominanceRatio),
      directionConsistency: roundedNumber(value?.directionConsistency, 4),
      eventCount: usableId(value?.eventCount),
      peakHorizontalDeltaPx: roundedNumber(value?.peakHorizontalDeltaPx),
      freshStrokeEvidence: optionalBoolean(value?.freshStrokeEvidence),
      nativeMomentumSupported: optionalBoolean(value?.nativeMomentumSupported),
      physicalEventCount: usableId(value?.physicalEventCount),
      automaticActionRequested: optionalBoolean(value?.automaticActionRequested),
      automaticActionTrigger: safeToken(value?.automaticActionTrigger),
      actionRequestedAfterMs: roundedNumber(value?.actionRequestedAfterMs),
    };
  }

  if (kind === "BACK_ACTION") {
    return {
      ...entry,
      gestureId: gestureId(value?.gestureId),
      inputEndReason: safeToken(value?.inputEndReason),
      physicalEventCount: usableId(value?.physicalEventCount),
      source: safeToken(value?.source),
      action: safeToken(value?.action),
      reason: safeToken(value?.reason),
      decision: safeToken(value?.decision),
      decisionReason: safeToken(value?.decisionReason),
      gateReason: safeToken(value?.gateReason),
      durationMs: roundedNumber(value?.durationMs),
      retryAfterMs: roundedNumber(value?.retryAfterMs),
      openerTabId: usableId(value?.openerTabId),
      targetTabId: usableId(value?.targetTabId),
      navigation: sanitizeNavigation(value?.navigation),
    };
  }

  if (kind === "GESTURE_INPUT") return {
    ...entry,
    phase: safeToken(value?.phase),
    nativeMomentumSupported: optionalBoolean(value?.nativeMomentumSupported),
  };

  if (kind === "GESTURE_OWNERSHIP") return {
    ...entry,
    owner: safeToken(value?.owner),
    reason: safeToken(value?.reason),
  };

  return {
    ...entry,
    event: safeToken(value?.event),
    reason: safeToken(value?.reason),
    openerTabId: usableId(value?.openerTabId),
    navigation: sanitizeNavigation(value?.navigation),
    transitionType: safeToken(value?.transitionType),
    transitionQualifiers: safeTokens(value?.transitionQualifiers),
    internalNavigationRequested: optionalBoolean(value?.internalNavigationRequested),
    action: safeToken(value?.action),
  };
}

function storedEntries(value) {
  if (!Array.isArray(value?.entries)) {
    return [];
  }
  return value.entries
    .map((entry) => sanitizeDiagnosticEntry(entry, entry?.recordedAtMs))
    .filter(Boolean);
}

export class DiagnosticLog {
  constructor(storageArea, limit = DEFAULT_DIAGNOSTIC_LOG_LIMIT, now = Date.now, version = null) {
    if (
      !storageArea ||
      typeof storageArea.get !== "function" ||
      typeof storageArea.set !== "function" ||
      typeof storageArea.remove !== "function"
    ) {
      throw new TypeError("DiagnosticLog requires storage get(), set(), and remove().");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) {
      throw new TypeError("DiagnosticLog limit must be an integer from 1 to 2000.");
    }
    if (typeof now !== "function") {
      throw new TypeError("DiagnosticLog requires a clock function.");
    }
    this.storageArea = storageArea;
    this.limit = limit;
    this.now = now;
    this.version = version;
    this.queue = Promise.resolve();
    this.lastError = null;
  }

  #retained(entries) {
    // Keep actions independently: a busy page must not evict their evidence.
    if (this.limit !== DEFAULT_DIAGNOSTIC_LOG_LIMIT) return entries.slice(-this.limit);
    let actions = 0;
    let context = 0;
    return [...entries].reverse().filter((entry) =>
      entry.kind === "BACK_ACTION"
        ? ++actions <= DEFAULT_ACTION_LIMIT
        : ++context <= this.limit - DEFAULT_ACTION_LIMIT,
    ).reverse();
  }

  #enqueue(operation) {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.catch(() => { this.lastError = "STORAGE_UNAVAILABLE"; });
    return next;
  }

  record(value) {
    const entry = sanitizeDiagnosticEntry({ ...value, version: this.version ?? value?.version }, this.now());
    if (!entry) {
      return Promise.resolve(null);
    }
    return this.#enqueue(async () => {
      const stored = await this.storageArea.get(DIAGNOSTIC_LOG_KEY);
      const previous = storedEntries(stored?.[DIAGNOSTIC_LOG_KEY]);
      if (entry.kind === "NAVIGATION_STATE") {
        const last = previous.findLast(item => item.kind === entry.kind && item.tabId === entry.tabId);
        if (last && last.documentId === entry.documentId && last.origin === entry.origin &&
          last.version === entry.version && last.reason === entry.reason &&
          JSON.stringify(last.navigation) === JSON.stringify(entry.navigation)) return null;
      }
      const entries = this.#retained([...previous, entry]);
      await this.storageArea.set({
        [DIAGNOSTIC_LOG_KEY]: {
          schemaVersion: DIAGNOSTIC_LOG_SCHEMA_VERSION,
          entries,
        },
      });
      this.lastError = null;
      return structuredClone(entry);
    });
  }

  list() {
    return this.#enqueue(async () => {
      const stored = await this.storageArea.get(DIAGNOSTIC_LOG_KEY);
      return structuredClone(this.#retained(storedEntries(stored?.[DIAGNOSTIC_LOG_KEY])));
    });
  }

  clear() {
    return this.#enqueue(async () => {
      await this.storageArea.remove(DIAGNOSTIC_LOG_KEY);
      this.lastError = null;
      return true;
    });
  }
}
