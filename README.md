# Backtrack

Backtrack is a Manifest V3 extension for Brave on macOS. A calibrated
two-finger Back gesture moves through a page's own history first. At the
beginning of that tab's history, the next gesture closes the tab and selects
the immediately adjacent tab on its left. If it was the only tab, Backtrack
closes **that browser window**, not the Brave application or any other window.

```text
One window:  A | B | C
Back at C's entry  → close C, select B
Back at B's entry  → close B, select A
Back at A's entry  → close this window; Brave remains in the macOS Dock
```

Tab position, not `openerTabId`, defines the return target in version 0.7.3.
When Chromium reports an opener or a matching new-navigation target, it is
used only as evidence that the new tab started from a link; it is not
required to select the left-hand tab.
Manually opened tabs are included. Internal page-history steps always come
before tab closure. Incomplete or contradictory history evidence never
authorizes closure.

The source, documentation, tests, and development interface are in English.
There are no dependencies, build tools, servers, analytics, or accounts.

## Status

Development version **0.7.3** implements positional Back, an explicit
last-tab window close, and browser-reported separation of physical input from
trackpad inertia. It replaces the unreliable acceleration heuristic in 0.7.2.
All 262 automated tests pass. A physical Brave/macOS regression on September
22 confirmed child closure followed by immediate Back in the previous tab,
without a repeated attempt or momentum-gate rejection. This is a focused fix
verification, not a broad compatibility claim for every site or trackpad.

This changes the previous safety rule: a manually opened tab with no Back
history can now close on a Back gesture. An unrelated tab to the left can be
selected. The older opener-based implementation and tests remain as
historical development material, but are not the 0.7.3 production action.

## Install or update in Brave

1. Open `brave://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder, or press
   **Reload** on an already installed Backtrack Development extension.
3. Verify that Brave displays version **0.7.3**.
4. Refresh ordinary web pages that were open before the reload. Newly opened
   tabs receive the current content script automatically.

Automatic Backtrack actions require browser support for `WheelEvent.momentum`
(introduced in Chromium 151). The running Brave/Chromium 153 build exposes it.
Without this signal, Backtrack leaves native browser Back active and does not
attempt automatic tab closure. The field does not identify finger count.
Brave on macOS remains the primary acceptance target.

Automatic actions remain off until Back direction has been calibrated. On
an ordinary `http://` or `https://` page, select **Backtrack Development**
as the DevTools JavaScript context and inspect:

```js
BacktrackGestureDebug.getSemanticSettings()
BacktrackGestureDebug.getStatus()
```

A physical rightward Back swipe was `NEGATIVE_X` on the development Mac;
macOS settings can reverse it. Calibrate only after checking your direction:

```js
await BacktrackGestureDebug.calibrateBackDirection("NEGATIVE_X")
// Use "POSITIVE_X" if your measured Back swipe has the opposite sign.
```

To stop automatic actions without deleting the calibration:

```js
await BacktrackGestureDebug.disableAutomaticActions()
```

## How it works

- `src/content/gesture-debug.js` classifies trusted horizontal wheel
  sequences, rejects vertical motion and horizontally scrollable controls,
  shows the arrow, and sends one confirmed Back request.
- `src/content/navigation-state.js` reads opaque Navigation API entry keys
  and requests the background decision.
- `src/background/navigation-tracker.js` remembers each newly created tab's
  first observed entry in session storage, including tabs without an opener.
  It handles redirects and Back loops. Browser-reported opener or navigation-
  target evidence can corroborate link opening without choosing the return
  destination. For a tab without that evidence, a baseline observed after
  earlier browser history does **not** authorize closing the tab.
- `src/background/positional-back.js` rechecks the active tab and tab order,
  activates its immediate left neighbor, and then closes the current tab.
  With exactly one tab, it closes only that normal, focused browser window.
  Pinned tabs and ambiguous states remain open.
- `src/shared/gesture-stroke-boundary.js` reads trusted `WheelEvent.momentum`.
  Only direct input contributes to a candidate. The first inertia event ends
  that candidate; subsequent inertia is ignored, including after a tab switch.
  If no inertia follows, 220 ms of input silence ends the candidate instead.
  Backtrack no longer closes a tab while a continuous physical stroke is arriving.
