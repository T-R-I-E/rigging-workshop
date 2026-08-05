# Rigging Workshop

Browser tool for authoring TODA rigs in TRDL (a JSONL format) and visualising
the resulting `.toda` bytes. Editor is the source of truth. Compile / decompile
run entirely in the browser via the sibling `../trdl` repo, imported through
the `trdl` symlink.

**Scope:** single test rigs (≤ ~500 twists). Abjects with delegation chains,
sub-rigs, or external poptops are detected on load and bailed out with a
banner in the rig-check panel — they need full multi-rig validation that
the workshop doesn't implement. See [abject-workshop.md](abject-workshop.md)
for the preliminary spec for the sibling tool that would handle those.

## Status
See [TODO.md](TODO.md) for current plan, tasks, and deferred items.

## Layout
- `index.html`, `style.css` — app shell (visual structure copied from `rw.html`).
- `rw.html` — original design mock, kept as reference, not loaded.
- `app.js` — adapted copy of `../svgiewer/svgiewer.js`. Takes an `ArrayBuffer`,
  populates the viz / hex / metadata / rig-check panels.
- `editor.js`, `hex.js`, `bridge.js` — workshop-specific glue.
- `trdl` — symlink to `../trdl/js`: the TRDL compiler / decompiler reference
  implementation (JS port of `toda-twist-maker` + the parts of `toda-core`
  it needs). Split out of this repo (August 2026, with git history) into the
  sibling `../trdl` repo, which also holds the TRDL spec, the Node test
  suites, and the browser byte-parity harness. See `../trdl/CLAUDE.md`.
- `toda/` — rig-checker bundles only, now that the TRDL modules moved to
  `../trdl`: holds `rustoda-wasm/` and `rignet/`, described below.
- `src/`, `rels.js` — symlinks into `../svgiewer/`. Don't edit; they're shared.
- `rigs/` — symlink into `../todaclj/toda-twist-maker/rigs/`. No longer read
  by the app since the TRDL split (the trdl repo has its own `fixtures/`
  symlinks); kept for manual browsing.
- `tests/` — symlink into `../todaclj/toda-clj-tests/`. ~35 paired
  `.trdl` / `.json` test rigs, organised by subdir. Same post-split status
  as `rigs/`.
- `todatests/` — symlink into `../todatests/`. ~60 paired `.toda` / `.json`
  rigging tests; `.toda` loads route through decompile.
- `toda/rustoda-wasm/` — `wasm-pack build --target web --release` output
  of `../rustoda` (the Rust rig-checker). Bundle is `rigcheck.js` (glue)
  + `rigcheck_bg.wasm` (~223 KB). Rebuild after changes to `../rustoda`
  with:
  ```
  cd ../rustoda && wasm-pack build --target web --release \
      --out-dir ../riggingworkshop/toda/rustoda-wasm && \
      trash ../riggingworkshop/toda/rustoda-wasm/.gitignore
  ```
  The trailing `trash` is needed because wasm-pack writes a `*` gitignore
  into the out-dir to treat it as a build artifact; we want the bundle
  committed instead. Wired into `app.js` as the 4th `CHECKERS` entry
  (`id: 'rust'`); loaded lazily, falls back to `warn` if the bundle is
  missing or fails to instantiate.
- `toda/rignet/` — compiled browser ES modules of the `../rignet` checker
  (a from-scratch TypeScript TODA interpreter; it uses WebCrypto, so the
  check path is browser-safe). Only the check-path closure of
  `interpreter`/`atom`/`lat` is bundled — `tsc` emits the full transitive
  set, which excludes `index.ts` (`node:fs`) and `torus.ts` (webtorrent).
  Rebuild after changes to `../rignet/src` with (build to a writable dir,
  then copy — the `rignet` symlink points outside the workshop):
  ```
  rignet/node_modules/.bin/tsc rignet/src/interpreter.ts \
      rignet/src/atom.ts rignet/src/lat.ts \
      --outDir "$TMPDIR/rignet-dist" --target ES2022 --module ES2022 \
      --moduleResolution bundler --skipLibCheck
  cp "$TMPDIR/rignet-dist"/*.js toda/rignet/
  ```
  Wired into `app.js` as the 5th `CHECKERS` entry (`id: 'rignet'`); loaded
  lazily, falls back to `broke` if the bundle is missing. `rignet_check`
  replicates `parseTodaBytes` inline (atomFromBytes loop → `lat` → `checkRig`)
  and maps green/yellow/red → ok/warn/bad. Caveat: `checkRig(l, corklineHex)`
  takes only the corkline and derives the focus from the file, so it verifies
  the rig's own focus rather than the user-clicked twist.
- Rig-check backend lives in the sibling `../rigchecker/` repo
  (`TodaQFinance/rigchecker`). The workshop's clj/bb rig-checkers point at
  the ALB-fronted deployment (`rigchecker.todaq.net/rigcheck-clj` and
  `…/rigcheck-bb`, HTTPS via ACM); see that repo's `terraform/`. Localhost
  URLs are kept commented next to the live ones in `app.js` as an
  offline-dev fallback for when you've run `clj -M:server` /
  `clj -M:server-bb` from `../rigchecker/`.

## Running
1. Static server serving `~/Dev` (already running per dev setup).
2. Open `http://<host>/toda/riggingworkshop/` — the workshop runs entirely in
   the browser.

## TRDL tests

The compiler's tests (Node suites + browser byte-parity harness) moved to
the trdl repo with the split — see `../trdl/CLAUDE.md` for how to run them.

## Known v1 caveats
Compiler-level caveats (ed25519 key format, decompile hoist detection,
random shields, anonymous-line naming) moved to `../trdl/CLAUDE.md`.
- Rig check uses `HalfHitchInterpreter` in `app.js`, a thin subclass of the
  canonical Interpreter that allows half-hitches: `hitchPost` returns null
  on a missing post-rig-entry instead of throwing `MissingPostEntry`, and
  `_verifyHitchLine` drops the "must be full hitch" check + null-guards
  the walk-back. This is *not* the unshielded relaxation we removed — that
  was a compile bug; this is about TRDL test rigs that use `post:"none"`
  to model the last hitch on a corkline.

## Git policy (overrides global)
You manage git directly in this project. The global "manual git" rule does
NOT apply here. `git push` remains denied at the permission layer; the user
handles pushing.

Workflow:
- Commit after each meaningful change passes its tests. One logical change
  per commit.
- Stage only the files relevant to the change. Use `git add <paths>`, not
  `git add .` or `git add -A`. Do not sweep up unrelated edits.
- Before committing, run `git diff --staged` and verify the diff is exactly
  what you intend. If something unintended is staged, `git restore --staged
  <path>` to unstage.
- Conventional commit messages: feat:, fix:, refactor:, docs:, test:, chore:.
  First line under 72 chars. Body if useful, omitted if not.
- Never commit on red. If a test was passing and now isn't, fix the test or
  the code before committing — do not commit broken state.
- Do not include AI attribution in commit messages.
