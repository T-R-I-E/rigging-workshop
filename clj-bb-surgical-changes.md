# Surgical CLJ / BB changes for the rigging workshop

Notes captured from `disagreement-bench.html` (2026-05-18 run, 135
fixtures, 4 checkers). Goal: a tight list of concrete starting
points for the toda-clj / toda-bb rig-checker maintainers. Sister
doc to `js-rig-checker-surgical-changes.md`.

## Background: which checker is the reference

The bench compares each checker's verdict against a *canonical* colour:

- `todatests/rigging/*` — pulled from the sidecar `.json` (committed
  alongside the `.toda` fixture; spec-cited in the fixture's
  `invariant` block).
- `rigs/*`, `tests/*` — heuristic colour hand-set in
  `editor.js`'s RIGS table (no sidecar). Less authoritative than
  sidecar but mostly correct for the canonical happy/sad paths.

Per-checker disagreement counts (135 fixtures, 2 errors excluded):

| checker | total disagree | todatests/rigging (sidecar-authoritative) | non-todatests |
|---|---:|---:|---:|
| rust  | 36 | 4 | 32 |
| bb    | 49 | 14 | 35 |
| clj   | 51 | 14 | 37 |
| js    | 52 | 15 | 37 |

Rust is the strongest baseline (the 2026-05-18 WASM rebuild picked up
the spec §9.5 hoist re-labelling). Where clj/bb disagree with rust
*and* the canonical, that's the highest-confidence bug signal.

## CLJ: two systematic bugs

### CLJ-A. False-red on valid splices (large cluster)

`clj` rejects many spec-green splices as red. In every case below
the canonical is green, the sidecar (when present) is green, and at
least one of `js` / `rust` agrees green:

| fixture | js | clj | bb | rust |
|---|---|---|---|---|
| `rigs/1-splice-no-post` | green | **red** | yellow | green |
| `rigs/4-lash-left-non-overlap-null` | green | **red** | green | red |
| `rigs/6-lash-right-non-overlap` | green | **red** | green | yellow |
| `rigs/15-splicing-hitches-with-identical-toplines` | green | **red** | yellow | green |
| `rigs/16-lashing-2-hitches-to-15` | green | **red** | red | green |
| `rigs/27-intermediate-lines-change-tether-direction-via-corkline` | green | **red** | red | green |
| `rigs/28-…-via-new-line` | green | **red** | red | green |
| `rigs/29-…-via-tether-loop` | green | **red** | broke | yellow |
| `rigs/29a-attempt-to-trigger-false-positive-on-tether-loop-detection` | green | **red** | yellow | green |
| `rigs/30-example-rig-from-spec` | green | **red** | yellow | green |
| `rigs/31-irrelevent-tether-loop-after-corkline-reached` | green | **red** | green | red |
| `todatests/rigging/splice_chain_4hitches` | green | **red** | red | green |

Several of these share a structural feature: **a splice or lashing
that reaches the corkline through more than one intermediate line**.
`splice_chain_4hitches` (4 consecutive half-hitches sharing the
corkline) and `rigs/30-example-rig-from-spec` (the spec's own appendix
B example) are the cleanest reproducers; both rust and js agree green
and both have canonical green.

Suspected root cause (educated guess from the names): the
extend-forward loop (§7.3) over-eagerly bails when a previously-seen
fastener reappears, even when reappearance is legal (corkline
revisits during a multi-line traversal).

Starting points to triage:

1. `splice_chain_4hitches.toda` — minimal hand-written 4-deep splice
   chain. Should be green; clj returns red.
2. `rigs/30-example-rig-from-spec.trdl` — straight out of spec
   appendix B.
3. `rigs/29a-attempt-to-trigger-false-positive-on-tether-loop-detection.trdl`
   — name says it all; designed to surface tether-loop false-positives.
   clj still trips on it.

### CLJ-B. `tether_loop` (spec §7.2 depth-cap reading)

`todatests/rigging/tether_loop.toda` — canonical **yellow** per
todatests commit 6720c79: "depth-cap reading (spec §7.2: red 'would
be inappropriate' when the loop was avoided by a height limit)".

| js | clj | bb | rust |
|---|---|---|---|
| green | **red** | broke (HTTP 400) | yellow |

rust agrees yellow with canonical. clj reports red — likely missing
the spec §7.2 "loop avoided via depth-cap → UNKNOWN" branch and
treating the height-cap-triggered short-circuit as a fatal loop.

(The bb HTTP 400 on this fixture is logged separately under BB-C.)

## BB: three systematic bugs

### BB-A. False-yellow on valid green splices

Mirror of CLJ-A but failing softer. Same fixture cluster:

| fixture | bb | (rust/js consensus) |
|---|---|---|
| `rigs/1-splice-no-post` | yellow | green |
| `rigs/15-splicing-hitches-with-identical-toplines` | yellow | green |
| `rigs/17-lashing-2-non-consecutive-hitches-to-15` | **yellow** | green (clj also green) |
| `rigs/22-indirect-tether-spliced-to-direct-tether` | yellow | green (also: canonical was yellow per heuristic; this case is ambiguous) |
| `rigs/29a-attempt-to-trigger-false-positive-on-tether-loop-detection` | yellow | green |
| `rigs/30-example-rig-from-spec` | yellow | green |
| `tests/test-suite/complex-rig-22-indirect-to-direct-tether` | yellow | green |
| `tests/test-suite/complex-rig-25-lashed-maximal-time-crossing` | yellow | green |
| `todatests/rigging/nested_lash_in_splice` | yellow | green (clj, js, rust all agree) |

`nested_lash_in_splice` is the cleanest reproducer: canonical green,
js/clj/rust all green, bb yellow.

