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

export function parse_trdl_string(s) {
  return s.split('\n')
          .filter(line => line.trim() !== '')
          .map(line => classify_entity(JSON.parse(line)))
}

function classify_entity(m) {
  if      ('rig'   in m) return { ...m, entity_type: 'rig',   entity_id: m.rig   }
  else if ('line'  in m) return { ...m, entity_type: 'line',  entity_id: m.line  }
  else if ('hitch' in m) return { ...m, entity_type: 'hitch', entity_id: m.hitch }
  else if ('twist' in m) return { ...m, entity_type: 'twist', entity_id: m.twist }
  else if ('id'    in m) return { ...m, entity_type: 'twist', entity_id: m.id    }
  else throw new Error('Unknown TRDL entity (no rig/line/hitch/twist/id key)')
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

    let hoist_rig = shielded
      ? { [`s:${lead}`]: meet, [`ss:${lead}`]: `s:${meet}` }
      : { [`f:${lead}`]: meet }

    let post_rig = post_kw ? { [lead]: hoist } : null

    set_in('tethers', lead, fastener)
    if (!all_leads.has(meet)) set_in('tethers', meet, fastener)
    merge_in('hoist_rigs', hoist, hoist_rig)
    if (shielded) set_in('shield_sources', hoist, lead)
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
    if ('shld'  in e) o.shield     = e.shld
    if ('cargo' in e) o.cargo      = e.cargo
    if ('rigs'  in e) o.extra_rigs = e.rigs
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

      let spec = { id, line: line_name }
      if (reqsat_kw)            spec.reqsat        = reqsat_kw
      if (override.prev_id)     spec.prev_id       = override.prev_id
      if (tether_kw)            spec.tether        = tether_kw
      if (Object.keys(rig_entries).length) spec.rig = rig_entries
      if (override.shield)      spec.shield        = override.shield
      else if (shield_hex)      spec.shield        = shield_hex
      if (shield_src)           spec.shield_source = shield_src
      if (is_abject_first)      spec.poptop        = poptop_first
      else if (is_other_first)  spec.cargo         = `cargo-${line_name}`
      if (override.cargo)       spec.cargo         = override.cargo
      return spec
    })
    edn_lines.set(line_name, specs)
  }

  let last_ids = line_order
    .map(ln => lines_map.get(ln)?.ids.at(-1))
    .filter(Boolean)

  return {
    lines:  edn_lines,
    output: {
      merge:    last_ids,
      exclude:  [],
      corkline: lines_map.get(poptop_name)?.ids[0] ?? null,
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
