// Roundtrip rig-perfect bench. Mirrors the rig-check pipeline in app.js
// without any of the workshop UI. Drives 60 .toda fixtures through:
//
//     bytes_orig
//       │
//       ├── all 4 checkers ──→ verdicts_orig
//       │
//       └── decompile → trdl → compile → bytes_recompile
//                                          │
//                                          └── all 4 checkers ──→ verdicts_rec
//
// A rig is "rig-perfect" iff verdicts_orig == verdicts_rec for every checker.
//
// HalfHitchInterpreter is copied from app.js so this bench is standalone —
// keeps the workshop's app.js untouched.

import { Atoms } from './src/core/atoms.js'
import { Interpreter } from './src/core/interpret.js'
import { Line } from './src/core/line.js'
import { Twist } from './src/core/twist.js'
import { Hash } from './src/core/hash.js'

import { decompile, emit_jsonl } from './toda/decompile.js'
import { parse_trdl_string, trdl_to_spec } from './toda/trdl.js'
import { build } from './toda/compile.js'

// ----------------------------------------------------------------------------
// Inline HalfHitchInterpreter (copy of app.js's). See app.js for rationale —
// briefly: allows missing post-rig entries and null-guards the walk-back so
// half-hitches on a corkline pass the workshop's relaxed semantics.

class HalfHitchInterpreter extends Interpreter {
  constructor(...args) { super(...args); this._visited = new Set() }
  hitchPost(hash) {
    let meet = this.hitchMeet(hash)
    let post = this.nextTetheredTwist(meet.hash)
    if (!post) return null
    let hoistHash = post.rig(hash)
    if (!hoistHash) return null
    if (hoistHash.equals(this.hitchHoist(hash).hash)) return post
    throw new Error('post rig entry conflict')
  }
  async _verifyHitchLine(unverifiedFast, optLastSupported, optFirst) {
    let key = String(unverifiedFast) + '|' + String(optLastSupported)
    if (this._visited.has(key)) return
    this._visited.add(key)
    await this._verifyHitch(unverifiedFast)
    if (optLastSupported && this.inSegment(unverifiedFast,
        this.nextTetheredTwist(unverifiedFast).hash, optLastSupported)) return
    let hasPrev = false
    try { hasPrev = !!this.twist(unverifiedFast).prev() } catch {}
    if (hasPrev) {
      let prevFast = this.prevTetheredTwist(unverifiedFast)
      if (prevFast) return this._verifyHitchLine(prevFast.hash, optLastSupported, false)
    }
  }
}

// ----------------------------------------------------------------------------
// Fixture list. Copy of the .toda entries from editor.js RIGS. Hardcoded so
// the bench is self-contained.

