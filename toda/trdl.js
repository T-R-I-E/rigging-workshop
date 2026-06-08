// TRDL (JSONL) parsing, emission, and entity → spec expansion. Mirrors
// twist-maker.trdl. Spec produced here is consumed by toda/compile.js#build.
//
// Spec shape produced by trdl_to_spec(entities):
//   { lines:   Map<line-name, [twist-spec, ...]>,
//     output:  { merge: [id, ...], exclude: [], corkline: id } }
//
// Twist-spec is a plain object with optional fields:
//   { id, line, reqsat?, prev_id?, tether?, rig?, shield?,
//     shield_source?, poptop?, cargo? }
//
// Rig values use string-encoded refs:
//   "id"       → twist by id
//   "f:id"     → fast hash of twist (= same hash as direct ref)
//   "s:id"     → s-hash of twist
//   "ss:id"    → ss-hash of twist

import { random_bytes, bytes_to_hex } from './bytes.js'

function random_shield_hex() {
  return bytes_to_hex(random_bytes(32))
}

// ---- Parsing & classification ----

// Spec: each non-empty, non-comment line is one JSON object. Lines beginning
// with `//` are comments (after trimming leading whitespace). Objects whose
// top-level key isn't one of the eight recognised entity types are silently
// discarded.
export function parse_trdl_string(s) {
  return s.split('\n')
          .map(line => line.trim())
          .filter(line => line !== '' && !line.startsWith('//'))
          .map(line => classify_entity(JSON.parse(line)))
          .filter(e => e !== null)
}

function classify_entity(m) {
  if      ('rig'    in m) return { ...m, entity_type: 'rig',    entity_id: m.rig    }
  else if ('spool'  in m) return { ...m, entity_type: 'spool',  entity_id: m.spool  }
  else if ('line'   in m) return { ...m, entity_type: 'line',   entity_id: m.line   }
  else if ('hitch'  in m) return { ...m, entity_type: 'hitch',  entity_id: m.hitch  }
  else if ('twist'  in m) return { ...m, entity_type: 'twist',  entity_id: m.twist  }
  else if ('reqsat' in m) return { ...m, entity_type: 'reqsat', entity_id: m.reqsat }
  else if ('trie'   in m) return { ...m, entity_type: 'trie',   entity_id: m.trie   }
  else if ('atom'   in m) return { ...m, entity_type: 'atom',   entity_id: m.atom   }
  // Objects without a recognised type key are discarded (spec §Syntax).
  // This includes the legacy {"id": "..."} shorthand for twists; callers
  // must now use {"twist": "..."} explicitly.
  else return null
}

// "a[3]" → "a_3", "mytwist" → "mytwist". Returns null on null/undefined input.
export function ref_to_kw(s) {
  if (s == null) return null
  let m = /^(.+)\[(\d+)\]$/.exec(s)
  return m ? `${m[1]}_${m[2]}` : s
}

// ---- Line / hitch / twist expansion ----

function expand_lines(line_entities) {
  let out = new Map()
  for (let e of line_entities) {
    let name     = e.entity_id
    let n        = e.twists  ?? 2
    let shielded = e.shielded ?? true
    let reqsat   = e.reqsat  ?? 'ed25519'
    let ids      = []
    for (let i = 0; i < n; i++) ids.push(`${name}_${i}`)
    out.set(name, { ids, shielded, reqsat })
  }
  return out
}

function build_twist_to_line(lines_map) {
  let m = new Map()
  for (let [name, info] of lines_map) {
    for (let id of info.ids) m.set(id, name)
  }
  return m
}

