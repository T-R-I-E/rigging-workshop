// Build pipeline. spec → twists map → output bytes. Mirrors twist-maker.core.

import { byte_concat, sha256, be32, bytes_to_hex, hex_to_bytes } from './bytes.js'
import { lat_focus, lat_to_bytes, NULL_HASH, get_hash, from_packet, SHAPE } from './lat.js'
import { arb, pairtrie, body, twist as build_twist } from './factory.js'
import { keypair as ed_keypair, req_pairtrie, sign_fn } from './ed25519.js'
import { evaluate, refs_in } from './values.js'

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

async function build_twists(lines, trie_specs = []) {
  let all_specs = collect_twist_specs(lines)
  let by_id     = new Map(all_specs.map(s => [s.id, s]))
  let line_keys = await collect_line_keypairs(all_specs)
  let twists    = new Map()
  let trie_hashes = new Map()      // name → atom hash hex
  let trie_lat    = new Map()       // accumulated trie atoms

  // Unified topo across twists + tries:
  //   * twist X may depend on a trie via its cargo field (if cargo
  //     is a string matching a declared trie name).
  //   * trie T may depend on twists referenced by name in its entries.
  // Cycles (T → X → T) are rejected by the topo pass.
  let trie_names = new Set(trie_specs.map(t => t.name))
  let twist_ids  = new Set(all_specs.map(s => s.id))
  let unified_nodes = [
    ...all_specs.map(s => ({ kind: 'twist', id: s.id, spec: s })),
    ...trie_specs.map(t => ({ kind: 'trie', id: t.name, spec: t })),
  ]
  let all_ids = new Set(unified_nodes.map(n => n.id))
  let sorted = topo_sort_unified(unified_nodes, all_ids, twist_ids, trie_names)

  for (let node of sorted) {
    if (node.kind === 'trie') {
      let one = await build_one_trie(node.spec, twists, trie_hashes)
      let hash = lat_focus(one)
      trie_hashes.set(node.id, hash)
      for (let [k, v] of one) {
        if (trie_lat.has(k)) trie_lat.delete(k)
        trie_lat.set(k, v)
      }
      continue
    }
    let spec = node.spec
    {
    let { id, prev_id, tether, cargo, shield, rig, shield_source,
          poptop, reqsat, line, rigs_raw, rigs_shape, rigs_null,
          rigs_hash, cargo_raw, cargo_shape, shield_raw, shield_shape,
          shield_hash, reqs_raw, reqs_shape, reqs_hash, reqs_null,
          sats_raw, sats_shape, sats_hash, sats_null } = spec

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
    // shield: precedence raw > hash > arb-bytes > null. Used for
    // designed-bad shield shapes (raw: lead_shield_non_arb) and for
    // shields whose target atom isn't in the bundle (hash:
    // missing_shield — body slot holds the hex, no atom synthesized).
    let shield_lat
    if (shield_raw) {
      let shape_byte = SHAPE[shield_shape] ?? SHAPE.arb
      shield_lat = await from_packet(shape_byte, hex_to_bytes(shield_raw))
    } else if (shield_hash) {
      shield_lat = shield_hash  // pass-through hex; factory writes verbatim
    } else if (shield) {
      shield_lat = await arb(hex_to_bytes(shield))
    } else {
      shield_lat = null
    }
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
    } else if (cargo_raw) {
      // Verbatim atom bytes — used for designed-bad cargo (e.g. a
      // pairtrie containing twist refs in multi-hoist fixtures).
      // Defaults to pairtrie shape; non-pairtrie shapes specified
      // via spec.cargo_shape.
      let shape_byte = SHAPE[cargo_shape] ?? SHAPE.pairtrie
      cargo_val = await from_packet(shape_byte, hex_to_bytes(cargo_raw))
    } else if (cargo === 'null' || cargo == null) {
      cargo_val = null
    } else if (typeof cargo === 'string' && cargo.startsWith('arb:')) {
      cargo_val = await arb(hex_to_bytes(cargo.slice(4)))
    } else if (typeof cargo === 'string' && /^(41|22)[0-9a-f]{64}$/i.test(cargo)) {
      cargo_val = cargo
    } else if (typeof cargo === 'string' && trie_hashes.has(cargo)) {
      // Trie entity reference — the body.carg slot holds the trie's
      // atom hash. The trie atom itself is built earlier in the same
      // topo pass (see build_one_trie) and merged into trie_lat.
      cargo_val = trie_hashes.get(cargo)
    } else if (cargo) {
      cargo_val = await str_to_hash(cargo)
    }

    let rig_shield
    if (shield_source) {
      let src_spec = by_id.get(shield_source)
      if (src_spec?.shield) rig_shield = hex_to_bytes(src_spec.shield)
    }

    // rigs slot precedence: explicit raw bytes > explicit hash > explicit
    // null > hitch-derived pairtrie.
    //   raw  → designed-bad pairs (any shape) — from_packet builds the
    //          atom, its hash goes in the body slot.
    //   hash → out-of-bundle rigs reference (missing_rigging) — the hex
    //          passes straight through to the body slot, no atom is
    //          synthesized, checkers see "missing" as in orig.
    //   null → explicit NULL slot.
    let rig_lat
    if (rigs_raw) {
      let shape_byte = SHAPE[rigs_shape] ?? SHAPE.pairtrie
      rig_lat = await from_packet(shape_byte, hex_to_bytes(rigs_raw))
    } else if (rigs_hash) {
      rig_lat = rigs_hash  // pass-through hex; factory writes verbatim
    } else if (rigs_null) {
      rig_lat = null
    } else {
      rig_lat = rig ? await build_rig_lat(twists, rig_shield, rig) : null
    }

    let kp        = (reqsat === 'ed25519') ? line_keys.get(line) : null
    let req_lat   = kp ? await req_pairtrie(kp.pub) : null
    let signFn    = kp ? sign_fn(kp.secret) : null

    // reqs override: raw > hash > null > ed25519-derived (above).
    // Used for designed-bad reqsat fixtures whose body.reqs slot holds
    // a specific pairtrie that won't be reproduced by ed25519 keygen.
    if (reqs_raw) {
      req_lat = await from_packet(SHAPE[reqs_shape] ?? SHAPE.pairtrie, hex_to_bytes(reqs_raw))
    } else if (reqs_hash) {
      req_lat = reqs_hash
    } else if (reqs_null) {
      req_lat = null
    }

    // sats override: raw > hash > null > signFn-derived. Lives on the
    // twist atom (not body); threads through factory.twist via
    // sat_override which wins over signFn when present.
    let sat_override
    if (sats_raw) {
      sat_override = await from_packet(SHAPE[sats_shape] ?? SHAPE.pairtrie, hex_to_bytes(sats_raw))
    } else if (sats_hash) {
      sat_override = sats_hash
    } else if (sats_null) {
      sat_override = NULL_HASH
    }

    let twist_lat = await build_twist({
      prev:   prev_lat,
      tether: tether_lat,
      shield: shield_lat,
      req:    req_lat,
      rig:    rig_lat,
      cargo:  cargo_val,
      signFn,
      sat_override,
    })

    twists.set(id, twist_lat)
    }
  }

  return { twists, trie_lat, trie_hashes }
}

