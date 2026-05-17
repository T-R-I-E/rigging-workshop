# Abject Workshop — preliminary spec

A sibling browser tool to rigging-workshop, focused on validating real-world
abjects (DQ tokens, simple-historic abjects, capabilities, etc.) end-to-end.
Where rigging-workshop checks a *single rig* against four interpreters,
abject-workshop walks *every rig in an abject* (poptop chain + delegations
+ sub-rig references) and verifies each across the same four backends.

This document is a starting sketch, not a finished design. The goal is to
capture (a) why it can't be folded into rigging-workshop, (b) what was
learned while investigating the issue that prompted this split, and
(c) the questions a real implementation needs to answer.


## Tests excluded from rigging-workshop

Rigging-workshop is exclusively for single rigs. Fixtures that require
abject-aware checking — delegation-chain walks, multi-rig enumeration,
sub-abject resolution — have been moved out of the workshop's `RIGS`
list (editor.js) and `disagreement-bench.js`'s probe set, and belong in
this workshop instead. Re-add them here when abject-workshop ships.

| Path | Source | Why excluded |
|---|---|---|
| `tests/toda-abject/delegation-chain-4-level.trdl` | `../todaclj/toda-clj-tests/toda-abject/` | Compiles to a 4-level delegation chain. The workshop's single-(twist, corkline) pipeline can't faithfully check it — the abject has multiple internal rigs and the rig-check needs `Abject.checkAllRigs()`, which doesn't exist yet on the canonical clj/bb/rust side and isn't worth half-implementing in the workshop. |

