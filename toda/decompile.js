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

function parse_atoms(buf) {
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
  for (let th of twist_hashes) {
    let prev = body_cache.get(th)?.prev
    if (is_null(prev)) genesis.push(th)
    else if (prev) succ.set(prev, th)
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

  let out = []
  out.push({ rig: name })
  for (let { name: ln, twists } of named) {
    let shielded = line_shielded(body_cache, twists)
    out.push(shielded
      ? { line: ln, twists: twists.length }
      : { line: ln, twists: twists.length, shielded: false, reqsat: 'null' })
  }
  for (let h of hitches) out.push({
    hitch: h.name, lead: h.lead, meet: h.meet,
    fastener: h.fastener, hoist: h.hoist,
  })
  for (let c of crosses) out.push(c)
  return out
}

export function emit_jsonl(entities) {
  return entities.map(e => JSON.stringify(e)).join('\n')
}
