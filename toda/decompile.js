// .toda bytes → TRDL entities. Mirrors twist-maker.decompile.
//
// Hitch detection uses the spec-canonical hoist rig: every hitch's hoist
// pairtrie has {S(lead, I(lead)) → I(meet), S(lead, S(lead, I(lead))) →
// S(lead, I(meet))}. We find candidate hoists by scanning for I(meet) as a
// value in some twist's rig, then confirm the matching SS pair against the
// lead's shield (NULL shield → plain hash, else hash prefixed with the
// shield arb's content).

import { bytes_to_hex, hex_to_bytes, sha256, byte_concat } from './bytes.js'

const TWIST = 0x48, BODY = 0x49, ARB = 0x60, HASHLIST = 0x61, PAIRTRIE = 0x63
const SYM_POPTOP = '22c70173874680c58e5c1d32854bd10486aac6f1aa821b56e3d512fd72e45ac72e'
const NULL_HASH = '00'
const SHAPE_NAMES = {
  [TWIST]: 'twist', [BODY]: 'body', [ARB]: 'arb',
  [HASHLIST]: 'hashes', [PAIRTRIE]: 'pairtrie',
}

// ---- low-level byte parsing ------------------------------------------------

function pluck_hash(bytes, i) {
  let algo = bytes[i]
  if (algo === 0x41 || algo === 0x22) {
    return { hex: bytes_to_hex(bytes.subarray(i, i + 33)), len: 33 }
  }
  if (algo === 0x00) return { hex: '00', len: 1 }
  if (algo === 0xff) return { hex: 'ff', len: 1 }
  return null
}

function read_be32(bytes, i) {
  return ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0
}

export function parse_atoms(buf) {
  let bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let atoms = [], index = {}, shapes = {}
  let i = 0
  while (i < bytes.length) {
    let h = pluck_hash(bytes, i)
    if (!h) throw new Error('Improper atom at offset ' + i)
    i += h.len
    let shape  = bytes[i++]
    let length = read_be32(bytes, i)
    i += 4
    let cfirst = i
    let last   = i + length - 1
    i += length
    if (index[h.hex]) continue
    let atom = { shape, hash: h.hex, length, cfirst, last }
    atoms.push(atom)
    index[h.hex] = atom
    ;(shapes[shape] = shapes[shape] || []).push(atom)
  }
  return { bytes, atoms, index, shapes }
}

function read_pairtrie(env, atom) {
  let pairs = []
  for (let i = atom.cfirst; i <= atom.last; ) {
    let k = pluck_hash(env.bytes, i); i += k.len
    let v = pluck_hash(env.bytes, i); i += v.len
    pairs.push([k.hex, v.hex])
  }
  return pairs
}

function decode_body(env, body_hash) {
  let a = env.index[body_hash]
  if (!a || a.shape !== BODY) return null
  let i = a.cfirst
  let parts = {}
  for (let f of ['prev', 'teth', 'shld', 'reqs', 'rigs', 'carg']) {
    let h = pluck_hash(env.bytes, i)
    parts[f] = h.hex
    i += h.len
  }
  return parts
}

// Cached body lookups (decompile is called once per build, so cache locally).
function build_body_cache(env) {
  let cache = new Map()
  for (let t of env.shapes[TWIST] || []) {
    let body_hash = pluck_hash(env.bytes, t.cfirst).hex
    cache.set(t.hash, decode_body(env, body_hash))
  }
  return cache
}

// ---- line discovery & naming ----------------------------------------------

function is_null(h) { return !h || h === NULL_HASH }

