# v1-tests: findings and questions

From the rigging workshop team, 2026-08-12, against todatests `fd24a64`.

We wired all 6,708 v1-tests fixtures into the workshop, compiled them, and ran
them through three rig-checkers (rustoda, todajs, rignet) to compare each
fixture's declared colour against what the checkers actually say.

Full detail and reproduction steps: `riggingworkshop/v1-tests-review.md`.

---

## The headline: the sidecar revision worked

Adopting the invariance principle in `88e2b2f` — *a verdict cannot flip on
bytes the rig walk never consults* — moved rustoda's agreement with your
declared colours from **17% to 56%**, and on three families to near-total:

| Family | before | after |
|---|---|---|
| Reqsat_list (1,575) | 1% | **99%** |
| secp256r1_reqsat (525) | 1% | **100%** |
| ed25519_reqsat (524) | 1% | **99%** |
| Invariance (31) | — | 90% |
| Plural (9) | — | 100% |

We reached the same conclusion independently by measurement before seeing your
sidecars, so this is two teams converging on one reading of the spec. The
workshop now treats the sidecar colour as authoritative and shows the
superseded header verdict struck through.

Also confirmed fixed: the Lat error colours (`d901db9`). 6,674 of 6,708
fixtures compile.

---

## Four things to fix

**1. 2,885 sidecars contradict themselves.** The generator reclassified
`colour` but copied `detail` from the old header, so the common shape is:

```json
{ "colour": "green", "detail": "RED (succession.predecessor INVALID)" }
```

Both fields are machine-read, so this will cause silent misreads. Either
regenerate `detail`, or keep the old verdict under a name that says what it is
(`superseded_detail`). We'd prefer the rename — the previous verdict is
genuinely useful, and we already display it.

**2. The invariance reasoning is attached to 23 of the 2,910
reclassifications.** 62 sidecars are "rich" (53 with an `invariant` block);
the other 2,887 changes are bare. The argument is well written where it
appears — it just needs to be referenced rather than repeated, e.g.
`"invariant": "carg-not-consulted"` resolving to one shared statement.

**3. Two fixtures can't compile — invalid JSONL.** Both in
`Half_hitch/hoist_incorporates_lead_and_meet_with_non-NULL_shield/`:
`lead_shld_alg_!=_lead_alg_and_hoisting_uses_lead_alg_for_s.trdl` and
`…_uses_lead_shld_alg_for_s.trdl`. Each spreads one JSON object across several
physical lines; TRDL is one object per line.

**4. `VALID` and `GREEN` are used interchangeably** (67 files say `VALID`), and
11 files underscore-join the expectation (`RED_(ed25519-reqsat_INVALID)`).
Harmless once normalised, but it's a machine-read field.

Not a defect, for the record: `Lat/valid_one_hitch_rig.trdl` has no expectation
header, which is correct — it's a base template, not a test. We miscounted it
as a defect initially.

---

## Three questions

**Q1. When the rig walk doesn't consult a field, is the result `nospec` or
green?**

This is the one question your remaining disagreement reduces to. After the
revision, the largest residual bucket is 1,774 fixtures declared yellow where
rustoda says green, concentrated in `Basic_Twist` (1% agreement), `Hash` (0%),
`Hitch` (3%) and `Packet` (2%).

These are the same argument as the invariance principle, applied to shape/alg
enumerations rather than to cargo. If the answer is "green", finishing the
reclassification there would likely take overall agreement past 80%.

**Q2. Do 251 `Basic_Twist/body_shape` fixtures need rerating?**

The spreadsheet is explicit — R105 `body.shape = 0x00-0x48` and R107
`0x4a-0xff` are both `twist.body INVALID` — while the fixtures declare
`YELLOW (nospec)`. Your `sats_shape` family declares the same way, so this is
consistent editorial practice, not a slip. It's really Q1 again in a different
place, but worth deciding explicitly because the spreadsheet disagrees in
writing.

**Q3. Should a rig checker's *error* be a colour at all?**

Not strictly a todatests question, but it affects how your corpus can be
scored. rustoda treats a malformed atom as a judgeable condition and returns a
colour. todajs and rignet throw — so **on ~94% of your corpus they return no
verdict at all**, because most fixtures are built from deliberately malformed
atoms. Our view is that a crash is not a verdict and must never be scored as
one; we'd like agreement on that before publishing any pass-rate number
against v1-tests.

(Separately: todajs reds 57 of 58 fixtures that everyone agrees should be
green, via `ReqSatError`. That's a checker bug, not yours — we're raising it
with that team, and your corpus is what found it.)

---

## One proposal: ranges instead of enumeration

About half the corpus exists to enumerate byte values inside a range the
spreadsheet states once, and 2,261 fixtures assert `nospec`. If TRDL gained a
parameter, one fixture could cover one spreadsheet row:

```jsonl
{"param": "s", "range": [0, 72]}
{"atom": "fakebody", "alg": "sha256", "shape": "param(s)", "data": "hex(00)"}
```

372 spreadsheet rows → ~372 fixtures instead of 6,708, with 1:1 traceability
and range edits becoming one-line changes. The costs are real: failures need
addressing like `fixture.trdl[s=0x8d]`, and it pulls against the per-file
`.json` sidecars you just generated. Worth deciding the direction before more
per-file infrastructure accumulates — we're not asking you to act now, only to
say whether it's a direction you'd want.

---

## What we'd find most useful

1. A ruling on Q1 — it's worth more than everything else combined.
2. `detail` regenerated or renamed (fix 1).
3. Whether ranges are a direction worth pursuing.

Happy to do any of the mechanical work on our side if that's easier; the
fixture-level judgement calls are the parts we can't make for you.
