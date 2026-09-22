const TAB_STORAGE_PREFIX = "backtrack.gesture.action-gate.tab.";
const WINDOW_STORAGE_PREFIX = "backtrack.gesture.action-gate.window.";

export const GESTURE_GATE_REASONS = Object.freeze({
  ACCEPTED: "ACCEPTED",
  INVALID_REQUEST: "INVALID_REQUEST",
  DUPLICATE_GESTURE: "DUPLICATE_GESTURE",
  MOMENTUM_CONTINUATION: "MOMENTUM_CONTINUATION",
});

function usableId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function tabStorageKey(tabId) {
  return `${TAB_STORAGE_PREFIX}${tabId}`;
}

function windowStorageKey(windowId) {
  return `${WINDOW_STORAGE_PREFIX}${windowId}`;
}

function validGestureId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

export class GestureActionGate {
  constructor(storageArea, stateRetentionMs = 10_000) {
    if (
      !storageArea ||
      typeof storageArea.get !== "function" ||
      typeof storageArea.set !== "function" ||
      typeof storageArea.remove !== "function"
    ) {
      throw new TypeError("GestureActionGate requires a storage area.");
    }
    if (!Number.isFinite(stateRetentionMs) || stateRetentionMs < 1000) {
      throw new TypeError(
        "GestureActionGate requires at least 1000 ms of gesture-state retention.",
      );
    }

    this.storageArea = storageArea;
    this.stateRetentionMs = stateRetentionMs;
    this.queues = new Map();
  }

  #enqueue(scopeKey, operation) {
    const previous = this.queues.get(scopeKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(scopeKey, next);
    const cleanup = () => {
      if (this.queues.get(scopeKey) === next) {
        this.queues.delete(scopeKey);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  claim(tabId, windowId, gesture, nowMs = Date.now()) {
    const safeTabId = usableId(tabId);
    const safeWindowId = usableId(windowId);
    const observedAtMs = gesture?.observedAtMs;
    if (
      safeTabId === null ||
      safeWindowId === null ||
      !validGestureId(gesture?.id) ||
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(nowMs) ||
      observedAtMs > nowMs + 1000 ||
      nowMs - observedAtMs > 10_000
    ) {
      return Promise.resolve({
        ok: false,
        reason: GESTURE_GATE_REASONS.INVALID_REQUEST,
      });
    }

    const tabKey = tabStorageKey(safeTabId);
    const windowKey = windowStorageKey(safeWindowId);
    return this.#enqueue(windowKey, async () => {
      const tabStored = await this.storageArea.get(tabKey);
      const windowStored = await this.storageArea.get(windowKey);
      const previousTab = tabStored?.[tabKey] ?? null;
      const previousWindow = windowStored?.[windowKey] ?? null;

      if (
        previousTab?.gestureId === gesture.id ||
        previousWindow?.gestureId === gesture.id
      ) {
        return {
          ok: false,
          reason: GESTURE_GATE_REASONS.DUPLICATE_GESTURE,
        };
      }
      for (const [scope, previous] of [
        ["TAB", previousTab],
        ["WINDOW", previousWindow],
      ]) {
        if (
          Number.isFinite(previous?.claimedAtMs) &&
          nowMs - previous.claimedAtMs < this.stateRetentionMs &&
          gesture?.freshStrokeEvidence !== true
        ) {
          return {
            ok: false,
            reason: GESTURE_GATE_REASONS.MOMENTUM_CONTINUATION,
            scope,
          };
        }
      }

      await this.storageArea.set({
        [tabKey]: {
          schemaVersion: 1,
          gestureId: gesture.id,
          claimedAtMs: nowMs,
          freshStrokeEvidence: gesture?.freshStrokeEvidence === true,
        },
        [windowKey]: {
          schemaVersion: 1,
          gestureId: gesture.id,
          claimedAtMs: nowMs,
          freshStrokeEvidence: gesture?.freshStrokeEvidence === true,
        },
      });
      return {
        ok: true,
        reason: GESTURE_GATE_REASONS.ACCEPTED,
        freshStrokeEvidence: gesture?.freshStrokeEvidence === true,
      };
    });
  }

  remove(tabId) {
    const safeTabId = usableId(tabId);
    if (safeTabId === null) {
      return Promise.resolve();
    }
    const key = tabStorageKey(safeTabId);
    return this.#enqueue(key, () => this.storageArea.remove(key));
  }

  removeWindow(windowId) {
    const safeWindowId = usableId(windowId);
    if (safeWindowId === null) {
      return Promise.resolve();
    }
    const key = windowStorageKey(safeWindowId);
    return this.#enqueue(key, () => this.storageArea.remove(key));
  }
}
