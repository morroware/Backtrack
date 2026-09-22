# Regression Matrix

Date: **August 30, 2026**

This document records the automated regression suite and the physical
Brave/macOS validation for development version `0.5.0`. It separates real
two-finger evidence from synthetic browser input. Synthetic `WheelEvent`
dispatches are never accepted as proof of physical gesture behavior.

## Environment

| Component | Version or state |
| --- | --- |
| macOS | 26.6.2 (Build 25G83) |
| Brave | 152.1.94.117 (Chromium build 194.117) |
| Extension | Unpacked Backtrack Development 0.5.0 |
| Test origin | `http://127.0.0.1:8765` |
| Back direction | Physical swipe right measured as `NEGATIVE_X` |
| Automatic actions | Enabled only after explicit direction calibration |
| Root containment | `overscroll-behavior-x: contain` while enabled |
| Natural Scrolling setting | Not changed during this run; preference value was not recorded |

## Automated suite

Command:

```sh
npm test
```

Version `0.5.0` result: **85 passed, 0 failed**.

Version `0.5.1` follow-up after the live `NO_OPENER` diagnosis: **97 passed,
0 failed**. The additional cases cover an exact
`onCreatedNavigationTarget` fallback, missing and untrusted relationships,
live-versus-tracked conflicts, different windows, decision eligibility, and
the guarded close path without a live `openerTabId`.

Version `0.5.2` latency follow-up: **108 passed, 0 failed**. The added cases
cover stronger early-commit evidence, rejection of page-owned input on the
fast path, and momentum rejection after a same-window document or tab switch.
The physical latency retest is still pending and must not be inferred from the
automated result.

Version `0.6.0` visual-feedback follow-up: **123 passed, 0 failed**. The added
cases cover early preview eligibility, progress clamping, and rejection of
vertical, forward, modified, synthetic, page-canceled, scroll-owned,
uncalibrated, and disabled input. This proves the pure preview policy, not the
appearance of the rendered overlay.

The real indicator module was also rendered in Brave on the local
`indicator-fixture.html`. Tracking, armed, and hidden states were exercised;
the arrow remained non-interactive, the fixture controls remained clickable,
and the browser console contained no Backtrack or fixture error. The initial
visual run exposed and corrected an overly strict paint-containment rule that
had clipped the overlay. This rendered check validates the overlay itself, not
a new physical trackpad latency measurement.

The suite covers:

- gesture distance, dominance, consistency, event-count, peak, and direction
  mapping;
- visual-only preview thresholds, progress, and fail-closed blockers;
- disabled, uncalibrated, forward, modified, synthetic, non-pixel, and
  page-canceled input;
- consumable, boundary, incomplete, and unknown horizontal scroll ownership;
- tab-and-window gesture ID deduplication, momentum cooldown, cleanup, and
  service-worker suspension-safe session state;
- internal-history precedence, multiple internal steps, SPA push/replace,
  cross-origin history, contradictory state, and missing baselines;
- manual, invalid, closed, moved, pinned, grouped, discarded, mismatched, and
  private opener relationships;
- exact one-level-at-a-time nested opener resolution and action;
- activation, post-activation validation, close failure, and focus restoration.

## September 5, 2026: ordinary Back after closing a child

Version `0.6.1`: **138 passed, 0 failed**. A new regression test first failed
against the previous implementation: after closing a child, its untracked
opener received a gesture but did not traverse its own history. Root
containment had disabled native Back while the missing opener relationship
caused the replacement action to do nothing.

The test runs the real content-side navigation script, message listener,
gesture gate, history tracker, and action layer with a controlled browser API
and history model. It now verifies:

- close the tracked child and focus its exact opener;
- reject the same movement's momentum in that opener;
- accept later gestures and traverse two ordinary history steps;
- retain the opener at the start of history;
- preserve this behavior for a cross-origin history model that reports
  `navigation.canGoBack: false`;
- allow ordinary Back without the Navigation API or after loss of a child
  baseline, without inventing closure eligibility;
