# TRDL syntax suggestions for rig-perfect roundtrip

This document lists the TRDL syntax extensions the rigging-workshop
needs in order to decompile every existing .toda test fixture, then
recompile it back to a byte stream that produces the **exact same rig
shape** as the original. Without these extensions, the workshop's
decompile→recompile loop silently canonicalizes designed-bad rigs:
the recompiled .toda file is *a valid rig that the rig-checkers
accept*, even though the original was supposed to be *invalid* and
the test relies on that.

The findings are driven by `roundtrip-bench.html`'s SHAPE-EQ column,
which canonicalizes the workshop renderer's layout into a sorted
JSON string and does literal `before === after` comparison. SHAPE-EQ
catches drift the four rig-checkers can't see — designed-bad rigs
where the recompiled byte stream is structurally different from the
original but the checkers happen to give the same colour either way.

This is the **workshop's** local list. The workshop will implement
each extension locally as it's needed. We're proposing the same
syntax for upstream TRDL so hand-authored fixtures and the
Clojure-side decompiler stay aligned. Each extension below has a
"why now / why upstream" sub-section answering whether it can stay
workshop-local indefinitely.

---

## How rigs go wrong (today)

A .toda fixture's body slots are six hashes: `prev`, `teth`, `shld`,
`reqs`, `rigs`, `carg`. Designed-bad rigs deliberately put values
into these slots that violate the spec:

- `rigs:` points at a pairtrie whose pairs don't satisfy the
  canonical `{S(lead) → I(meet), SS(lead) → S(meet)}` quad
- `rigs:` points at an atom that isn't a pairtrie at all
- `shld:` points at an atom that isn't an arb
- `teth:` is NULL when the twist is asserted as a lead (or vice versa)
- `prev:` chains to a twist whose body is malformed
- `carg:` points at a structure other than the canonical poptop pairtrie

TRDL today gets you the *good* version of each of these: it names
the lead/meet/hoist of a hitch and the compiler synthesizes the
canonical rigging pairtrie; it expresses `shld: null` or `shld:
<hex>` and the compiler synthesizes an arb; it has `shielded: true/
false` per line. It can't express "give me a `rigs:` pointing at a
pairtrie with these *wrong* pairs" or "give me a `shld:` pointing
at a hashlist instead of an arb".

For those cases, the decompile loses the badness, the recompile
emits a clean rig, the SHAPE-EQ check fails, and the rig-checkers
flip from RED to GREEN.

---

## Proposed extensions

Numbered by frequency of usage in the existing fixture set. Each
extension is a backwards-compatible addition to the per-twist
`{id, ...}` override entity that decompile already emits.

### 1. `rigs:` override for arbitrary body.rigs content

**Affects:** `hh_wrong_hoist_values`, `hh_mismatched_s_ss_values`,
`hh_wrong_shield`, `hitch_meet_tether_null`, `hh_non_fast_meet`,
`complex_bad_hoist_direct_to_indirect`,
`complex_bad_hoist_indirect_to_direct`, `hitch_splice_post_wrong_hoist`,
`multiple_hoists_green`, `invalid_rigging_green` (~10 fixtures).

**What's needed:** the `{hitch, lead, meet, hoist}` entity is a
high-level convenience — it tells the compiler to *build* the
canonical four-pair quad in the hoist's `rigs:` slot. For rigs that
test what happens when those pairs are wrong, we need a low-level
escape hatch.

```jsonl
{"id":"c[2]", "rigs":{"raw":"<pairtrie-hex>"}}              // verbatim atom bytes
{"id":"c[2]", "rigs":{"pairs":[["41…ab","41…cd"], …]}}      // explicit pairs
{"id":"c[2]", "rigs":{"shape":"hashlist","hex":"41…"}}      // point at non-pairtrie atom
{"id":"c[2]", "rigs":"null"}                                 // explicit NULL slot
```

When present on a hitch's *hoist* twist, the explicit `rigs:`
override replaces what `{hitch}` would have built. When present
on a *post* twist (whose `rigs:` would carry the
`{lead → hoist}` post-rig pair) the override likewise wins.

**Why now:** ~25% of the SHAPE-NEQ fixtures are designed-bad-rigs
fixtures, and rigs-content invariants are the largest single
category of "designed bad" tests. The workshop can fake this with
the `raw:` form alone if upstream resists — emit verbatim atom bytes
and let `compile.js` write them straight into the body slot.

**Why upstream:** the canonical Clojure decompiler will eventually
need to round-trip the same fixtures. Doing this with hand-rolled
byte injection breaks the TRDL-is-a-text-format contract.

---

### 2. `shld:` non-arb shape

**Affects:** `hh_wrong_shield`, `lead_shield_non_arb`,
`invalid_shielding_green`, `missing_shield` (~4 fixtures).

