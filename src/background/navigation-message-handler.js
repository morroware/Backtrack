import { evaluateBackDecision } from "./back-decision.js";
import { performConfirmedBackAction } from "./tab-action.js";
import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  diagnosticOrigin, navigationDiagnostic, DEFAULT_ACTION_LIMIT, DEFAULT_DIAGNOSTIC_LOG_LIMIT,
} from "./diagnostic-log.js";
import { reviewDiagnosticLog } from "./diagnostic-review.js";

export function createNavigationMessageListener(
  tabsApi,
  navigationTracker,
  gestureActionGate = null,
  diagnosticLog = null,
  backNavigationLoopGuard = null,
  strategy = {
    evaluate: evaluateBackDecision,
    perform: performConfirmedBackAction,
  },
) {
  const recordDiagnostic = async (entry) => {
    try {
      await diagnosticLog?.record?.(entry);
    } catch {
      // Diagnostics are best effort and must never change navigation behavior.
    }
  };

  const senderDiagnostic = (sender) => ({
    tabId: sender?.tab?.id,
    windowId: sender?.tab?.windowId,
    documentId: sender?.documentId,
    origin: diagnosticOrigin(sender?.origin ?? sender?.url),
  });

  const actionDiagnostic = (sender, message, result, gateReason = null) => ({
    kind: "BACK_ACTION",
    recordedAtMs: Date.now(),
    ...senderDiagnostic(sender),
    source: message?.gesture?.source,
    action: result?.action,
    reason: result?.reason,
    decision: result?.decision?.decision,
    decisionReason: result?.decision?.reason,
    gateReason,
    retryAfterMs: result?.gestureGate?.retryAfterMs,
    openerTabId: result?.openerTabId ?? result?.decision?.opener?.openerTab?.id,
    targetTabId: result?.targetTabId,
    navigation: navigationDiagnostic(message?.snapshot),
  });

  return (message, sender, sendResponse) => {
    if (message?.type === MESSAGE_TYPES.NAVIGATION_SNAPSHOT) {
      if (sender?.frameId !== undefined && sender.frameId !== 0) {
        sendResponse({ ok: false });
        return false;
      }
      navigationTracker
        .recordSnapshot(sender?.tab?.id, message.snapshot, sender?.documentId)
        .then((state) => {
          sendResponse({ ok: state !== null });
          void recordDiagnostic({
            kind: "NAVIGATION_STATE", ...senderDiagnostic(sender),
            reason: state?.documentId && state.documentId !== sender?.documentId
              ? "STALE_DOCUMENT" : null,
            navigation: navigationDiagnostic(message.snapshot, state),
          });
        })
        .catch(() => {
          sendResponse({ ok: false });
          void recordDiagnostic({
            kind: "NAVIGATION_STATE", ...senderDiagnostic(sender), reason: "TRACKER_ERROR",
          });
        });
      return true;
    }

    if (message?.type === MESSAGE_TYPES.NAVIGATION_INTERACTION) {
      if (sender?.frameId !== 0) {
        sendResponse({ ok: false });
        return false;
      }
      navigationTracker.recordInteraction(sender?.tab?.id, sender?.documentId)
        .then((state) => {
          sendResponse({ ok: state !== null });
          void recordDiagnostic({
            kind: "NAVIGATION_STATE", ...senderDiagnostic(sender),
            event: "USER_INTERACTION", navigation: navigationDiagnostic(null, state),
          });
        })
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message?.type === MESSAGE_TYPES.GET_BACK_DECISION) {
      strategy.evaluate(
        sender?.tab,
        message.snapshot,
        tabsApi,
        navigationTracker,
      )
        .then(sendResponse)
        .catch(() =>
          sendResponse({
            decision: "NO_SPECIAL_ACTION",
            reason: "INTERNAL_ERROR",
            notice:
              "Decision evaluation only; no history or tab action was performed.",
          }),
        );
      return true;
    }

    if (message?.type === MESSAGE_TYPES.RECORD_GESTURE_DIAGNOSTIC) {
      recordDiagnostic({
        ...message.diagnostic,
        recordedAtMs: Date.now(),
        ...senderDiagnostic(sender),
      })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message?.type === MESSAGE_TYPES.GET_DIAGNOSTIC_REPORT) {
      Promise.resolve(diagnosticLog?.list?.() ?? []).then((entries) => sendResponse({
        ok: true, schemaVersion: 2, exportedAtMs: Date.now(),
        retention: { actions: DEFAULT_ACTION_LIMIT, context: DEFAULT_DIAGNOSTIC_LOG_LIMIT - DEFAULT_ACTION_LIMIT },
        storageError: diagnosticLog?.lastError ?? null,
        review: reviewDiagnosticLog(entries), entries,
      })).catch(() => sendResponse({ ok: false, reason: "STORAGE_UNAVAILABLE" }));
      return true;
    }

    if (message?.type === MESSAGE_TYPES.NAVIGATION_RESULT) {
      if (sender?.frameId !== 0) { sendResponse({ ok: false }); return false; }
      recordDiagnostic({
        kind: "NAVIGATION_RESULT", ...senderDiagnostic(sender),
        action: message.action,
        internalNavigationRequested: message.internalNavigationRequested,
        navigation: navigationDiagnostic(message.snapshot),
      }).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message?.type === MESSAGE_TYPES.GET_DIAGNOSTIC_LOG) {
      Promise.resolve(diagnosticLog?.list?.() ?? [])
        .then((entries) => sendResponse({ entries }))
        .catch(() => sendResponse({ entries: [] }));
      return true;
    }

    if (message?.type === MESSAGE_TYPES.CLEAR_DIAGNOSTIC_LOG) {
      Promise.resolve(diagnosticLog?.clear?.() ?? false)
        .then((cleared) => sendResponse({ cleared: cleared === true }))
        .catch(() => sendResponse({ cleared: false }));
      return true;
    }

    if (message?.type === MESSAGE_TYPES.PERFORM_CONFIRMED_BACK_ACTION) {
      const startedAtMs = Date.now();
      const logAction = (result, gateReason = null) => {
        // Storage is deliberately outside the navigation response's critical path.
        void recordDiagnostic({
          ...actionDiagnostic(sender, message, result, gateReason),
          durationMs: Date.now() - startedAtMs,
        });
        return result;
      };
      const runAction = async () => {
        if (sender?.frameId !== undefined && sender.frameId !== 0) {
          const result = {
            action: "NO_SPECIAL_ACTION",
            reason: "NOT_TOP_FRAME",
          };
          return logAction(result);
        }
        if (message?.gesture?.source === "AUTOMATIC") {
          if (!gestureActionGate) {
            const result = {
              action: "NO_SPECIAL_ACTION",
              reason: "GESTURE_GATE_UNAVAILABLE",
            };
            return logAction(result);
          }
          const claim = await gestureActionGate.claim(
            sender?.tab?.id,
            sender?.tab?.windowId,
            message.gesture,
          );
          if (!claim.ok) {
            const result = {
              action: "NO_SPECIAL_ACTION",
              reason: claim.reason === "DUPLICATE_GESTURE"
                ? "GESTURE_DEDUPLICATED"
                : claim.reason,
              gestureGate: claim,
            };
            return logAction(result, claim.reason);
          }
        } else if (message?.gesture?.source !== "MANUAL_DEVELOPMENT") {
          const result = {
            action: "NO_SPECIAL_ACTION",
            reason: "UNSUPPORTED_ACTION_SOURCE",
          };
          return logAction(result);
        }

        const result = await strategy.perform(
          sender?.tab,
          message.snapshot,
          tabsApi,
          navigationTracker,
        );
        if (
          message?.gesture?.source === "AUTOMATIC" &&
          result?.action === "USE_INTERNAL_HISTORY"
        ) {
          try {
            backNavigationLoopGuard?.recordAttempt?.({
              tabId: sender?.tab?.id,
              documentId: sender?.documentId,
              entryKey: message?.snapshot?.currentEntryKey,
              url: sender?.url,
            });
          } catch {
            // Losing correlation must only cause a safe missed loop detection.
          }
        }
        return logAction(result);
      };

      runAction()
        .then(sendResponse)
        .catch(() =>
          sendResponse(logAction({
            action: "NO_SPECIAL_ACTION",
            reason: "INTERNAL_ERROR",
          })),
        );
      return true;
    }

    return false;
  };
}
