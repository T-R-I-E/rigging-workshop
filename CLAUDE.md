# Rigging Workshop

Browser tool for authoring TODA rigs in TRDL (a JSONL format) and visualising
the resulting `.toda` bytes. Editor is the source of truth. Compile / decompile
run entirely in the browser via the modules under `toda/`.

## Status
See [TODO.md](TODO.md) for current plan, tasks, and deferred items.

## Layout
- `index.html`, `style.css` — app shell (visual structure copied from `rw.html`).
- `rw.html` — original design mock, kept as reference, not loaded.
- `app.js` — adapted copy of `../svgiewer/svgiewer.js`. Takes an `ArrayBuffer`,
  populates the viz / hex / metadata / rig-check panels.
- `editor.js`, `hex.js`, `bridge.js` — workshop-specific glue.
- `toda/` — JS port of `toda-twist-maker` + the parts of `toda-core` it needs.
  - `bytes.js` — hex / sha256 / random / be32 primitives
  - `lat.js` — atom packet build + Lat (insertion-ordered Map)
  - `factory.js` — arb / pairtrie / hashes / body / twist atom builders
  - `ed25519.js` — keypair / sign / req-sat pairtrie helpers (raw 32-byte keys)
  - `trdl.js` — JSONL parser, classifier, trdl→spec, emit
  - `compile.js` — build pipeline (TRDL → bytes)
  - `decompile.js` — bytes → TRDL entities (unshielded path only in v1)
- `tests.html`, `tests.js` — byte-equality test harness vs the Clojure server.
- `src/`, `rels.js` — symlinks into `../svgiewer/`. Don't edit; they're shared.
- `rigs/` — symlink into `../todaclj/toda-twist-maker/rigs/`. Lets the
  workshop fetch example rigs from a path that stays inside the served root,
  so it works on any deploy (not just one that serves all of `~/Dev`).
- `deps.edn`, `clj/rigging_workshop/server.clj` — Clojure server. **Test-only
  oracle.** The workshop runs entirely in the browser; the server is required
  *only* if you want to run `tests.html`'s byte-equality checks against the
  canonical `toda-twist-maker` implementation.

## Running
1. Static server serving `~/Dev` (already running per dev setup).
2. Open `http://<host>/toda/riggingworkshop/` — the workshop runs entirely in
   the browser. No Clojure server needed.

## Running tests.html
Verification harness, optional. **Requires the Clojure server.**
1. Make sure `../todaclj` is on a branch that has `toda-twist-maker/` (e.g.
   `twist-maker-trdl`).
2. `clj -M:server` from this directory.
3. Open `http://<host>/toda/riggingworkshop/tests.html`.

## Known v1 caveats
- `ed25519.js` uses raw 32-byte public keys; the Clojure server wraps them
  in X.509. Bytes diverge on `reqsat: ed25519` rigs (none of the test rigs
  use ed25519, so this hasn't surfaced in practice).
- `decompile.js` only detects unshielded hitches. Shielded hitch detection
  (computing `s/ss` hashes from shield arbs) is deferred.
- Random shields make `shielded: true` rigs non-deterministic across runs.
- Anonymous-line naming in decompile (`a`, `b`, `c`, …) follows JS atom
  byte-discovery order, which can differ from the Clojure server's JVM
  hash-bucket order. The resulting TRDL is structurally equivalent — same
  rig, possibly different label assignment to nameless lines.
- Rig check uses an `UnshieldedInterpreter` subclass in `app.js` for trdl
  rigs with `shielded:false`. The canonical `Interpreter` only recognises
  the shielded `{s(lead) → meet, ss(lead) → s(meet)}` hoist form; trdl's
  `shielded:false` produces the simpler `{lead.hash → meet.hash}` form.
  Strict verification is tried first; if it fails with `MissingHoistError`,
  the unshielded fallback runs (also relaxes the "must be full hitch" rule
  so `post:"none"` rigs verify).
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