**What's needed:** today TRDL `shld:<hex>` means "the bytes of an
arb atom whose content is `<hex>`". For designed-bad rigs where the
lead's `shld:` points at an atom of a different shape (hashlist,
pairtrie, twist, …), we need a way to express it.

```jsonl
{"id":"a[0]", "shld":{"raw":"<arb-or-other-atom-bytes>"}}    // verbatim atom
{"id":"a[0]", "shld":{"hex":"41…","shape":"hashlist"}}        // point at existing atom
{"id":"a[0]", "shld":"null"}                                  // already supported
{"id":"a[0]", "shld":"<arb-hex>"}                             // already supported (arb bytes)
```

**Why now:** without it the shield-shape fixtures all canonicalize.

**Why upstream:** same as rigs-override; staying consistent across
the two decompilers.

---

### 3. `carg:` non-poptop, non-cargo-default content

**Affects:** all line-genesis twists with non-null, non-poptop cargo
in the original bytes (~10 fixtures including `simple_last`,
`missing_rigging`, `simple_lash_f1/f2`, `cork_*`,
`post_rigging_missing_post_key`, others).

**Status (workshop):** the workshop just added per-twist `cargo:`
overrides that distinguish `'null'`, `'arb:<hex>'`, and literal hash
hex (the first being "explicitly NULL", the second a fresh arb, the
third a reference to an already-present atom). See
`toda/decompile.js`'s cargo block. This is sufficient for the cargo
shapes seen in the fixture set.

**Why upstream:** the existing `cargo: "string"` value (which hashes
the string into a synthetic hash) is hand-author-friendly but
lossy for decompile. The proposed three encodings are precise. If
upstream prefers a single tagged value, e.g.:

```jsonl
{"id":"c[0]","cargo":{"arb":"<hex>"}}
{"id":"c[0]","cargo":{"hash":"<hex>"}}
{"id":"c[0]","cargo":"null"}
```

…that's structurally equivalent and likely easier to parse than the
positional `arb:` prefix the workshop adopted.

---

### 4. `reqs:` / `sats:` non-ed25519 explicit content

**Affects:** `cork_reqsat_fail`, `lash_succession_reqsat_fail`,
`unit_rig`, `unit_rig_multi`, `cork_reqsat_fail`-style.

**What's needed:** today TRDL has per-line `reqsat: "ed25519"` or
`"null"`. There's no way to put a *wrong* reqsat trie into a
designed-bad rig, or a non-ed25519 satisfier.

```jsonl
{"id":"a[3]", "reqs":{"raw":"<pairtrie-hex>"}}
{"id":"a[3]", "reqs":"null"}
{"id":"a[4]", "sats":{"raw":"<pairtrie-hex>"}}
```

**Why now:** four fixtures depend on it.

**Why upstream:** reqsat coverage is central to long-term rig
correctness; this should be a first-class TRDL concept.

---

### 5. `prev:` outside-file and `teth:` outside-file (literal hash)

**Status:** **already supported** in the workshop. `decompile.js`
emits `prev: "<66-char hex>"` for dangling/cross-line prevs and
`teth: "<66-char hex>"` for tethers whose target atom isn't in the
file. `compile.js` writes those into the body slot verbatim. No new
syntax needed — just documenting that the literal-hash form on these
two fields means "atom not in bundle, write the hash as-is".

**Why upstream:** to align the Clojure decompiler with this
convention. Today its TRDL emits `prev: "dangling"` (a sentinel
that compile resolves to a fresh random arb), which is non-
deterministic and breaks rig-perfect roundtrips.

---

### 6. Hitch entity: explicit `lead.teth`, `meet.teth`, post-twist override

**Affects:** `hh_tether_null`, `hh_tether_not_twist`,
`hh_tether_symbol`, `hh_non_fast_meet`, `hitch_meet_tether_null`.

