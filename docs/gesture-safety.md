# Conservative Gesture Safety

Status: September 5, 2026

Implementation: development version `0.6.2`

## Purpose

This layer turns a completed horizontal `wheel` sequence into a semantic
`BACK_GESTURE` only when the evidence is deliberately one-sided. Its governing
rule is:

```text
unclear movement → no special action
```

A missed tab return is acceptable. An accidental tab closure is not.

## Decision sequence

Backtrack does not act at the preliminary distance threshold. It uses two
conservative paths:

1. A stronger early candidate must remain fully eligible for 90 ms. This avoids
   waiting for a multi-second macOS momentum tail.
2. If the early path is inconclusive, no related event may arrive for 220 ms
   before the completed-sequence fallback is evaluated.

```text
wheel events
  → physical-shape checks
  → page and scroll-ownership checks
  → calibrated back-direction check
  → stronger early threshold + 90 ms confirmation
       or completed-sequence fallback
  → root-containment check
  → tab-and-window momentum gate
  → live internal-history and opener decision
```

The existing navigation and tab-action layers still make the final decision.
The gesture classifier cannot directly close a tab.

## Visual-only feedback

Version `0.6.0` adds a separate preview threshold so the user receives visible
feedback before the stricter action decision. This does not lower any action
threshold and does not add a delay:

| Signal | Visual-preview minimum |
| --- | ---: |
| Net horizontal distance | 80 CSS pixels |
| Horizontal-to-vertical accumulated movement | 3:1 |
| Movement retained in one horizontal direction | 85% |
| Pixel-mode events | 4 |
| Largest individual horizontal delta | 6 CSS pixels |

The preview also requires a calibrated back direction and enabled automatic
behavior. Every non-threshold blocker still applies, including page
cancellation, non-pixel or synthetic input, modifiers, forward movement, and
horizontal scroll ownership. A preview can fade away without an action; it is
feedback about an emerging candidate, not a promise that a tab will close.

The indicator is confined to the top frame, has no pointer interaction, and
lives in a closed Shadow DOM. It uses no screenshot, page text, URL, external
asset, storage, or additional permission. `prefers-reduced-motion: reduce`
removes the animated travel and keeps only effectively immediate state changes.

## Minimum physical evidence

All of these thresholds must pass:

| Signal | Minimum |
| --- | ---: |
| Net horizontal distance | 240 CSS pixels |
| Horizontal-to-vertical accumulated movement | 4:1 |
| Movement retained in one horizontal direction | 90% |
| Pixel-mode events | 8 |
| Largest individual horizontal delta | 8 CSS pixels |

The sequence is rejected if any event uses line or page delta mode, is
synthetic (`isTrusted: false`), contains a modifier key, or appears to have been
canceled by a page listener. These rules also reduce the chance that a mouse
wheel, Shift-plus-wheel shortcut, zoom gesture, or custom page interaction is
treated as browser navigation.

The thresholds are intentionally well below the real back sequences observed
in the controlled Brave/macOS matrix, which reached roughly 2,300–5,500 pixels
while remaining strongly horizontal. They are also far above the incidental
horizontal drift in the fastest measured vertical scroll, which accumulated
only 22 horizontal pixels.

## Stronger early-commit evidence

The fast path deliberately requires more evidence than the final diagnostic
classification:

| Signal | Early minimum |
| --- | ---: |
| Net horizontal distance | 720 CSS pixels |
| Horizontal-to-vertical accumulated movement | 5:1 |
| Movement retained in one horizontal direction | 95% |
| Pixel-mode events | 12 |
| Largest individual horizontal delta | 12 CSS pixels |
| Stable confirmation time | 90 ms |

Every ordinary blocker still applies. A consumable or edge-positioned inner
horizontal scroller, an unknown scroll direction, a modifier, non-pixel input,
synthetic input, page cancellation, a forward direction, missing calibration,
or disabled automatic behavior prevents early commitment. The 90 ms timer is
not restarted by every momentum event; at its end, the complete safety
evaluation is run again against all events observed so far.

## Horizontal scroll ownership

For every event, Backtrack inspects the event path for a horizontally
scrollable element and records whether it can consume movement in that event's
direction.

| Context | Policy |
| --- | --- |
| Inner scroller can move | Reject the sequence |
| Inner scroller is already at its edge | Reject the sequence |
| Scroll direction cannot be interpreted safely, including RTL | Reject the sequence |
| Root viewport scroller can move horizontally | Reject the sequence |
| Root viewport scroller is at the relevant boundary | May continue through the remaining checks |

Blocking an inner scroller even at its boundary is deliberate. A carousel,
Kanban board, gallery, table, timeline, or custom code view may attach its own
edge behavior that DOM geometry alone cannot reveal. Version 1 therefore
prefers a missed back action over stealing that interaction.

## Direction calibration

The sign of `deltaX` is not assigned a universal meaning. Hardware, macOS
Natural Scrolling, and browser behavior can change the relationship between a
physical movement and the reported sign.

Automatic behavior starts disabled. Development version `0.5.0` requires one
of these explicit local calibrations in the extension's isolated DevTools
context:

```js
await BacktrackGestureDebug.calibrateBackDirection("NEGATIVE_X")
await BacktrackGestureDebug.calibrateBackDirection("POSITIVE_X")
```

The current test Mac reported physical back as `NEGATIVE_X`, but that result is
not hard-coded. The opposite calibrated sign becomes `FORWARD_GESTURE` and
never requests a back action.

The stored object contains only schema version, direction, and enabled state.
Settings from an unknown schema version are ignored and therefore disable
automatic behavior. The object contains no URL, history entry, page content,
or gesture samples.

## Native-navigation containment