function expand_hitches(hitch_entities, lines_map) {
  let twist_to_line = build_twist_to_line(lines_map)
  let all_leads     = new Set(hitch_entities.map(h => ref_to_kw(h.lead)))
  let acc = { tethers: new Map(), hoist_rigs: new Map(),
              post_rigs: new Map(), shield_sources: new Map() }

  function set_in(map_field, k, v) { acc[map_field].set(k, v) }
  function merge_in(map_field, k, addition) {
    let prev = acc[map_field].get(k) || {}
    acc[map_field].set(k, Object.assign(prev, addition))
  }

  for (let h of hitch_entities) {
    let lead     = ref_to_kw(h.lead)
    let meet     = ref_to_kw(h.meet)
    let fastener = ref_to_kw(h.fastener)
    let hoist    = ref_to_kw(h.hoist)
    let lead_line = twist_to_line.get(lead)
    let shielded  = lines_map.get(lead_line)?.shielded ?? true

    let explicit_post = h.post
    let meet_line   = twist_to_line.get(meet)
    let meet_info   = lines_map.get(meet_line)
    let meet_idx    = meet_info ? meet_info.ids.indexOf(meet) : -1
    let post_kw
    if (explicit_post === 'none')        post_kw = null
    else if (explicit_post != null)      post_kw = ref_to_kw(explicit_post)
    else if (meet_idx >= 0 && meet_idx + 1 < (meet_info?.ids.length ?? 0))
                                         post_kw = meet_info.ids[meet_idx + 1]
    else                                 post_kw = null

    // Hoist rig is always {S(lead) → meet, S(S(lead)) → S(meet)} per spec.
    // For null-shielded leads (shielded:false), the shield function on the
    // resolver side falls back to plain hash, but the entry shape stays the
    // same — the keys are never the raw lead hash.
    let hoist_rig = { [`s:${lead}`]: meet, [`ss:${lead}`]: `s:${meet}` }

    // A post-rig entry only makes sense when there's a hoist to point at;
    // decompiled TRDL for "unit rig" .toda files emits hitches with only
    // lead+meet (no fastener/hoist), and a {lead: null} entry crashed
    // parse_rig_ref downstream.
    let post_rig = (post_kw && hoist) ? { [lead]: hoist } : null

    set_in('tethers', lead, fastener)
    if (!all_leads.has(meet)) set_in('tethers', meet, fastener)
    merge_in('hoist_rigs', hoist, hoist_rig)
    // shield_source names the lead whose shield bytes feed S(lead); set
    // unconditionally because every hoist needs the lookup, even when the
    // lead's shield is NULL (resolver returns plain hash in that case).
    set_in('shield_sources', hoist, lead)
    if (post_kw)  merge_in('post_rigs', post_kw, post_rig)
    if (post_kw && !all_leads.has(post_kw)) set_in('tethers', post_kw, hoist)
  }
  return acc
}