- keep the manual development command non-navigating for history results;
- reject subframe actions and inactive, discarded, or changing sender tabs.

The unpacked extension was reloaded in Brave and displayed version `0.6.1`.
The controlled live browser sequence was not completed because DevTools UI
automation became unreliable. The automated result is not a physical trackpad
retest or a completed browser-integration result. The real sequence to repeat
is: navigate twice in a parent tab, open and gesture-close a child, then use
two separate back gestures in the parent. Refresh pages that were open before
the extension update before testing.

## September 13, 2026: returning past an opening redirect

Live inspection of version `0.6.3` found a child at its visible GitHub landing
page classified as `USE_INTERNAL_HISTORY / TRACKED_INTERNAL_ENTRY`, despite
same-origin `canGoBack: false`. The opener relationship was valid. The local
diagnostic ring recorded an accepted Back request after approximately 234 ms;
this instance was not a missed gesture or a missing opener.

One ordinary browser Back exposed a redirect wrapper from the source site.
Forward restored the GitHub page. No challenge was solved and no download was
performed. The wrapper address and any challenge parameters are deliberately
not retained here. This establishes the unexpected predecessor; the original
creation-time browser transition qualifier was not captured in that old build.

Version `0.6.4` handles the guarded `client_redirect` case and adds passive
snapshot/document consistency checks. Automated tests cover same- and
cross-origin redirect landings, two subsequent internal steps, return to the
landing, and exact opener focus/child closure. Negative tests retain ordinary
navigation and redirects after trusted input, reject stale or subframe data,
and prevent closure when the opener disappears. Worker restart, multi-hop
opening redirects and full-document/back-forward-cache return are included.

A replay of the wrapper → landing → further page → landing sequence against
the previous committed tracker returned `INTERNAL_BACK_AVAILABLE`; the updated
tracker returned `AT_ENTRY_POINT / TRACKED_REDIRECT_ENTRY_POINT` when supplied
with the confirmed, unattended client-redirect metadata. This is controlled
before/after evidence, not a capture of the real site's initial transition.

Current automated result before redirected-Back-loop recovery: **187 passed,
0 failed**. This includes the separately
requested development event log, expanded to **400 action attempts plus 1,600
context events**. Retention groups, persistence across recorder instances,
sanitization, deduplication, storage failure/recovery, non-blocking action
responses and worker event wiring are covered. Review tests distinguish
possible anomalies from observed successful progress and ordinary deduplication.

### September 13, 2026: redirected Back returned to GitHub

The expanded development log captured a later child that started on its source
site, recorded user activation, and then reached GitHub through a form submit
plus server redirect. This was correctly not promoted as an unattended opening
redirect. Backtrack authorized internal history on the first gesture. Chromium
then reported `forward_back` plus `server_redirect`, but the committed document
was again on GitHub with a fresh entry key and `canGoBack: false`. The tracker
therefore kept returning `TRACKED_INTERNAL_ENTRY`. One rapid follow-up was
correctly rejected by the momentum cooldown; another internal Back produced no
observed progress. The tab was later removed without a successful opener return.

Version `0.6.5` adds a separate, narrowly bounded recovery path. It correlates
one automatic internal-Back request with the next top-level commit and accepts
a loop only when a redirected Back returns to the exact same HTTP(S) address,
the opaque attempted entry still matches, the destination produces a fresh
`push`/`replace` entry, and no same-origin Back entry remains. The full addresses
exist only for the equality comparison in volatile worker memory and are never
stored or logged. A different destination, remaining history, expired or lost
correlation, worker restart before commit, mismatched entry, or later navigation
does not authorize closure.

Automated result for the complete development tree: **203 passed, 0 failed**.
New coverage includes one-shot exact-address correlation, server/client redirect
qualifiers, different destinations, normal traversal, ordinary redirects,
expiration, mismatched entry identity, remaining same-origin history, later
navigation, worker restart after the safe marker, exact opener focus and child
closure, plus the real message layer recording the attempt before traversal.
This is controlled evidence; the affected physical website still requires a
fresh child and trackpad retest after reloading version `0.6.5`.

