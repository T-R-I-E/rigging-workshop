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
- **TRDL spec alignment (phases 1–4)** against
  `resources/trdl-spec.md`. Four commits on top of the prior state:
  1. **Parser surface** — `//` comment lines tolerated; bare
     `{"id":…}` shorthand dropped (objects without a recognised type
     key are silently discarded per spec); `spool` / `reqsat` / `trie`
     classified as known types; decompile emits per-twist overrides
     as `{"twist": id, …}` not `{"id": id, …}`.
  2. **Utility evaluator (`toda/values.js`)** — full grammar for
     `null` / `unit` / `hex()` / `base64()` / `+` concat / `sort()` /
     `hash()` / `symbol()` plus a name-resolver hook. `sign()` /
     `shield()` deferred. Wired into the `atom` entity so `data` +
     `length` + integer `shape` work; legacy `raw` field preserved.
     Symbols sourced from a new `toda/symbols.js` (poptop, context,
     actionable class identifiers).
  3. **v2 field gate** — `hitch.end` / `hitch.liftable` /
     `hitch.lift-ticket` / `twist.lift` / `line.liftreqs` /
     `rig.version` parsed and preserved; default rig version = 1
     (workshop deviation from spec default 2 — see
     `validate_v1_compatible` comment); any v2 semantics throw a
     clear error at trdl_to_spec time. Documented in the validator's
     leading comment.
  4. **Trie entity** — `{"trie": "name", "entries": {"<expr>":
     "<expr>"}}` builds a pairtrie atom whose entries are evaluated
     via values.js (twist refs by `line[N]` form resolved against the
     twist map). `twist.cargo` referencing a trie name lands the
     trie's atom hash in body.carg. Cycles (trie → twist → same
     trie) rejected by a unified topo pass. spool / reqsat entities
     rejected (v2).

  Tests live in `tmp/phase1.test.mjs … phase4b.test.mjs` (run via
  `node tmp/phase*.test.mjs` — bypasses the browser harness, no
  Clojure server needed). 344 pass / 0 fail at session end: 32
  byte-stable rig snapshots, ~270 decompile-roundtrip checks across
  `tests/` + `todatests/`, plus the per-phase unit tests.

  Carry-over (deferred): liftable bodies (shape 0x4a), end-hitch +
  lift-ticket synthesis, spool poptops, sign() / shield() helpers
  in the value evaluator, rsline reqsats. All blocked on canonical
  (Clojure / Rust) implementations — the workshop's role is to
  track them, not to invent layouts.

- **TRDL spec alignment phase 5 — named reqsat entities**. ed25519
  (raw 32-byte pubkey, raw 64-byte sig per RFC 8032 §5.1.5 — the
  workshop is canonical here, the Clojure `twist-maker.ed25519`'s
  X.509 wrap is the outlier; CLAUDE.md note flipped), secp256r1
  (WebCrypto P-256/SHA-256, SPKI pubkey, DER ECDSA sig matching
  todaadot), rslist (canonical symbol "reqsatlist" → HashesAtom of
  [weight_arb, sub_req_pairtrie] entries; topo-sorted over deps with
  cycle rejection). New module `toda/reqsat_keys.js`. rsline still
  rejected. 15 phase-5 tests across 5a/5b/5c green; 407 total.

- **Status pill in collapsed h4** for both rig-meta (green/yellow/red)
  and rig-check sections. Rig-check pill later split into one mini pill
  per checker (js, clj, bb, rust) so all four states are visible at a
  glance when collapsed.
- **Arrow-key scroll scoped to the examples list**, not its ancestors —
  navigating through rigs no longer jolts the surrounding panel.
- **Neutral CHECK rows**: `.rig-check` default is panel-coloured;
  explicit `.rig-check.ok` carries the green styling. The in-progress
  CHECK state no longer reads as green.
- **clj / bb checkers point at the ALB HTTPS endpoint**
  (`rigchecker.todaq.net/rigcheck-clj` and `…/rigcheck-bb`,
  ACM-issued cert directly on the ALB; deploy infra lives in the
  sibling `TodaQFinance/rigchecker` repo). Localhost URLs commented
  next to them as the offline-dev fallback.
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
  (requires `cd ../rigchecker && clj -M:server` for port 7878). Last
  recorded state before the ALB swap: 29 pass · 0 fail · 3 skip.

## Open / next
Compiler-level items (bytes_struct tightening, twist-loss cases, orphan-body
fixtures, inflation cases, parity-harness skip tightening) moved to the trdl
repo's TODO.md with the August 2026 split.
- ! **v1-tests compile gaps** (work belongs in `../trdl`, blocking here):
  3,212 of 6,633 `todatests/v1-tests/` fixtures compile; the workshop lists
  the rest but can't build them. Ranked by fixtures unblocked — atom
  entities missing from the reference namespace ~2,326, `name[i]suffix`
  refs 520, rslist `"none"` 292, `shld` expression evaluation 256,
  `shield()` 14, ~13 stragglers. The first one is one resolution path and
  dwarfs the rest. See the caveat in CLAUDE.md. Re-measure in the browser
  (a Node sweep invents thousands of ed25519 failures).
- `../trdl` `js/symbols.js` has an uncommitted `rslist` symbol alias — I
  can't write that repo's .git from the sandbox, so it needs committing.
- **2 malformed v1-tests fixtures** to report upstream: both files under
  `Half_hitch/hoist_incorporates_lead_and_meet_with_non-NULL_shield/` split
  one JSON object over several lines, which JSONL disallows. Also
  `Lat/valid_one_hitch_rig.trdl` is the only fixture with no comment header,
  so it gets no dot and no rig-meta.
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
- Push remains denied in this repo and the user manages all git in todaclj.
- Compiler notes (esm.sh noble vendoring, dx-null-shield-fun branch) moved
  to `../trdl/CLAUDE.md`.
