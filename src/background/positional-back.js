import { NAVIGATION_AVAILABILITY, NAVIGATION_REASONS } from "./navigation-tracker.js";

export const POSITION_DECISIONS = Object.freeze({
  USE_INTERNAL_HISTORY: "USE_INTERNAL_HISTORY",
  CLOSE_POSITION_ELIGIBLE: "CLOSE_POSITION_ELIGIBLE",
  NO_SPECIAL_ACTION: "NO_SPECIAL_ACTION",
});

export const POSITION_ACTIONS = Object.freeze({
  USE_INTERNAL_HISTORY: "USE_INTERNAL_HISTORY",
  USE_BROWSER_HISTORY: "USE_BROWSER_HISTORY",
  CLOSED_TAB_TO_LEFT: "CLOSED_TAB_TO_LEFT",
  CLOSED_WINDOW: "CLOSED_WINDOW",
  NO_SPECIAL_ACTION: "NO_SPECIAL_ACTION",
});

const id = (value) => Number.isInteger(value) && value >= 0 ? value : null;

// The target event can corroborate a link-opened tab even when openerTabId is
// absent. Store only that fact; the source tab is never the return target.
export async function markLinkOpenedByNavigationTarget(details, tabsApi, tracker) {
  const tabId = id(details?.tabId);
  const sourceId = id(details?.sourceTabId);
  if (tabId === null || sourceId === null || tabId === sourceId) {
    return { ok: false, reason: "INVALID_NAVIGATION_TARGET" };
  }
  const [target, source] = await Promise.all([
    readTab(tabsApi, tabId), readTab(tabsApi, sourceId),
  ]);
  if (!target || !source || id(target.windowId) === null ||
      target.windowId !== source.windowId ||
      (target.incognito === true) !== (source.incognito === true) ||
      (id(target.openerTabId) !== null && target.openerTabId !== sourceId)) {
    return { ok: false, reason: "NAVIGATION_TARGET_NOT_CONFIRMED" };
  }
  const state = await tracker.beginPosition(target, true);
  return state?.createdFromTab === true
    ? { ok: true, reason: "LINK_OPENED_CONFIRMED" }
    : { ok: false, reason: "TRACKING_UNAVAILABLE" };
}

export async function evaluatePositionalBackDecision(currentTab, snapshot, tracker) {
  const tabId = id(currentTab?.id);
  if (tabId === null) {
    return { decision: POSITION_DECISIONS.NO_SPECIAL_ACTION, reason: "INVALID_TAB" };
  }

  const navigation = await tracker.assess(tabId, snapshot);
  if (navigation.availability === NAVIGATION_AVAILABILITY.INTERNAL_BACK_AVAILABLE) {
    return { decision: POSITION_DECISIONS.USE_INTERNAL_HISTORY,
      reason: navigation.reason, navigation };
  }
  if (navigation.availability === NAVIGATION_AVAILABILITY.AT_ENTRY_POINT) {
    return { decision: POSITION_DECISIONS.CLOSE_POSITION_ELIGIBLE,
      reason: navigation.reason, navigation };
  }

  // A tab already open when the extension started has no captured entry point.
  // Only the independent combination of a one-entry browser history and a
  // complete Navigation API snapshot can establish that there is no Back step.
  if (navigation.reason === NAVIGATION_REASONS.NOT_TRACKED &&
      snapshot?.apiAvailable === true &&
      typeof snapshot.currentEntryKey === "string" &&
      snapshot.currentEntryKey.length > 0 &&
      snapshot.historyLength === 1 &&
      snapshot.sameOriginCanGoBack === false &&
      snapshot.transitionActive === false) {
    return { decision: POSITION_DECISIONS.CLOSE_POSITION_ELIGIBLE,
      reason: "UNTRACKED_SINGLE_ENTRY", navigation };
  }

  return { decision: POSITION_DECISIONS.NO_SPECIAL_ACTION,
    reason: navigation.reason, navigation };
}

async function readTab(tabsApi, tabId) {
  try { return await tabsApi.get(tabId); } catch { return null; }
}

function matchesSender(live, sender) {
  return live?.id === sender?.id && live?.windowId === sender?.windowId &&
    (live?.incognito === true) === (sender?.incognito === true) &&
    live?.discarded !== true;
}

function noAction(reason, decision, extra = {}) {
  return { action: POSITION_ACTIONS.NO_SPECIAL_ACTION, reason, decision, ...extra };
}

async function restoreFocus(tabsApi, tabId, windowId) {
  const tab = await readTab(tabsApi, tabId);
  if (tab?.windowId !== windowId) return false;
  try { return (await tabsApi.update(tabId, { active: true }))?.active === true; }
  catch { return false; }
}

async function entryStillEligible(senderTab, snapshot, tracker, firstDecision) {
  try {
    const latest = await evaluatePositionalBackDecision(senderTab, snapshot, tracker);
    return latest.decision === POSITION_DECISIONS.CLOSE_POSITION_ELIGIBLE &&
      latest.reason === firstDecision.reason;
  } catch {
    return false;
  }
}

