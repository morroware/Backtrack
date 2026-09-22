# Gesture Research: Brave/macOS Trackpad

Status: August 28, 2026<br>
PoC version: 0.1.0<br>
Decision: **Conditional Go for a bounded Phase 2 prototype; the extended compatibility matrix remains open**

## Research question

Can a Manifest V3 extension in Brave on macOS detect the ordinary horizontal
two-finger back gesture early and reliably, distinguish it from normal
horizontal scrolling, and control Brave's own navigation when necessary?

This proof of concept covers only the input side. It deliberately included no
service worker, Tabs API integration, or history management at the time of the
Phase 1 measurements.

## Essential distinction: established versus still unproven

### Established by standards, Chrome documentation, or Chromium source

1. A DOM `WheelEvent` exposes `deltaX`, `deltaY`, `deltaZ`, and `deltaMode`.
   The UI Events specification says the sign depends on the environment and
   device. Back semantics must therefore never be inferred from an unverified
   sign assumption.
2. `preventDefault()` can cancel only an event that is actually cancelable
   (`cancelable: true`). That fact alone does not show whether it stops Brave's
   separate native back gesture in every phase; this requires a real test.
3. Chromium's macOS `HistorySwiper` processes native
   `NSEventTypeScrollWheel` events and their native phase. It also uses
   higher-resolution macOS touch feedback. Those data are not part of the
   standardized DOM `WheelEvent`.
4. Current Chromium source describes how scroll or wheel events acknowledged
   as consumed can prevent a browser overscroll gesture. On macOS, Chromium
   also considers the page's computed `overscroll-behavior`. The controlled
   Brave test below confirmed that effect for the tested setup.
5. Chrome documents that `overscroll-behavior: contain` on the root element can
   prevent overscroll navigation. An extension would have to alter page CSS to
   apply it, which is a significant product and compatibility intervention and
   is not automatically acceptable.

### Established by the first real trackpad series

On the tested page without a usable back target, four physical back swipes
each reached the content script as a long DOM `wheel` sequence. All four
sequences completed and produced summaries. On this Mac, the physical back
movement produced negative `deltaX`. That mapping applies only to the measured
device and system configuration; the code still does not treat the sign as a
universal back direction.

Most importantly, only the first event in each sequence was cancelable. The
remaining 83 to 141 events were not. Calling `preventDefault()` only after the
80-pixel threshold would therefore be too late. The later controlled
suppression test also showed that proactively canceling horizontal DOM events
did not stop Brave's native navigation.

### Established by controlled navigation tests

1. With DevTools open and docked on the right, the IANA test page remained in
   place despite having back history. The content script received a complete
   176-event sequence. With DevTools closed, the same physical gesture
   navigated from IANA back to `example.com`. Open DevTools therefore changes
   the path under test and cannot prove successful suppression.
2. With DevTools closed and `preventDefaultMode: "horizontal"`, Brave still
   navigated from IANA to `example.com`. DOM cancellation alone did not
   reliably control the native two-finger back gesture in the tested version.
3. With DOM cancellation disabled and
   `overscroll-behavior-x: contain !important` on the root element, IANA
   remained open after two physical back gestures. Both gestures arrived as
   separate, complete content-script sequences. Root CSS is the only pure
   extension technique that succeeded in the controlled test so far.
4. Slow and fast vertical scrolling did not become a horizontal candidate.
   The fast test contained 5,669 px of vertical movement but only 22 px of
   absolute horizontal movement.
5. Two real horizontal gestures inside the local scroll area were associated
   with that `div` for every event in both directions and blocked by
   `HORIZONTAL_SCROLL_CONTEXT`.
6. The same horizontal area remained usable with root containment enabled:
   its measured position moved from 717 to 0. The entire sequence remained
   associated with the scroll area and was not classified as a navigation
   candidate.

### Still not established empirically

- Whether a complete DOM `wheel` sequence remains available for evaluation
  while Brave actually navigates without DevTools. The measurement window
  changes this path, and navigation destroys the old page context.
- Whether root CSS suppression remains stable on more ordinary websites and
  after repeated document changes.
- How root CSS suppression affects complex real tables, carousels, Kanban
  boards, and web applications outside the local fixture.
- Whether the positive `deltaX` polarity of the physical opposite direction
  remains the same for native forward navigation on a simple page. The mapping
  was measured inside the local scroll area.
- Whether robust thresholds exist across slow, fast, and momentum-heavy
  gestures and across different trackpads.

## Test setup

Captured environment:

