# TODO

## Done — earlier sessions
- App shell, editor, hex panel, viz panel adapted from svgiewer.
- JS port of `toda-twist-maker` (compile / decompile / trdl / lat / factory).
- Auto-build (300ms debounce) with `build_seq` to drop stale builds.
- Examples panel: clickable list, dot colours, keyboard nav (arrows + Home/End).
- `tests.html` byte-equality harness vs the Clojure server.
- `rigs/`, `tests/`, `todatests/` symlinks so the workshop can serve example
  rigs without depending on the static server's doc-root layout.
- Sats trie pluck in `twist_list`; usage map (twist↔body↔reqs↔rigs↔shld↔carg↔sats)
  drives hex-row hover/select to highlight every twist that uses an atom.

## Done — earlier sessions (rig-checker plurality, viz, persistence, hex)
- **Rig-checker plurality**: workshop runs **four** rig-checkers in
  parallel (js · todajs, clj · toda-rig-checker, clj · toda-bb,
  rust · rustoda WASM), each rendering its own row in the Rig check panel.
- **Spec-canonical hoist rig**: compile (JS + Clojure) always emits the
  `{S(lead) → meet, S(S(lead)) → S(meet)}` quad. Decompile detects this
  form via cheap value-only scan + cryptographic confirmation against
  the lead's shield.
- **`HalfHitchInterpreter`** replaces the dropped `UnshieldedInterpreter`:
  relaxes `hitchPost` and `_verifyHitchLine` so half-hitches and
  tether-loops don't freeze the page.
- **Dual UI for click vs hover**: independent decoration tracks across
  viz / editor / hex; hover overlays select rather than replacing it.
- **Adaptive viz sizing**: compact/dense glow scaling so 6-twist and
  300-twist rigs both look right.
- **Persistence**: SVG / hex selection survive rebuilds; viz no longer
  auto-pans on click.
- **Decompile→recompile divergence note** + rig-meta panel showing the
  canonical `<filename>.json`'s moniker · colour · cork hash · issue.
- **Collapsible sections** with chevron toggle.
- **Kiwanoed hex view**: structural per-atom annotation with named slots
  (prev/teth/shld/reqs/rigs/carg; body/sats), rig-position atom names,
  pairtrie key/value labelling. Toggle between raw and kiwanoed.

## Done — this session
- **Status pill in collapsed h4** for both rig-meta (green/yellow/red)
  and rig-check sections. Rig-check pill later split into one mini pill
  per checker (js, clj, bb, rust) so all four states are visible at a
  glance when collapsed.
- **Arrow-key scroll scoped to the examples list**, not its ancestors —
  navigating through rigs no longer jolts the surrounding panel.
- **Neutral CHECK rows**: `.rig-check` default is panel-coloured;
  explicit `.rig-check.ok` carries the green styling. The in-progress
  CHECK state no longer reads as green.
- **clj / bb checkers point at the deployed ALB**
  (`rigging-workshop-alb-…/rigcheck-clj` and `…/rigcheck-bb`).
  Localhost URLs commented next to them as the offline-dev fallback.
- **Compile fix**: `expand_hitches` no longer emits `{lead: null}` as a
  post-rig entry when the hitch has no hoist (the shape decompile emits
  for `unit_rig.toda`-style files). One-line guard; 6 compile failures
  in the example sweep dropped to 2 (only the documented circular-dep
  rigs 19/20).
- **Decompile fix**: `discover_lines` now treats `prev` pointing to a
  hash outside the file (dangling) as line genesis, and emits a
  `{id:'<line>[0]', prev:'dangling'}` override so recompile produces a
  random arb prev. Fixes the two `.toda` files that decompiled to empty
  TRDL and recompiled to 0 bytes.
- **`toda/bytes_struct.js` (v1)**: atom-level structural comparison via
  per-shape atom counts. `parse_atoms` is now exported from decompile.js.
  Bucketing across the .toda corpus surfaces (a) shielded-default
  inflation, (b) negative-test fixtures with intentional orphan bodies,
  and (c) a small number of genuine lossy cases.