function collect_twist_overrides(twist_entities) {
  let out = new Map()
  for (let e of twist_entities) {
    let kw = ref_to_kw(e.entity_id)
    let o  = {}
    if ('prev'  in e) o.prev_id    = ref_to_kw(e.prev)
    if ('teth'  in e) o.tether     = ref_to_kw(e.teth)
    // reqs override (body.reqs slot). Four forms mirror shld/rigs/cargo:
    //   "reqs": "null"                            → explicit NULL slot
    //   "reqs": { "raw": "<hex>", "shape":… }    → verbatim atom
    //   "reqs": { "hash": "<hex>" }               → literal hash, no atom
    // Designed-bad reqsat fixtures: cork_reqsat_fail,
    // lash_succession_reqsat_fail. Without this, the workshop
    // auto-generates ed25519 req tries and the body.reqs slot diverges.
    if ('reqs'  in e) {
      if (e.reqs === 'null') {
        o.reqs_null = true
      } else if (e.reqs && typeof e.reqs === 'object') {
        if ('raw' in e.reqs) {
          o.reqs_raw   = e.reqs.raw
          o.reqs_shape = e.reqs.shape || 'pairtrie'
        } else if ('hash' in e.reqs) {
          o.reqs_hash = e.reqs.hash
        }
      }
    }
    // sats override (twist.sats slot — separate from body). Same forms.
    // sats lives on the twist atom itself, not the body, so it threads
    // through factory.twist via sat_override (added alongside this).
    if ('sats'  in e) {
      if (e.sats === 'null') {
        o.sats_null = true
      } else if (e.sats && typeof e.sats === 'object') {
        if ('raw' in e.sats) {
          o.sats_raw   = e.sats.raw
          o.sats_shape = e.sats.shape || 'pairtrie'
        } else if ('hash' in e.sats) {
          o.sats_hash = e.sats.hash
        }
      }
    }
    if ('shld'  in e) {
      // Four forms:
      //   "shld": "null"                           → explicit NULL slot
      //   "shld": { "raw": "<hex>", "shape":… }   → verbatim non-arb atom
      //   "shld": { "hash": "<hex>" }              → literal hash, no atom
      //                                              (out-of-bundle shield)
      //   "shld": "<arb-bytes-hex>"                → arb form (legacy)
      // raw / hash forms preserve designed-bad shield references:
      //   raw  → lead_shield_non_arb (body.shld points at a non-arb atom)
      //   hash → missing_shield (body.shld hash not present in bundle)
      if (e.shld && typeof e.shld === 'object') {
        if ('raw' in e.shld) {
          o.shield_raw   = e.shld.raw
          o.shield_shape = e.shld.shape || 'arb'
        } else if ('hash' in e.shld) {
          o.shield_hash = e.shld.hash
        }
      } else {
        o.shield = e.shld
      }
    }
    if ('cargo' in e) {
      // Three forms (matching rigs):
      //   "cargo": "null"                          → explicit NULL slot
      //   "cargo": { "raw": "<hex>", "shape":… }   → verbatim atom bytes
      //   "cargo": "<other string>"                → legacy: arb:, hash hex, or utf-8
      // raw form preserves designed-bad cargo atoms (e.g. pairtries
      // containing twist refs in multi-hoist fixtures); needed because
      // a plain literal-hash cargo override sets the body slot right
      // but doesn't include the atom in the bundle, losing the
      // cargo→target edge in the shape extractor.
      if (e.cargo && typeof e.cargo === 'object' && 'raw' in e.cargo) {
        o.cargo_raw   = e.cargo.raw
        o.cargo_shape = e.cargo.shape || 'pairtrie'
      } else {
        o.cargo = e.cargo
      }
    }
    if ('rigs'  in e) {
      // Four forms of the rigs override (mirrors shld):
      //   "rigs": "null"                         → explicit NULL slot
      //   "rigs": { "raw": "<hex>", "shape":… }  → verbatim atom content
      //   "rigs": { "hash": "<hex>" }            → literal hash, no atom
      //                                            (out-of-bundle rigs)
      //   "rigs": { ...pair-entries }            → legacy: extra pairs
      //                                            merged with hitch-derived
      // raw / hash forms take precedence over hitch-derived rigtrie:
      //   raw  → designed-bad pairs that canonical reconstruction can't
      //          produce (hh_wrong_hoist_values etc.)
      //   hash → rigs hash refers to an atom absent from the bundle
      //          (missing_rigging, cork_missing_rigging)
      if (e.rigs === 'null') {
        o.rigs_null = true
      } else if (e.rigs && typeof e.rigs === 'object') {
        if ('raw' in e.rigs) {
          o.rigs_raw   = e.rigs.raw
          o.rigs_shape = e.rigs.shape || 'pairtrie'
        } else if ('hash' in e.rigs) {
          o.rigs_hash = e.rigs.hash
        } else {
          o.extra_rigs = e.rigs
        }
      } else {
        o.extra_rigs = e.rigs
      }
    }
    out.set(kw, o)
  }
  return out
}

function determine_line_order(lines_map, poptop_name, abject_name) {
  let others = [...lines_map.keys()]
                 .filter(n => n !== poptop_name && n !== abject_name)
                 .sort()
  return [poptop_name, abject_name, ...others]
}

// ---- Spec assembly ----

