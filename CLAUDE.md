# Rigging Workshop

Browser tool for authoring TODA rigs in TRDL (a JSONL format) and visualising
the resulting `.toda` bytes. Editor is the source of truth. Compile / decompile
run entirely in the browser via the modules under `toda/`.

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
- `toda/` — JS port of `toda-twist-maker` + the parts of `toda-core` it needs.
  - `bytes.js` — hex / sha256 / random / be32 primitives
  - `lat.js` — atom packet build + Lat (insertion-ordered Map)
  - `factory.js` — arb / pairtrie / hashes / body / twist atom builders
  - `ed25519.js` — keypair / sign / req-sat pairtrie helpers (raw 32-byte keys)
  - `trdl.js` — JSONL parser, classifier, trdl→spec, emit
  - `compile.js` — build pipeline (TRDL → bytes)
  - `decompile.js` — bytes → TRDL entities (unshielded path only in v1).
    Exports `parse_atoms` for reuse by `bytes_struct.js`.
  - `bytes_struct.js` — atom-level structural comparison of two .toda byte
    streams (v1: per-shape atom counts). Used to assess decompile→recompile
    round-trip fidelity when byte-equality isn't possible (random shields
    / sigs / pubkeys).
- `tests.html`, `tests.js` — byte-equality test harness vs the Clojure server.
- `src/`, `rels.js` — symlinks into `../svgiewer/`. Don't edit; they're shared.
- `rigs/` — symlink into `../todaclj/toda-twist-maker/rigs/`. Workshop's
  primary example set, served from a path that stays inside the served root.
- `tests/` — symlink into `../todaclj/toda-clj-tests/`. ~35 paired
  `.trdl` / `.json` test rigs, organised by subdir.
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
- `deps.edn`, `clj/rigging_workshop/server.clj`,
  `clj/rigging_workshop/server_bb.clj` — two sidecar Clojure servers.
  Optional: the workshop's clj/bb rig-checkers now point at the
  ALB-fronted deployment (`rigchecker.todaq.net/rigcheck-clj` and
  `…/rigcheck-bb`, HTTPS via ACM on the ALB; see `terraform2/`),
  so the local servers are only needed for `tests.html` byte-equality
  parity checks. Localhost URLs are kept commented next to the live
  ones in `app.js` as an offline-dev fallback.

## Running
1. Static server serving `~/Dev` (already running per dev setup).
2. Open `http://<host>/toda/riggingworkshop/` — the workshop runs entirely in
   the browser. No Clojure server needed.

## Running the Clojure servers (optional)

Two sidecar servers, run in separate terminals. Both are optional —
the workshop's main UI runs entirely in the browser. The servers exist
to support `tests.html` byte-equality checks and the dual rig-check
display in the rig-check panel.

Main server (port 7878) — compile/decompile + canonical toda-rig-checker:
```
clj -M:server
```

BB server (port 7879) — toda-bb interpreter, runs in its own JVM because
toda-bb's `toda.shielding` namespace collides with toda-core's:
```
clj -M:server-bb
```

`tests.html` only needs the main server.

## Known v1 caveats
- `ed25519.js` uses raw 32-byte public keys; the Clojure server wraps them
  in X.509. Bytes diverge on `reqsat: ed25519` rigs (none of the test rigs
  use ed25519, so this hasn't surfaced in practice).
- `decompile.js` finds candidate hoists by scanning rig pairtries for the
  bare `I(meet)` value, then confirms the spec-canonical quad against the
  lead's shield (NULL → plain hash, arb → prefixed hash). Works for both
  shielded:true and shielded:false rigs.
- Random shields make `shielded: true` rigs non-deterministic across runs.
- Anonymous-line naming in decompile (`a`, `b`, `c`, …) follows JS atom
  byte-discovery order, which can differ from the Clojure server's JVM
  hash-bucket order. The resulting TRDL is structurally equivalent — same
  rig, possibly different label assignment to nameless lines.
- Rig check uses `HalfHitchInterpreter` in `app.js`, a thin subclass of the
  canonical Interpreter that allows half-hitches: `hitchPost` returns null
  on a missing post-rig-entry instead of throwing `MissingPostEntry`, and
  `_verifyHitchLine` drops the "must be full hitch" check + null-guards
  the walk-back. This is *not* the unshielded relaxation we removed — that
  was a compile bug; this is about TRDL test rigs that use `post:"none"`
  to model the last hitch on a corkline.

## TODO
- **`tests.html` skipped rigs**: 3 of 32 are skipped, currently in a way
  that hides per-side compile failures behind "skip". The 3 are:
    - `5-lash-left-non-overlap-missing.trdl` — non-deterministic (random
      shield/sig/dangling), legitimately can't byte-compare. Could move to
      a parallel "structural equality" check instead of skipping.
    - `19-fast-line-multiply-lashed-up-to-slow-line.trdl` — circular
      dependency in twist specs (server agrees, both compilers reject it
      symmetrically). Could mark as "expected error" so it's reported
      instead of silently skipped.
    - `20-slow-line-lashed-up-to-fast-line.trdl` — same circular dep as 19.
  Also: the harness's skip path swallows *any* per-side compile error
  (`tests.js:115-119` skips when *either* side errors, despite the comment
  saying "both failing the same way"). Means a JS-only or server-only
  failure currently masquerades as a skip. Tighten the harness to require
  both sides to error symmetrically before skipping; otherwise FAIL.
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
