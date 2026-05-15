# Rig-Checker Disagreement Audit

For each of the 127 rigs surfaced in the Rigging Workshop's examples panel,
all four rig-checkers (`js · todajs`, `clj · toda-rig-checker`, `clj · toda-bb`,
`rust · rustoda`) were run and their colour verdicts captured. This document
lists every disagreement among them, groups them by root cause, and
adjudicates each category against the rigging specification
(`../rustoda/docs/rigging_specifications.pdf`, v0.9876, January 2023).

## Method

The harness clicked each entry in the rig-list sidebar, waited for a fresh
render to start (a `CHECK` badge appearing), then waited up to 15 s for all
four checkers to settle. The full per-rig harvest is in
[`per-rig.json`](per-rig.json); raw harness state in
[`harvest-v2.json`](harvest-v2.json).

The state ↔ colour mapping used throughout: `OK` ≡ green, `WARN` ≡ yellow,
`FAIL` ≡ red. Tuples in this document are written
`(js | clj | bb | rust)`, e.g. `green|red|yellow|red`.

## Headline numbers

| Outcome | Rigs | % |
|---|---|---|
| All four agree (clean) | 55 | 43.3% |
| ─ all green | 37 | 29.1% |
| ─ all red | 18 | 14.2% |
| At least one disagreement | 69 | 54.3% |
| Anomalies (timeout / no-new-render) | 3 | 2.4% |
| **Total** | **127** | |

### Solo-deviation tally

How often each checker alone gave a verdict different from the unanimous
verdict of the other three:

| Checker | Solo deviations | Notes |
|---|---|---|
| `clj · toda-rig-checker` | 5 | mostly classifies MISSING as yellow when others say red — spec-correct (see C2). |
| `clj · toda-bb`          | 12 | mix of false-greens (real bugs) and false-yellows (over-caution). The dominant solo offender. |
| `rust · rustoda`         | 2 | rare; both genuine misses. |
| `js · todajs`            | 6 | the `HalfHitchInterpreter` relaxation lets it accept rigs the others reject. |

These don't sum to the 69 disagreement total because most disagreements
have two-way or three-way splits, not single-checker outliers.

## Anomalies (excluded from the categories below)

| Path | Declared | Mode |
|---|---|---|
| `rigs/19-fast-line-multiply-lashed-up-to-slow-line.trdl` | yellow | no-new-render — JS compiler rejects ("Circular dependency in twist specs"), expected per [CLAUDE.md](CLAUDE.md) |
| `rigs/20-slow-line-lashed-up-to-fast-line.trdl` | yellow | same circular rejection |
| `todatests/rigging/cork_reqsat_fail.toda` | red | 15 s timeout — at least one HTTPS checker never returned |

The first two are *known* unbuildable cases that never reach the rig-check
pipeline. The third is a probe failure that warrants a focused re-run.

---

## Disagreement categories

The 69 disagreement rigs split into the following categories, ordered by
size. Each entry shows the rig path, its declared (spec-canonical or
heuristic) colour, and the four-checker tuple.

### C1 — Half-hitch on corkline rejected by canonical checkers (≈20 rigs)

**Pattern.** The rig ends with a *half-hitch* whose topline IS the
corkline (the workshop's TRDL convention encodes this as `post: "none"` on
the last hitch). The `HalfHitchInterpreter` in `app.js` accepts this; `bb`
generally accepts it too; `clj` and `rust` reject it as a malformed full
hitch with a missing `post-key` MISMATCH.

**Tuple signatures.** `green|red|red|red` (6 rigs) and similar patterns
where JS is green and `clj`/`rust` are red.

**Rust detail (representative).**

```
{
  "structype": "rig",  "colour": "red",
  "children": {
    "hitch": {  "colour": "red",
      "children": {
        "post-key": {
          "colour": "red",  "issue": "MISMATCH",
          "detail": "no post entry mapping lead X to hoist Y"
        }
      }
    }
  }
}
```

**Spec adjudication.** Rigging spec §7 (page 19) defines half-hitches as
first-class: *"The simplest rigs (i.e. the inductive/recursive base case)
are half-hitches. A half-hitch has the first four twists of a hitch, but
omits the post. Each hitch begins as a half-hitch, before its post is
added."* §7.2 (page 21) defines lashing in terms of a half-hitch (`bottom`)
attached to a top rig. The "in a rig consisting of a single hitch, the
topline functions as a corkline, and the footline as a leadline" sentence
(§7, page 19) makes the corkline-tied half-hitch explicitly valid.

