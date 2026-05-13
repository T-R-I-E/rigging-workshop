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

## Done — this session
- **Rig-checker plurality**: workshop now runs **three** rig-checkers in
  parallel, each rendering its own row in the Rig check panel:
    1. `js · todajs` — `HalfHitchInterpreter` (svgiewer base + half-hitch
       relaxations), in browser.
    2. `clj · toda-rig-checker` — POSTs to `/rigcheck-clj` on the main server
       (`clj -M:server`, port 7878).
    3. `clj · toda-bb` — POSTs to `/rigcheck-bb` on the sidecar
       (`clj -M:server-bb`, port 7879). Sidecar exists because toda-bb's
       `toda.shielding` namespace collides with toda-core's; loading both
       in one JVM silently rebinds the vars and breaks both interpreters.
- **Spec-canonical hoist rig**: compile (JS + Clojure) always emits the
  `{S(lead) → meet, S(S(lead)) → S(meet)}` quad. With NULL-shield leads
  the shield function degenerates to plain hash; the entry shape stays
  the same. Decompile updated to detect this form (cheap value-only scan
  + cryptographic confirmation against the lead's shield).
- **Dropped `UnshieldedInterpreter`** (the workaround for the compile bug
  it papered over). Replaced with a focused `HalfHitchInterpreter` that
  relaxes only `hitchPost` (no `MissingPostEntry` on missing post entries)
  and `_verifyHitchLine` (drops the must-be-full-hitch check, null-guards
  prev walk, swallows `MissingPrevError`, deduplicates via cycle guard so
  rig 29's tether-loop doesn't freeze the page).
- **Dual UI for click vs hover**: independent decoration tracks across
  viz / editor / hex; hover overlays select rather than replacing it.
  Distinct colours per state. Editor hover dispatches alongside the
  cursor-broadcast for select.
- **Adaptive viz sizing**: `.viz-wrap.compact` (<30 twists) and
  `.viz-wrap.dense` (≥200) adjust hover/select/focus glow so they don't
  look comical on a 6-twist rig nor overlap neighbours on a 300-twist one.
- **Persistence & UX**: SVG and hex selection survive rebuilds (lookup by
  hash, falls back to focus when a hash is gone). Viz no longer auto-pans
  on click. Rig-meta section above Rig check shows the canonical
  `<filename>.json`'s moniker · colour · cork hash · issue.
- **Decompile→recompile divergence note**: when a `.toda` is loaded and
  the JS recompile of its decompiled TRDL produces different bytes from
  the original, the Rig check panel keeps the initial-pass results, adds
  a "recompiled bytes differ" note, and renders only the per-checker rows
  that disagree with the baseline. Eliminates the kiwano "OK-flash →
  FAIL" confusion.
- **Collapsible sections**: rig-meta and Rig check H4s are clickable,
  with chevron at the left.
- **Corkline source**: `.toda` loads use the canonical corkline from the
  sibling `.json`. `build()` no longer null-overwrites `workshop.corkline`.
- **Test harness**: skips JS-error rigs client-side (rigs 19/20 circular
  dep) so the browser console stays clean; logs `console.warn DIVERGE` on
  byte mismatches with hex context.

## Test status
- `tests.html`: **29 pass · 0 fail · 3 skip** when both `dx-null-shield-fun`
  is checked out in `../todaclj` and the main server is running. Skips:
  rig 5 (non-deterministic random shield), rigs 19 & 20 (circular dep
  in spec graph; both compilers reject symmetrically).
- Workshop rig-check across 60+ examples: works for the canonical-shape
  rigs. Known canonical-strict failures (informational, not workshop bugs):
  rig 7 / 8 (corkline-self-tether walks back to non-lead twists),
  rig 10 (cross-line `prev` rejected by `Line.fromTwist`),
  `rigging-corkline-incomplete-early` (interp/structural).

## Open / next
- **Decompile lossiness**: the kiwano set's recompile produces different
  bytes from the original, surfaced via the new diff note. Real fix is
  making decompile lossless (capture more rig structure into TRDL).
  Not blocking for now since the diff note shows the user where the gap is.
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