export function trdl_to_spec(entities) {
  let rig_entity     = entities.find(e => e.entity_type === 'rig')
  let line_entities  = entities.filter(e => e.entity_type === 'line')
  let hitch_entities = entities.filter(e => e.entity_type === 'hitch')
  let twist_entities = entities.filter(e => e.entity_type === 'twist')

  let poptop_name = rig_entity?.poptop || 'poptop'
  let abject_name = rig_entity?.abject || 'abject'

  let lines_map = expand_lines(line_entities)
  let hitch_data = expand_hitches(hitch_entities, lines_map)
  let { tethers, hoist_rigs, post_rigs, shield_sources } = hitch_data

  let overrides = collect_twist_overrides(twist_entities)

  let fast_twists = new Set(tethers.keys())
  for (let [kw, o] of overrides) if (o.tether) fast_twists.add(kw)

  let line_order = determine_line_order(lines_map, poptop_name, abject_name)

  let edn_lines = new Map()
  for (let line_name of line_order) {
    let info = lines_map.get(line_name)
    if (!info) continue
    let { ids, shielded, reqsat } = info
    let reqsat_kw = (reqsat && reqsat !== 'null') ? reqsat : null
    let poptop_first = lines_map.get(poptop_name)?.ids[0]

    let specs = ids.map((id, i) => {
      let override   = overrides.get(id) || {}
      let tether_kw  = override.tether ?? tethers.get(id) ?? null
      let is_fast    = (tether_kw != null) || fast_twists.has(id)
      let rig_entries = Object.assign({},
        hoist_rigs.get(id) || {},
        post_rigs.get(id)  || {})
      let shield_hex  = (shielded && is_fast && tether_kw && !override.shield)
                          ? random_shield_hex() : null
      let shield_src  = shield_sources.get(id) ?? null
      let is_abject_first = (line_name === abject_name && i === 0)
      let is_other_first  = (line_name !== poptop_name &&
                             line_name !== abject_name && i === 0)
      // Decompile emits explicit `cargo` overrides — 'null' for
      // line-firsts whose original body.carg was NULL, 'arb:<hex>' /
      // literal hash for non-null. Presence of the key (rather than
      // truthiness of the value) means "decompile told us what was
      // really there, don't fall back to the cargo-<linename> heuristic".
      let hasCargoOverride    = 'cargo' in override
      let hasCargoRawOverride = 'cargo_raw' in override

      let spec = { id, line: line_name }
      if (reqsat_kw)            spec.reqsat        = reqsat_kw
      if (override.prev_id)     spec.prev_id       = override.prev_id
      if (tether_kw)            spec.tether        = tether_kw
      // rigs override precedence: explicit raw > explicit null >
      // hitch-derived (rig_entries). Raw bytes go straight into a
      // pairtrie (or other-shape) atom that we hand to compile via
      // spec.rigs_raw; compile.js writes its hash into body.rigs.
      if (override.rigs_raw) {
        spec.rigs_raw   = override.rigs_raw
        spec.rigs_shape = override.rigs_shape || 'pairtrie'
      } else if (override.rigs_hash) {
        spec.rigs_hash = override.rigs_hash
      } else if (override.rigs_null) {
        spec.rigs_null = true
      } else if (Object.keys(rig_entries).length) {
        spec.rig = rig_entries
      }
      // reqs / sats overrides: propagate raw / hash / null to spec.
      // The presence of any reqs/sats override implies the workshop's
      // ed25519 auto-generation should NOT fire for this twist.
      if (override.reqs_raw) {
        spec.reqs_raw   = override.reqs_raw
        spec.reqs_shape = override.reqs_shape || 'pairtrie'
      } else if (override.reqs_hash) {
        spec.reqs_hash = override.reqs_hash
      } else if (override.reqs_null) {
        spec.reqs_null = true
      }
      if (override.sats_raw) {
        spec.sats_raw   = override.sats_raw
        spec.sats_shape = override.sats_shape || 'pairtrie'
      } else if (override.sats_hash) {
        spec.sats_hash = override.sats_hash
      } else if (override.sats_null) {
        spec.sats_null = true
      }
      // Decompile emits shld: 'null' explicitly to mean "no shield" even
      // for fast twists on shielded lines. Distinguish from no-override.
      // shld raw form (override.shield_raw) wins over both null and arb;
      // used for designed-bad shield-shape fixtures.
      let hasShieldOverride     = 'shield' in override
      let hasShieldRawOverride  = 'shield_raw' in override
      let hasShieldHashOverride = 'shield_hash' in override
      if (hasShieldRawOverride) {
        spec.shield_raw   = override.shield_raw
        spec.shield_shape = override.shield_shape || 'arb'
      } else if (hasShieldHashOverride) {
        spec.shield_hash = override.shield_hash
      } else if (hasShieldOverride && override.shield && override.shield !== 'null') {
        spec.shield = override.shield
      } else if (!hasShieldOverride && !hasShieldHashOverride && shield_hex) {
        spec.shield = shield_hex
      }
      if (shield_src)           spec.shield_source = shield_src
      if (is_abject_first)      spec.poptop        = poptop_first
      else if (is_other_first && !hasCargoOverride && !hasCargoRawOverride)
                                spec.cargo         = `cargo-${line_name}`
      if (hasCargoOverride)     spec.cargo         = override.cargo
      if (hasCargoRawOverride) {
        spec.cargo_raw   = override.cargo_raw
        spec.cargo_shape = override.cargo_shape || 'pairtrie'
      }
      return spec
    })
    edn_lines.set(line_name, specs)
  }

  let last_ids = line_order
    .map(ln => lines_map.get(ln)?.ids.at(-1))
    .filter(Boolean)

  // If the rig declares a focus, ensure that twist's lat is merged
  // LAST so its twist atom is the last atom of the recompile bundle.
  // Reorder merge: remove focus_id if present, append it at the end.
  // If focus_id isn't already in last_ids (e.g., focus is a mid-line
  // twist, not a line's last), append it anyway so its lat is built
  // and merged.
  let focus_id_kw = rig_entity?.focus ? ref_to_kw(rig_entity.focus) : null
  if (focus_id_kw) {
    last_ids = last_ids.filter(id => id !== focus_id_kw)
    last_ids.push(focus_id_kw)
  }

  // Raw atom entities: {"atom":"<hash>", "shape":"arb", "raw":"<hex>"}
  // get registered as standalone atoms in the output bundle, regardless
  // of whether any twist spec references them. Designed-bad rigs whose
  // body slots point at non-twist atoms (the cork_prev_invalid_*
  // family: arb in a twist.prev slot) need this — the literal-hex
  // override gets the body bytes right but the arb atom itself isn't
  // pulled in by the lat-merging path.
  let atoms = entities
    .filter(e => e.entity_type === 'atom')
    .map(e => ({ hash: e.atom, shape: e.shape || 'arb', raw: e.raw }))

  return {
    lines:  edn_lines,
    atoms,
    output: {
      focus: focus_id_kw,
      merge:    last_ids,
      exclude:  [],
      // Resolve the corkline ID to the named poptop line when present;
      // fall back to the first real line in lines_map otherwise. Without
      // this, single-line rigs (or anything whose corkline isn't called
      // "poptop") returned corkline:null, so `workshop.corkline` after
      // recompile stayed pinned to the .json sidecar's canonical hash,
      // which doesn't appear in the recompiled bytes — and every checker
      // got handed a corkline twist that wasn't in the file.
      corkline: (lines_map.get(poptop_name) ?? [...lines_map.values()][0])
                ?.ids[0] ?? null,
    },
  }
}

// ---- Emission ----

export function emit_trdl(entities) {
  return entities
    .map(e => {
      let { entity_type, entity_id, ...rest } = e
      return JSON.stringify(rest)
    })
    .join('\n')
}