| Property | Value |
| --- | --- |
| macOS | 26.6.2 (Build 25G83) |
| Brave | 1.94.117 |
| Chromium reported by `brave://version` | 152.0.7977.64 (arm64) |
| Device / trackpad | MacBook Pro (Mac14,6), built-in trackpad |
| Natural scrolling | Still to be recorded |
| Brave swipe navigation | Enabled; native navigation observed in D1 and D2 |
| Extension | Backtrack Gesture Research 0.1.0 |
| Test pages | `https://ai4performance.com/` without a back target; `example.com` → IANA with usable back history; local `docs/gesture-fixture.html` for controlled vertical and horizontal scrolling |
| DevTools Preserve log | Enabled; DevTools closed during the actual navigation tests |

A synthetic wheel event from DevTools or test software is not sufficient
evidence. Only a real two-finger movement passes through native macOS and
Chromium gesture recognition.

## PoC instrumentation

The listener is registered on `window` at `document_start`:

```text
event: wheel
capture: true
passive: false
frames: every matching HTTP(S) frame
```

Each event records locally:

- `deltaX`, `deltaY`, `deltaZ`, and `deltaMode`;
- pixel normalization, explicitly marked as an approximation for line and
  page delta modes;
- timestamp and interval since the preceding event;
- axis dominance and the still-uncalibrated X sign;
- `cancelable` and `defaultPrevented` before and after Backtrack's handler;
- the result of an opt-in controlled `preventDefault()` experiment;
- modifier keys, especially `ctrlKey` as a possible zoom signal;
- starting point and distance from the left and right viewport edges;
- a detectable horizontal scroll area under the event target;
- any available non-standard or legacy browser fields as probes only;
- a cautious indicator for a decaying tail.

Logs deliberately contain no URL or page text, and nothing is transmitted.

Completed sequences are also emitted as
`[Backtrack:Gesture:SessionJSON]`. Since the horizontal navigation test, the
threshold crossing is also preserved as
`[Backtrack:Gesture:ThresholdJSON]`. With DevTools Preserve log enabled, this
keeps the last scroll context available even if Brave destroys the old page
context before the normal sequence end.

## Building an event sequence

Events belong to the same sequence until the gap exceeds 160 ms. The sequence
finishes after 220 ms of inactivity. A possible decaying tail is marked only
heuristically when several later horizontal values are clearly below the
preceding peak and keep the same direction.

This historical marker is **not** a reliable momentum field. The original
research incorrectly assumed no browser-provided field was available; see
the 0.7.3 correction below. The heuristic was only a comparison aid.

## Preliminary thresholds

| Signal | Initial value | Purpose |
| --- | ---: | --- |
| Net horizontal distance | 80 px | Ignore small diagonal corrections |
| Horizontal dominance | 2.5 : 1 | Conservative starting point; Chromium also uses a 2.5 ratio for direction selection in its overscroll controller, although not necessarily on the same measurements |
| Direction consistency | 80% | Reject back-and-forth movement |
| Gap between sequences | 160 ms | Keep separate inputs separate |
| Finish after inactivity | 220 ms | Include a trailing decay in one summary |
| Horizontal scroll area | Always block | False positives are worse than a missed transition |
| Any modifier key | Block | Protect zoom and modified scrolling |

These are research parameters, not a recommendation for version 1. The
`threshold-crossed` log means only that numerical thresholds were crossed. It
never triggers a browser action.

## Results matrix

`NOT TESTED` means no matching real trackpad measurement exists. `PARTIALLY
TESTED` means real data exists but at least one condition was not sufficiently
controlled. Assumptions and synthetic wheel events must not fill those gaps.

