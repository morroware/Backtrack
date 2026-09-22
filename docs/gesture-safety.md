# Conservative Gesture Safety

Status: September 22, 2026 — development version `0.7.3`.

## Purpose

Unclear movement must never authorize a tab closure. A missed close is
preferable to silently losing a page. The classifier cannot close tabs:
the background independently checks history, the active window and tab order.

## Physical input and inertia

Chromium 151 introduced `WheelEvent.momentum`. On the current development Mac,
the running Brave/Chromium 153 exposes the field. This is browser-reported
inertia, not a finger-count or intention signal.

Backtrack uses only trusted events with `momentum === false` as candidate
input. The first `momentum === true` ends the physical sequence and evaluates
it once. Remaining inertia never contributes distance or triggers an action,
including when it arrives in the newly active tab or a replacement document.

If no inertia arrives, 220 ms without direct input completes the sequence.
This is an inactivity fallback, not a post-action waiting period. DOM events
do not expose finger contact or every macOS gesture phase: a pause exceeding
this interval during a held stroke cannot be identified perfectly.

No action is committed while direct input continues to arrive. This avoids
closing a tab while the same finger stroke could still produce direct input
in the next tab. The old 720-pixel / 90-ms early-commit path is no longer loaded.

If the field is unavailable, Backtrack restores the original root overscroll
style and leaves native Back to the browser. It does not guess a safe close
from an intensity ramp. Synthetic events are ignored. Hidden pages cancel
incomplete sequences; returning to a tab does not revive an old candidate.

## Decision sequence

```text
trusted direct wheel input
  → physical-shape and page-ownership checks
  → calibrated Back direction
  → first native inertia event, or 220 ms of input silence
  → root-containment check
  → duplicate-ID and overlapping-input guard
  → live history and positional-tab decision
```

A newer completed physical sequence can act immediately. There is no
1.8-second cooldown and no 10-second recovery block. The gate stores the
last claimed ID and input interval per tab and window in session storage.
Duplicate IDs and overlapping intervals are rejected, including across
worker restarts. A stale request older than ten seconds is rejected as a
stale message; that does not lock out a subsequent new gesture.

## Minimum physical evidence

All thresholds apply to direct input only, never to the inertia tail:

| Signal | Minimum |
| --- | ---: |
| Net horizontal distance | 240 CSS pixels |
| Horizontal-to-vertical accumulated movement | 4:1 |
| Movement retained in one horizontal direction | 90% |
| Pixel-mode events | 8 |
| Largest individual horizontal delta | 8 CSS pixels |

Line/page delta mode, modifiers, page cancellation and ambiguous scroll
ownership reject a candidate. Untrusted events do not enter a sequence.
These thresholds were retained from the earlier classifier; because 0.7.3
excludes inertia, its effective physical-input requirement needs new
trackpad acceptance. Earlier total-stream distances are not proof of passing
these thresholds with direct input alone.

## Horizontal scroll ownership

| Context | Policy |
| --- | --- |
| Inner scroller can move | Reject |
| Inner scroller is at its edge | Reject |
| Direction is ambiguous, including RTL | Reject |
| Root viewport can scroll horizontally | Reject |
| Root viewport is at the relevant boundary | Continue other checks |

A carousel, Kanban board, table or code view can own edge behavior that DOM
geometry does not reveal. Preserving that interaction takes priority.

## Visual feedback

The arrow is a preview, not a promise to close: 80 pixels, 3:1 axis dominance,
85% consistency, four pixel events and a six-pixel peak may show it before the
action thresholds pass. All non-threshold safety blockers still apply.
The indicator is confined to the top frame, has no pointer interaction, and
uses a closed Shadow DOM. Reduced-motion preferences are respected.
It uses no screenshot, URL, external asset or additional permission.

## Direction and native navigation

Back direction remains explicitly calibrated locally to `NEGATIVE_X` or
`POSITIVE_X`. The development Mac used negative X for a rightward Back swipe;
this sign is not universal. Automatic actions remain off until calibrated.

Phase 1 found that `preventDefault()` did not reliably suppress Brave's own
history swipe. Root `overscroll-behavior-x: contain !important` worked in the
controlled setup while leaving the inner horizontal fixture scrollable.
Backtrack uses containment only for enabled, supported automatic input and
rechecks it immediately before requesting an action. Disabling actions or
missing native momentum support restores the previous inline value.

This CSS intervention remains a compatibility risk. It is not evidence that
all sites or Chromium versions behave identically.

## History and positional behavior

Since 0.7.0, the immediate left-hand tab is the destination, not the opener.
The background revalidates active/focused state and live history before acting:

- Known internal history: one ordinary page Back.
- Unknown history: ordinary Back, never an inferred closure.
- Confirmed entry point: activate the left neighbor, recheck, close the tab.
- Only one tab in the focused normal window: close that window, not the app.
- Pinned tab, missing left neighbor, changed state or failed checks: no close.

History that predates a captured baseline is not erased. Older opener-based
modules and their tests are retained as historical development material.

## Verification and remaining limits

Automated tests cover raw event sequences through the content scripts,
message handler, session gate, history tracker and positional action.
They test abrupt, gradual and modest direct strokes; inherited inertia;
immediate follow-up Back; C → B → A; input silence; unsupported browsers;
page cancellation; horizontal/vertical scrolling; duplicate or overlapping
requests; and worker restart.

Earlier physical results are recorded in
[regression-matrix.md](regression-matrix.md). They do not certify the new input
boundary. The September 22 version 0.7.3 physical regression confirmed child
closure followed by immediate Back in the previous tab. Broader production
acceptance still requires Natural Scrolling variants,
slow/fast strokes, real carousels and Kanban boards, multiple browser versions,
and another Mac/trackpad. Any regular accidental closure is a No-Go.

The smallest fallback remains an extension keyboard shortcut. A native macOS
component requires separate approval.

## Sources

- [Chrome 151: Wheel Event Momentum](https://developer.chrome.com/release-notes/151#wheel_event_momentum)
- [Pointer Events: WheelEvent momentum](https://w3c.github.io/pointerevents/#dom-wheelevent-momentum)
- [Recorded gesture research](gesture-research.md)