export async function performPositionalBackAction(
  senderTab, snapshot, tabsApi, windowsApi, tracker,
) {
  const decision = await evaluatePositionalBackDecision(senderTab, snapshot, tracker);
  if (snapshot?.transitionActive === true ||
      decision.reason === NAVIGATION_REASONS.NAVIGATION_IN_PROGRESS) {
    return noAction("NAVIGATION_IN_PROGRESS", decision);
  }

  const tabId = id(senderTab?.id);
  const windowId = id(senderTab?.windowId);
  if (tabId === null || windowId === null) {
    return noAction("CURRENT_TAB_UNAVAILABLE", decision);
  }
  const current = await readTab(tabsApi, tabId);
  if (!matchesSender(current, senderTab)) return noAction("CURRENT_TAB_CHANGED", decision);
  if (current.active !== true) return noAction("CURRENT_TAB_NOT_ACTIVE", decision);

  if (decision.decision !== POSITION_DECISIONS.CLOSE_POSITION_ELIGIBLE) {
    const tracked = decision.decision === POSITION_DECISIONS.USE_INTERNAL_HISTORY;
    return {
      action: tracked ? POSITION_ACTIONS.USE_INTERNAL_HISTORY : POSITION_ACTIONS.USE_BROWSER_HISTORY,
      reason: tracked ? "INTERNAL_HISTORY_AVAILABLE" : "BROWSER_HISTORY_FALLBACK",
      decision,
    };
  }

  if (current.pinned === true) return noAction("CURRENT_TAB_PINNED", decision);
  let windowInfo;
  let tabs;
  try {
    [windowInfo, tabs] = await Promise.all([
      windowsApi.get(windowId), tabsApi.query({ windowId }),
    ]);
  } catch {
    return noAction("WINDOW_UNAVAILABLE", decision);
  }
  if (windowInfo?.id !== windowId || windowInfo.type !== "normal" ||
      windowInfo.focused !== true || !Array.isArray(tabs)) {
    return noAction("WINDOW_CHANGED", decision);
  }

  const ordered = tabs.filter(tab => tab.windowId === windowId &&
    id(tab.id) !== null && id(tab.index) !== null)
    .sort((a, b) => a.index - b.index);
  const currentIndex = ordered.findIndex(tab => tab.id === tabId);
  if (currentIndex < 0 || ordered[currentIndex].index !== current.index ||
      ordered[currentIndex].active !== true || ordered.length !== tabs.length) {
    return noAction("TAB_ORDER_CHANGED", decision);
  }

  if (currentIndex === 0) {
    if (ordered.length !== 1) return noAction("NO_LEFT_TAB", decision);
    let lastWindow;
    let lastTabs;
    try {
      [lastWindow, lastTabs] = await Promise.all([
        windowsApi.get(windowId), tabsApi.query({ windowId }),
      ]);
    } catch { return noAction("WINDOW_CHANGED", decision); }
    const lastCheck = await readTab(tabsApi, tabId);
    if (!matchesSender(lastCheck, senderTab) || lastCheck.active !== true ||
        lastCheck.pinned === true || lastCheck.index !== current.index ||
        lastWindow?.id !== windowId || lastWindow.type !== "normal" ||
        lastWindow.focused !== true || lastTabs?.length !== 1 ||
        lastTabs[0]?.id !== tabId) return noAction("CURRENT_TAB_CHANGED", decision);
    if (!await entryStillEligible(senderTab, snapshot, tracker, decision)) {
      return noAction("ENTRY_CHANGED_BEFORE_CLOSE", decision);
    }
    try {
      await windowsApi.remove(windowId);
      return { action: POSITION_ACTIONS.CLOSED_WINDOW,
        reason: "LAST_TAB_WINDOW_CLOSED", decision, windowId };
    } catch { return noAction("WINDOW_CLOSE_FAILED", decision); }
  }

  const left = ordered[currentIndex - 1];
  const beforeFocus = await readTab(tabsApi, tabId);
  if (!matchesSender(beforeFocus, senderTab) || beforeFocus.active !== true ||
      beforeFocus.index !== current.index) {
    return noAction("CURRENT_TAB_CHANGED", decision);
  }
  let activated;
  try { activated = await tabsApi.update(left.id, { active: true }); }
  catch { return noAction("LEFT_TAB_ACTIVATION_FAILED", decision); }
  if (activated?.id !== left.id || activated?.windowId !== windowId ||
      activated?.active !== true) {
    const focusRestored = await restoreFocus(tabsApi, tabId, windowId);
    return noAction("LEFT_TAB_ACTIVATION_UNCONFIRMED", decision, { focusRestored });
  }

  const [tabBeforeClose, leftBeforeClose] = await Promise.all([
    readTab(tabsApi, tabId), readTab(tabsApi, left.id),
  ]);
  if (!matchesSender(tabBeforeClose, senderTab) ||
      tabBeforeClose.pinned === true ||
      tabBeforeClose.index !== current.index ||
      leftBeforeClose?.windowId !== windowId ||
      leftBeforeClose?.index !== left.index ||
      leftBeforeClose?.active !== true) {
    const focusRestored = await restoreFocus(tabsApi, tabId, windowId);
    return noAction("POST_ACTIVATION_VALIDATION_FAILED", decision, { focusRestored });
  }
  if (!await entryStillEligible(senderTab, snapshot, tracker, decision)) {
    const focusRestored = await restoreFocus(tabsApi, tabId, windowId);
    return noAction("ENTRY_CHANGED_BEFORE_CLOSE", decision, { focusRestored });
  }

  try { await tabsApi.remove(tabId); }
  catch {
    const focusRestored = await restoreFocus(tabsApi, tabId, windowId);
    return noAction("TAB_CLOSE_FAILED", decision, { focusRestored });
  }
  return { action: POSITION_ACTIONS.CLOSED_TAB_TO_LEFT,
    reason: "CLOSED_TAB_TO_LEFT", decision, tabId, targetTabId: left.id };
}