The Phase 1 evidence showed that DOM `preventDefault()` did not suppress
Brave's native history swipe reliably. Root
`overscroll-behavior-x: contain !important` did suppress it in the controlled
test while the inner fixture remained horizontally scrollable.

Backtrack therefore applies root containment only after automatic actions are
explicitly enabled. Immediately before an action request it also verifies that
the computed root value is still `contain`. If the page or browser prevents
that state, the request becomes a no-op. Disabling actions or clearing the
calibration restores the root's previous inline value.

This CSS intervention remains the largest compatibility risk and requires the
extended real-site matrix before a production MVP decision.

## Momentum deduplication

Standard `WheelEvent` exposes no dependable momentum phase. Backtrack therefore
marks a content sequence as already requested before any early action and the
service worker atomically claims the gesture ID in `chrome.storage.session`.
The latest accepted gesture state is retained for the sending tab and its
browser window, but it is not a fixed waiting period.

The window guard matters because an early action can navigate the document or
activate an opener while the old physical movement is still producing events.
If that remainder reaches the newly active document, it is rejected instead of
causing a second history step or closing another level of the tab tree. The
guard survives document navigation and service-worker suspension. The tradeoff
is that an abrupt second movement without a measurable low-to-high ramp may be
ignored conservatively.

Version 0.7.2 separates a strong renewed acceleration after a decaying tail
into a new content-script gesture session. Three sustained increases from a
low-intensity valley to a meaningful peak provide explicit fresh-stroke
evidence. The background accepts that evidence immediately, even directly
after a tab switch. A merely decaying or noisy tail remains blocked. Retained
state expires after ten seconds only as a recovery fallback; normal operation
does not wait for that expiry.

## Internal history and opener behavior

### Root-tab native navigation in version 0.6.2

Before taking over input, the content layer requests the existing opener and
history decision. Only an explicit `NO_OPENER` result enables native root-tab
handling. This decision includes Chromium's exact navigation-target fallback;
an unavailable history API, lost child baseline, closed opener, or API error
alone is not enough to select this mode.

A verified root restores the page's original inline overscroll value and
priority, leaves its wheel input untouched, and displays no Backtrack arrow.
Brave handles ordinary history and gesture boundaries directly, so its next
Back does not depend on the extension's 1.8-second gate. Site-supplied
overscroll restrictions are preserved, not overridden.

Ownership is refreshed on page show, history-entry changes, and return to a
visible tab. Responses from superseded requests are ignored. Containment is
never released while a Backtrack sequence or automatic action is active.
Transient refresh failures preserve the previous owner. All child-tab action
checks and the nested-tab momentum gate remain unchanged.

### Extension-controlled child tabs

After a gesture survives all checks, the background still re-evaluates the
current tab:

- `USE_INTERNAL_HISTORY`: the content script calls `history.back()` once;
- `USE_BROWSER_HISTORY`: no safe child-closure decision exists, but the sender
  was freshly revalidated; the content script calls `history.back()` once;
- `RETURN_TO_OPENER_ELIGIBLE`: the guarded action activates the exact opener,
  revalidates it, then closes the child;
- an action of `NO_SPECIAL_ACTION`: nothing happens.

Missing baselines, closed openers, already-moved children, and pinned children
never authorize closure. Since `0.6.1`, they can still use ordinary browser
Back; otherwise root containment would suppress navigation without replacing
it. Protected pages, inactive/changed senders, unsupported sources or frames,
in-progress navigation, rejected gesture claims, and API failures remain
no-ops. The window-wide momentum guard is unchanged.

## Automated coverage

The tests cover:

- both physical direction signs and forward rejection;
- disabled and uncalibrated states;
- distance, dominance, consistency, event-count, and peak thresholds;
- line/page delta mode, synthetic events, modifiers, and page cancellation;
- consumable, boundary, incomplete, and unknown horizontal scroll state;
- stronger early-commit thresholds and ordinary safety blockers on the fast
  path;
- duplicate gesture IDs and split momentum tails;
- same-window tail blocking, cross-window isolation, and cleanup;
- gate enforcement before any tab action;
- internal-history precedence and guarded nested opener actions.

Run all tests with:

```sh
npm test
```

## Brave development smoke test

On August 30, 2026, the unpacked development build was reloaded in Brave
`152.1.94.117` on macOS `26.6.2`. The isolated content API reported gesture
module `0.2.0`, navigation module `0.3.0`, no calibration, automatic actions
disabled, and unchanged root overscroll behavior at startup.

A deliberately strong synthetic ten-event sequence reached 500 horizontal
pixels with 50:1 dominance. It still ended as `NO_CANDIDATE` with the sole
physical blocker `UNTRUSTED_EVENT`; no navigation request occurred. Explicit
`NEGATIVE_X` calibration then enabled automatic actions and reported root mode
`contain`. This confirms the browser wiring for safe defaults, settings,
containment, completed-sequence classification, and synthetic-event rejection.

This smoke test by itself did not count as a new physical-trackpad run. A later
calibrated version `0.5.0` run completed the core vertical-scroll,
horizontal-scroller, entry-point action, and multi-step internal-history cases.
See [regression-matrix.md](regression-matrix.md) for the measured values and
visible browser outcomes.

## Remaining manual validation

The core regression gate passed on the recorded Brave/macOS setup. Before
calling version 1 production-ready, extend real two-finger coverage across:

- Natural Scrolling on and off;
- slow, normal, and fast back gestures;
- ordinary pages with and without internal history;
- large tables, carousels, Kanban boards, image galleries, and code panes;
- long pages with vertical momentum;
- multiple current Brave and Chrome versions;
- at least one additional Mac and trackpad.

Any regular false tab closure is a No-Go. The keyboard-command fallback remains
the smallest pure-extension alternative if root containment or scroll ownership
cannot be made sufficiently safe.
