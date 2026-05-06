// .toda bytes → TRDL entities. Mirrors twist-maker.decompile.
//
// v1 caveat: the shielded-hitch detection path (computing s/ss hashes from
// shield arbs) is not implemented. For shielded:false rigs (the rigs/* test
// set), unshielded hoist detection — finding a rigging entry whose value
// equals the meet hash — is sufficient.

import { bytes_to_hex } from './bytes.js'

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

// ---- hitch detection (unshielded only in v1) ------------------------------

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

function rig_contains_meet(env, body_cache, twist_h, meet_h) {
  let rig_h = body_cache.get(twist_h)?.rigs
  if (is_null(rig_h)) return false
  let rig_a = env.index[rig_h]
  if (!rig_a || rig_a.shape !== PAIRTRIE) return false
  return read_pairtrie(env, rig_a).some(([, v]) => v === meet_h)
}

function find_hoist(env, body_cache, succ_map, fastener_h, meet_h) {
  let cur = fastener_h
  while (cur) {
    if (rig_contains_meet(env, body_cache, cur, meet_h)) return cur
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

function detect_hitches(env, body_cache, named_lines) {
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
      let hoist = find_hoist(env, body_cache, succ_map, fastener, meet)
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

export function decompile(buf, name = 'rig') {
  let env        = parse_atoms(buf)
  let body_cache = build_body_cache(env)
  let lines      = discover_lines(env, body_cache)
  let named      = name_lines(env, body_cache, lines)
  let hitches    = detect_hitches(env, body_cache, named)
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