Suspected root cause: bb's traversal returns UNKNOWN (yellow) in
cases where the canonical reading is GREEN — possibly an overcautious
"haven't proven valid" default vs. spec §9.1.2's "checker that has
seen enough atoms to verify must return GREEN".

### BB-B. False-green on canonical-red half-hitch invariant violations

`bb` says green on a striking cluster of canonical-red half-hitch
fixtures, paired with `js` also saying green and `clj`+`rust` saying
red:

| fixture | js | clj | bb | rust |
|---|---|---|---|---|
| `tests/test-suite/half-hitch-invalid-lead-not-tethered` | green | red | **green** | red |
| `tests/test-suite/half-hitch-invalid-meet-not-fast` | green | red | **green** | red |
| `tests/test-suite/half-hitch-valid-null-shield` | green | red | **green** | red |
| `tests/test-suite/half-hitch-valid-with-shield` | green | red | **green** | red |
| `tests/toda-rig-checker/half-hitch-footline-reaches-null` | red | red | **green** | red |
| `tests/toda-rig-checker/half-hitch-lead-not-fast` | green | red | **green** | red |
| `tests/toda-rig-checker/half-hitch-meet-not-fast` | green | red | **green** | red |
| `tests/toda-rig-checker/half-hitch-topline-fastener-not-found` | green | red | **green** | red |
| `tests/toda-rig-checker/half-hitch-valid` | green | red | **green** | red |
| `tests/toda-rig-checker/hitch-lead-footline-reaches-null` | green | red | **green** | red |
| `tests/toda-rig-checker/hitch-post-footline-reaches-null` | red | red | **green** | red |
| `tests/toda-rig-checker/hitch-post-not-fast` | green | red | **green** | red |
| `tests/toda-rig-checker/hitch-valid` | green | red | **green** | red |

This is the largest single bb-specific cluster. Hypothesis: bb
short-circuits at "found a half-hitch matching the corkline" without
checking the half-hitch's *internal* invariants (lead-tethered,
meet-fast, footline-not-reaching-null, etc.). The fixture names
encode the specific invariant each is testing.

Cleanest starting points:

- `half-hitch-invalid-lead-not-tethered.trdl` — lead is detached;
  spec § 4 / 6 say red.
- `half-hitch-invalid-meet-not-fast.trdl` — meet is a slow twist;
  spec §6 says red.

Note: js also fails most of these — see
`js-rig-checker-surgical-changes.md` §3 ("Make the lead-validity
invariant fire *before* the hoist search"). Same root cause, two
implementations.

### BB-C. `tether_loop` → HTTP 400

`todatests/rigging/tether_loop.toda` causes the bb server to return
HTTP 400 (request failed; no verdict produced).

This is the only fixture in the bench that elicits a HTTP 400 from
bb. Other fixtures with non-trivial tether structures pass through
bb fine. Likely a parser-level crash on a specific atom shape inside
this rig.

Reproducer: POST the `.toda` bytes to `…/rigcheck-bb?cork=…&twist=…`.

### BB-D. Roundtrip shielded-rig sensitivity (low priority)

In the roundtrip-bench, bb consistently flips orig=red → rec=yellow
on shielded rigs with random shields (the workshop's compile
regenerates the shield per run). Other checkers stay stable. Not
necessarily a bug — the rec bytes legitimately differ — but bb's
sensitivity to shield-derived hoist values is structurally larger
than js/clj/rust's. Worth flagging but lower priority than A–C.

Affected fixtures: most `hh_*` and `corkline_*` cases in the
roundtrip-bench's shape-eq-diff bucket.

## Shared patterns

### Half-hitch invariant fires (cluster of ~10)

The largest single canonical-red cluster — `tests/test-suite/half-
hitch-*` and `tests/toda-rig-checker/half-hitch-*`, plus
`hitch-*` — fails the same way across **js + bb** (both green when
spec says red). clj and rust agree red.

This is a single bug pair: bb and js both share a too-permissive
half-hitch validation path. js's version is documented in §3 of
`js-rig-checker-surgical-changes.md`; bb's may be the same root
cause translated.

### Spec §7.2 tether-loop / §7.3 splice traversal

CLJ-A and BB-A are two faces of the same underlying issue: the
splice-traversal loop in §7.3 (and the tether-loop check in §7.2)
have edge cases that clj turns into red and bb turns into yellow.
Both should be green when canonical is green; the spec is the
arbiter.

## How to start

Suggested triage order, ordered by reproducer simplicity:

1. **bb HTTP 400 on `tether_loop.toda`** — single broken bundle,
   first to fix because everything else is "wrong verdict" but
   this one is "no verdict".
2. **bb-B half-hitch false-greens** — 13 fixtures all in the same
   pattern; should be a single internal-invariant code path.
3. **clj-A splice false-reds** — start with
   `splice_chain_4hitches.toda` (4 hand-written hitches, smallest
   reproducer; rust+js agree green).
4. **bb-A splice false-yellows** — same fixtures as clj-A, so a
   side-by-side comparison while triaging (3) may locate both.
5. **clj-B tether_loop red→yellow** — needs the §7.2 depth-cap
   reading.

## Appendix: where the data came from

```
http://<host>/toda/riggingworkshop/disagreement-bench.html
   → click Run, wait ~45s, click Download
   → disagreement-bench.json (uncommitted; ephemeral artifact)
```

Each row records:
- canonical colour (sidecar or heuristic)
- per-checker verdict (`ok` / `warn` / `bad` / `broke`)
- detail string from each checker (for clj/bb: just the colour
  string from the JSON response; for rust: a structured JSON tree
  with `structype` / `colour` / `issue` / `reference`)

For clj/bb triage the detail field is currently low-signal —
upstream would benefit from emitting the same structured-issue
JSON that rust does (matches the sidecar `.json` schema).