The change has not yet been verified with a physical swipe in the updated
Brave extension. An automated pass is not confirmation that the inspected
real-world wrapper emits every signal required by the conservative guard.

Retest opening redirects after reloading Backtrack `0.6.5`; existing children
cannot be adopted retroactively. Serve `docs` as described in the README, then:

1. Open `navigation-fixture.html` and select **Open child through automatic
   redirect**. Leave the intermediate page untouched.
2. On the landing page, select **Add SPA step** twice.
3. Swipe Back once per step: both gestures must remain in the child.
4. Swipe once more at the landing: only the child should close; the fixture
   opener should become active. The action log should report
   `TRACKED_REDIRECT_ENTRY_POINT` as the decision reason.
5. Repeat using **Full-document navigation** instead of SPA steps.
6. Repeat on the affected real website with a freshly link-opened child.
7. For the safety comparison, click the intermediate fixture before its
   redirect. It must remain the original entry, not be skipped by child closure.

Do not mark any physical case passed until it has actually been observed.

For the redirected-Back-loop regression, open a fresh child, deliberately
navigate from its entry page to the affected GitHub destination, and swipe Back.
If the predecessor redirects immediately to the exact GitHub page, wait until
the redirect visibly settles and make one new deliberate Back gesture. The
child should close and focus its valid opener. The diagnostic sequence should
contain `BACK_REDIRECT_LOOP_DETECTED`, then
`TRACKED_BACK_REDIRECT_LOOP_ENTRY_POINT`, then `RETURNED_TO_OPENER`. A different
page after the first Back must remain internal and must not close.

### September 17, 2026: confirmed loop lost on a traverse snapshot

The live `0.6.5` log showed `BACK_REDIRECT_LOOP_DETECTED` at 17:00:58 CEST,
followed immediately by a destination snapshot with `navigationType: TRAVERSE`
and `canGoBack: false`. The pending marker was cleared without establishing a
loop entry. Subsequent same-entry `REPLACE`/`TRAVERSE` snapshots could not
recover it. A follow-up action at 17:01:00 was rejected with 178 ms remaining
in the normal cooldown; another at 17:01:01 still chose internal history,
with no subsequent navigation or successful opener return in the log.

Development version `0.6.6` accepts `traverse` only within the existing
browser-confirmed, exact-document redirected-Back path. It does not change
ordinary traversal, initial-redirect handling, opener validation, gesture
thresholds, cooldown duration, permissions or diagnostic retention.

Verification:

- Before the fix, the added tracker replay lost the loop marker, and the real
  worker integration test returned `USE_INTERNAL_HISTORY` instead of
  `RETURNED_TO_OPENER` for the `traverse` variant.
- After the fix, the complete suite reports **222 passed, 0 failed**.
- Real worker integration covers `push`, `replace` and `traverse` destination
  snapshots, repeated same-entry updates, the 178 ms cooldown rejection,
  successful subsequent automatic opener return, and persistent diagnostics.
- Negative tests retain internal history or refuse closure for missing loop
  metadata, ordinary traversal, mismatched attempted entry, remaining or
  unknown same-origin history, unknown/reload snapshot type, stale document,
  changed live entry, missing/moved opener, pinned child and later navigation.
- The production log was read for diagnosis and was not cleared or modified.
  Test storage and tab APIs are isolated in-memory substitutes.

Physical verification is **pending**, not passed. Reload the unpacked extension
and verify `0.6.6`, refresh the source page, then open a **fresh** child. Existing
children cannot regain their original tracking state after an extension reload.
Repeat the affected source → GitHub → redirected Back sequence. Once the page
has settled and the existing 1.8-second cooldown has elapsed, the next deliberate
Back gesture should close only the child and focus its valid opener. The log
should show `BACK_REDIRECT_LOOP_DETECTED`, a `NAVIGATION_STATE` with
`backRedirectLoopEntry: true`, then a `RETURNED_TO_OPENER` action with decision
reason `TRACKED_BACK_REDIRECT_LOOP_ENTRY_POINT`. Also check that ordinary
internal history still runs first and a missing opener never closes the child.