const FIXTURES = [
  'todatests/rigging/complex_bad_hoist_direct_to_indirect.toda',
  'todatests/rigging/complex_bad_hoist_indirect_to_direct.toda',
  'todatests/rigging/complex_direct_to_indirect_splice.toda',
  'todatests/rigging/complex_indirect_to_direct_splice.toda',
  'todatests/rigging/complex_maximal_time_crossing.toda',
  'todatests/rigging/complex_maximal_time_crossing_complex.toda',
  'todatests/rigging/complex_tether_direction_change.toda',
  'todatests/rigging/cork_missing_rigging.toda',
  'todatests/rigging/cork_prev_invalid_green.toda',
  'todatests/rigging/cork_prev_invalid_red.toda',
  'todatests/rigging/cork_reqsat_fail.toda',
  'todatests/rigging/corkline_incomplete_early_red.toda',
  'todatests/rigging/corkline_incomplete_early_yellow.toda',
  'todatests/rigging/corkline_incomplete_late.toda',
  'todatests/rigging/hh_corkline_twist_missing.toda',
  'todatests/rigging/hh_footline_prev_gap.toda',
  'todatests/rigging/hh_mismatched_s_ss_values.toda',
  'todatests/rigging/hh_no_s_lead.toda',
  'todatests/rigging/hh_no_ss_lead.toda',
  'todatests/rigging/hh_non_fast_meet.toda',
  'todatests/rigging/hh_self_referential_rig.toda',
  'todatests/rigging/hh_tether_missing.toda',
  'todatests/rigging/hh_tether_not_twist.toda',
  'todatests/rigging/hh_tether_null.toda',
  'todatests/rigging/hh_tether_symbol.toda',
  'todatests/rigging/hh_valid_lead_root.toda',
  'todatests/rigging/hh_valid_self_ref_subsequent_valid.toda',
  'todatests/rigging/hh_valid_shield_non_null.toda',
  'todatests/rigging/hh_valid_shield_null.toda',
  'todatests/rigging/hh_wrong_hoist_values.toda',
  'todatests/rigging/hh_wrong_shield.toda',
  'todatests/rigging/hitch_hoist_rigs_missing.toda',
  'todatests/rigging/hitch_meet_tether_null.toda',
  'todatests/rigging/hitch_splice_post_no_lead_entry.toda',
  'todatests/rigging/hitch_splice_post_wrong_hoist.toda',
  'todatests/rigging/hitch_valid_basic_splice.toda',
  'todatests/rigging/invalid_rigging_green.toda',
  'todatests/rigging/invalid_shielding_green.toda',
  'todatests/rigging/lash_succession_missing_prev.toda',
  'todatests/rigging/lash_succession_no_fast_twist.toda',
  'todatests/rigging/lash_succession_reqsat_fail.toda',
  'todatests/rigging/lashed_non_colinear.toda',
  'todatests/rigging/meets_do_not_match.toda',
  'todatests/rigging/missing_rigging.toda',
  'todatests/rigging/missing_shield.toda',
  'todatests/rigging/multiple_hoists_green.toda',
  'todatests/rigging/post_rigging_missing_post_key.toda',
  'todatests/rigging/self_referential.toda',
  'todatests/rigging/simple_lash_f1.toda',
  'todatests/rigging/simple_lash_f2.toda',
  'todatests/rigging/simple_last.toda',
  'todatests/rigging/splice_mismatch.toda',
  'todatests/rigging/unit_rig.toda',
  'todatests/rigging/unit_rig_multi.toda',
  'todatests/rigging/valid_kiwano.toda',
  'todatests/rigging/valid_kiwano_0.toda',
  'todatests/rigging/valid_kiwano_1.toda',
  'todatests/rigging/valid_kiwano_f1.toda',
  'todatests/rigging/valid_kiwano_f2.toda',
  'todatests/rigging/valid_kiwano_f5.toda',
]

const CLJ_URL = 'https://d3myckc3w6ekfv.cloudfront.net/rigcheck-clj'
const BB_URL  = 'https://d3myckc3w6ekfv.cloudfront.net/rigcheck-bb'

// ----------------------------------------------------------------------------
// Checker drivers (mirror app.js CHECKERS run() functions)

async function js_check(ctx) {
  try {
    let line   = Line.fromTwist(ctx.twist)
    let interp = new HalfHitchInterpreter(line, ctx.corklineHash)
    await interp.verifyTopline()
    await interp.verifyHitchLine(ctx.twistHash)
    return { v: 'ok', detail: 'verified' }
  } catch (e) {
    let name = e?.name || e?.constructor?.name || ''
    if (/^Missing/.test(name)) return { v: 'warn', detail: e.message || String(e) }
    return { v: 'bad', detail: e.message || String(e) }
  }
}

async function server_check(ctx, base) {
  let url = `${base}?cork=${ctx.corklineHex}&twist=${ctx.twistHex}`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ctx.bytes,
    })
  } catch { return { v: 'warn', detail: 'server offline' } }
  if (!res.ok) return { v: 'bad', detail: `HTTP ${res.status}` }
  let { colour } = await res.json()
  return {
    v: colour === 'green' ? 'ok' : colour === 'yellow' ? 'warn' : 'bad',
    detail: colour,
  }
}