## Test status (as of this session)
- **Compile sweep across all 127 examples** (`.trdl` + `.toda → decompile
  → recompile`): **125 pass · 2 fail (circular-dep rigs 19 / 20)**.
- **Decompile → recompile round-trip** across the 60 `.toda` examples:
  **60 / 60 succeed without exception, 0 produce empty bytes**.
- **Structural equality** (atom-shape counts, v1): **1 / 60 pass**,
  59 differ. Broken down:
    - 38 — arb + pairtrie inflation (recompile adds shield arbs +
      hoist-rig pairtries the original didn't have; likely a `shielded:
      true` default issue).
    - 17 — orphan bodies in the *original* (all `hh_*` / `hitch_*`
      negative-test fixtures designed to model malformed rigs; the
      decompiler correctly omits the orphans, so byte-mismatch is
      structural-by-design).
    - 4 — recompile genuinely loses twists (`cork_prev_invalid_*`,
      `lashed_non_colinear`, `corkline_incomplete_late`).
    - 0 — `twist_gain` cases (recompile never invents twists).
- `tests.html` (byte-equality vs Clojure server): not run this session
  (requires local Clojure server on port 7878). Last recorded state
  before the ALB swap: 29 pass · 0 fail · 3 skip.

## Open / next
- **Tighten `bytes_struct_equal`** beyond shape counts: digest each
  atom recursively (ignoring random-content positions: shield arbs,
  ed25519 sig arbs, pubkey arbs) so structural-equivalent shielded rigs
  can compare equal. Likely path: walk both rigs from the corkline,
  build (atom-shape, child-digest-list) tuples, compare those.
- **Investigate the 4 twist-loss cases**: real decompile lossiness.
  `cork_prev_invalid_green/red` look line-related; `lashed_non_colinear`
  and `corkline_incomplete_late` may be different mechanisms.
- **Decide how to handle the 17 orphan-body fixtures** in the structural
  test: either exclude them (their byte stream isn't a valid rig) or
  add a TRDL `{"orphan_body":"<hash>"}` entity so the decompile can
  preserve them verbatim.
- **38 `arb_and_pairtrie` inflation cases**: are these all explained by
  `shielded:true` default on lines that the original wasn't shielding?
  Worth confirming by comparing trdl-emit shielded flags against the
  original's actual shield-arb presence.
- **`tests.html` skipped rigs (per CLAUDE.md TODO)**: tighten the harness
  so a JS-only or server-only error reports as FAIL instead of silently
  matching the existing skip path. Also: rigs 19/20 could be marked as
  `expected-error` rather than counted in skip.
- **Heuristic dot colours**: only ~12 of the 60+ examples have an
  authoritative descriptor (those with a `tests/<dir>/*.json` or
  `todatests/rigging/*.json` sibling). The rest in `rigs/*.trdl` are
  filename-pattern guesses. Worth grounding by running each rig through
  the dual checker and snapshotting the agreed colour.
- **`twist-chain-with-fields` / `twist-isolation-multi-line`**: red on
  the JS row but per their JSON descriptors should be green. Stack trace
  is entirely inside svgiewer's `RequirementSatisfier.verifySatisfaction`
  → unowned code; either a real bug there or an unimplemented requirement
  type. Worth filing upstream.
- **JS-port of toda-bb via SCI** (deferred): would let us drop the BB
  sidecar JVM and run all three checkers in-browser. ~1-2 days for POC,
  3-5 for maintainable.

## Notes
- `toda-twist-maker` fix lives on `dx-null-shield-fun` branch in todaclj.
  Main server's JVM uses whatever is checked out at start time — restart
  required after a branch switch.
- `noble-ed25519` v2 is fetched from esm.sh; if esm.sh ever goes down,
  vendor the file under `toda/vendor/`.
- Push remains denied in this repo and the user manages all git in todaclj.