// Topo over the unified twist+trie node list. Deps:
//   * twist node depends on referenced twists (existing twist_deps),
//     plus a trie when its cargo string matches a declared trie name.
//   * trie node depends on every twist OR trie referenced by name in
//     any entry expression (excluding null/unit, sort keys, hash
//     algos, and symbol() name args — see refs_in).
function topo_sort_unified(nodes, all_ids, twist_ids, trie_names) {
  let node_idx = new Map(nodes.map((n, i) => [n.id, i]))
  let id_deps = new Map()
  for (let n of nodes) id_deps.set(n.id, node_deps(n, all_ids, twist_ids, trie_names))
  let sorted = []
  let remaining = new Set(all_ids)
  while (remaining.size) {
    let ready = [...remaining].filter(id =>
      [...id_deps.get(id)].every(d => !remaining.has(d)))
      .sort((a, b) => node_idx.get(a) - node_idx.get(b))
    if (!ready.length) {
      throw new Error('Circular dependency in twist/trie specs: ' + [...remaining])
    }
    for (let id of ready) { sorted.push(id); remaining.delete(id) }
  }
  return sorted.map(id => nodes[node_idx.get(id)])
}

function node_deps(node, all_ids, twist_ids, trie_names) {
  if (node.kind === 'twist') {
    let deps = new Set(twist_deps(node.spec, twist_ids))
    if (typeof node.spec.cargo === 'string' && trie_names.has(node.spec.cargo)) {
      deps.add(node.spec.cargo)
    }
    return deps
  }
  // trie node
  let deps = new Set()
  for (let [k, v] of Object.entries(node.spec.entries)) {
    for (let ref of refs_in(k)) if (all_ids.has(ref_to_kw_top(ref))) deps.add(ref_to_kw_top(ref))
    for (let ref of refs_in(v)) if (all_ids.has(ref_to_kw_top(ref))) deps.add(ref_to_kw_top(ref))
  }
  return deps
}

// Convert "poptop[0]" → "poptop_0" to match twist spec ids; pass other
// names (trie / atom names) through unchanged.
function ref_to_kw_top(ref) {
  let m = /^(.+)\[(\d+)\]$/.exec(ref)
  return m ? `${m[1]}_${m[2]}` : ref
}