| Test | `preventDefault` | Expected observation | Actual finding | Status |
| --- | --- | --- | --- | --- |
| A1: simple page, physical swipe right | off | Capture sign and complete sequence | Four complete sequences; back movement produced `NEGATIVE_X`. The page's horizontal scroll context was not separately controlled. | PARTIALLY TESTED |
| A2: simple page, physical swipe left | off | Capture the opposite direction | The physical opposite direction in the controlled scroll area produced only positive X; native forward navigation on a simple page was not run separately. | PARTIALLY TESTED |
| B1: slow vertical scroll | off | No horizontal candidate | Two vertical sequences with 215 and 450 px net Y; no threshold crossing, both `NO_CANDIDATE`. | TESTED |
| B2: fast vertical scroll | off | No horizontal candidate despite small X components | 162 events, 5,669 px net Y, only 22 px absolute X; no threshold crossing, `NO_CANDIDATE`. | TESTED |
| C1: horizontal area, middle position | off | Detect scroll context, no candidate | 143 events, `netX: -3315`; 143/143 events in the `div` scroll context, blocker `HORIZONTAL_SCROLL_CONTEXT`. | TESTED |
| C2: horizontal area, edge/opposite direction | off | Continue blocking the scroll context conservatively | 142 events, `netX: +3665`; 142/142 events in the `div` scroll context, blocker `HORIZONTAL_SCROLL_CONTEXT`. | TESTED |
| C3: horizontal area with root CSS `contain` | off, root CSS `contain` | Scrolling still works, no navigation candidate | 152/152 events in the scroll context; position moved from 717 to 0; `NO_CANDIDATE`. | TESTED |
| D1: native back gesture with internal history | off | Compare event arrival, completeness, and Brave navigation | With DevTools: 176 events, no navigation. Without DevTools: native navigation IANA → `example.com`. DevTools changed the test. | TESTED |
| D2: repeat D1 | horizontal | Test whether DOM cancellation prevents native navigation | Despite horizontal cancellation mode and closed DevTools, Brave navigated IANA → `example.com`. | TESTED |
| D3: repeat D1 | off, root CSS `contain` | Isolate the CSS effect from JavaScript cancellation | Two physical back gestures, two separate event sequences; IANA remained open. | TESTED |
| D4: back gesture without internal history | off | Check whether the same event sequence remains visible | Four complete sequences; only event 1 in each was cancelable, all following events were not. No navigation because no back target existed. | TESTED |
| E1: short fast impulse | off | Measure the count and duration of the decaying sequence | Pending | NOT TESTED |
| E2: two separate fast impulses | off | Two summaries, no duplicate signal per impulse | Two gestures accidentally performed in succession produced two summaries. The gap was still too long for the explicit fast double-impulse test. | PARTIALLY TESTED |

## First measurement series: back gesture without internal history

On August 28, 2026, four physical back swipes were recorded on real hardware.
`preventDefault` was off. The page had no usable internal back target, so this
series alone does not show whether Brave would navigate in parallel when a
target exists.

| Sequence | Duration | Events | Net X | Absolute X | Absolute Y | Largest \|X\| | Cancelable / not cancelable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,074.7 ms | 129 | -2,764 px | 2,764 px | 24 px | 73 px | 1 / 128 |
| 2 | 682.3 ms | 84 | -2,481 px | 2,481 px | 25 px | 64 px | 1 / 83 |
| 3 | 1,370.0 ms | 142 | -2,910 px | 2,910 px | 29 px | 76 px | 1 / 141 |
| 4 | 1,328.1 ms | 134 | -2,326 px | 2,326 px | 24 px | 60 px | 1 / 133 |

All 489 events used `deltaMode: PIXEL`. X movement was negative throughout all
four sequences; `positiveX` stayed zero. Each sequence crossed the preliminary
candidate threshold exactly once and produced one final summary. With
cancellation disabled, no cancellation attempt was expected or recorded.

The series shows that the detector receives enough data at the history edge.
It does **not** show that a pure extension can control native Brave navigation.
D1 and D2 are decisive for that question.

## Controlled navigation and suppression

### D1: native navigation without intervention

Each run started with the same history:

```text
example.com → iana.org/help/example-domains
```

Brave's Back button was active. With DevTools docked on the right, IANA stayed
open after the gesture. The recorded sequence lasted 1,682.7 ms, contained 176
events, and reached `netX: -6547 px` and `netY: 38 px`. Only the first event was
cancelable; the other 175 were not. `preventDefault` was off.

After DevTools was closed, the next physically equivalent gesture navigated
immediately back to `example.com`. Docked DevTools therefore affected the
native gesture in this setup. Future claims about actual Brave navigation must
be verified with DevTools closed by observing page state.

### D2: DOM cancellation

The PoC was reloaded with `preventDefaultMode: "horizontal"`. DevTools was
closed and the same IANA history was active. The physical back gesture again
navigated to `example.com`. The controlled non-passive `preventDefault()`
approach was therefore insufficient to take over native navigation in this
configuration.

### D3: root CSS suppression

For this comparison, `preventDefault` was off again. The PoC applied
`overscroll-behavior-x: contain !important` to the root element and reported
the change in its local debug log. DevTools was then closed. IANA remained open
after two physical back gestures.

