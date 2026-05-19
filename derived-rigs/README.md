# derived-rigs

Workshop-compiled .toda bytes for the .trdl-only fixtures referenced by
the workshop's disagreement / roundtrip benches. Each fixture has
three files (or two, for the circular-dep cases that fail to compile):

- `*.trdl`  — verbatim copy of the source fixture
- `*.toda`  — bytes produced by `toda/compile.js`
- `*.json`  — heuristic sidecar (moniker + heuristic colour pulled from
              the workshop's RIGS table; not spec-canonical, unlike
              todatests/rigging/*.json)

Generated 2026-05-18. 64 fixtures compiled successfully, 2 stubs.

## Source paths

- `rigs/1-splice-no-post.trdl` (green)
- `rigs/10-leadline-has-corkline-predecessor.trdl` (green)
- `rigs/11-bottom-fastener-not-fast.trdl` (red)
- `rigs/12-bottom-hoist-not-fast.trdl` (red)
- `rigs/13-bottom-corkline-top-leadline.trdl` (green)
- `rigs/14-bottom-corkline-shorter-than-top-leadline-both-sides.trdl` (green)
- `rigs/15-splicing-hitches-with-identical-toplines.trdl` (green)
- `rigs/16-lashing-2-hitches-to-15.trdl` (green)
- `rigs/17-lashing-2-non-consecutive-hitches-to-15.trdl` (green)
- `rigs/18-lashing-to-2-hitch-splice-with-missing-right-hoist.trdl` (yellow)
- `rigs/19-fast-line-multiply-lashed-up-to-slow-line.trdl` (yellow) — compile error: Circular dependency in twist specs: poptop_1,abject_2,abject_3,abject_4,a_2,a_3,
- `rigs/2-right-fast-first.trdl` (green)
- `rigs/20-slow-line-lashed-up-to-fast-line.trdl` (yellow) — compile error: Circular dependency in twist specs: poptop_3,poptop_4,poptop_5,poptop_6,poptop_7
- `rigs/21-direct-tether-spliced-to-indirect-tether.trdl` (green)
- `rigs/22-indirect-tether-spliced-to-direct-tether.trdl` (yellow)
- `rigs/23-indirect-tether-spliced-to-direct-tether-bad-post.trdl` (red)
- `rigs/24-direct-tether-spliced-to-indirect-tether-bad-post.trdl` (red)
- `rigs/25-lashed-rigs-spliced-for-maximal-time-crossing.trdl` (yellow)
- `rigs/26-like-above-back-and-forth.trdl` (red)
- `rigs/27-intermediate-lines-change-tether-direction-via-corkline.trdl` (green)
- `rigs/28-intermediate-lines-change-tether-direction-via-new-line.trdl` (green)
- `rigs/29-intermediate-lines-change-tether-direction-via-tether-loop.trdl` (green)
- `rigs/29a-attempt-to-trigger-false-positive-on-tether-loop-detection.trdl` (green)
- `rigs/3-normally-expected-splice.trdl` (green)
- `rigs/30-example-rig-from-spec.trdl` (green)
- `rigs/31-irrelevent-tether-loop-after-corkline-reached.trdl` (green)
- `rigs/4-lash-left-non-overlap-null.trdl` (green)
- `rigs/5-lash-left-non-overlap-missing.trdl` (yellow)
- `rigs/6-lash-right-non-overlap.trdl` (green)
- `rigs/7-corkline-self-tether.trdl` (green)
- `rigs/8-splice-on-mutual-tether.trdl` (green)
- `rigs/9-leadline-equivocal-from-corkline.trdl` (red)
- `tests/test-suite/complex-rig-21-direct-to-indirect-tether.trdl` (green)
- `tests/test-suite/complex-rig-22-indirect-to-direct-tether.trdl` (yellow)
- `tests/test-suite/complex-rig-25-lashed-maximal-time-crossing.trdl` (yellow)
- `tests/test-suite/complex-rig-26-lashed-complex.trdl` (red)
- `tests/test-suite/half-hitch-invalid-lead-not-tethered.trdl` (red)
- `tests/test-suite/half-hitch-invalid-meet-not-fast.trdl` (red)
- `tests/test-suite/half-hitch-valid-null-shield.trdl` (red)
- `tests/test-suite/half-hitch-valid-with-shield.trdl` (red)
- `tests/toda-core/twist-chain-with-fields.trdl` (green)
- `tests/toda-core/twist-isolation-multi-line.trdl` (green)
- `tests/toda-graph/basic-half-hitch.trdl` (green)
- `tests/toda-graph/extra-fast-between-meet-and-post.trdl` (yellow)
- `tests/toda-graph/full-hitch-with-post.trdl` (red)
- `tests/toda-graph/multi-level-rig.trdl` (yellow)
- `tests/toda-graph/three-hitches-horizontal.trdl` (green)
- `tests/toda-graph/three-hitches-vertical.trdl` (green)
- `tests/toda-rig-checker/api-valid-lashed-rig.trdl` (yellow)
- `tests/toda-rig-checker/half-hitch-footline-reaches-null.trdl` (red)
- `tests/toda-rig-checker/half-hitch-lead-mismatch.trdl` (red)
- `tests/toda-rig-checker/half-hitch-lead-not-fast.trdl` (red)
- `tests/toda-rig-checker/half-hitch-meet-not-fast.trdl` (red)
- `tests/toda-rig-checker/half-hitch-topline-fastener-not-found.trdl` (red)
- `tests/toda-rig-checker/half-hitch-valid.trdl` (red)
- `tests/toda-rig-checker/hitch-lead-footline-reaches-null.trdl` (red)
- `tests/toda-rig-checker/hitch-post-footline-reaches-null.trdl` (red)
- `tests/toda-rig-checker/hitch-post-not-fast.trdl` (red)
- `tests/toda-rig-checker/hitch-valid.trdl` (red)
- `tests/toda-rig-checker/rigging-corkline-incomplete-early.trdl` (green)
- `tests/toda-rig-checker/rigging-corkline-incomplete-late.trdl` (red)
- `tests/toda-rig-checker/rigging-lash-non-colinear.trdl` (green)
- `tests/toda-rig-checker/rigging-valid-lash-and-splice.trdl` (red)
- `tests/toda-rig-checker/rigging-valid-simple-lash.trdl` (red)
- `tests/toda-rig-checker/rigging-valid-spliced-unit-rigs.trdl` (green)
- `tests/toda-rig-checker/rigging-valid-unit-rig.trdl` (red)