**What's needed:** today `{"hitch", "lead": …, "meet": …, "hoist":
…, "fastener": …}` auto-derives `lead.teth = fastener` and
`meet.teth = (canonical fast-twist before meet)`. For designed-bad
rigs where one of those is NULL or wrong-shape, the existing
per-twist override is fine in principle (`{"id":"meet[…]","teth":
"null"}`), but the hitch entity then needs to *not* override what
the twist override said.

The workshop already implements this precedence: `trdl_to_spec`'s
override path wins over hitch-derived auto-teth. Need to confirm
the upstream Clojure version has the same precedence rule.

**Why upstream:** this is a precedence clarification, not a syntax
addition. Worth documenting explicitly.

---

### 7. Hitch `lead`, `meet`, `fastener`, `hoist`: literal-hash form

**Affects:** any hitch whose participants are anchored upstream
(cross-file hitches in delegation chains; not common in this
fixture set but will be needed for abject-workshop fixtures).

**What's needed:** allow `"lead": "<66-char hex>"` instead of
`"lead": "a[0]"`. The compiler then doesn't try to look up `a[0]`
in the local lines map; it uses the hash directly.

**Why upstream:** required for delegation-chain rigs that
abject-workshop will need.

---

## Out of scope (decompile bugs, not TRDL gaps)

These don't need new TRDL syntax — they're workshop-local
decompile bugs being fixed in parallel:

- `simple_last` line absorption: caused by force-null cargo (fixed
  2026-05-17 in `decompile.js`)
- Kiwano cluster (6 fixtures, all bb-only `ok → warn`): under
  investigation; likely a single decompile issue
- Line-discovery ordering instability: `shape.js` now sorts firsts
  by hash before y-assignment

---

## Adoption path

Workshop side:
1. Land each extension as a parser change in `toda/trdl.js` and a
   compiler branch in `toda/compile.js`.
2. Bump `decompile.js` to emit the new form when it detects the
   relevant pattern.
3. Verify each landing with the roundtrip-bench's SHAPE-EQ column.

Upstream side (later):
1. Share this document.
2. For each extension, agree on syntax shape.
3. Land matching parser/compiler/decompiler changes in
   toda-clj / toda-bb.
4. Test that hand-authored `.trdl` files using the new syntax
   roundtrip cleanly through both sides.

---

## Appendix: roundtrip-bench column reference

After landing the workshop-side support for these extensions, the
SHAPE-EQ column of `roundtrip-bench.html` should be EQ for every
fixture. Verdict `PERFECT` requires both checker-eq AND shape-eq.

| date       | perfect | shape-eq, checkers-diverge | shape-neq | running change |
|------------|---------|----------------------------|-----------|----------------|
| 2026-05-17 (pre-cargo-fix) | 11 / 68 | 9  | 48 | baseline |
| 2026-05-17 (post-cargo-fix, firsts-sort) | 13 / 68 | 10 | 45 | +2 perfect |
| 2026-05-17 (rigs-raw + mid-line cargo) | 18 / 68 | 17 | 33 | +5 perfect |
| 2026-05-17 (cargo-raw for non-arb) | **33 / 68** | 22 | **13** | +15 perfect |
| 2026-05-17 (conflicting-prev + prev-non-twist) | 33 / 68 | 23 | **12** | +1 shape-eq |

The shape-eq-but-checker-diverge bucket grew from 9 → 22 over these
changes: the recompile produces a structurally-equivalent rig
(SHAPE EQ) but the *bytes* still differ (different random shields,
atom interleaving), which shifts what the checkers see. That's
checker stability work, not decompile-loop work.

### Remaining 13 SHAPE-NEQ fixtures

Clustered by diff position (suggests shared root cause):

**char 22 — twist-count drops (was 5 fixtures, now 4 after the
conflicting-successors + prev-to-non-twist fixes; counts now match
across all 5, but 4 still SHAPE NEQ on layout because they reference
non-twist atoms that aren't synthesized in the recompile):**
`splice_mismatch` — **now PERFECT**.
Still NEQ but with matching twist counts:
`conflicting_successors`, `cork_prev_invalid_green`,
`cork_prev_invalid_red`, `lashed_non_colinear`.

The remaining diff: `body.prev` (or other slot) points at an arb /
pairtrie / etc. atom in the original bundle. The literal-hex prev
override makes the body bytes match, but the referenced atom itself
isn't carried into the rec bundle. Shape extractor's prev-walk
therefore can't reach the atom in rec → layout differs.

**Proposed extension #8 — raw atom entities:**
```jsonl
{"atom": "<hash-hex>", "shape": "arb", "raw": "<bytes-hex>"}
```
Standalone TRDL line that synthesizes the named atom into the
output bundle. Compile registers it in the global lat regardless of
whether any spec.lines twist references it. Lets designed-bad rigs
preserve "orphan" atoms (referenced only by body slots via literal
hex) through the roundtrip.

**chars 71–2004 — single-edge differences (6 fixtures):**
`lead_shield_non_arb` (71), `lash_succession_reqsat_fail` (114),
`missing_rigging` (114), `missing_shield` (845),
`post_rigging_missing_post_key` (1435), `cork_missing_rigging`
(1562), `cork_reqsat_fail` (2004). Same twist count;
edge missing or shifted. Likely one of the remaining proposed
extensions (reqs/sats override for the reqsat fixtures; non-arb
shield for `lead_shield_non_arb`) catches each.

**single oddball (2):** `hh_tether_not_twist` (50), tether shape
edge cases.