function discover_lines(env, body_cache) {
  let twist_hashes = (env.shapes[TWIST] || []).map(t => t.hash)
  let succ = new Map()
  let genesis = []
  // Conflicting-successors handling: designed-bad rigs (e.g. the
  // conflicting_successors fixture) intentionally have two twists
  // claiming the same predecessor. last-write-wins in succ.set
  // would silently drop one of them (it isn't a genesis — its prev
  // IS in env.index — so it ends up in no line). To preserve every
  // twist, promote the second-encountered conflicting successor to
  // its own line genesis. The per-twist override loop downstream
  // will then emit a prev override pointing at the contested
  // predecessor (since prev_ref !== expected for the new line-first).
  for (let th of twist_hashes) {
    let prev = body_cache.get(th)?.prev
    let prev_atom = env.index[prev]
    // Treat as genesis when:
    //   - prev is NULL                       — natural line start
    //   - prev hash isn't in the bundle      — dangling
    //   - prev points at a non-twist atom    — designed-bad rig: an
    //     arb or pairtrie sits where a twist hash should be (the
    //     cork_prev_invalid_* fixtures). Without this check, env.index
    //     [prev] is truthy so we'd fall through to succ.set; but
    //     nothing has prev=arb, so the chain-builder never visits
    //     this twist → 10+ twists silently dropped.
    //   - the prev's slot in succ is already taken (conflicting
    //     successor, see comment above this loop)
    if (is_null(prev) || !prev_atom || prev_atom.shape !== TWIST) {
      genesis.push(th)
    } else if (succ.has(prev)) {
      genesis.push(th)
    } else {
      succ.set(prev, th)
    }
  }
  return genesis.map(g => {
    let chain = [g], cur = g
    while (succ.has(cur)) { cur = succ.get(cur); chain.push(cur) }
    return chain
  })
}

function name_lines(env, body_cache, lines) {
  let line_idx = new Map()
  lines.forEach((line, idx) => line.forEach(h => line_idx.set(h, idx)))

  let poptop_idx = null, abject_idx = null
  outer: for (let line of lines) {
    for (let h of line) {
      let carg = body_cache.get(h)?.carg
      if (is_null(carg)) continue
      let cargo_a = env.index[carg]
      if (!cargo_a || cargo_a.shape !== PAIRTRIE) continue
      let pairs = read_pairtrie(env, cargo_a)
      let entry = pairs.find(([k]) => k === SYM_POPTOP)
      if (entry) {
        abject_idx = line_idx.get(h)
        poptop_idx = line_idx.get(entry[1])
        break outer
      }
    }
  }

  let other = []
  for (let i = 0; i < lines.length; i++) {
    if (i !== poptop_idx && i !== abject_idx) other.push(i)
  }

  let named = []
  if (poptop_idx != null) named.push({ name: 'poptop', twists: lines[poptop_idx] })
  if (abject_idx != null) named.push({ name: 'abject', twists: lines[abject_idx] })
  let letters = 'abcdefghijklmnopqrstuvwxyz'
  other.forEach((idx, i) => named.push({ name: letters[i], twists: lines[idx] }))
  return named
}

// ---- shield-aware hitch detection -----------------------------------------

async function sha256_hex(bytes) {
  return '41' + bytes_to_hex(await sha256(bytes))
}

// shield(twist, data) = hash(I(twist))(C(twist.shld) | data); if shld is
// NULL, devolves to hash(I(twist))(data). shield_bytes is C(twist.shld) or
// null. s_hash takes a 33-byte (66 hex char) hash, returns same shape.
async function s_hash(h_hex, shield_bytes) {
  let h_bytes = hex_to_bytes(h_hex)
  let data = shield_bytes ? byte_concat(shield_bytes, h_bytes) : h_bytes
  return sha256_hex(data)
}
async function ss_hash(h_hex, shield_bytes) {
  return s_hash(await s_hash(h_hex, shield_bytes), shield_bytes)
}

function shield_bytes_for(env, body_cache, lead_h) {
  let shld_h = body_cache.get(lead_h)?.shld
  if (is_null(shld_h)) return null               // NULL shield → plain hash
  let arb = env.index[shld_h]
  if (!arb || arb.shape !== ARB) return null     // missing or wrong shape
  return env.bytes.subarray(arb.cfirst, arb.last + 1)
}

function is_fast(body_cache, h) {
  let teth = body_cache.get(h)?.teth
  return teth && !is_null(teth)
}

function last_fast(body_cache, twist_h, skip = 0) {
  let cur = twist_h, n = skip
  while (cur && !is_null(cur)) {
    if (is_fast(body_cache, cur)) {
      if (n > 0) { n--; cur = body_cache.get(cur)?.prev }
      else return cur
    } else {
      cur = body_cache.get(cur)?.prev
    }
  }
  return null
}

function lead_and_meet(body_cache, fast_h) {
  let meet = last_fast(body_cache, fast_h, 0)
  let lead = last_fast(body_cache, fast_h, 1)
  return (lead && meet) ? [lead, meet] : null
}

function rig_pairs_of(env, body_cache, twist_h) {
  let rig_h = body_cache.get(twist_h)?.rigs
  if (is_null(rig_h)) return null
  let rig_a = env.index[rig_h]
  if (!rig_a || rig_a.shape !== PAIRTRIE) return null
  return read_pairtrie(env, rig_a)
}