**Verdict.** `clj` and `rust` are *over-strict* — they require a `post-key`
trie entry even when the last hitch is structurally a half-hitch. **JS is
correct** in accepting these.

**Rigs (clearest sub-cluster — `rust` reports `post-key`+MISMATCH explicitly):**

| Path | Declared | Tuple |
|---|---|---|
| `rigs/16-lashing-2-hitches-to-15.trdl` | green | `green\|red\|red\|red` |
| `rigs/27-intermediate-lines-change-tether-direction-via-corkline.trdl` | green | `green\|red\|red\|red` |
| `rigs/28-intermediate-lines-change-tether-direction-via-new-line.trdl` | green | `green\|red\|red\|red` |
| `rigs/29a-attempt-to-trigger-false-positive-on-tether-loop-detection.trdl` | green | `green\|red\|yellow\|red` |
| `rigs/30-example-rig-from-spec.trdl` | green | `green\|red\|yellow\|red` |
| `todatests/rigging/hitch_splice_post_no_lead_entry.toda` | red | `green\|red\|red\|red` |
| `todatests/rigging/post_rigging_missing_post_key.toda` | red | `green\|red\|red\|red` |

`rigs/30` is named "example rig from spec" — and JS correctly classifies it
green while `clj` and `rust` mark it red.

**Larger pattern.** A further ~14 rigs (`green|red|green|red`) listed
under C3 below match the same root cause but produce different rust
diagnostic strings, so they were bucketed separately by the detector.

---

### C2 — Missing topline atom: severity disagreement (13 rigs)

**Pattern.** The .toda file refers to a poptop/topline atom that isn't
bundled in the file. `clj` correctly reports yellow (MISSING). The other
three treat the absence as a hard error and report red (or in JS's case
throw `MissingError`).

**Tuple signature.** `red|yellow|red|red` (13 rigs, all from `todatests/rigging/`).

**Detail strings (representative — `complex_bad_hoist_direct_to_indirect.toda`):**

- `js`:   `MissingError: Missing topline hash` → red
- `clj`:  `yellow`
- `bb`:   `red`
- `rust`: `poptop 4147699aee… not found in file` → red

**Spec adjudication.** Spec §9.1.3 (page 30) is unambiguous:

> **MISSING**: indicates that a piece of required information was not provided.
> The status is marked as yellow if the result is marked with a yellow issue
> (ie. MISSING, UNKNOWN) and is not marked with a red issue.

Spec §2.5 (page 4): *"None of the error types at this level are fatal (so
they should all be treated as having a status colour of 'yellow'), but they
do differ in their severity."*

**Verdict.** `clj` is *spec-correct*. `bb`, `rust`, and `js` should be
reporting yellow here, not red. Note that the workshop's declared colour
for these rigs is `red` because the rigs are *designed* to be bad in
multiple ways, but with the canonical topline absent, the spec says all a
checker can prove is MISSING (yellow). The declared colour reflects intent
("this rig should fail in production with the topline available"); the
spec answer in the workshop's no-relay context is yellow.

**Rigs:**