| Sequence | Duration | Events | Net X | Absolute X | Absolute Y | Largest \|X\| | Cancelable / not cancelable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,522.0 ms | 159 | -4,236 px | 4,236 px | 33 px | 105 px | 1 / 158 |
| 2 | 1,167.6 ms | 140 | -5,519 px | 5,519 px | 113 px | 127 px | 1 / 139 |

Both sequences used only `deltaMode: PIXEL`, stayed fully negative on X, and
completed separately. No DOM cancellation occurred. Successful suppression is
therefore attributable to root CSS, not to `preventDefault()`.

## Vertical scrolling and horizontal scroll areas

The local `docs/gesture-fixture.html` page contains a long vertical area and a
horizontal `overflow-x: auto` area that starts in the middle. It has no gesture
logic and loads no external resources.

### B1/B2: vertical movement

| Run | Duration | Events | Net X | Absolute X | Net Y | Absolute Y | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| slow 1 | 1,336.8 ms | 124 | 37 px | 37 px | 215 px | 215 px | `NO_CANDIDATE` |
| slow 2 | 1,386.2 ms | 142 | 46 px | 92 px | 450 px | 450 px | `NO_CANDIDATE` |
| fast | 1,568.9 ms | 162 | 12 px | 22 px | 5,669 px | 5,669 px | `NO_CANDIDATE` |

None produced `threshold-crossed`. The fast run is particularly strong
counter-evidence against confusing small sideways finger drift with the back
gesture.

### C1/C2: scroll context in both directions

| Direction | Duration | Events | Net X | Absolute Y | Context coverage | Blocker |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| physical right | 1,401.3 ms | 143 | -3,315 px | 26 px | 143 / 143 | `HORIZONTAL_SCROLL_CONTEXT` |
| physical left | 1,387.5 ms | 142 | +3,665 px | 27 px | 142 / 142 | `HORIZONTAL_SCROLL_CONTEXT` |

Both sequences were horizontal enough to cross the numerical threshold. The
final classification was still `NO_CANDIDATE` because every event began inside
the horizontal scroll area. This also confirms the sign mapping in both
physical directions for this configuration.

An earlier, insufficiently instrumented run navigated immediately from the
local fixture back to IANA. The old page context vanished before the sequence
ended, and `ThresholdJSON` did not yet exist, so the real start position could
not be proven. That run is not counted as C1 evidence; it motivated the
fail-safe threshold JSON record.

### C3: root CSS compatibility with inner scrolling

Before the run, the page console confirmed computed
`overscroll-behavior-x: contain`. The horizontal area started at
`scrollLeft: 717`. After a real physical movement, it was at `scrollLeft: 0`,
showing visible and measurable scrolling.

The sequence lasted 1,498.7 ms, contained 152 events, and reached
`netX: -4423 px`. All 152 events belonged to the `div` scroll context; the
classification remained `NO_CANDIDATE` because of
`HORIZONTAL_SCROLL_CONTEXT`. Root containment did not break the controlled
inner scroll area in this run. Complex real applications remain a required
Phase 2 compatibility test.

## Evaluation criteria

### A pure extension is sufficiently plausible for Phase 2 if

all of the following hold repeatedly on real hardware:

1. The intended back gesture produces a distinguishable content-script event
   sequence early enough.
2. Direction can be calibrated reliably for each macOS configuration or
   derived from a stable browser signal.
3. Brave's native navigation can be prevented before competing history
   navigation occurs.
4. Vertical scrolling and horizontal scroll areas produce no false candidates
   in the test matrix.
5. Momentum produces at most one completed candidate signal.
6. Behavior remains stable across multiple ordinary websites and across slow
   and fast gestures.

### A pure extension must be rejected if

any of these findings is reproducible:

- Brave takes over before enough DOM events arrive.
- The visible DOM stream cannot be distinguished reliably from normal
  horizontal scrolling.
- `preventDefault()` or an acceptable CSS approach cannot control native
  navigation consistently.
- The only working suppression requires a global intervention that regularly
  breaks normal horizontal web interactions.
- Direction or momentum varies enough to make accidental tab closure
  realistic.

## Phase 1 decision

**Go for a bounded Phase 2 prototype; not yet a Go for a production-ready
MVP.**

The content script sees the back gesture repeatedly and early. DOM
`preventDefault()` does not control Brave's native navigation. Root CSS
containment did prevent it in the controlled test, including two consecutive
gestures. The completed local B/C core matrix also showed that slow and fast
vertical scrolling created no candidate, the horizontal fixture was detected
fully in both directions, and it remained scrollable with root containment.