## Physical Brave/macOS matrix

### September 5, 2026: root-tab responsiveness follow-up

Version `0.6.2`: **146 passed, 0 failed**, including eight new tests that run
the real gesture content script with a controlled document and clock. They
cover native root input bypass, unchanged child classification/deduplication,
original site-style restoration, deferred ownership changes, stale replies,
missing child-history evidence, transient failures, and settings changes.

During the preceding live investigation, a physical horizontal sequence on
the opener lasted **3,752.8 ms** and contained **434 events**. Its automatic
action had already been requested after **241.2 ms**. A later accepted
history request returned in approximately **4 ms**. The evidence identifies
the long-lived sequence and fixed action gate as a responsiveness risk; it
does not prove the exact rejection reason for that earlier request because
its response object was lost during navigation.

The subsequently requested repeat reached the opener's home page, but its
complete action logs did not survive the browser-control turn boundary. No
timing or rejection claim is based on that incomplete repeat.

The fix gives a verified root's normal Back to Chromium instead of weakening
the destructive child-close guard. Physical confirmation is still required:
one gesture must close the child without also navigating the opener, and the
next intentional gesture must perform exactly one native Back. The browser
tool blocked opening the extension-management page. The user subsequently
reloaded version `0.6.2`, and the affected root page was refreshed. Live
inspection then confirmed content-script version `0.6.2`,
`navigationOwner: "BROWSER"`, and computed `overscroll-behavior-x: auto`
(previously `contain`). This verifies the active ownership change, not
physical macOS momentum behavior.

The normal browser Back command then reached the site's home page, and
Forward restored the article. The restored article again reported version
`0.6.2`, browser ownership, and `auto` overscroll. The console contained
pre-existing/repeated asynchronous message-channel errors attributed to the
page, without an identified responsible extension; this is not a clean-console
claim. The controlled Back/Forward result does not replace the physical
child-close-to-native-Back retest.

### Original August 30 physical run

All physical cases used ordinary two-finger trackpad movement. The extension
was freshly reloaded before the run so the version 2 local settings schema was
active and earlier development calibration was ignored.

| Case | Physical result | Backtrack result | Status |
| --- | --- | --- | --- |
| Native Brave back before containment | A swipe right delivered only the beginning of the DOM stream before Brave navigated from the gesture fixture back to `brave://extensions`. | No automatic action was possible because calibration was disabled. This reconfirms that DOM `preventDefault()` is not the control mechanism. | PASS, research observation |
| Direction calibration on child entry | 175 events over 1,704.3 ms; `netX: -7650`, `netY: -31`, `absoluteX: 7650`, peak X 254 px. | `HORIZONTAL_NEGATIVE_X`, no classifier blocker. `NEGATIVE_X` was explicitly stored as back and automatic actions became enabled. | PASS |
| Fast vertical scroll with momentum | 159 events over 1,540.4 ms; `netX: 12`, `netY: 4817`, `absoluteX: 22`, peak X 4 px. | Rejected as `NO_CANDIDATE`; the child stayed open and no navigation occurred. | PASS |
| Inner horizontal scroller, back direction | 162 events over 1,563.5 ms; `netX: -5141`, `netY: -12`, 116 decay-tail events. The scroller consumed 17 events and reached its boundary for 145 events. | Rejected as `NO_CANDIDATE` with `HORIZONTAL_SCROLL_CAN_CONSUME` and `INNER_HORIZONTAL_SCROLL_EDGE_GUARD`; the child stayed open. | PASS |
| Child at entry point | One calibrated physical back gesture outside a scroller. | The gesture-fixture child closed and its exact navigation-fixture opener became active. | PASS |
| Child with two SPA history steps | Physical sequence from `step=2`: back to `step=1`, back to `?child=1`, then back once more. | First two gestures stayed inside the child. The third gesture closed the child and activated its exact opener. | PASS |

One instructed internal-history attempt produced no `wheel` session and no
automatic action. The same case was repeated immediately and passed. It is
recorded as a missed test input, not as a navigation failure: the fail-closed
path left the tab and URL unchanged.