let _rustoda_load
async function load_rustoda() {
  if (!_rustoda_load) _rustoda_load = (async () => {
    try {
      let mod = await import('./toda/rustoda-wasm/rigcheck.js')
      await mod.default()
      return { mod }
    } catch (e) { return { error: e } }
  })()
  return _rustoda_load
}
async function rust_check(ctx) {
  let { mod, error } = await load_rustoda()
  if (error) return { v: 'warn', detail: 'wasm load failed' }
  try {
    let bytes = ctx.bytes instanceof Uint8Array ? ctx.bytes : new Uint8Array(ctx.bytes)
    let { state, detail } = JSON.parse(mod.check_rig(bytes, ctx.corklineHex, ctx.twistHex))
    return { v: state, detail }
  } catch (e) { return { v: 'bad', detail: e.message || String(e) } }
}

async function run_all_checkers(ctx) {
  // Parallel — same as the workshop. Each returns { v, detail }.
  let [js, clj, bb, rust] = await Promise.all([
    js_check(ctx).catch(e => ({ v: 'bad', detail: e.message || String(e) })),
    server_check(ctx, CLJ_URL),
    server_check(ctx, BB_URL),
    rust_check(ctx),
  ])
  return { js, clj, bb, rust }
}

// ----------------------------------------------------------------------------
// Ctx construction

function build_ctx(bytes, corkline_hex) {
  let atoms = Atoms.fromBytes(bytes)
  let focus_hex = atoms.focus?.toString()
  if (!focus_hex) throw new Error('atoms have no focus')
  let twist = new Twist(atoms, atoms.focus)
  return {
    twist,
    twistHash:    twist.getHash(),
    corklineHash: Hash.fromHex(corkline_hex),
    bytes,
    corklineHex:  corkline_hex,
    twistHex:     focus_hex,
  }
}

// ----------------------------------------------------------------------------
// One fixture: load → check orig → decompile/recompile → check recompile → compare

async function run_one(path) {
  let r = { path }
  let bytes_orig
  try {
    let res = await fetch(path)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    bytes_orig = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    r.error = 'fetch: ' + (e.message || String(e))
    return r
  }

  // Canonical corkline from the .json sidecar — same as the workshop uses.
  let corkline_orig
  try {
    let res = await fetch(path.replace(/\.toda$/, '.json'))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    let j = await res.json()
    corkline_orig = j.corkline
    r.expectedColour = j.colour || null
  } catch (e) {
    r.error = 'sidecar: ' + (e.message || String(e))
    return r
  }
  if (!corkline_orig) { r.error = 'sidecar has no corkline'; return r }

  // --- pass 1: original bytes ---
  let ctx_orig
  try { ctx_orig = build_ctx(bytes_orig, corkline_orig) }
  catch (e) { r.error = 'ctx_orig: ' + (e.message || String(e)); return r }
  r.orig = await run_all_checkers(ctx_orig)
  r.origLen = bytes_orig.length

  // --- decompile → recompile ---
  let bytes_rec, corkline_rec
  try {
    let entities    = await decompile(bytes_orig.buffer)
    let trdl_text   = emit_jsonl(entities)
    let parsed      = parse_trdl_string(trdl_text)
    let spec        = trdl_to_spec(parsed)
    let compiled    = await build(spec)
    bytes_rec       = new Uint8Array(compiled.bytes)
    corkline_rec    = compiled.corkline_h || null
    r.trdl          = trdl_text
  } catch (e) {
    r.recompileError = e.message || String(e)
    return r
  }
  r.recLen = bytes_rec.length

  if (!corkline_rec) {
    r.recompileError = 'compile produced no corkline'
    return r
  }

  // --- pass 2: recompile bytes ---
  let ctx_rec
  try { ctx_rec = build_ctx(bytes_rec, corkline_rec) }
  catch (e) { r.recompileError = 'ctx_rec: ' + (e.message || String(e)); return r }
  r.rec = await run_all_checkers(ctx_rec)

  // Compare verdicts.
  r.diffs = []
  for (let k of ['js', 'clj', 'bb', 'rust']) {
    if (r.orig[k].v !== r.rec[k].v) {
      r.diffs.push(`${k}: ${r.orig[k].v} → ${r.rec[k].v}`)
    }
  }
  r.rigPerfect = r.diffs.length === 0
  return r
}