A pure extension is therefore plausible enough for the next tightly bounded
technical phase. Phase 2 may test `openerTabId`, conservative history
detection, and tab activation/closure in an unpublished development build.
Root CSS containment remains a substantial page intervention. Before an MVP,
Backtrack must be tested with real tables, carousels, Kanban boards, multiple
Brave/Chromium versions, and additional trackpads. An unclear scroll context
must always result in no action and, in particular, no tab closure.

## Phase 2 safety implementation addendum

Development version `0.5.2` implements the conservative policy derived from
this evidence without changing the historical Phase 1 measurements above:

- physical X signs remain semantically unassigned until explicit local
  calibration;
- automatic behavior is disabled by default;
- root containment is applied only while calibrated automatic behavior is
  enabled and is checked again before action;
- a full sequence must reach 240 horizontal pixels, 4:1 axis dominance, 90%
  directional consistency, 8 pixel-mode events, and an 8-pixel peak;
- consumable or ambiguous horizontal scroll contexts are rejected;
- inner horizontal scrollers remain blocked even at their edge;
- the preliminary threshold never acts by itself;
- a stronger 720-pixel, 5:1, 95%, 12-event, 12-pixel-peak candidate can act
  after remaining eligible for a further 90 ms, avoiding the complete macOS
  momentum tail;
- completed-sequence evaluation remains the fallback;
- a session-backed tab-and-window gate rejects duplicate IDs and decaying
  momentum tails after navigation or a tab switch. Version 0.7.2 later tried
  renewed-acceleration evidence; the findings below supersede that approach.

This is implementation progress, not new physical-trackpad evidence and not a
production Go. The extended real-site and multi-configuration matrix remains
open. See [gesture-safety.md](gesture-safety.md) for the exact policy.

## Version 0.7.3: native momentum correction

On September 22, 2026, the latest retained 0.7.2 incident showed a successful
child close followed by repeated `MOMENTUM_CONTINUATION` rejections in the
previous tab. The strict low-to-high acceleration detector did not report
fresh-stroke evidence in any of the 20 completed sequences inspected. Nine
of 17 action requests were rejected. This is evidence of a failing heuristic,
not evidence that another large cooldown would fix the interaction.

The earlier claim that a DOM inertia signal was unavailable was incorrect:
[Chrome 151 introduced `WheelEvent.momentum`](https://developer.chrome.com/release-notes/151#wheel_event_momentum).
The running Brave reported Chromium 153 and
`"momentum" in WheelEvent.prototype === true`. Chromium derives this boolean
from its native momentum phase. A synthetic default event reporting `false`
confirms API presence only; it does not establish real trackpad behavior.

Version 0.7.3 therefore removes the acceleration-ramp requirement and stops
early actions during an ongoing direct-input sequence. It evaluates direct
input at the first native inertia event, or after 220 ms of input silence
when no inertia follows. Inertia arriving in another tab is ignored before
classification. Duplicate IDs and overlapping input intervals remain guarded;
there is no multi-second post-action lockout. If the API is absent, native
browser Back remains active and automatic Backtrack closure is unavailable.

The release gate distinguishes automated event-to-navigation coverage, live
API presence and physical-trackpad acceptance. The first two are not a
substitute for the third. Direct-input-only thresholds, browser containment
and the no-inertia idle fallback still require physical validation. The field
does not identify two fingers or expose all native gesture/contact phases.

## Smallest alternatives if the result turns negative

Evaluate only; do not implement without separate approval:

| Alternative | Advantage | Disadvantage |
| --- | --- | --- |
| Browser keyboard shortcut (`commands`) | Pure extension, reliable and unambiguous | Not the same trackpad gesture |
| Modifier plus observable scrolling | Fewer false positives | Unfamiliar; modifier detection and horizontal scrolling remain concerns |
| Clearly separate three-finger gesture | Semantically closer to a swipe | A normal web extension cannot reliably read raw finger count; likely needs native help |
| Small native macOS helper plus extension | Can target native gesture recognition | Extra installation, signing, permissions, and substantially more complexity |

The smallest robust fallback would probably be an extension keyboard shortcut.
A native component must not be investigated or built without explicit
approval.

## Sources

- [W3C UI Events: delta values, signs, and default behavior](https://www.w3.org/TR/uievents/)
- [Chrome: content scripts and isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chromium: macOS HistorySwiper](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/renderer_host/chrome_render_widget_host_view_mac_history_swiper.h)
- [Chromium: OverscrollController](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/renderer_host/overscroll_controller.cc)
- [Chrome: overscroll behavior](https://developer.chrome.com/blog/overscroll-behavior/)