### Protected network-error page observation

On August 30, 2026, `https://auth.devlab.is/` failed in Brave with
`ERR_SSL_UNRECOGNIZED_NAME_ALERT`; a separate HTTPS client reproduced the TLS
`unrecognized name` failure. Brave displayed its protected
`chrome-error://chromewebdata/` document behind the requested address. The
Backtrack content script cannot run on that internal error document, so no
ordinary trackpad gesture can reach the extension there. This is an explicit
pure-extension limitation, not a gesture-classifier result.

## Original regression acceptance result

The issue-level regression gate passes for the tested Brave/macOS setup:

- vertical movement did not become a back action;
- a strong back-direction movement inside a horizontal scroller was blocked,
  including its momentum tail and boundary phase;
- a calibrated entry-point back gesture closed only the verified child and
  focused its exact opener;
- meaningful internal history was exhausted before opener behavior;
- all automated invalid-opener, nested-opener, deduplication, and failure paths
  passed.

This is not a broad production-compatibility claim. The extended research
matrix still needs Natural Scrolling on/off comparison, more gesture speeds,
real-world tables/carousels/Kanban boards, Chrome, additional Brave versions,
and another Mac/trackpad. Any repeatable false tab closure remains a No-Go.

## Version 0.7.3 — September 22, 2026

Automated result: **262 passed, 0 failed**. New integrated tests feed raw wheel
events into the real gesture content script and navigation content script,
then the real message handler, gate, history tracker and positional strategy.
Browser APIs and time are simulated; the tests do not preset gesture success
or fresh-stroke evidence. Abrupt, gradual and modest direct-input profiles all
close the child, ignore inherited inertia, and traverse the previous tab's
history on each new stroke. C → B → A → window close and the no-inertia idle
fallback also pass.

Additional checks cover missing native momentum support, duplicate/overlapping
claims, old 0.7.2 gate state, worker restart, phase-log filtering, tab hiding,
page cancellation, horizontal scrolling, vertical input, modifiers and
synthetic events. The earlier early-commit module remains historical test
material but is not loaded by the manifest.

Live API check: regular Brave reported Chromium 153 and the native momentum
property on `WheelEvent.prototype`. The installed content script reported
version 0.7.3, native support and calibrated `NEGATIVE_X` Back.

The first child-close observation at
18:32:31 UTC passed: 15 direct-input events, 542 px, then `NATIVE_MOMENTUM`
and exactly one `CLOSED_TAB_TO_LEFT`. The intended follow-up-history case was
not valid: automation had opened the child next to a different active tab.
The unchanged prepared page therefore does not establish a follow-up failure
or pass. The test was reset with visibly verified adjacent test tabs.

### Corrected physical regression — PASS for the reported interaction

With the test parent actually activated before opening its child, both test
tabs were visibly adjacent. The user performed two normal rightward swipes
without an instructed pause. Browser state and persistent logs confirmed:

| UTC time | Direct input and boundary | Verified result |
| --- | --- | --- |
| 18:34:20.467–20.667 | 20 physical events, 554 px, native inertia boundary | `CLOSED_TAB_TO_LEFT`; parent activated at 20.675, child removed at 20.725. Action response: 60 ms. |
| 18:34:21.369–21.527 | 19 physical events, 727 px, native inertia boundary | `USE_BROWSER_HISTORY`; response 2 ms, subsequent navigation observed, visible URL `?step=2` → `?step=1`. |

The second physical stroke began 644 ms after child removal and succeeded
without a repeated attempt or gate rejection. This parent predated the reload,
so ordinary-history fallback was expected and still performed the Back step.
Action response durations exclude the user's stroke and browser paint time.
No additional tab/page action was observed from either inertia tail.

This passes the focused child-close → previous-tab Back regression. It does
not re-certify every manual row above. Three-tab/window closure, non-inertial
idle completion, unsupported-browser behavior and scrolling safeguards were
covered automatically, not re-tested physically in this focused run.