// Build a single trie spec into a lat. Entries are evaluated via
// values.js with name resolution covering twists (by `line[N]` form)
// and previously-built tries (by their bare name).
async function build_one_trie(trie_spec, twists, trie_hashes) {
  if (trie_spec.type && trie_spec.type !== 'pairtrie')
    throw new Error(`trie type "${trie_spec.type}" not yet supported`)
  let resolve = make_unified_resolver(twists, trie_hashes)
  let pairs = []
  for (let [key_expr, val_expr] of Object.entries(trie_spec.entries)) {
    let k = await evaluate(key_expr, resolve)
    let v = await evaluate(val_expr, resolve)
    pairs.push([bytes_to_hex(k), bytes_to_hex(v)])
  }
  let lat = await pairtrie(pairs)
  if (!lat) {
    // Empty trie. Build an empty pairtrie atom directly so the trie
    // name still has a defined hash. Mirrors lat.factory.pairtrie's
    // null-on-empty short-circuit by going around it.
    return await from_packet(SHAPE.pairtrie, new Uint8Array(0))
  }
  return lat
}

function make_unified_resolver(twists, trie_hashes) {
  return function resolve(name) {
    // Twist reference: "poptop[0]" or bare "poptop_0"
    let m = /^(.+)\[(\d+)\]$/.exec(name)
    let kw = m ? `${m[1]}_${m[2]}` : name
    let lat = twists.get(kw)
    if (lat) return lat_focus(lat)
    if (trie_hashes.has(name)) return trie_hashes.get(name)
    throw new Error(`unknown reference: ${name}`)
  }
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

// Build atom entities into a lat. Each entity creates one atom whose
// content can come from either:
//   * `raw` (legacy / decompile output): verbatim hex string
//   * `data` (spec): a bitstream expression evaluated via values.js
//
// `shape` can be a name (SHAPE[…]) or an integer byte (passed through
// directly so shapes outside SHAPE work for fixtures).
//
// `length` overrides the BE32 length field in the packet — used by
// designed-bad rigs that intentionally encode the wrong length so the
// atom hash differs from the canonical (length-correct) one.
async function build_atoms(atom_entries) {
  let lat = new Map()
  for (let entry of atom_entries) {
    let { shape, raw, data, length } = entry
    let shape_byte = typeof shape === 'number' ? shape : SHAPE[shape]
    if (shape_byte == null) continue
    let content
    if (raw != null)       content = hex_to_bytes(raw)
    else if (data != null) content = await evaluate(data)
    else                   content = new Uint8Array(0)
    let len_field = (length != null) ? length : content.length
    let atom_lat = (length != null && length !== content.length)
      ? await packet_with_length(shape_byte, len_field, content)
      : await from_packet(shape_byte, content)
    for (let [k, v] of atom_lat) {
      if (lat.has(k)) lat.delete(k)
      lat.set(k, v)
    }
  }
  return lat
}

// Build an atom whose packet's BE32 length field disagrees with the
// content length. The hash is computed over the (mis-length) packet,
// so the resulting atom is intentionally non-canonical. Mirrors
// from_packet in lat.js but exposes the length field explicitly.
async function packet_with_length(shape_byte, length, content) {
  let pkt = byte_concat(new Uint8Array([shape_byte]), be32(length), content)
  let digest = await sha256(pkt)
  let hash_b = byte_concat(new Uint8Array([0x41]), digest)
  let atom_bytes = byte_concat(hash_b, pkt)
  let lat = new Map()
  lat.set(bytes_to_hex(hash_b), atom_bytes)
  return lat
}

// Public entry point. Returns { bytes, twists, corkline_h }.
export async function build(spec) {
  let { twists, trie_lat } = await build_twists(spec.lines, spec.tries ?? [])
  let out_lat = assemble_output(twists, spec.output)
  // Atom + trie entities are merged at the BEGINNING of the byte
  // stream. Several rig-checkers treat the last atom in the bundle
  // as the rig's focus (the topline-ish anchor); appending extras
  // at the end would shift that off. Prepending preserves the
  // final-atom-is-focus invariant while still ensuring the extras
  // are present.
  let extras_lat = null
  if (spec.atoms?.length) {
    extras_lat = await build_atoms(spec.atoms)
  }
  if (trie_lat && trie_lat.size) {
    if (extras_lat) {
      for (let [k, v] of trie_lat) {
        if (extras_lat.has(k)) extras_lat.delete(k)
        extras_lat.set(k, v)
      }
    } else {
      extras_lat = trie_lat
    }
  }
  if (extras_lat) {
    let reordered = new Map()
    for (let [k, v] of extras_lat) reordered.set(k, v)
    for (let [k, v] of out_lat) {
      if (!reordered.has(k)) reordered.set(k, v)
    }
    out_lat = reordered
  }
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