// ----------------------------------------------------------------------------
// Rendering

function pill(v) {
  if (!v) return '<span class="v-skip">—</span>'
  return `<span class="v-${v.v || v}">${(v.v || v).toUpperCase()}</span>`
}

function render_row(tbody, r) {
  let tr = document.createElement('tr')
  let basename = r.path.replace(/^.*\//, '').replace(/\.toda$/, '')
  let oc = r.orig || {}, rc = r.rec || {}
  let verdict, vClass
  if (r.error) { verdict = 'ERR'; vClass = 'error' }
  else if (r.recompileError) { verdict = 'COMPILE ERR'; vClass = 'error' }
  else if (r.rigPerfect)     { verdict = 'PERFECT';     vClass = 'perfect' }
  else                       { verdict = 'DIFF';        vClass = 'imperfect' }

  let note = r.error || r.recompileError || (r.diffs?.length ? r.diffs.join('\n') : '')

  tr.innerHTML =
    `<td title="${r.path}">${basename}</td>` +
    `<td class="col-orig">${pill(oc.js)}</td>` +
    `<td class="col-orig">${pill(oc.clj)}</td>` +
    `<td class="col-orig">${pill(oc.bb)}</td>` +
    `<td class="col-orig">${pill(oc.rust)}</td>` +
    `<td class="col-orig">→</td>` +
    `<td class="col-rec">${pill(rc.js)}</td>` +
    `<td class="col-rec">${pill(rc.clj)}</td>` +
    `<td class="col-rec">${pill(rc.bb)}</td>` +
    `<td class="col-rec">${pill(rc.rust)}</td>` +
    `<td><span class="verdict ${vClass}">${verdict}</span></td>` +
    `<td class="note">${escape_html(note)}</td>`
  tbody.appendChild(tr)
}

function escape_html(s) {
  return String(s || '').replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')
}

// ----------------------------------------------------------------------------
// Driver

let _results = []

async function run_all() {
  let filter   = document.getElementById('filter').value.trim().toLowerCase()
  let tbody    = document.querySelector('#results tbody')
  let progress = document.getElementById('progress')
  let summary  = document.getElementById('summary')
  let download = document.getElementById('download')
  tbody.innerHTML = ''
  summary.hidden = true
  download.disabled = true

  let targets = filter
    ? FIXTURES.filter(f => f.toLowerCase().includes(filter))
    : FIXTURES

  _results = []
  let perfect = 0, imperfect = 0, errs = 0
  for (let i = 0; i < targets.length; i++) {
    progress.textContent = `${i + 1}/${targets.length} · ${targets[i].replace(/^.*\//, '')}`
    let r = await run_one(targets[i])
    _results.push(r)
    render_row(tbody, r)
    if (r.error || r.recompileError) errs++
    else if (r.rigPerfect)            perfect++
    else                              imperfect++
  }

  progress.textContent = ''
  summary.hidden = false
  summary.innerHTML =
    `<strong>${perfect}</strong> rig-perfect · ` +
    `<strong>${imperfect}</strong> divergent · ` +
    `<strong>${errs}</strong> error(s) · ` +
    `${targets.length} total`
  download.disabled = _results.length === 0
}

function do_download() {
  let blob = new Blob([JSON.stringify(_results, null, 2)], { type: 'application/json' })
  let a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'roundtrip-bench.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

document.getElementById('run').addEventListener('click', run_all)
document.getElementById('download').addEventListener('click', do_download)
document.getElementById('filter').addEventListener('keydown', e => {
  if (e.key === 'Enter') run_all()
})