// Confirm a candidate hoist by checking both spec-canonical pairs against
// the lead's shield function. False positives from value-only matches
// (e.g. dense rigs where some other twist's pairtrie happens to contain
// meet_h as a value) get rejected here.
async function verify_hoist_quad(pairs, lead_h, meet_h, shield_bytes) {
  let s_lead  = await s_hash(lead_h, shield_bytes)
  let ss_lead = await ss_hash(lead_h, shield_bytes)
  let s_meet  = await s_hash(meet_h, shield_bytes)
  let map = new Map(pairs)
  return map.get(s_lead) === meet_h && map.get(ss_lead) === s_meet
}

async function find_hoist(env, body_cache, succ_map, fastener_h, lead_h, meet_h) {
  let shield_bytes = shield_bytes_for(env, body_cache, lead_h)
  let cur = fastener_h
  while (cur) {
    let pairs = rig_pairs_of(env, body_cache, cur)
    // Cheap value-only filter first; only run the cryptographic confirmation
    // when meet_h actually appears in this twist's rig.
    if (pairs && pairs.some(([, v]) => v === meet_h)) {
      if (await verify_hoist_quad(pairs, lead_h, meet_h, shield_bytes)) return cur
    }
    cur = succ_map.get(cur) || null
  }
  return null
}

function build_succ_map(body_cache) {
  let m = new Map()
  for (let [th, body] of body_cache) {
    if (body && !is_null(body.prev)) m.set(body.prev, th)
  }
  return m
}

