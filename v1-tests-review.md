# v1-tests: a review from four angles

A review of `todatests/v1-tests/` — the 6,633-fixture spec-conformance corpus
added in todatests `3e8dfb7` — against the specification spreadsheet it was
derived from, against the rig-checker implementations that are supposed to
answer it, and against the TRDL compiler that has to build it.

Measured 2026-08-12. Reproduce with `tmp/spec-join.mjs` (spec axis) and
`tmp/v1-checker-sweep.js` driven from the workshop page (implementation axis).

---

## 0. The one-paragraph version

The corpus is mechanically excellent and conceptually mismatched with its
consumers. Every fixture but one maps cleanly onto a row of the spec
spreadsheet, and 6,605 of 6,633 now compile. But **on 95% of the corpus, two
of the three local rig-checkers cannot return a verdict at all** — they throw
while parsing the deliberately-malformed atoms the fixtures are built from.
The third (rustoda) does return a colour, and disagrees with the fixture's
declared colour on 83% of what it evaluates. Most of that disagreement is not
a bug in either party: a large fraction of v1-tests asks *atom- and
body-shape* questions that a *rig* checker is not scoped to answer. The
corpus and the checkers are talking past each other, and the spreadsheet's
"(Captured in Rig Checks)" annotation is the assumption that fails.

---

## 1. What the corpus is

| | |
|---|---|
| Fixtures | 6,633 `.trdl` |
| Layout | `v1-tests/<Structure>/<Property>/<Condition>.trdl`, 19 structures |
| Metadata | 4-line comment header, **no `.json` sidecars** |
| Largest families | Reqsat_list 1,585 · Basic_Body 1,558 · Half_hitch 1,062 |

Declared colours: **3,295 yellow · 3,267 red · 70 green**. Of the yellows,
2,261 are `YELLOW (nospec)` — a third of the whole corpus asserts that the
specification says nothing about the case.

The header format is a genuine improvement over the `.json` sidecars used by
`rigging/` and `reqsat/`: the expectation lives in the file it describes, and
it records *why* (`Structure` / `Property` / `Condition`) rather than only
*what*. The workshop now reads it directly.

---

## 2. Against the spec spreadsheet

Joined every fixture header against `test-descs/Test Coverage-Table 1.csv`
(372 rows, 263 of which carry a colour-bearing Expected Eval). The join is
many-to-one: the sheet states conditions as ranges (`body.shape = 0x00 -
0x48`) that fixtures expand one file per byte.

| | |
|---|---|
| Fixtures matched to a sheet row | 6,632 / 6,633 |
| — via exact condition text | 208 |
| — via range containment | 3,320 |
| — via (structure, property) bucket only | 3,104 |
| Colour-bearing sheet rows covered | **205 / 263** |
| Sheet rows with no fixture | **58** |
| Fixture/sheet colour conflicts | **263** |

### 2.1 The corpus is an ~18× expansion of the spreadsheet

372 sheet rows became 6,633 fixtures. Half the corpus (3,320) exists to
enumerate byte values inside a range the sheet states once. This is the
corpus's defining design decision and it deserves scrutiny — see §5.

### 2.2 Uncovered spec rows (58)

| Count | Structure |
|---|---|
| 19 | ed25519 reqsat — sheet says **NOT IMPLEMENTED** |
| 8 | secp256r1 reqsat |
| 8 | Half-hitch |
| 7 | Reqsat list |
| 5 | Basic Body (Captured in Rig Checks) |
| 4 | Pairtrie · 4 ReqSat · 1 each Basic Twist / Succession / Hitch |

The ed25519 block is the sheet's own acknowledged hole, so 19 of the 58 are
not really the corpus's debt. The 8 Half-hitch and 7 Reqsat list gaps are the
substantive ones: those are rig-shaped conditions the checkers *can* answer,
which is exactly where fixtures are most valuable.

### 2.3 Colour conflicts (263) — three distinct causes

**(a) 251 × Basic Twist `body.shape` — the corpus contradicts the sheet.**

The sheet is unambiguous across three rows:

| Row | Condition | Expected Eval |
|---|---|---|
| R105 | `body.shape = 0x00 - 0x48` | twist.body INVALID → **red** |
| R106 | `body.shape = 0x49` | valid → green |
| R107 | `body.shape = 0x4a - 0xff` | twist.body INVALID → **red** |

251 of the 259 fixtures in `Basic_Twist/body_shape_=_0x49/` declare
`YELLOW (nospec)`; only 4 declare `RED (twist.body INVALID)`, 3
`RED (shape error)`, 1 `VALID`.

This is **not** authoring drift — it is a coherent editorial stance applied
consistently. The sibling family declares the same way: `sats_shape` is
251 nospec + 6 `RED (sattrie INVALID)` + 2 `VALID`. In both, the corpus marks
only the specific byte values the spec *names* as invalid, and treats the
large unassigned ranges as **unspecified**. The spreadsheet does the
opposite: it sweeps whole ranges into `INVALID`.

So the disagreement is a real semantic question, not a typo:

> **When a shape byte is not assigned by the specification, is the twist
> `INVALID` (spreadsheet) or is the behaviour `nospec` (corpus)?**

Both positions are defensible — "unassigned means nothing may rely on it" vs
"unassigned means undefined, so no verdict is mandated". It needs one ruling,
and that ruling propagates to ~500 fixtures across both families and to every
other `*_shape` and `*_alg` enumeration in the corpus.

**(b) 9 × atomic/lat error — an inherited deviation.**

7 Lat + 2 Packet fixtures declare **red** where the sheet's `lat error` /
`atomic error` maps to **yellow** per the conversion rule. This is precisely
the deviation `SPREADSHEET_DEVIATIONS.md` §2 already documented for the older
`atomic/` fixtures. v1-tests reproduced it rather than resolving it, so the
same open question now exists in two places.

**(c) 3 × one-off.** 2 Half-hitch (`hoist INVALID or hoist UNKNOWN` — the
sheet itself is ambiguous here, offering two evals) and 1 Basic Body fixture
declaring red against a sheet `valid`.

---

## 3. Against the implementations

Compiled all 6,633 and ran the three in-browser checkers. **6,340 reached the
checkers**; 28 fail to compile (documented in CLAUDE.md) and 265 produce no
corkline (the raw-atom `Packet` / `Lat` families, which have no rig).

> Scope: the two server checkers (`clj`, `bb`) are excluded. One HTTPS
> round-trip per rig per checker is ~13k requests against a shared ALB for a
> single sweep. Every claim in this section is about `js · todajs`,
> `rust · rustoda` and `rignet · ts` only.

### 3.1 The headline: most checkers cannot answer most of the corpus

| Checker | Returned a verdict | Could not evaluate |
|---|---|---|
| `rust · rustoda` | **6,340 / 6,340** | 0 |
| `js · todajs` | 319 (5%) | **6,021 — threw during parse** |
| `rignet · ts` | 270 (4%) | **6,070 — threw during check** |

The failure modes are parser strictness, not checker logic:

- **js** throws `SHAPE_UNKNOWN` (5,768) and `Unknown algorithm code` (250) out
  of `Atoms.fromBytes` — before any rig logic runs.
- **rignet** throws `Unknown packet shape` (~2,400+) and `Unknown hash algo`
  (251) inside its own atom parser.
- **rustoda** parses leniently and *returns a colour*, including a red with a
  diagnostic (`parse error: Unknown algorithm byte 0x.. at offset N`, 252
  cases) where the others abort.

This is a real, load-bearing difference in implementation philosophy, and a
corpus built almost entirely from intentionally-malformed atoms is precisely
the instrument that exposes it. **A malformed atom is a verdict-worthy
condition to rustoda and an exception to the other two.**

> **Correction to an earlier reading.** Opening a single fixture in the
> workshop shows all five checker rows saying `FAIL … SHAPE_UNKNOWN`, which
> looks like unanimous agreement. It is not. `app.js:1497-1503` catches a
> ctx-construction failure and renders *the same message into every row* to
> keep the panel layout stable. One svgiewer parse failure is being displayed
> five times. The panel cannot currently distinguish "all checkers agree" from
> "no checker ran."

