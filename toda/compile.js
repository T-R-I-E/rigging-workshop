// Build pipeline. spec → twists map → output bytes. Mirrors twist-maker.core.

import { byte_concat, sha256, bytes_to_hex, hex_to_bytes } from './bytes.js'
import { lat_focus, lat_to_bytes, NULL_HASH, get_hash } from './lat.js'
import { arb, pairtrie, body, twist as build_twist } from './factory.js'
import { keypair as ed_keypair, req_pairtrie, sign_fn } from './ed25519.js'

const SYM_POPTOP = '22c70173874680c58e5c1d32854bd10486aac6f1aa821b56e3d512fd72e45ac72e'

// ---- Hash helpers ---------------------------------------------------------

async function sha256_hex(bytes) {
  return '41' + bytes_to_hex(await sha256(bytes))
}

async function s_hash(h_hex, shield_bytes) {
  let h_bytes = hex_to_bytes(h_hex)
  let data = shield_bytes ? byte_concat(shield_bytes, h_bytes) : h_bytes
  return sha256_hex(data)
}

async function ss_hash(h_hex, shield_bytes) {
  return s_hash(await s_hash(h_hex, shield_bytes), shield_bytes)
}

async function str_to_hash(s) {
  let utf8 = new TextEncoder().encode(s)
  return sha256_hex(utf8)
}

// ---- Rig-ref resolution ---------------------------------------------------

// "id" → twist id (no prefix); "s:id" / "ss:id" → tagged ref.
function parse_rig_ref(s) {
  if (s.startsWith('ss:')) return { tag: 'ss', id: s.slice(3) }
  if (s.startsWith('s:'))  return { tag: 's',  id: s.slice(2) }
  return { tag: 'id', id: s }
}

// Resolve a rig key or value. Plain ids return the LAT (so pairtrie's
// val_lats merges in the referenced twist's atoms). :s and :ss return a
// hash hex computed via the lead's shield function (plain hash when
// shield_bytes is null).
async function resolve_rig_ref(twists, shield_bytes, ref) {
  let { tag, id } = parse_rig_ref(ref)
  let lat = twists.get(id)
  if (!lat) return null                       // referenced twist not yet built
  switch (tag) {
    case 'id': return lat
    case 's':  return s_hash(lat_focus(lat), shield_bytes)
    case 'ss': return ss_hash(lat_focus(lat), shield_bytes)
  }
}

async function build_rig_lat(twists, shield_bytes, rig_spec) {
  let entries = Object.entries(rig_spec)
  if (!entries.length) return null
  let resolved = []
  for (let [k, v] of entries) {
    let rk = await resolve_rig_ref(twists, shield_bytes, k)
    let rv = await resolve_rig_ref(twists, shield_bytes, v)
    if (rk == null || rv == null) continue    // skip if referent not built
    resolved.push([rk, rv])
  }
  if (!resolved.length) return null
  return await pairtrie(resolved)
}

// ---- Spec collection & topo-sort ------------------------------------------

function collect_twist_specs(lines) {
  let out = []
  for (let [_name, twists] of lines) {
    twists.forEach((spec, i) => {
      if ('prev_id' in spec && spec.prev_id !== undefined) {
        out.push(spec)
      } else {
        out.push({ ...spec, prev_id: i > 0 ? twists[i-1].id : null })
      }
    })
  }
  return out
}

function twist_deps(spec, all_ids) {
  let deps = new Set()
  let add  = id => { if (id && all_ids.has(id)) deps.add(id) }
  if (spec.prev_id && spec.prev_id !== 'null' && spec.prev_id !== 'dangling')
    add(spec.prev_id)
  if (spec.tether)        add(spec.tether)
  if (spec.shield_source) add(spec.shield_source)
  if (spec.rig) {
    // Match twist-maker.core/twist-deps:
    //   plain key (post-rig {lead hoist}) → only the key is a dep; hoist is
    //     on a higher line and built first by natural topo order.
    //   tagged key (:s/:ss, hoist-rig) → both key and value are deps.
    for (let [k, v] of Object.entries(spec.rig)) {
      let pk = parse_rig_ref(k)
      let pv = parse_rig_ref(v)
      add(pk.id)
      if (pk.tag !== 'id') add(pv.id)
    }
  }
  return deps
}

