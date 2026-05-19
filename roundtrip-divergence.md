# Decompile → Recompile Roundtrip Divergence Audit

For every `.toda` file in the workshop's rig list (60 entries, all under
`todatests/rigging/`), the workshop's load path runs `decompile(buf)` to
produce TRDL, sets the editor doc, and the auto-build then `compile()`s that
TRDL back to bytes. This audit measured whether the recompiled bytes match
the original .toda bytes (the "clean roundtrip" property).

## Headline number

**0 of 60 `.toda` files roundtrip cleanly.** Every file's recompiled bytes
differ from the original. The workshop's existing `pass === 'rebuild-diff'`
heuristic correctly flags 59 of them (one — `invalid_rigging_green.toda` —
hits a state where `initial_toda_load` doesn't capture original bytes; see
below).

Raw harvest in [`roundtrip-raw.json`](roundtrip-raw.json),
categorized in [`roundtrip-cats.json`](roundtrip-cats.json).

## Categories by byte-size delta

| Category | Count | Pattern |
|---|---|---|
| Shrunk (recompile < original) | 15 | Mostly designed-bad `hh_*` rigs where decompile strips invalid / orphan atoms |
| Same length, different bytes | 1 | `hh_valid_lead_root.toda` — atom reorder + content variation (see §A) |
| Modest growth (1.0×–1.3×) | 8 | Small additions; usually shield arb regenerated |
| Big growth (1.3×–1.8×) | 20 | Hitch / kiwano variants; shielding regeneration is the dominant cause |
| Roughly doubled (≥1.8×) | 15 | Multi-line lash/splice rigs with multiple shielded lines |
| No initial (origLen undefined) | 1 | `invalid_rigging_green.toda`: see §F |

Total: 60.

## Root causes

These map to the divergence patterns above. Several are documented in
[CLAUDE.md](CLAUDE.md)'s "Known v1 caveats" section; the audit confirms
their full scope.

### Cause 1 — Decompile is unshielded-only (v1)

CLAUDE.md, decompile.js: *"bytes → TRDL entities (unshielded path only
in v1)."* For shielded rigs, decompile produces TRDL that doesn't faithfully
preserve the shield structure. Recompile then generates a *fresh* shield
configuration, which can be larger (more arb shield atoms) or differently
shaped than the original.

Affected: roughly all "big growth" and "doubled" cases.

### Cause 2 — Random shields (non-determinism per CLAUDE.md)

*"Random shields make `shielded: true` rigs non-deterministic across runs."*
Even when shielding *is* preserved, each compile generates fresh random
`arb` content for shields. So two compiles of the same TRDL produce
different bytes. This is fundamental, not a bug — but it makes
byte-equality roundtrip impossible for any rig that uses shields.

Affected: anything with `shielded: true` lines. (b and c in `simple_lash_f1`
are `shielded: false`; a, d, e default to shielded, hence the doubling.)

### Cause 3 — Anonymous-line naming order

CLAUDE.md: *"Anonymous-line naming in decompile (`a`, `b`, `c`, …)
follows JS atom byte-discovery order, which can differ from the Clojure
server's JVM hash-bucket order. The resulting TRDL is structurally
equivalent — same rig, possibly different label assignment to nameless
lines."*

This affects TRDL text equality across implementations, but for our
self-roundtrip (JS decompile → JS recompile) it's deterministic — same
JS atom-discovery order both times. So Cause 3 is *not* a contributor here.

### Cause 4 — Atom serialization order

The example in §A below (`hh_valid_lead_root.toda`) has byte 1 differing
between original and recompile despite identical total length. Byte 1 is
the first byte of the *digest portion* of the first atom's identifier.
Either: (a) the first emitted atom differs in content (semantically
equivalent but laid out differently), or (b) the first emitted atom is a
different atom entirely (atom-ordering difference, same set, different
sequence).

Decompile-then-recompile in JS doesn't preserve the original `.toda` file's
atom emission order. The atom *set* may be the same modulo shield random
content, but the *order in the file* isn't.

This is a real divergence even for `shielded: false` rigs, and it's the
hardest one to fix because it requires recompile to know the original
file's serialization order.

### Cause 5 — Decompile strips invalid / orphan atoms

For the 15 "shrunk" rigs, the original `.toda` file contains atoms that
the rig structure doesn't actually use — extras meant to test how the
checkers handle malformed input (e.g. `hh_no_s_lead.toda` has a hitch
referencing a non-existent shielded-lead atom; `hh_tether_not_twist.toda`
has a tether pointing at a non-twist).

Decompile reads only the rig-structure atoms and emits TRDL that captures
those. Recompile produces a minimal valid-looking serialization. The
diagnostic atoms vanish. **This is a serious problem for the test suite:**
several of these rigs are *only* testing the checkers' handling of those
extras, and the roundtrip silently discards the thing being tested.

Examples (delta in bytes):

| Path | Δ | What gets stripped |
|---|---|---|
| `hh_no_s_lead.toda` | −174 | The lead's shielded-key entry |
| `hh_no_ss_lead.toda` | −174 | The lead's double-shielded-key entry |
| `hh_tether_not_twist.toda` | −298 | The non-twist atom pointed at by the tether |
| `hh_tether_symbol.toda` | −240 | The symbol that the tether references |
| `hh_tether_null.toda` | −208 | The NULL-tether construction |
| `hh_mismatched_s_ss_values.toda` | −240 | One of the mismatched shield entries |
| `hh_non_fast_meet.toda` | −240 | The non-fast meet twist's distinguishing atoms |
| `hh_self_referential_rig.toda` | −240 | The self-reference loop |

In every case, the workshop's rebuild-diff section shows the recompiled
rig getting *different* checker verdicts than the original (typically the
recompile is more permissive — the test rig becomes "fixed" by stripping
its bug).

