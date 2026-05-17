# Surgical JS-side changes for the rigging workshop

Notes captured from disagreement-bench / roundtrip-bench audits and the
`hh_tether_*` family in particular. Goal: a tight list of concrete,
small changes to `svgiewer/src/core/{interpret,twist}.js` (and a few
callers) that would let the workshop classify rig issues correctly
*without* the workshop having to keep heuristic name-based dispatch
over an error hierarchy that doesn't match the spec's two categories.

## Background: the spec has exactly two issue categories

Spec §9.1.3 (p. 30) — every issue is one of:

- **MISSING / UNKNOWN → yellow.** "A piece of required information was
  not provided." The bytes-as-supplied are *incomplete*; if you handed
  the checker more atoms, the rig might be green.
- **INVALID / MISMATCH → red.** All the relevant atoms are present;
  what they encode contradicts a structural rule. No additional atoms
  would make this rig green; the bytes themselves are wrong.

These map cleanly onto the spec's distinction between "I don't know"
and "I know, and the answer is no". The JS error hierarchy currently
*does not* preserve this distinction — it names several invariant
violations with a `Missing` prefix even though they describe *present*
bytes that fail a rule.

## The hh_tether_* family makes the gap concrete

All four `todatests/rigging/hh_tether_*.toda` fixtures share a corkline
and differ only in the lead's tether slot. Canonical answers (from the
.json sidecars):

| fixture | lead.teth | spec category | canonical | what JS throws today |
|---|---|---|---|---|
| `hh_tether_missing` | hash provided, atom *not* in bundle | MISSING | yellow | `MissingHashPacketError` (via `prev()`, wrapped into `MissingPrevious`) |
| `hh_tether_null`    | NULL                       | INVALID (claims slow twist as lead) | red    | `MissingHoistError` |
| `hh_tether_not_twist` | hash points at wrong-shape atom | INVALID (lead.teth not a twist) | red | `MissingHoistError` |
| `hh_tether_symbol`  | hash is a symbol (0x22…)  | INVALID (lead.teth not a twist) | red    | `MissingHoistError` |

Only `hh_tether_missing` is genuinely MISSING — the lead's tether atom
isn't in the bundle. The other three have the lead's tether atom right
there in the bundle; it just isn't a fast twist. The spec calls each of
the last three INVALID, and the .json sidecars agree.

The current JS funnels all four into the same "Missing*" family and the
workshop's name-prefix dispatch (`app.js:717`, `/^Missing/.test(name) →
warn`) turns all four yellow. That's three false-yellows.

## The actual JS error taxonomy as it exists today

From `svgiewer/src/core/interpret.js` and `src/core/twist.js`:

```
InterpreterResult
├── MissingError              ← bare; thrown when topline / reqsat atom absent
│   ├── MissingHoistError     ← MISNAMED — INVALID-class (no valid hoist exists)
│   ├── MissingPrevious       ← wrapper around any throw from prev()
│   └── MissingSuccessor      ← MISNAMED — INVALID-class (line ends early)
├── MissingEntryError
│   └── MissingPostEntry      ← MISNAMED — INVALID-class (post lacks canonical entry)
└── LooseTwistError

