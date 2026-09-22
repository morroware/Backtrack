import { createOpenerMessageListener } from "./opener-message-handler.js";
import { createNavigationMessageListener } from "./navigation-message-handler.js";
import { GestureActionGate } from "./gesture-action-gate.js";
import { NavigationTracker } from "./navigation-tracker.js";
import {
  evaluatePositionalBackDecision, markLinkOpenedByNavigationTarget,
  performPositionalBackAction,
} from "./positional-back.js";
import { DiagnosticLog, diagnosticOrigin, navigationDiagnostic } from "./diagnostic-log.js";
import { BackNavigationLoopGuard } from "./back-navigation-loop-guard.js";

const navigationTracker = new NavigationTracker(chrome.storage.session);
const gestureActionGate = new GestureActionGate(chrome.storage.session);
const backNavigationLoopGuard = new BackNavigationLoopGuard();
const diagnosticLog = new DiagnosticLog(
  chrome.storage.local, undefined, Date.now, chrome.runtime.getManifest().version,
);
const recordDiagnostic = (entry) => { void diagnosticLog.record(entry).catch(() => undefined); };

recordDiagnostic({ kind: "RUNTIME_EVENT", event: "WORKER_STARTED" });
chrome.runtime.onStartup.addListener(() => recordDiagnostic({ kind: "RUNTIME_EVENT", event: "BROWSER_STARTED" }));
chrome.runtime.onInstalled.addListener((details) => recordDiagnostic({
  kind: "RUNTIME_EVENT", event: "EXTENSION_INSTALLED_OR_UPDATED", reason: details.reason?.toUpperCase(),
}));

chrome.runtime.onMessage.addListener(
  createOpenerMessageListener(chrome.tabs),
);
chrome.runtime.onMessage.addListener(
  createNavigationMessageListener(
    chrome.tabs,
    navigationTracker,
    gestureActionGate,
    diagnosticLog,
    backNavigationLoopGuard,
    {
      evaluate: (tab, snapshot, _tabs, tracker) =>
        evaluatePositionalBackDecision(tab, snapshot, tracker),
      perform: (tab, snapshot, tabs, tracker) =>
        performPositionalBackAction(tab, snapshot, tabs, chrome.windows, tracker),
    },
  ),
);

chrome.tabs.onCreated.addListener((tab) => {
  recordDiagnostic({
    kind: "TAB_EVENT", event: "CREATED", tabId: tab.id, windowId: tab.windowId,
    openerTabId: tab.openerTabId,
  });
  void navigationTracker
    .beginPosition(tab)
    .catch(() => {
      recordDiagnostic({
        kind: "TAB_EVENT", event: "POSITION_TRACKING_FAILED", tabId: tab.id,
        windowId: tab.windowId, reason: "INTERNAL_ERROR",
      });
    });
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void markLinkOpenedByNavigationTarget(details, chrome.tabs, navigationTracker)
    .then(result => recordDiagnostic({
      kind: "TAB_EVENT", event: "NAVIGATION_TARGET", tabId: details.tabId,
      openerTabId: details.sourceTabId, reason: result.reason,
    }))
    .catch(() => recordDiagnostic({
      kind: "TAB_EVENT", event: "NAVIGATION_TARGET", tabId: details.tabId,
      reason: "TRACKER_ERROR",
    }));
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const loopEvidence = backNavigationLoopGuard.consumeCommit(details);
  // The development log retains only the origin, never a full event URL.
  const diagnostic = {
    kind: "NAVIGATION_COMMIT", tabId: details.tabId, documentId: details.documentId,
    origin: diagnosticOrigin(details.url),
    transitionType: details.transitionType?.toUpperCase(),
    transitionQualifiers: details.transitionQualifiers?.map(value => value.toUpperCase()),
  };
  void navigationTracker.recordDocumentCommit({
    tabId: details.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
    documentLifecycle: details.documentLifecycle,
    transitionType: details.transitionType,
    transitionQualifiers: details.transitionQualifiers,
    backRedirectLoop: loopEvidence.detected,
    backAttemptEntryKey: loopEvidence.attemptedEntryKey,
  }).then(state => recordDiagnostic({
    ...diagnostic,
    event: loopEvidence.detected
      ? state?.pendingBackRedirectLoopDocumentId === details.documentId
        ? "BACK_REDIRECT_LOOP_DETECTED"
        : "BACK_REDIRECT_LOOP_REJECTED"
      : null,
    navigation: navigationDiagnostic(null, state),
  })).catch(() => recordDiagnostic({ ...diagnostic, reason: "TRACKER_ERROR" }));
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  recordDiagnostic({ kind: "TAB_EVENT", event: "REMOVED", tabId, windowId: info.windowId });
  void navigationTracker.remove(tabId);
  void gestureActionGate.remove(tabId);
  backNavigationLoopGuard.remove(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  recordDiagnostic({ kind: "TAB_EVENT", event: "REPLACED", tabId: removedTabId });
  void navigationTracker.remove(removedTabId);
  void navigationTracker.remove(addedTabId);
  void gestureActionGate.remove(removedTabId);
  void gestureActionGate.remove(addedTabId);
  backNavigationLoopGuard.remove(removedTabId);
  backNavigationLoopGuard.remove(addedTabId);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  recordDiagnostic({ kind: "TAB_EVENT", event: "ACTIVATED", tabId, windowId });
});
chrome.tabs.onDetached.addListener((tabId, info) => {
  recordDiagnostic({ kind: "TAB_EVENT", event: "DETACHED", tabId, windowId: info.oldWindowId });
});
chrome.tabs.onAttached.addListener((tabId, info) => {
  recordDiagnostic({ kind: "TAB_EVENT", event: "ATTACHED", tabId, windowId: info.newWindowId });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void gestureActionGate.removeWindow(windowId);
});