function topo_sort(specs) {
  let all_ids = new Set(specs.map(s => s.id))
  let id_idx  = new Map(specs.map((s, i) => [s.id, i]))
  let id_spec = new Map(specs.map(s => [s.id, s]))
  let id_deps = new Map(specs.map(s => [s.id, twist_deps(s, all_ids)]))
  let sorted    = []
  let remaining = new Set(all_ids)
  while (remaining.size) {
    let ready = [...remaining].filter(id =>
      [...id_deps.get(id)].every(d => !remaining.has(d)))
      .sort((a, b) => id_idx.get(a) - id_idx.get(b))
    if (!ready.length) {
      throw new Error('Circular dependency in twist specs: ' + [...remaining])
    }
    for (let id of ready) { sorted.push(id); remaining.delete(id) }
  }
  return sorted.map(id => id_spec.get(id))
}

// ---- Build pipeline -------------------------------------------------------

async function collect_line_keypairs(specs) {
  let lines = new Set()
  for (let s of specs) if (s.reqsat === 'ed25519') lines.add(s.line)
  let kps = new Map()
  for (let l of lines) kps.set(l, await ed_keypair())
  return kps
}

async function build_twists(lines) {
  let all_specs = collect_twist_specs(lines)
  let by_id     = new Map(all_specs.map(s => [s.id, s]))
  let sorted    = topo_sort(all_specs)
  let line_keys = await collect_line_keypairs(all_specs)
  let twists    = new Map()

  for (let spec of sorted) {
    let { id, prev_id, tether, cargo, shield, rig, shield_source,
          poptop, reqsat, line } = spec

    let prev_lat
    if (prev_id == null || prev_id === 'null') prev_lat = null
    else if (prev_id === 'dangling') {
      // Legacy marker. Pre-rig-perfect decompile emitted 'dangling' and
      // expected compile to synthesize a random arb. Still supported for
      // hand-authored TRDL, but lossy: each compile produces different
      // bytes for the prev and every downstream body hash cascades.
      let { random_bytes } = await import('./bytes.js')
      prev_lat = await arb(random_bytes(32))
    }
    else if (twists.has(prev_id)) prev_lat = twists.get(prev_id)
    else if (/^(41|22)[0-9a-f]{64}$|^00$|^ff$/i.test(prev_id)) {
      // Literal hash hex (sha-256 with 0x41 prefix, symbol with 0x22, or
      // NULL/UNIT singletons). Decompile emits this for line-genesis whose
      // body.prev points outside the file — compile writes the hex into
      // the body slot directly, without synthesizing an arb atom. Result:
      // recompile body matches the original's body hash slot-for-slot, and
      // the canonical checkers see "prev → not in file" exactly as they
      // did against the original bytes. get_hash() in lat.js returns a
      // string input unchanged, so passing the hex through as `prev` works
      // without any further plumbing.
      prev_lat = prev_id
    }
    else prev_lat = null

    // tether resolves to: a known twist's lat (normal case from
     // hitch-derived tethers), or a literal hash hex (decompile preserves
     // the teth of fasteners / hoists whose original points to a twist
     // outside the file). Literal hex goes into the body slot verbatim
     // without synthesizing an atom, matching the prev handling above.
    let tether_lat
    if (!tether)                                            tether_lat = null
    else if (twists.has(tether))                            tether_lat = twists.get(tether)
    else if (/^(41|22)[0-9a-f]{64}$/i.test(tether))         tether_lat = tether
    else                                                    tether_lat = null
    let shield_lat   = shield ? await arb(hex_to_bytes(shield)) : null
    let poptop_lat   = poptop ? twists.get(poptop) || null : null
    // Cargo encodings (from decompile, see toda/decompile.js):
    //   'null'        → explicitly no cargo (body.carg = NULL)
    //   'arb:<hex>'   → rebuild the arb atom with those bytes
    //   '<66-char hex>' → literal hash; write into body slot without
    //                     synthesizing a corresponding atom
    //   anything else → legacy hand-authored TRDL: hash the UTF-8 string
    let cargo_val
    if (poptop && poptop_lat) {
      cargo_val = await pairtrie([[SYM_POPTOP, poptop_lat]])
    } else if (cargo === 'null' || cargo == null) {
      cargo_val = null
    } else if (typeof cargo === 'string' && cargo.startsWith('arb:')) {
      cargo_val = await arb(hex_to_bytes(cargo.slice(4)))
    } else if (typeof cargo === 'string' && /^(41|22)[0-9a-f]{64}$/i.test(cargo)) {
      cargo_val = cargo
    } else if (cargo) {
      cargo_val = await str_to_hash(cargo)
    }

    let rig_shield
    if (shield_source) {
      let src_spec = by_id.get(shield_source)
      if (src_spec?.shield) rig_shield = hex_to_bytes(src_spec.shield)
    }

    let rig_lat = rig ? await build_rig_lat(twists, rig_shield, rig) : null

    let kp        = (reqsat === 'ed25519') ? line_keys.get(line) : null
    let req_lat   = kp ? await req_pairtrie(kp.pub) : null
    let signFn    = kp ? sign_fn(kp.secret) : null

    let twist_lat = await build_twist({
      prev:   prev_lat,
      tether: tether_lat,
      shield: shield_lat,
      req:    req_lat,
      rig:    rig_lat,
      cargo:  cargo_val,
      signFn,
    })

    twists.set(id, twist_lat)
  }

  return twists
}