NamedError
├── HashNotFoundError
├── MissingHashPacketError    ← genuine atom-not-in-bundle
│   └── MissingPrevError      ← genuine atom-not-in-bundle, via prev() path
├── ShapeError                ← already correctly named: INVALID
└── ReqSatError               ← already correctly named: INVALID (mismatch)
```

The five "MISNAMED" entries are the bulk of the workshop's false
yellows. Each one fires when *all relevant atoms are present in the
bundle* but a structural rule is broken — these are INVALID per spec,
not MISSING.

## Proposed surgical changes (small, ordered easiest → hardest)

### 1. Rename the four misnamed `Missing*` classes

| current | proposed | rationale |
|---|---|---|
| `MissingHoistError` | `InvalidLeadError` | A lead is invalid iff no twist in the line carries the canonical {S→meet, SS→S(meet)} entries for it. The atoms are all present; the *structure* doesn't satisfy §6's hoist invariant. |
| `MissingPostEntry` | `InvalidPostError` | The post twist *is* in the bundle; its rigs pairtrie just lacks the canonical entry for the lead. Per §6 that's a post-validity rule, not a missing-atom condition. |
| `MissingSuccessor` | `LineTooShortError` (or `InvalidLineSegmentError`) | The line legitimately ends; that's an invariant on segment completeness, not on atom presence. |
| `MissingPrevious` (the wrapper) | drop the wrapper entirely; rethrow the inner error | See §2 below. |

Pure renames + one alias each (`class MissingHoistError extends
InvalidLeadError {}` left in place for one release) keep callers
working while the workshop switches over. Class hierarchies still let
`instanceof InterpreterResult` work the same.

### 2. Stop swallowing distinctions in `interpret.js:prev()`

Current code (`src/core/interpret.js:80-89`):

```js
prev(hash) {
    if (hash?.isNull?.()) {
        return null;
    }
    try {
        return this.twist(hash).prev();
    } catch (e) {
        throw new MissingPrevious(hash);
    }
}
```

This catches `MissingHashPacketError` (genuine missing atom → MISSING)
and any other lookup-time error and *rebrands them all* as
`MissingPrevious`. Downstream loses the ability to tell "I couldn't
find the prev atom you said exists" (yellow) from "the prev chain is
structurally wrong" (red).

**Fix:** drop the try/catch. Let `MissingHashPacketError` propagate as
itself. If `prev()` can throw a *non-missing* error today, look at each
call site and convert it to an explicit invariant exception there.

### 3. Make the lead-validity invariant fire *before* the hoist search

The proximate cause of the three false-yellows in `hh_tether_*` is that
`hitchMeet` → `hitchHoist` returns null and we throw
`MissingHoistError`. But we never checked the simpler invariant first:
**a lead must be a fast twist**.

Add a precondition at the top of `hitchMeet` (or in a new
`_validateLead`):

```js
hitchMeet(hash) {
    const leadTwist = this.twist(hash);
    const teth = leadTwist.tether?.();          // or however it's accessed
    if (!teth || teth.hash.isNull()) {
        throw new InvalidLeadError(hash, 'lead.teth is NULL — not a fast twist');
    }
    if (!teth.isBasicTwist?.()) {
        throw new InvalidLeadError(hash, 'lead.teth is not a basic twist');
    }
    // ... existing hitchHoist call ...
}
```

This catches `hh_tether_null`, `hh_tether_not_twist`, and
`hh_tether_symbol` with a *specific* and *correctly-named* error,
leaving `hitchHoist` to do its job of finding a hoist among present
atoms for a *legitimately* fast lead.

### 4. Split `MissingError` so consumers can dispatch on category instead of name prefix

Right now the workshop does `/^Missing/.test(name) → warn`. After the
renames above, the workshop could do `instanceof MissingError ||
instanceof MissingHashPacketError → warn`, which is better than name
sniffing but still requires the workshop to know two unrelated class
trees.

A more permanent fix: introduce a shared base for "MISSING" (atom not
in bundle) and another for "INVALID" (structural rule violated):

```js
// src/core/interpret.js
class IssueError extends NamedError {}
class MissingIssue extends IssueError {}     // spec MISSING / UNKNOWN — yellow
class InvalidIssue extends IssueError {}     // spec INVALID / MISMATCH — red
```

Then:
- `MissingError`, `MissingHashPacketError`, `MissingPrevError`
  `extends MissingIssue`
- `InvalidLeadError`, `InvalidPostError`, `LineTooShortError`,
  `ShapeError`, `ReqSatError` `extends InvalidIssue`

Consumers (the workshop's app.js, and any future tooling) classify
with two clean `instanceof` checks. The class-hierarchy reshuffle is
mechanical and doesn't change any throw sites.

### 5. Attach a structured payload, not just a message string

Today the workshop displays `e.message`, which is enough for a human
but loses everything else. While renaming, add to each
`InvalidIssue`/`MissingIssue`:

```js
{
    spec: '§6 p.14 — lead invariant',   // pointer back into the spec
    structype: 'lead' | 'post' | …,     // matches the .json sidecar field
    reference: <Hash>,                  // the twist this issue attaches to
}
```

The .json sidecars already use this shape (see e.g.
`todatests/rigging/hh_tether_null.json`'s `issue` block). Aligning the
JS error payload with the canonical .json schema means the workshop
(and any future audit tool) can render issues exactly the way the
fixtures describe them.

## What the workshop would do after the JS changes

`app.js`'s `CHECKERS[0].run` becomes:

```js
} catch (e) {
    if (e instanceof MissingIssue)  return { state: 'warn', detail: e.message }
    if (e instanceof InvalidIssue)  return { state: 'bad',  detail: e.message }
    throw e   // genuinely unexpected — surface as a FAIL
}
```

No name sniffing, no special cases for `Missing*` subclasses, and no
heuristic re-classification when a new class lands upstream.

## What we can do *today* (interim workshop-side mitigation)

Until the JS lands these changes, the workshop can hardcode an explicit
classification list. Two known-INVALID classes are in the `Missing*`
namespace and routinely fire on present-but-bad bytes:

```js
const JS_INVALID_AS_MISSING = new Set([
    'MissingHoistError',
    'MissingPostEntry',
    'MissingSuccessor',
])

// in CHECKERS[0].run catch:
if (JS_INVALID_AS_MISSING.has(name)) return { state: 'bad', detail: ... }
if (/^Missing/.test(name))           return { state: 'warn', detail: ... }
throw e
```

`MissingPrevious` is left in the yellow bucket because the wrapper
currently swallows the distinction (#2 above) — sometimes it really is
a missing atom. Once #2 lands upstream, `MissingPrevious` goes away.

## Open questions

- **What exactly should happen for a topline whose atom is genuinely
  absent vs. one whose successor walk ends prematurely?** The spec
  treats both under §9.1.3 but the former is MISSING (yellow) and the
  latter is INVALID (red — the line you have is structurally short).
  The current code throws bare `MissingError("Missing topline
  successor")` for the second case; rename that throw to a new
  `LineTooShortError` per #1, but worth confirming with §6/§7.
- **Post-rig conflict** (`interpret.js:305`: `throw new Error("post
  rig entry conflict!")`) — this is INVALID, not MISSING. Should
  become `InvalidPostError("post rigs entry disagrees with hoist")`
  with a proper class.
- **`Error("Meet is not fast.")` at `interpret.js:289`** — same shape;
  the meet is structurally wrong → `InvalidMeetError`.
- **`LooseTwistError`** is already a distinct class, but the workshop
  currently propagates it as a FAIL since it doesn't match `/^Missing/`.
  Per spec a loose twist (no fast tether back to a topline) is an
  INVALID-class issue; the proposed `InvalidIssue` base would catch it
  uniformly.