## Per-category representatives

### §A. `hh_valid_lead_root.toda` (same length, different bytes)

- Original 1450 bytes, recompiled 1450 bytes, **byte 1 differs**.
- 8 twists, 17 atoms.
- `shielded: true` lines → random shield arb regenerated.
- Even with identical length, byte 1 is in the digest of the first emitted
  atom's identifier. The first emitted atom of the recompile is a
  different atom (or the same atom with different shield content).

### §B. `simple_lash_f1.toda` (roughly doubled, 4862 → 9414)

- 5 lines (a:6, b:1, c:4, d:3, e:6) — 20 twists total.
- 4 hitches (H1–H4).
- `b` and `c` are `shielded: false`; `a`, `d`, `e` default to shielded.
- Recompile produces 88 atoms: 20 twists, 20 bodies, 25 arb, 23 pairtrie.
- The roughly-doubled byte count comes from arb shield content
  regenerated for 15 shielded twists (a, d, e — the lines without
  `shielded: false`).

### §C. `complex_maximal_time_crossing_complex.toda` (8365 → 17104)

The biggest absolute delta. Multi-line, multi-hitch, heavy shielding.
Recompile regenerates shields for every shielded line.

### §D. `hh_corkline_twist_missing.toda` (1454 → 1240, −214)

The "designed-bad" rig where the corkline twist is intentionally absent.
Original has additional atoms (probably the hitch's references that
*should* fail because the target twist isn't there). Decompile produces
TRDL describing the present lines (a:1, b:4, c:2 — 7 twists) without
referencing the missing corkline. Recompile produces a leaner file with
just the 7 twists' worth of structure.

The TRDL emitted by decompile uses `prev: "dangling"` for lines without
predecessors — a workshop-specific marker for "this is where the line
ends; don't try to find a predecessor."

### §E. `splice_mismatch.toda` (16353 → 26640)

The largest file in the test set. Recompile adds ~10KB. Likely a rig
with many shielded lines where each shield is regenerated. Note: this
rig is intentionally bad — splice mismatch — so the recompile's "fix" by
canonicalization may mask the original's bug.

### §F. `invalid_rigging_green.toda` (no `origLen` captured)

The harness recorded `currLen: 5224` but no `origLen`. This is the only
file where `window.workshop.initial_toda_load.bytes` was null at probe
time. Looking at the harvest detail (`diffNote: false`, `diffRowCount: 0`),
the rebuild-diff path didn't fire — the workshop saw the recompiled bytes
as the "initial" load. Possible cause: the load_bytes path bailed before
setting `initial_toda_load`, then a subsequent compile populated env. The
specific failure mode is worth digging into; one of:

- The decompile threw an error and `set_rigcheck('bad', 'DECOMPILE ERROR', …)`
  fired without setting `initial_toda_load.bytes`.
- The check-supported fast-path bailed (abject or > 500 twists), clearing
  `initial_toda_load = null`, and a subsequent state mutation populated
  `env.buff` without rebuilding the workshop's snapshot.

Worth a focused single-rig debug session.

## What this means for the workshop's test value

The .toda fixtures in `todatests/rigging/` were authored to test specific
rigging conditions (shielding, tether validity, hoist correctness,
splice mismatch, etc.). The workshop's decompile→recompile loop:

1. Does not preserve shielding faithfully (Cause 1).
2. Generates random arb content even when shielding is preserved (Cause 2).
3. Strips diagnostic atoms from designed-bad rigs (Cause 5).
4. Reorders atom emission within the file (Cause 4).

For **valid rigs that pass all four checkers** (the `complex_*`,
`valid_kiwano_*`, `hh_valid_*`, `simple_*`, `unit_rig*` group): the
recompile *might* be semantically equivalent but the bytes diverge — and
the rig-check panel typically shows the recompile getting *worse* verdicts
than the original. That's worth a one-shot investigation: are the rigs
semantically equivalent (just byte-different) or does the recompile
actually break them?

For **invalid rigs** that exist to test checker behavior on malformed
input: the recompile silently strips the malformed part, so the
re-checked rig is testing nothing.

## Recommendations

1. **Surface the divergence in the workshop UI more clearly.** The
   rebuild-diff section is currently appended below the initial rows.
   Promote it to a banner like "warning: recompile differs from original
   by X bytes" with a one-click toggle between viewing original vs
   recompile in the visualizer.

2. **For test fixtures, treat .toda load as read-only.** Don't run the
   decompile→recompile cycle when loading a `.toda` from `todatests/`.
   Display the original bytes' rig-check results directly. Only run the
   decompile when the user explicitly chooses to edit the TRDL.

3. **Preserve shield atoms through decompile.** A v2 decompile that
   captures `lead.shld` atom content (rather than treating shielding as a
   boolean) would let recompile reproduce the same bytes for `shielded:
   false` rigs and produce *byte-equal* recompile for any rig the user
   doesn't edit.

4. **Preserve diagnostic atoms.** When decompiling, also capture atoms
   that aren't part of the rig structure but are *referenced* by the rig
   atoms (e.g. dangling hash references). Emit them in the TRDL as
   `extra: ...` entities so recompile can re-include them. Without this,
   the designed-bad test rigs lose what they're testing.

5. **Investigate `invalid_rigging_green.toda` specifically** (§F) — the
   only file where the workshop's roundtrip detection silently passes
   (`diffNote: false`). Either a real workshop bug or an edge case in
   load_bytes' state management.

6. **Make atom emission order deterministic and round-trippable.**
   Either: (a) sort atoms canonically (e.g. by hash) so emission order is
   stable across implementations, or (b) preserve the original atom
   ordering through decompile and re-emit it on recompile. Without one or
   the other, byte-equality is impossible even for trivial rigs.