function assemble_output(twists, output) {
  // merge specified twists' lats, preserving insertion order
  let merged = new Map()
  for (let id of output.merge) {
    let lat = twists.get(id)
    if (!lat) continue
    for (let [k, v] of lat) {
      if (merged.has(k)) merged.delete(k)
      merged.set(k, v)
    }
  }
  // dissoc focus of each excluded id
  for (let id of (output.exclude || [])) {
    let lat = twists.get(id)
    if (!lat) continue
    let focus = lat_focus(lat)
    if (focus) merged.delete(focus)
  }
  return merged
}

// Public entry point. Returns { bytes, twists, corkline_h }.
export async function build(spec) {
  let twists  = await build_twists(spec.lines)
  let out_lat = assemble_output(twists, spec.output)
  let corkline_h = spec.output.corkline ? lat_focus(twists.get(spec.output.corkline)) : null
  return {
    bytes:   lat_to_bytes(out_lat),
    twists,
    corkline_h,
  }
}

// Compute per-entity twist hashes, matching server.clj's :line-hashes.
export function entity_hashes(entities, twists) {
  return entities.map(e => {
    switch (e.entity_type) {
      case 'rig': return []
      case 'line': {
        let n = e.twists ?? 2
        let hashes = []
        for (let i = 0; i < n; i++) {
          let id  = `${e.entity_id}_${i}`
          let lat = twists.get(id)
          if (lat) hashes.push(lat_focus(lat))
        }
        return hashes
      }
      case 'hitch': {
        return ['lead', 'meet', 'fastener', 'hoist']
          .map(role => {
            let kw = (function ref_to_kw(s) {
              if (s == null) return null
              let m = /^(.+)\[(\d+)\]$/.exec(s)
              return m ? `${m[1]}_${m[2]}` : s
            })(e[role])
            let lat = twists.get(kw)
            return lat ? lat_focus(lat) : null
          })
          .filter(Boolean)
      }
      case 'twist': {
        let kw = (function ref_to_kw(s) {
          let m = /^(.+)\[(\d+)\]$/.exec(s)
          return m ? `${m[1]}_${m[2]}` : s
        })(e.entity_id)
        let lat = twists.get(kw)
        return lat ? [lat_focus(lat)] : []
      }
      default: return []
    }
  })
}