(The line above is the only abject-explicit test that was in either
RIGS list at the time of the split. As more abject fixtures land
upstream they belong here, not in the rigging-workshop's sidebar.)

For *.toda loads at the byte level, rigging-workshop already has a
fail-fast detector (`workshop_bail_check` in `app.js`) — it parses the
focus twist with `Abject.fromTwist`, and if non-null it short-circuits
the load with an `ABJECT ERROR` banner pointing at this doc. That
boundary check stays in the workshop indefinitely; it's the
"refused-to-process" message a user sees when they drop a DQ token or
similar into the wrong tool. Don't remove it when implementing
abject-workshop — instead make abject-workshop the suggested
destination.


## Why separate from rigging-workshop

rigging-workshop is for authoring TRDL test rigs. The editor is the source
of truth: text → compile → render → check. Its check pipeline takes one
`(twist, corkline)` pair and runs four backend interpreters against it, in
parallel, with a small UI grid showing four pass/warn/fail pills.

Real abjects have multiple internal rigs:

- the abject's own top-level rig (poptop chain up from the focus twist);
- one rig per entry in a `DelegableActionable.delegationChain()`;
- sub-rigs reachable through field-referenced abjects.

Conflating "all rigs" with "one rig" in the same UI makes both worse:
TRDL authoring loses its single-focus clarity, and abject inspection loses
the per-rig depth a real auditor needs.


## What `checkAllRigs` means

Borrowed from svgiewer's `Abject.checkAllRigs()` (in `svgiewer/src/abject`).
The intent is: enumerate every rig the abject claims to support and verify
each.

Roughly:

1. Build a `Line` from the focus twist's atoms.
2. From the focus, walk every `prev` and every `successor` linked from
   `getTetherHash()` — these are the tethers of the abject's primary line.
3. For each delegated abject in `DelegableActionable.delegationChain()`,
   walk the same way starting from that delegate's twist hash.
4. For each tether-or-poptop discovered, construct the canonical
   `(twist, corkline)` pair and verify the rig.

The svgiewer source has the canonical walker — abject-workshop should
either reuse it directly (it's pure JS, already imported) or document any
divergence.


## Findings from the rigging-workshop investigation

These are the constraints the four backends impose. They shape what
"check all rigs" can actually mean across the stack.

### 1. clj `toda-rig-checker` is single-rig

`interpreter.api/interpret-rig`
(`todaclj/toda-rig-checker/src/interpreter/api.clj:14-21`) takes
`(store, twist-h, cork-h)` — one twist, one corkline. It builds one `Rig`
from the twist's oldest known ancestor up through the latest successor of
the corkline (`interpreter/rigging/core.clj:118-127`). No delegation walk.

To do `checkAllRigs` against clj, the caller enumerates `(twist, cork)`
pairs from the abject (in JS) and calls `/rigcheck` N times. The
workshop's server endpoint already accepts a `twist` query parameter —
plumbed but currently always set to the file's focus.

### 2. clj "yellow" means "missing", not "partial pass"

`issue → colour` mapping
(`todaclj/toda-rig-checker/src/interpreter/result/symbols.clj:25-32`):

- red    ← `:invalid`, `:mismatch`, `:lat-error`, `:shape-error`
- yellow ← `:missing`, `:unknown`, `:atomic-error`, `:no-spec-error`
- green  ← no issue

So a "yellow" rig isn't "some sub-rigs failed and some passed" — it's
"the checker couldn't find something it needed (e.g. the topline atom
isn't in the file) and the absence was treated as a lower-severity issue
than a positively-invalid value."

This is the *same condition* that makes:

- JS throw `MissingError("Missing topline hash")`
  (`svgiewer/src/core/interpret.js:97-98`)
- rustoda say `"poptop X not found in file"`

The three backends just classify the missing-atom condition differently.

### 3. JS already has an abject-level entrypoint

`svgiewer/svgiewer.js:1491` calls `abject.checkAllRigs()` as its primary
check, falling back to a single-rig `TwinInterpreter` only when the
abject-level check fails. So one of the four backends already has the
multi-rig path implemented; abject-workshop can reuse it directly without
re-deriving the walker.

### 4. rust rustoda is single-rig

Same call shape as clj: bytes plus `(cork, twist)` hex strings. Confirmed
by the error format "poptop X not found in file" (one poptop, one file).
Lives in `../rustoda`, exposed via the `wasm-pack` bundle at
`toda/rustoda-wasm/`.

### 5. bb toda-bb is single-rig

Same shape as clj. Reuses the same endpoint contract; runs in a separate
JVM because `toda.shielding` namespace conflicts with toda-core's. Lives
behind `/rigcheck-bb`.

### 6. None of the four backends fetches external atoms

When an abject's declared poptop isn't bundled into the file, all four
backends report some flavour of "missing" — they don't reach out to a
relay or external store. This is fine for an authoring/inspection tool,
but means abject-workshop has to either (a) accept "missing external
poptop" as a valid terminal state for some rigs, or (b) take on the job
of fetching prior atoms from somewhere.


## Issues to solve

### A. rig enumeration

Where does the list of `(twist, corkline)` pairs come from?

- Option 1: lean on the JS abject layer. `svgiewer/src/abject/abject.js`
  has `checkAllRigs` and friends; call it, log every rig it would check,
  feed those `(twist, corkline)` pairs to the other three backends.
- Option 2: build a separate enumerator (probably in clj) and treat *it*
  as authoritative. Then JS, bb, rust are all called per-rig.

Question: are the enumerations consistent across backends? If JS misses
a rig the others see (or vice versa), is that a finding or a bug? Pick
one authoritative enumerator and surface divergence as a separate signal.

### B. external poptops

Many real-world abjects (DQ tokens, capability lines) reference a poptop
that lives on a relay rather than being bundled in the file. For these:

- clj returns yellow with `:missing`.
- JS throws `MissingError`.
- rustoda says "poptop X not found in file".

Options:
- Treat "external poptop" as a first-class, non-failure state. Render it
  as a distinct pill (not green/yellow/red but "external").
- Add an optional relay-fetch layer. Probably out of scope for v1.

### C. backend invocation per rig

Each backend takes one `(twist, cork)` pair. To check N rigs we call
N times. For the server backends (clj, bb), that's N HTTPS requests. For
rust (wasm-in-browser) and JS (in-process), it's cheap.

Plumbing options:
- Naive fan-out: parallel `Promise.all` over rigs, per backend. Probably
  fine up to a few dozen rigs.
- Server-side batch endpoint: POST bytes once, take a list of
  `(twist, cork)` pairs, return a list of results. Requires extending
  `clj/rigging_workshop/server.clj` and `server_bb.clj`.

### D. result aggregation and UI

With M backends × N rigs the result is an M×N grid. UI questions:

- Per-rig row, four backend pills per row. Good when N is small.
- Per-backend row, N status dots per row. Good when N is large.
- Hybrid: show a summary at the top (worst colour across all rigs and
  backends), drill into rigs below.

Click-through into a single `(rig, backend)` cell should show the same
detail the rigging-workshop shows today: the result object, missing/
invalid refs, the chain of issues.

### E. shared atoms / re-upload cost

The same bytes underlie every rig check. For the server backends, the
naive design re-POSTs the bytes N times. Mitigation:

- Cache `bytes-hash → store` on the server, look up by hash on subsequent
  calls. Means a hash-prefix request shape.
- Or use a batch endpoint (issue C) so bytes are sent once.

### F. performance budget

`dq.toda` is 338 KB. A heavily-delegated abject might have 50+ internal
rigs × 4 backends = 200 checks. Worst-case round-trip needs to be in the
single-digit seconds range to feel responsive, which means the
re-POST-every-time naive design is probably too slow for large abjects;
a batch or store-by-hash endpoint is needed before this is usable.

### G. relationship to rigging-workshop

What gets shared, what's distinct?

Shared:
- `app.js` showpipe — visualizer / hex / shape parsing.
- `hex.js`, `src/` (svgiewer imports).
- The four-backend `CHECKERS` shape and the server endpoints (with
  per-rig invocation as in issue C).

Distinct:
- No editor, no TRDL authoring path, no decompile / recompile cycle.
- Abject info card (type, quantity, display value, minting info, etc.).
- Delegation-chain navigation (svgiewer has this — adapt it).
- M×N results grid instead of M-row single-rig list.

Codebase shape question: separate page (`abject-workshop/index.html`) in
the same repo sharing modules, or fully separate repo? Probably the
former — re-using `toda/`, `src/`, hex/visualizer code without
duplicating saves a lot.


## UI sketch

```
┌──────────────────────────────────────────────────────────────┐
│  abject-workshop                                              │
├──────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌─────────────────────────────────────┐  │
│  │ Abject card  │  │  Rig results grid                    │  │
│  │ - type       │  │                                      │  │
│  │ - quantity   │  │            JS    clj   bb    rust   │  │
│  │ - display    │  │  rig 0    ●     ●     ●     ●     │  │
│  │ - minting    │  │  rig 1    ●     ●     ◐     ●     │  │
│  │              │  │  rig 2    ●     ◐     ◐     ◐     │  │
│  │ Delegation   │  │  rig 3    ○     ●     ●     ●     │  │
│  │ chain:       │  │  ...                                │  │
│  │  → A         │  │                                      │  │
│  │  → B         │  │  Worst: yellow                       │  │
│  │  → C focus   │  └─────────────────────────────────────┘  │
│  └──────────────┘                                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Visualizer (shared with rigging-workshop)             │   │
│  │ ...                                                    │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

Click a cell to expand: which atoms were missing, which req/sat failed,
the canonical issue ref. Click a row label to focus that rig in the
visualizer.


## Implementation outline

Five phases, each shippable on its own.

**Phase 1 — detection + redirect (now, in rigging-workshop):**
Rigging-workshop bails out cleanly on abjects and files larger than
~500 twists, pointing at this doc. No abject-workshop yet — just a
clear "this isn't the right tool" message. Implemented in `app.js`
`show_abject_info`.

**Phase 2 — scaffold:**
Copy `index.html` and `style.css` from rigging-workshop, drop the editor
column. Wire `load_bytes` to set up an abject_workshop env: parse atoms,
build the focus twist, surface the abject info card. No checks yet.

**Phase 3 — JS multi-rig:**
Call `abject.checkAllRigs()` in-browser and render the per-rig results,
single backend column. Identify how `checkAllRigs` enumerates and
whether its output shape is what we want.

**Phase 4 — wire the other three backends:**
For each rig surfaced by the JS walker, also call clj / bb / rust with
the `(twist, cork)` pair. Render the M×N grid. Decide whether to leave
this as parallel fan-out or push a batch endpoint into the clj servers
(issue C).

**Phase 5 — drilling / navigation:**
Click into cells for detail; click row labels to navigate the
visualizer; surface "external poptop" as its own state (issue B).
