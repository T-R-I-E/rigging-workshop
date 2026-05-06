# TODO

## v1 done
- [x] Symlinked `src/`, `rels.js` from `../svgiewer/`
- [x] Adapted `svgiewer.js` → `app.js` for the workshop's panels
- [x] Editor (CodeMirror 6 + lang-json) wired to Open / Save / Export
- [x] Hex viewer (atoms tab) with hash / shape / length / content columns
- [x] Three-way mouseover sync (editor ↔ viz ↔ hex)
- [x] JS port of `toda-twist-maker` under `toda/`
- [x] `bridge.js` cut over to the JS port (workshop runs without server)
- [x] `tests.html` for byte-equality verification
- [x] **Compile**: byte-equal to Clojure server on every deterministic rig
      (29/29 in `toda-twist-maker/rigs/`).
- [x] **Decompile**: structurally correct on every server-decompile-able rig
      (28/28); 5 differ only in anonymous-line label assignment.
- [x] Clojure server demoted to a test-only oracle.

## v1.1 done (this session)
- [x] Build button retired; debounced auto-build (300ms) on every doc change,
      with a `build_seq` counter so stale builds don't overwrite newer ones.
- [x] Hex panel header now shows compact metadata; `atoms / raw / tries`
      tabs removed.
- [x] Workshop panel BL replaced metadata section with a scrollable list of
      32 example rigs (clickable to load).
- [x] Each example has a green/yellow/red dot showing the expected rig-check
      result. Rigs 21–27 confirmed from `complex_rigs.clj`; the rest are
      pattern-based guesses from filenames (correct as needed).
- [x] Rig check no longer goes through the abject layer. `compile()` returns
      the corkline hex; `editor.js` stashes it on `window.workshop.corkline`;
      `app.js` constructs `Hash.fromHex(corkline)` and runs
      `Interpreter.verifyTopline()` + `verifyHitchLine()` directly.
- [x] `UnshieldedInterpreter` subclass added to `app.js` for `shielded:false`
      rigs (recognises `{lead.hash → meet.hash}` rig entries) and relaxes
      the "must be full hitch" rule so `post:"none"` rigs verify.

## Pending verification
- [ ] User to confirm in browser that v1.1 UX changes work end-to-end:
      auto-build on initial load, example dots, rig-check ✓ on green rigs
      (with `(unshielded)` suffix), informative errors on red/yellow rigs.
- [ ] Heuristic dot colours for rigs 1–20, 28, 29, 29a, 31 may be wrong;
      confirm against actual rig-check outcomes once verified in browser.

## Deferred (v2+)
- Editor↔viz↔hex selection sync (currently only hover-sync)
- Custom TRDL language mode for CodeMirror (currently `lang-json`)
- `raw` and `tries` hex tabs (no longer rendered)
- Shielded-hitch detection in `decompile.js`
- X.509-wrapped ed25519 public keys to match the Clojure encoder bytewise
- Match the Clojure server's anonymous-line label order (would require
  replicating JVM `String.hashCode` + hash-bucket order in JS)
- Live-update example dots from actual rig-check results once a rig is
  loaded, so expected vs actual is visible at a glance.

## Notes
- `toda-twist-maker` lives on the `twist-maker-trdl` branch in todaclj.
  Only needed for `tests.html`; not required to run the workshop.
- noble-ed25519 v2 is fetched from esm.sh; if esm.sh ever goes down, vendor
  the file under `toda/vendor/`.