### 3.2 Where rustoda lands, and why agreement is low

Across the 6,340 it evaluated: **green 4,248 · yellow 1,564 · red 528**.
Against declared colour it matches **1,091 (17%)**.

Of the 4,248 it calls green, 2,677 are declared **red** and 1,517 declared
**yellow**.

Agreement is not uniformly bad — it splits cleanly by what the fixture is
*about*:

| Structure | n | rustoda agreement |
|---|---|---|
| Basic_Rig | 5 | **80%** |
| Succession | 14 | 50% |
| Basic_Lash_mechanics | 2 | 50% |
| Half_hitch | 1,060 | **49%** |
| Basic_Body | 1,558 | 33% |
| ReqSat | 11 | 27% |
| Basic_Twist | 521 | 2% |
| Hitch | 267 | 2% |
| Reqsat_list | 1,575 | **1%** |
| ed25519_reqsat | 526 | **1%** |
| secp256r1_reqsat | 525 | **1%** |
| Hash | 253 | 1% |

The pattern is the conclusion. Families that ask **rig-topology** questions
(Basic_Rig, Half_hitch, Succession) get 49–80% agreement. Families that ask
**field-shape** questions get 1–2%, and rustoda returns a uniform green:
Reqsat_list 1,575/1,575 green, ed25519_reqsat 526/526 green,
secp256r1_reqsat 525/525 green.

A rig checker walking a rig it finds structurally sound reports green. It is
not asked, and does not answer, "is this body's `carg` field a trie?" The
spreadsheet's own annotation — *"Basic Body (Captured in Rig Checks)"*,
*"Basic Twist (Captured in Rig Checks)"* — asserts that these conditions
**are** captured by rig checking. **Measured against rustoda, that assertion
is false for ~3,200 fixtures.** Either the checkers need a shape-validation
pass they don't have, or those fixtures need a different harness than a rig
checker.

### 3.3 The declared-VALID sanity set — where a real bug shows

59 fixtures declared VALID reached the checkers. These are the subset where
every implementation should agree, and disagreement is unambiguously a defect
somewhere.

| Checker | green on declared-VALID |
|---|---|
| `rignet` | 54 / 59 |
| `rust` | 53 / 59 |
| `js` | **1 / 58 that ran** |

`js · todajs` calls almost every should-be-valid fixture red, overwhelmingly
via `ReqSatError` (276 occurrences overall). CLAUDE.md already flags one such
case as long-standing and predating the 2026-08-12 compiler work. This sweep
shows it is not one case: **it is the js checker's behaviour on essentially
every v1-tests rig that uses the default `reqsat: ed25519` line.** That is the
most actionable implementation finding in this review, because unlike §3.2 it
is not a scope mismatch — these fixtures are rig-shaped and should pass.

The 6 fixtures where rustoda is not green on a declared-VALID case are worth
individual attention; two of them (`Half_hitch/…/valid_hitch_with_no_
succession_chain_connecting_lead_teth_and_meet_teth`, and its `Hitch`
sibling) are red on **all three** checkers, which suggests the fixtures'
declared colour, not the implementations, is what needs revisiting.

---

## 4. Against the TRDL compiler

Not the focus of this review — CLAUDE.md tracks it — but the corpus was an
effective forcing function. Compiling fixtures went 659 → 3,208 → 6,605 over
two days as it drove out bare hex/octal literals, atom entities as
first-class references, `name[i]suffix` tokens, rslist `"none"`, and
`shield()`. 28 remain, of which 2 are fixture bugs (JSONL violations) and 8
are rejected by design.

Worth noting what this means for the corpus's *own* validity: until this
week, **no one could build 90% of these fixtures**, so their declared colours
had never been executed against anything. The colours are authored
assertions, not observed results — which is the right way to read every
number in §3.

---

## 5. The corpus as an artifact — design critique