async function detect_hitches(env, body_cache, named_lines) {
  let succ_map = build_succ_map(body_cache)
  let hash_to_ref = new Map()
  for (let { name, twists } of named_lines) {
    twists.forEach((h, i) => hash_to_ref.set(h, `${name}[${i}]`))
  }
  let counter = 0
  let out = []
  for (let { twists } of named_lines) {
    let fast = twists.filter(h => is_fast(body_cache, h))
    let seen = new Set(), pairs = []
    for (let h of fast) {
      let lm = lead_and_meet(body_cache, h)
      if (!lm) continue
      let key = `${lm[0]}|${lm[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push(lm)
    }
    for (let [lead, meet] of pairs) {
      let fastener = body_cache.get(lead)?.teth
      if (is_null(fastener)) continue
      let hoist = await find_hoist(env, body_cache, succ_map, fastener, lead, meet)
      if (!hoist) continue
      counter++
      out.push({
        name: `H${counter}`,
        lead:     hash_to_ref.get(lead),
        meet:     hash_to_ref.get(meet),
        fastener: hash_to_ref.get(fastener),
        hoist:    hash_to_ref.get(hoist),
      })
    }
  }
  return out
}

function detect_cross_line_prevs(body_cache, named_lines) {
  let info = new Map()
  for (let { name, twists } of named_lines) {
    twists.forEach((h, i) => info.set(h, { ref: `${name}[${i}]`, line: name }))
  }
  let out = []
  for (let { name, twists } of named_lines) {
    twists.forEach((h, i) => {
      let prev = body_cache.get(h)?.prev
      if (is_null(prev)) return
      let pinfo = info.get(prev)
      if (!pinfo) return
      if (pinfo.line !== name) {
        out.push({ twist: `${name}[${i}]`, prev: pinfo.ref })
      }
    })
  }
  return out
}

function line_shielded(body_cache, twists) {
  if (!twists.some(h => is_fast(body_cache, h))) return false
  return twists.some(h => {
    let shld = body_cache.get(h)?.shld
    return shld && !is_null(shld)
  })
}

// ---- public API ------------------------------------------------------------

export async function decompile(buf, name = 'rig') {
  let env        = parse_atoms(buf)
  let body_cache = build_body_cache(env)
  let lines      = discover_lines(env, body_cache)
  let named      = name_lines(env, body_cache, lines)
  let hitches    = await detect_hitches(env, body_cache, named)
  let crosses    = detect_cross_line_prevs(body_cache, named)

  // Identify the corkline line. trdl_to_spec uses the rig entity's `poptop`
  // field to resolve which line's ids[0] becomes the corkline hash; without
  // a meaningful value it falls back to lines_map.values()[0] which is the
  // first-discovered line — for most test rigs that's the LEADLINE, and
  // the recompile then hands every checker a cork hash that points at the
  // hitch's lead. Symptom: rust reports "lead tether is NULL (not fast)"
  // because it ends up identifying the corkline's own twist as the hitch
  // lead.
  //
  // Heuristic: the corkline is the line that contains hitch hoists but
  // not hitch leads — the topmost line in the stack of hitches. For a
  // single-hitch rig (no splice/lash) the hoist's line and the fastener's
  // line are the same; for splices/lashings the leadline of one hitch may
  // be the topline of another, so we look for the line that's purely a
  // target. Fallbacks cover degenerate cases.
  let lead_lines = new Set(), hoist_lines = new Set(), fastener_lines = new Set()
  let line_of = ref => {
    let m = /^(.+)\[(\d+)\]$/.exec(ref || '')
    return m ? m[1] : null
  }
  for (let h of hitches) {
    if (line_of(h.lead))     lead_lines.add(line_of(h.lead))
    if (line_of(h.hoist))    hoist_lines.add(line_of(h.hoist))
    if (line_of(h.fastener)) fastener_lines.add(line_of(h.fastener))
  }
  let corkline_line_name = null
  for (let l of hoist_lines) {
    if (!lead_lines.has(l)) { corkline_line_name = l; break }
  }
  if (!corkline_line_name) {
    for (let l of fastener_lines) {
      if (!lead_lines.has(l)) { corkline_line_name = l; break }
    }
  }
  if (!corkline_line_name && hitches.length > 0) {
    corkline_line_name = line_of(hitches[0].hoist) || line_of(hitches[0].fastener)
  }

  // Hash → 'line[i]' map, used both by post detection (for hitch entities)
  // and by the per-twist override loop further down.
  let hash_to_ref = new Map()
  for (let { name: ln, twists } of named) {
    twists.forEach((h, i) => hash_to_ref.set(h, `${ln}[${i}]`))
  }

  let out = []
  out.push(corkline_line_name
    ? { rig: name, poptop: corkline_line_name }
    : { rig: name })
  for (let { name: ln, twists } of named) {
    let shielded = line_shielded(body_cache, twists)
    // Always emit reqsat:'null'. The default in trdl.js is ed25519, but the
    // JS port at ed25519.js uses raw 32-byte public keys (per CLAUDE.md's
    // "Known v1 caveats"), so recompile of any shielded line produces a
    // pubkey the canonical checkers can't parse ("could not parse public
    // key" in rust, "ed25519-req INVALID" up the stack). For test rigs we
    // don't need cryptographic signatures — the rig-check verifies tether
    // / hoist / topline structure regardless of req-sat. Stripping reqsat
    // here makes the recompile rig-equivalent under all four checkers
    // until we ship X.509-wrapped public keys in ed25519.js.
    out.push({ line: ln, twists: twists.length, shielded, reqsat: 'null' })
  }
  // For each hitch, detect whether it has a real post (full hitch) or is
  // a half-hitch. Without explicit post info, trdl.js's expand_hitches
  // auto-computes post_kw = next-twist-after-meet on the meet's line,
  // tethers that twist to the hoist, and adds a post-rig entry. For
  // kiwano-family rigs whose hitches are *half-hitches* in the original
  // (no twist has the canonical [lead, hoist] entry), that auto-promotion
  // creates spurious fast twists on adjacent hitches' footlines — rust
  // flags them as "extra fast twist between lead and meet".
  //
  // We identify the post by scanning every twist's rigs pairtrie for the
  // canonical {lead-hash → hoist-hash} entry. The twist whose rigs
  // contains it IS the post. If no twist has it, the hitch is a half-
  // hitch and we emit post:"none" to suppress the auto-tether.
  let ref_to_hash = new Map()
  for (let [hash, ref] of hash_to_ref) ref_to_hash.set(ref, hash)
  function detect_post_for(h) {
    let lead_h  = ref_to_hash.get(h.lead)
    let hoist_h = ref_to_hash.get(h.hoist)
    if (!lead_h || !hoist_h) return 'none'
    for (let t of (env.shapes[TWIST] || [])) {
      let body = body_cache.get(t.hash)
      let rigs_h = body?.rigs
      if (!rigs_h || is_null(rigs_h)) continue
      let rig_atom = env.index[rigs_h]
      if (!rig_atom || rig_atom.shape !== PAIRTRIE) continue
      let pairs = read_pairtrie(env, rig_atom)
      if (pairs.some(([k, v]) => k === lead_h && v === hoist_h)) {
        return hash_to_ref.get(t.hash) || 'none'
      }
    }
    return 'none'
  }
  for (let h of hitches) {
    out.push({
      hitch: h.name, lead: h.lead, meet: h.meet,
      fastener: h.fastener, hoist: h.hoist,
      post: detect_post_for(h),
    })
  }
  // Cross-line prev is folded into the per-twist override loop below
  // (the `{id,...}` form), where it merges with shld/teth/cargo into a
  // single entity per twist. Standalone {twist,prev} entities would
  // collide with the override entities in collect_twist_overrides
  // (replace-by-id, not merge), so we don't emit them separately.
  void crosses
  // Per-twist overrides. We accumulate them keyed by twist id and emit one
  // entity per twist at the end — collect_twist_overrides in trdl.js replaces
  // (doesn't merge) when it sees the same id twice, so emitting separate
  // entities for prev vs shld vs … would lose all but the last.
  //
  // What we preserve here:
  //   • prev:<hex>      — for line-genesis twists whose body.prev points to
  //     a hash NOT in the file (anchored upstream / dangling). We emit the
  //     LITERAL hex from the original body — compile.js writes it straight
  //     into the body slot without synthesizing an arb atom, so the
  //     recompile's body hash matches the original's. Crucial for rig-
  //     perfect: without this, each compile generates a fresh random arb
  //     for "dangling" and every downstream hash cascades, breaking the
  //     hoist trie's S(lead) keys that the canonical checkers expect.
  //   • shld:<hex>      — the shield arb's bytes, verbatim. Recompile already
  //     accepts an shld override; feeding the real bytes here makes the
  //     hoist trie's S(lead)/SS(lead) keys land on the same hashes as the
  //     original, so the recompiled rig is semantically equivalent under
  //     all four checkers instead of failing on a randomly-rolled shield.
  let twist_overrides = new Map()
  let set_override = (id, key, value) => {
    let o = twist_overrides.get(id) || {}
    o[key] = value
    twist_overrides.set(id, o)
  }
  // hash_to_ref is built above (shared with the post-detection scan).
  for (let { name: ln, twists } of named) {
    twists.forEach((h, i) => {
      let id = `${ln}[${i}]`
      let body = body_cache.get(h)
      // prev override:
      //   - line genesis (i === 0) with prev pointing outside the file:
      //     emit the literal hex (dangling).
      //   - any twist with prev pointing into the file but NOT to the
      //     previous twist on the same line: emit the cross-line ref.
      //   - non-genesis prev pointing to the same-line predecessor: no
      //     override needed; trdl_to_spec computes it by position.
      let prev = body?.prev
      if (!is_null(prev)) {
        let prev_atom = env.index[prev]
        if (!prev_atom) {
          // Dangling — atom not in bundle. Emit literal for line-firsts;
          // mid-line dangling is unusual but harmless to skip (positional
          // default ends up referencing the previous twist on the line,
          // which won't match the original body hash — but at least the
          // twist isn't dropped).
          if (i === 0) set_override(id, 'prev', prev)
        } else if (prev_atom.shape !== TWIST) {
          // prev points at a non-twist atom (designed-bad rig:
          // cork_prev_invalid_*). Emit the literal hex so compile
          // writes the same hash into the body slot — the body bytes
          // match the original even though the referenced atom isn't a
          // twist. discover_lines already promoted this twist to a
          // genesis so it gets its own line.
          set_override(id, 'prev', prev)
        } else {
          let prev_ref = hash_to_ref.get(prev)
          if (prev_ref) {
            let expected = i > 0 ? `${ln}[${i - 1}]` : null
            if (prev_ref !== expected) set_override(id, 'prev', prev_ref)
          }
        }
      }
      // teth override: expand_hitches only tethers leads + meets. Every
      // other fast twist (fasteners, hoists, twists fast for other
      // structural reasons) needs an explicit teth — without it, the
      // recompile leaves them non-fast, the lead-footline walk has the
      // wrong fast-twist set, and the canonical checkers reject the rig.
      // This is the kiwano-family bug: rust reports "extra fast twist
      // between lead and meet" or "lead tether is NULL" because the
      // fasteners and hoists came back non-fast on recompile. Emit a
      // teth override for every twist with non-null body.teth; the
      // override path in trdl_to_spec wins over the auto-tether-from-
      // hitches, so this also covers leads and meets correctly when
      // their original teth differs from the hitch's fastener.
      let teth = body?.teth
      if (!is_null(teth)) {
        let teth_ref = hash_to_ref.get(teth)
        if (teth_ref) set_override(id, 'teth', teth_ref)
        else          set_override(id, 'teth', teth)  // literal hex, no atom
      }
      // Cargo: preserve the original body.carg verbatim for every twist.
      //
      // trdl_to_spec's default for "other firsts" (non-poptop, non-abject)
      // is spec.cargo = `cargo-<line_name>` — a deterministic per-line
      // string hashed via str_to_hash, intended for hand-authored TRDL.
      // For decompile, we want the EXACT original cargo bytes so that
      // two slow corkline-genesis twists with distinct cargo don't
      // collapse to the same hash (simple_last bug: b[0] and c[0] both
      // had non-null cargo arbs in the original; force-nulling here
      // produced byte-identical bodies → one twist atom for both).
      //
      // Encodings (matches compile.js's parse):
      //   null atom (00)     → 'null'      (compile: cargo_val = null)
      //   arb atom in bundle → 'arb:<hex>' (compile: rebuild arb)
      //   anything else      → literal hex (compile: write hash as-is)
      //
      // The poptop-line first twist gets its cargo synthesized from
      // spec.poptop (a pairtrie of {SYM_POPTOP → abject_first}) — see
      // compile.js's poptop branch which takes precedence over cargo.
      // So overriding cargo here doesn't affect the poptop encoding.
      // Mid-line twists matter too: designed-bad-rig fixtures like
      // multiple_hoists_green put a cargo on a fast twist mid-line,
      // and dropping that loses an edge in the shape extractor.
      let carg = body?.carg
      if (!carg || is_null(carg)) {
        if (i === 0) set_override(id, 'cargo', 'null')
        // mid-line twists default to no-cargo; no override needed.
      } else {
        let carg_atom = env.index[carg]
        if (carg_atom && carg_atom.shape === ARB) {
          let arb_bytes = env.bytes.subarray(carg_atom.cfirst, carg_atom.last + 1)
          set_override(id, 'cargo', 'arb:' + bytes_to_hex(arb_bytes))
        } else if (carg_atom) {
          // Pairtrie / hashlist: emit raw atom bytes so the cargo atom
          // ends up in the recompile bundle. Without this, body.carg
          // points at a hash whose atom isn't synthesized → cargo→target
          // edges (e.g. multi-hoist fixtures) vanish from the shape.
          let content = env.bytes.subarray(carg_atom.cfirst, carg_atom.last + 1)
          let raw_hex = bytes_to_hex(content)
          let shape_name = SHAPE_NAMES[carg_atom.shape]
          if (shape_name === 'pairtrie') {
            set_override(id, 'cargo', { raw: raw_hex })
          } else {
            set_override(id, 'cargo', {
              raw:   raw_hex,
              shape: shape_name || `0x${carg_atom.shape.toString(16)}`,
            })
          }
        } else {
          // Out-of-file: emit literal hash. The body slot holds it;
          // checkers see a "missing atom" reference, same as orig.
          set_override(id, 'cargo', carg)
        }
      }
      // Shield: always emit. trdl_to_spec auto-generates a random
      // shield for fast tethered twists on shielded lines when the
      // override is absent — preserving null-shld twists explicitly
      // (with 'null') suppresses that for meets/hoists/etc. whose
      // original had no shield even though their line is shielded
      // (the kiwano-family fasteners + meets exhibit this).
      let shld_hash = body?.shld
      if (!shld_hash || is_null(shld_hash)) {
        set_override(id, 'shld', 'null')
      } else {
        let shld_atom = env.index[shld_hash]
        if (shld_atom && shld_atom.shape === ARB) {
          let arb_bytes = env.bytes.subarray(shld_atom.cfirst, shld_atom.last + 1)
          set_override(id, 'shld', bytes_to_hex(arb_bytes))
        } else if (shld_atom) {
          // Non-arb shield atom (designed-bad: lead_shield_non_arb).
          // Emit raw form so compile recreates the exact shape.
          let content = env.bytes.subarray(shld_atom.cfirst, shld_atom.last + 1)
          let raw_hex = bytes_to_hex(content)
          let shape_name = SHAPE_NAMES[shld_atom.shape] || `0x${shld_atom.shape.toString(16)}`
          set_override(id, 'shld', { raw: raw_hex, shape: shape_name })
        } else {
          // Out-of-bundle shld hash (designed-bad: missing_shield).
          // Emit literal hash form so compile writes the hex into the
          // body slot verbatim, without synthesizing an arb. The body
          // bytes then match the original; the referenced atom remains
          // genuinely missing from the bundle (same as orig).
          set_override(id, 'shld', { hash: shld_hash })
        }
      }
      // Rigs: emit raw override whenever body.rigs is non-null. The
      // {hitch, lead, meet, hoist, fastener} entity is a high-level
      // convenience that the compiler turns into the canonical
      // {S(lead)→I(meet), SS(lead)→S(meet)} quad — but designed-bad-
      // rig fixtures put non-canonical pairs into rigs, and that
      // reconstruction can't reproduce them. Always-emit-raw preserves
      // verbatim atom bytes (regardless of shape) and the compiler
      // routes them straight into the body.rigs slot via spec.rigs_raw.
      // Cost: ~80 bytes of extra TRDL per hitch/post entry; gain: every
      // pair (canonical or wrong, missing or extra) survives the
      // roundtrip exactly.
      let rigs_h = body?.rigs
      if (rigs_h && !is_null(rigs_h)) {
        let rigs_atom = env.index[rigs_h]
        if (rigs_atom) {
          let content = env.bytes.subarray(rigs_atom.cfirst, rigs_atom.last + 1)
          let raw_hex = bytes_to_hex(content)
          let shape_name = SHAPE_NAMES[rigs_atom.shape]
          if (shape_name === 'pairtrie') {
            set_override(id, 'rigs', { raw: raw_hex })
          } else {
            set_override(id, 'rigs', {
              raw:   raw_hex,
              shape: shape_name || `0x${rigs_atom.shape.toString(16)}`,
            })
          }
        } else {
          // Out-of-bundle rigs hash (missing_rigging, cork_missing_rigging).
          // Emit literal-hash form so compile writes the hex into the body
          // slot verbatim; the referenced atom stays missing as in orig.
          set_override(id, 'rigs', { hash: rigs_h })
        }
      }
      // reqs (body slot): preserve verbatim. Designed-bad reqsat fixtures
      // (cork_reqsat_fail, lash_succession_reqsat_fail) have specific
      // pairtries here that the workshop's ed25519 auto-keygen can't
      // reproduce. Same encoding family as rigs/cargo/shld.
      let reqs_h = body?.reqs
      if (reqs_h && !is_null(reqs_h)) {
        let reqs_atom = env.index[reqs_h]
        if (reqs_atom) {
          let content = env.bytes.subarray(reqs_atom.cfirst, reqs_atom.last + 1)
          let raw_hex = bytes_to_hex(content)
          let shape_name = SHAPE_NAMES[reqs_atom.shape] || `0x${reqs_atom.shape.toString(16)}`
          if (shape_name === 'pairtrie') {
            set_override(id, 'reqs', { raw: raw_hex })
          } else {
            set_override(id, 'reqs', { raw: raw_hex, shape: shape_name })
          }
        } else {
          set_override(id, 'reqs', { hash: reqs_h })
        }
      }
      // sats (twist slot — separate from body). Read the second hash
      // out of the twist atom's content.
      let twist_atom = env.index[h]
      if (twist_atom) {
        let body_h_at = pluck_hash(env.bytes, twist_atom.cfirst)
        let sats_h_at = pluck_hash(env.bytes, twist_atom.cfirst + body_h_at.len)
        let sats_hex = sats_h_at?.hex
        if (sats_hex && !is_null(sats_hex)) {
          let sats_atom = env.index[sats_hex]
          if (sats_atom) {
            let content = env.bytes.subarray(sats_atom.cfirst, sats_atom.last + 1)
            let raw_hex = bytes_to_hex(content)
            let shape_name = SHAPE_NAMES[sats_atom.shape] || `0x${sats_atom.shape.toString(16)}`
            if (shape_name === 'pairtrie') {
              set_override(id, 'sats', { raw: raw_hex })
            } else {
              set_override(id, 'sats', { raw: raw_hex, shape: shape_name })
            }
          } else {
            set_override(id, 'sats', { hash: sats_hex })
          }
        }
      }
    })
  }
  for (let [id, o] of twist_overrides) out.push({ id, ...o })

  // Raw atom entities: targeted scan for non-twist atoms in env that
  // are referenced but NOT pulled in by any override's lat-merge path.
  // Compile's shld / rigs / cargo overrides already rebuild and
  // include the directly-referenced atom; we only need to pick up
  // atoms reachable through pairtrie / hashlist content hashes.
  //
  // What we emit:
  //   1. Non-twist atoms referenced by body.prev / body.teth.
  //      Already handled by cork_prev_invalid_*; the slot override
  //      writes the hex but doesn't synthesize the referent.
  //   2. Non-twist atoms whose hash appears INSIDE a rigs/cargo
  //      pairtrie's pair keys/values (post_rigging_missing_post_key:
  //      a rigs pair key points at an arb that no other override
  //      pulls in). The pairtrie itself is built by rigs:{raw};
  //      its content's referenced atoms need explicit entities.
  //
  // Broader "emit every non-twist atom" was tried; it ships extra
  // ed25519/shield atoms that re-insert at the end of out_lat,
  // shifting byte order and breaking checker stability on previously-
  // perfect valid rigs.
  let seen_atoms = new Set()
  function emit_atom_for(h) {
    if (!h || is_null(h) || seen_atoms.has(h)) return
    let atom = env.index[h]
    if (!atom || atom.shape === TWIST || atom.shape === BODY) return
    seen_atoms.add(h)
    let shape_name = SHAPE_NAMES[atom.shape] || `0x${atom.shape.toString(16)}`
    let raw_hex = bytes_to_hex(env.bytes.subarray(atom.cfirst, atom.last + 1))
    out.push({ atom: h, shape: shape_name, raw: raw_hex })
  }
  // Orphan-body emission: some imPERFECT fixtures (hh_tether_missing,
  // hh_wrong_hoist_values, ...) have body atoms in orig that no twist
  // references — likely the bodies of "missing" twists referenced by
  // hash from elsewhere (e.g., as a hitch's fastener). Now that atom
  // entities prepend at the head of out_lat (preserving the last-atom
  // focus invariant), it's safe to re-enable. Build a set of body
  // hashes that ARE referenced by a twist; emit atom entities for
  // the rest.
  let referenced_bodies = new Set()
  for (let t of env.shapes[TWIST] || []) {
    let body_h = pluck_hash(env.bytes, t.cfirst)
    if (body_h) referenced_bodies.add(body_h.hex)
  }
  for (let body_atom of env.shapes[BODY] || []) {
    if (referenced_bodies.has(body_atom.hash)) continue
    if (seen_atoms.has(body_atom.hash)) continue
    seen_atoms.add(body_atom.hash)
    let raw_hex = bytes_to_hex(env.bytes.subarray(body_atom.cfirst, body_atom.last + 1))
    out.push({ atom: body_atom.hash, shape: 'body', raw: raw_hex })
  }
  for (let t of env.shapes[TWIST] || []) {
    let body = body_cache.get(t.hash)
    if (!body) continue
    // (1) prev / teth slots pointing at non-twist atoms.
    emit_atom_for(body.prev)
    emit_atom_for(body.teth)
    // (2) hashes inside rigs + reqs pairtrie content (body slots) and
    //     twist.sats pairtrie content (twist slot). Each pairtrie atom
    //     itself is built by its raw override but the atoms it
    //     references via content (post-rig key arbs, ed25519 pub-arbs,
    //     sig hashes) need explicit atom entities or rec is missing
    //     them. Cargo content scan is INTENTIONALLY skipped — the
    //     workshop ignores cargo for verification purposes; preserving
    //     it would needlessly bloat the rec bundle.
    for (let slot of ['rigs', 'reqs']) {
      let h = body[slot]
      if (!h || is_null(h)) continue
      let atom = env.index[h]
      if (!atom || atom.shape !== PAIRTRIE) continue
      for (let [k, v] of read_pairtrie(env, atom)) {
        emit_atom_for(k); emit_atom_for(v)
      }
    }
    let twist_atom = env.index[t.hash]
    if (twist_atom) {
      let body_h_at = pluck_hash(env.bytes, twist_atom.cfirst)
      let sats_h_at = pluck_hash(env.bytes, twist_atom.cfirst + body_h_at.len)
      if (sats_h_at && !is_null(sats_h_at.hex)) {
        let sats_atom = env.index[sats_h_at.hex]
        if (sats_atom && sats_atom.shape === PAIRTRIE) {
          for (let [k, v] of read_pairtrie(env, sats_atom)) {
            emit_atom_for(k); emit_atom_for(v)
          }
        }
      }
    }
  }
  return out
}

export function emit_jsonl(entities) {
  return entities.map(e => JSON.stringify(e)).join('\n')
}