| Path | Declared | Tuple |
|---|---|---|
| `todatests/rigging/complex_bad_hoist_direct_to_indirect.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/complex_bad_hoist_indirect_to_direct.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_mismatched_s_ss_values.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_no_s_lead.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_no_ss_lead.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_non_fast_meet.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_self_referential_rig.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_tether_missing.toda` | yellow | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_tether_not_twist.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_tether_null.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/hh_tether_symbol.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/self_referential.toda` | red | `red\|yellow\|red\|red` |
| `todatests/rigging/splice_mismatch.toda` | red | `red\|yellow\|red\|red` |

---

### C3 — `bb` accepts rigs the canonical checkers reject (22 rigs)

**Pattern.** `bb` reports green; `clj` and/or `rust` report red. Splits
along two lines:

**C3a — `bb` is correct, `clj`+`rust` are over-strict (≈10 rigs).** Workshop
rigs (`rigs/*`) declared green where `bb` agrees green and `clj`+`rust` fall
into the half-hitch trap from C1. Tuples are `green|red|green|red`.

| Path | Declared | Tuple |
|---|---|---|
| `rigs/4-lash-left-non-overlap-null.trdl` | green | `green\|red\|green\|red` |
| `rigs/6-lash-right-non-overlap.trdl` | green | `green\|red\|green\|red` |
| `rigs/31-irrelevent-tether-loop-after-corkline-reached.trdl` | green | `green\|red\|green\|red` |
| `tests/toda-graph/three-hitches-vertical.trdl` | green | `red\|red\|green\|red` |
| `tests/toda-core/twist-isolation-multi-line.trdl` | green | `red\|red\|green\|red` |
| `tests/toda-rig-checker/rigging-corkline-incomplete-early.trdl` | green | `red\|red\|green\|red` |
| `tests/toda-rig-checker/rigging-lash-non-colinear.trdl` | green | `red\|red\|green\|red` |
| `tests/toda-core/twist-chain-with-fields.trdl` | green | `red\|yellow\|green\|red` |

For these, `bb` matches the declared (spec-canonical) colour and the others
are wrong. Adjudication: **`bb` correct.**

**C3b — `bb` is actually wrong: declared-red rigs that `bb` calls green
(≈13 rigs).** These are rigs deliberately constructed to fail per spec; `bb`
fails to detect the problem.

| Path | Declared | Tuple |
|---|---|---|
| `rigs/5-lash-left-non-overlap-missing.trdl` | yellow | `red\|red\|green\|red` |
| `tests/test-suite/half-hitch-invalid-lead-not-tethered.trdl` | red | `green\|red\|green\|red` |
| `tests/test-suite/half-hitch-invalid-meet-not-fast.trdl` | red | `green\|red\|green\|red` |
| `tests/test-suite/half-hitch-valid-null-shield.trdl` | red | `green\|red\|green\|red` |
| `tests/test-suite/half-hitch-valid-with-shield.trdl` | red | `green\|red\|green\|red` |
| `tests/toda-rig-checker/half-hitch-footline-reaches-null.trdl` | red | `red\|red\|green\|red` |
| `tests/toda-rig-checker/half-hitch-lead-not-fast.trdl` | red | `green\|red\|green\|red` |
| `tests/toda-rig-checker/half-hitch-meet-not-fast.trdl` | red | `green\|red\|green\|red` |
| `tests/toda-rig-checker/half-hitch-topline-fastener-not-found.trdl` | red | `green\|red\|green\|red` |
| `tests/toda-rig-checker/half-hitch-valid.trdl` | red | `green\|red\|green\|red` |
| `tests/toda-rig-checker/hitch-lead-footline-reaches-null.trdl` | red | `green\|red\|green\|red` |
| `tests/toda-rig-checker/hitch-post-footline-reaches-null.trdl` | red | `red\|red\|green\|red` |
| `tests/toda-rig-checker/hitch-post-not-fast.trdl` | red | `green\|red\|green\|red` |
| `tests/toda-rig-checker/hitch-valid.trdl` | red | `green\|red\|green\|red` |

For `half-hitch-valid-null-shield.trdl` and `half-hitch-valid-with-shield.trdl`:
spec §6.1.1 (page 17) requires `lead.shld` be an arb shape; *"Setting it to a
shape other than arb results in an issue of INVALID in the lead's status."*
INVALID → red (§9.1.3). `clj` and `rust` catch this; `bb` (and `js`) miss it.

For `tests/test-suite/half-hitch-invalid-*`: the names themselves say
"invalid"; declared red. `bb` greenlights them — clearly wrong.

**Verdict (C3b):** `bb` has a class of bugs producing false-greens on
half-hitch-related rigs. It's the dominant defect across the dataset.

---

### C4 — `bb` over-cautious yellow (7 rigs)

**Pattern.** `js`, `clj`, and `rust` all agree green; `bb` alone reports
yellow. Tuple `green|green|yellow|green`.

| Path | Declared | Notes |
|---|---|---|
| `rigs/17-lashing-2-non-consecutive-hitches-to-15.trdl` | green | `bb` flags non-consecutive lashing |
| `rigs/22-indirect-tether-spliced-to-direct-tether.trdl` | yellow | declared yellow — `bb` matches declared |
| `rigs/23-indirect-tether-spliced-to-direct-tether-bad-post.trdl` | red | declared red, but everyone else green; possibly the workshop's heuristic decl is wrong here |
| `rigs/25-lashed-rigs-spliced-for-maximal-time-crossing.trdl` | yellow | declared yellow — `bb` matches declared |
| `tests/test-suite/complex-rig-22-indirect-to-direct-tether.trdl` | yellow | declared yellow — `bb` matches declared |
| `tests/test-suite/complex-rig-25-lashed-maximal-time-crossing.trdl` | yellow | declared yellow — `bb` matches declared |
| `tests/toda-rig-checker/rigging-valid-lash-and-splice.trdl` | red | declared red, but everyone else green |

**Spec adjudication.** This is the *interesting* category. For the
declared-yellow tests/* rigs (5 of 7), `bb` is the *only* checker that
agrees with the canonical .json. The yellow declaration likely reflects
"insufficient information to prove validity" — a MISSING/UNKNOWN status per
§9.1.3. `clj`, `rust`, and `js` are calling these green when the canonical
declaration says yellow — i.e. they're over-eagerly green.

**Verdict.** Mixed. For the 5 declared-yellow rigs, **`bb` matches the
canonical answer** and the other three are wrong (false-green). For the two
declared-red rigs (`rigs/23`, `rigging-valid-lash-and-splice`), all four
checkers disagree with the declaration; one of them may be a stale
heuristic colour rather than the spec answer.

---

### C5 — `rust` verifies known-bad rigs (2 rigs)

**Pattern.** `rust` reports verified green; the others all say red (or
mixed).

| Path | Declared | Tuple | Notes |
|---|---|---|---|
| `rigs/10-leadline-has-corkline-predecessor.trdl` | green | `red\|red\|red\|green` | JS: "Conflicting successors"; `clj` HTTP 400 "multiple successors"; `bb` red; `rust` verified |
| `tests/toda-graph/extra-fast-between-meet-and-post.trdl` | yellow | `red\|red\|yellow\|green` | declared yellow; `bb` correctly yellow; `clj` red; `rust` verified |

**Spec adjudication.** Spec §8.2 (page 27): *"No changes to rigging will be
made however, which undermine the fundamental rigging guarantee: that any
two twists `succA` and `succB` which are supported as successors of the same
twist `init` by colinear supports `suppA` and `suppB` will be colinear
themselves."*

For `rigs/10`, the conflicting-successors situation is *exactly* the
condition this guarantee addresses. JS, `clj`, and `bb` all detect the
multiple-successors anomaly. `rust` says verified — it's missing the
conflicting-successors check. **`rust` is wrong** on this rig.

For `extra-fast-between-meet-and-post`: declared yellow; `bb` correctly
yellow; `rust` says green. `rust` is missing the issue.

**Verdict.** `rust` has two specific cases where it accepts rigs that
violate spec guarantees. Worth filing as targeted bugs.

---

### C6 — JS crashes (8 rigs; 5 fixed in this commit)

**Status.** The workshop's JS checker `run` in `app.js` now catches errors
whose class name begins with `Missing` and returns `state: warn` (matching
spec §9.1.3 MISSING → yellow) rather than letting them propagate to the
outer FAIL handler. After the fix, 5 of the 8 rigs below correctly return
yellow; the other 3 stay red because their underlying error class is
`ReqSatError` (INVALID → red) or "Conflicting successors" (a real spec
violation per §8.2). The pre-fix data captured by the harness is preserved
below for the audit record.

**Pattern.** The JS checker throws an exception (often a JS runtime error,
not a `MissingError`) — rendered as FAIL with the error string as detail.

| Path | Declared | JS error |
|---|---|---|
| `tests/toda-abject/delegation-chain-4-level.trdl` | green | ReqSatError |
| `todatests/rigging/cork_missing_rigging.toda` | yellow | (rig-shaped error) |
| `todatests/rigging/corkline_incomplete_early_red.toda` | red | MissingHoistError |
| `todatests/rigging/corkline_incomplete_early_yellow.toda` | yellow | MissingHoistError |
| `todatests/rigging/hitch_hoist_rigs_missing.toda` | yellow | MissingHashPacketError |
| `todatests/rigging/invalid_rigging_green.toda` | green | (rig-shaped error) |
| `todatests/rigging/lashed_non_colinear.toda` | red | "Conflicting successors" |
| `todatests/rigging/missing_rigging.toda` | yellow | MissingHashPacketError |

**Spec adjudication.** Per spec §9.1.2 (page 29):

> A rig checker may treat an atomic error as a yellow error, and/or a shape
> error as a red, however it may also terminate without providing a status
> at all on either of these errors.

So a JS-side exception is *acceptable* per spec, but the workshop
classifies the result as "FAIL" (red). Where the underlying condition is
MISSING (`MissingHoistError`, `MissingHashPacketError`) it should be yellow.
Where it's a structural / atomic error, terminating-without-status is
allowed but the workshop should label it accordingly rather than as a hard
fail.

**Verdict.** Workshop UX issue: JS's exception path is mapped to FAIL
indiscriminately. For exceptions corresponding to MISSING conditions
(`MissingHoistError`, `MissingHashPacketError`), the result should be
classified as WARN/yellow to match spec.

The `delegation-chain-4-level.trdl` case is special: it's an *abject*
(compiled from TRDL) that the workshop's per-render abject detection
doesn't currently catch (only the byte-load path does, see
`abject-workshop.md`). That's a separate gap.

---

### C7 — Other multi-way splits (10 rigs)

These don't cleanly fit the categories above. Most involve a mix of the
half-hitch issue with secondary differences.

| Path | Declared | Tuple |
|---|---|---|
| `rigs/1-splice-no-post.trdl` | green | `green\|red\|yellow\|yellow` |
| `rigs/15-splicing-hitches-with-identical-toplines.trdl` | green | `green\|red\|yellow\|yellow` |
| `rigs/26-like-above-back-and-forth.trdl` | red | `green\|red\|yellow\|red` |
| `rigs/29-intermediate-lines-change-tether-direction-via-tether-loop.trdl` | green | `green\|red\|red\|red` |
| `tests/test-suite/complex-rig-26-lashed-complex.trdl` | red | `green\|green\|red\|green` |
| `tests/toda-rig-checker/api-valid-lashed-rig.trdl` | yellow | `green\|red\|yellow\|red` |
| `tests/toda-graph/multi-level-rig.trdl` | yellow | `green\|red\|yellow\|red` |
| `todatests/rigging/cork_prev_invalid_green.toda` | green | `green\|red\|green\|green` |
| `todatests/rigging/lash_succession_missing_prev.toda` | yellow | `red\|yellow\|yellow\|red` |
| `todatests/rigging/missing_shield.toda` | yellow | `red\|yellow\|yellow\|yellow` |

Highlights:

- `tests/test-suite/complex-rig-26-lashed-complex.trdl` (declared red):
  only `bb` correctly reports red; all three others say green. The 22-rig
  bb-false-green pattern reverses here — **`bb` is the only checker that
  catches the issue**.
- `cork_prev_invalid_green.toda` (declared green): three say green, `clj`
  alone says red. `clj` likely wrong.
- `lash_succession_missing_prev.toda`, `missing_shield.toda` (declared
  yellow): `clj` and `bb` correctly yellow per spec; JS / rust have
  variable failures.

---

## Sources of disagreement, summarized

1. **The half-hitch post convention.** `clj` and `rust` (and sometimes
   `bb`) require a `post-key` trie entry on every hitch, including the
   last one whose topline is the corkline. The spec (§7, page 19; §7.2,
   page 21) treats half-hitches as first-class and the corkline-tied
   half-hitch as the canonical terminating form. **Fix candidates:** `clj`
   and `rust` should accept half-hitches at the rig's terminal position.

2. **MISSING-vs-RED severity.** When required atoms (toplines, predecessors,
   shields) aren't bundled in the file, the spec is explicit: MISSING →
   yellow, not red (§9.1.3). Only `clj` honours this consistently. **Fix
   candidates:** `bb`, `rust`, and the JS `MissingError` path should
   downgrade to yellow.

3. **`bb` false-greens on canonical-bad rigs.** Across the
   `tests/toda-rig-checker/` half-hitch and hitch test suite, `bb` accepts
   rigs that are *designed* to be bad — INVALID shields, lead-not-fast,
   meet-not-fast, lead-not-tethered, etc. **This is the biggest defect in
   the dataset (13 rigs)** and represents real false-positives, not
   convention disagreements.

4. **`bb` over-yellow on lashing/splicing edge cases.** Five test rigs
   declared yellow are correctly flagged by `bb` and missed by the other
   three. Whether this is over-caution or correctness depends on what the
   declared yellow encodes — the named JSON ("indirect-tether-spliced-to-
   direct-tether", "lashed-maximal-time-crossing") suggests genuine
   "cannot prove" states, in which case `bb` is right.

5. **`rust` two specific holes.** Conflicting-successors and "extra fast
   between meet and post" are both not detected.

6. **JS error classification.** The workshop maps any JS exception to FAIL
   (red), but per spec, MISSING-class exceptions should be WARN (yellow).
   Eight rigs are mislabeled this way.

## Next steps

- File targeted issues per checker: `bb` half-hitch false-greens (13
  rigs); `rust` conflicting-successors + extra-fast (2 rigs);
  `clj`/`rust` post-key-on-corkline-terminal (≈14 rigs); `bb`/`rust`
  missing→yellow severity (13 rigs); JS exception-class mapping.
- Re-run `cork_reqsat_fail.toda` standalone to capture the result that
  timed out here.
- Decide whether the workshop should display the workshop-declared
  colour as a fifth column, surfacing declaration-vs-checker
  disagreements directly in the UI.