- The background gesture gate rejects duplicate IDs and overlapping input
  intervals across tabs. A new completed physical stroke needs no acceleration
  ramp or post-action cooldown. Missing phase support preserves native Back.

When history evidence is unknown, Backtrack requests ordinary page Back
without closing anything. For a tab already open when the extension started,
only a single-entry history plus a complete Navigation API snapshot can
establish that no earlier Back step exists. `history.length` is never used
by itself as proof of closure.

## Local diagnostics

The development build keeps the latest **400 action attempts** plus
**1,600 context events** locally. It stores tab IDs, timings, reason codes,
website origins, and opaque navigation identifiers, but not full URLs, page
text, form input, credentials, or raw wheel streams. Nothing is sent to a
server. The log survives tab closure:

```js
await BacktrackGestureDebug.getPersistentDiagnosticReport()
```

The decision probe is read-only:

```js
await BacktrackNavigationState.requestBackDecision()
```

It returns `USE_INTERNAL_HISTORY`, `CLOSE_POSITION_ELIGIBLE`, or
`NO_SPECIAL_ACTION`. The manual action probe **can close a tab or window**;
use it only in disposable test windows:

```js
await BacktrackNavigationState.performConfirmedBackAction()
```

See [diagnostic-log.md](docs/diagnostic-log.md) for the log format. Previous
research remains in [gesture-research.md](docs/gesture-research.md) and
[gesture-safety.md](docs/gesture-safety.md); older opener-based sections
describe versions before 0.7.0.

## Manual acceptance matrix for Brave/macOS

Use disposable ordinary web pages and a window with no important unsaved work.

- [ ] Verify 0.7.3 is loaded and refresh existing test pages.
- [ ] Open `A | B | C` in one window. One right swipe closes C and selects B;
      the next deliberate swipe closes B and selects A.
- [ ] A third deliberate swipe closes that window. Brave remains in the Dock
      and any other Brave window stays open.
- [ ] Navigate two pages inside B. Each swipe traverses one page; only the
      following swipe at B's entry closes the tab.
- [ ] A manually opened unrelated tab follows the same position rule.
- [ ] Vertical scrolling and horizontal carousels/tables do not close tabs.
- [ ] One swipe plus its momentum performs at most one action.
- [ ] Immediately after closing C, the next deliberate swipe traverses B's
      internal history once, without repeated attempts or a multi-second wait.
- [ ] Check both an abrupt second stroke and a slow stroke without inertia.
- [ ] A pinned tab, unfocused window, unclear history, or moved tab stays open.
- [ ] A tab with earlier history does not close merely because the extension
      was reloaded at its current page.

Run automated tests with `npm test`.

## Permissions and limits

| Access | Purpose | Data and alternatives |
| --- | --- | --- |
| `storage` | Session-only entry and gesture-gate state; local calibration and bounded development log. | Could hold extension data; the log excludes full URLs and page content. Worker suspension would otherwise lose the entry boundary. |
| `webNavigation` | Top-level commits identify opening redirects and redirected Back loops. | Can expose navigation URLs; only origins and approved metadata enter the log. Removing it would weaken history-boundary detection. |
| No `tabs` permission | Numeric tab IDs, positions, activation, and close use `chrome.tabs` methods without privileged URL/title access. | Avoids broader tab fields. |
| HTTP(S) content scripts | Observe gestures and navigation early on ordinary websites. | Cannot run on `brave://`, `chrome://`, extension-store pages, many PDF viewers, or Chromium error documents. |

Closing the only window uses the browser's window API; it does not call Quit.
macOS normally keeps the app in the Dock, but exact Brave behavior still
needs physical acceptance. Backtrack never closes all Brave windows in one
gesture. If the active tab is leftmost while other tabs remain to its right,
there is no leftward destination, so Backtrack leaves it open.

The gesture remains an extension-level approximation of Brave's native
trackpad handling. Complex scroll interfaces, protected pages, and
cross-origin history can be ambiguous. In an ambiguous state, the tab
remains open; a missed close is preferable to silently losing a page.