**The exhaustive-enumeration pattern.** Roughly half the corpus enumerates
every byte in a range: 256 `carg_shape=0x00…0xff` fixtures, 256 for `reqs`,
`rigs`, `shld`, `teth`, `prev`, and so on. Strengths: total, mechanical, no
judgement calls, and trivially auditable against a sheet range. Weakness:
**2,261 fixtures assert `nospec`** — that the specification says nothing.
Enumerating 200+ separate files to record "undefined behaviour" buys very
little that one range-fixture plus a comment would not, and it dominates
every aggregate statistic computed over the corpus. Any future
agreement-rate metric will be swamped by nospec cases unless they are
deliberately excluded.

**Recommend:** keep the enumeration, but make `nospec` machine-separable —
the header term is already there, so any harness can and should stratify by
it. Do not report a single corpus-wide "pass rate"; it will be meaningless.

**Defects found** (all minor, all fixable):

1. `Lat/valid_one_hitch_rig.trdl` — the only fixture of 6,633 with no header
   block. It gets no dot, no metadata, and no spec-row match.
2. Two fixtures under
   `Half_hitch/hoist_incorporates_lead_and_meet_with_non-NULL_shield/` spread
   one JSON object across several physical lines, which JSONL forbids. They
   cannot compile.
3. `VALID` and `GREEN` are used interchangeably (67 files say `VALID`), and
   11 files underscore-join the expectation
   (`RED_(ed25519-reqsat_INVALID)`). Harmless once normalised, but it is
   avoidable inconsistency in a machine-read field.
4. todatests' own `CLAUDE.md` and `README.md` still describe the pre-v1-tests
   layout and make no mention of the directory that is now 95% of the repo.

---

## 6. Conclusions

1. **The corpus is sound as a specification artifact and traceable to its
   source.** 6,632 of 6,633 fixtures map to a spreadsheet row. That is
   unusually good provenance for a test corpus this size.

2. **It is not yet usable as a pass/fail suite against rig checkers**, and no
   amount of compiler work will make it so. Two of three checkers cannot
   parse 95% of it, and the third answers a different question than the one
   ~3,200 fixtures ask.

3. **The single most valuable fix is on the implementation side, not the
   corpus side:** `js · todajs` returning red on 57 of 58 declared-VALID
   fixtures via `ReqSatError` is a real defect with a bounded, well-specified
   reproduction set.

4. **One semantic question needs a human ruling, and it is bigger than its
   251-fixture headline.** The corpus treats spec-unassigned shape/alg bytes
   as `nospec`; the spreadsheet treats them as `INVALID`. Both are coherent,
   both are applied consistently, and they cannot both stand. The ruling
   governs every `*_shape` / `*_alg` enumeration in the corpus — well over a
   thousand fixtures — not just the 251 that happen to surface as conflicts
   against colour-bearing sheet rows.

5. **The `atomic error` / `lat error` → yellow-or-red question is now open in
   two places.** It was already documented for `atomic/`; v1-tests reproduced
   the same 9 conflicts. Resolve it once, in the conversion rule, and apply
   to both.

6. **The parse-strictness split is a finding in its own right**, independent
   of this corpus. rustoda treats a malformed atom as a red verdict with a
   diagnostic; svgiewer and rignet treat it as an exception. For a system
   whose whole purpose is to render a colour for untrusted bytes, "throws"
   is arguably the wrong answer, and this corpus makes the case at scale.

### Recommended next steps, in order

1. Fix the workshop's fatal-for-everyone panel path so "no checker ran" is
   visually distinct from "all checkers agree" (§3.1). It is currently
   actively misleading, and it misled this review.
2. Investigate `ReqSatError` in `js · todajs` against the 58-fixture
   declared-VALID set (§3.3).
3. Get a ruling on unassigned shape/alg bytes — `nospec` or `INVALID` (§2.3a).
4. Decide whether field-shape conditions are in scope for rig checkers. If
   yes, that is a substantial implementation programme across three
   codebases; if no, ~3,200 fixtures need a different harness and should stop
   being measured against rig checkers (§3.2).
5. Fix the 4 corpus defects in §5 — an afternoon's work.
6. Re-run this review including `clj` and `bb` on a stratified sample once
   the above lands.
