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
import { check_via_worker } from './toda/rustoda-wasm/client.js'

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
  // 8 fixtures added on todatests's rustoda-updates branch — each ships
  // an `invariant` block in the sidecar that cites the spec section the
  // test is probing. Inserted into the alphabetical fixture list below.
  'todatests/rigging/complex_direct_to_indirect_splice.toda',
  'todatests/rigging/complex_indirect_to_direct_splice.toda',
  'todatests/rigging/complex_maximal_time_crossing.toda',
  'todatests/rigging/complex_maximal_time_crossing_complex.toda',
  'todatests/rigging/complex_tether_direction_change.toda',
  'todatests/rigging/conflicting_successors.toda',
  'todatests/rigging/cork_missing_rigging.toda',
  'todatests/rigging/cork_prev_invalid_green.toda',
  'todatests/rigging/cork_prev_invalid_red.toda',
  'todatests/rigging/cork_reqsat_fail.toda',
  'todatests/rigging/corkline_incomplete_early_red.toda',
  'todatests/rigging/corkline_incomplete_early_yellow.toda',
  'todatests/rigging/corkline_incomplete_late.toda',
  'todatests/rigging/example_rig_from_spec.toda',
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
  'todatests/rigging/hitch_extra_fast_in_footline.toda',
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
  'todatests/rigging/lead_shield_non_arb.toda',
  'todatests/rigging/meets_do_not_match.toda',
  'todatests/rigging/missing_rigging.toda',
  'todatests/rigging/missing_shield.toda',
  'todatests/rigging/multiple_hoists_green.toda',
  'todatests/rigging/nested_lash_in_splice.toda',
  'todatests/rigging/post_rigging_missing_post_key.toda',
  'todatests/rigging/self_referential.toda',
  'todatests/rigging/simple_lash_f1.toda',
  'todatests/rigging/simple_lash_f2.toda',
  'todatests/rigging/simple_last.toda',
  'todatests/rigging/splice_chain_4hitches.toda',
  'todatests/rigging/splice_mismatch.toda',
  'todatests/rigging/terminating_half_hitches_on_corkline.toda',
  'todatests/rigging/tether_loop.toda',
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

// rustoda is invoked through a Web Worker (toda/rustoda-wasm/client.js)
// so we can worker.terminate() any fixture that sends the wasm into a
// tight synchronous loop. CHECKER_TIMEOUT_MS bounds each call; on
// timeout the rust verdict becomes warn with a 'wasm timeout' detail
// and the next call gets a fresh worker.

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
  if (!res.ok) {
    // A non-2xx is the server failing to process the request, not the
    // checker producing a red verdict. Per spec §9.1.3 atomic / unable-
    // to-interpret conditions are yellow, not red — conflating them
    // would let a parser hiccup pose as "this rig is proven invalid".
    return { v: 'warn', detail: `HTTP ${res.status}` }
  }
  let { colour } = await res.json()
  return {
    v: colour === 'green' ? 'ok' : colour === 'yellow' ? 'warn' : 'bad',
    detail: colour,
  }
}

async function rust_check(ctx) {
  let bytes = ctx.bytes instanceof Uint8Array ? ctx.bytes : new Uint8Array(ctx.bytes)
  let res = await check_via_worker({ bytes, cork: ctx.corklineHex, twist: ctx.twistHex }, CHECKER_TIMEOUT_MS)
  if (!res.ok) {
    // Both timeouts and worker errors mean the wasm didn't produce a
    // verdict for this rig. Per spec §9.1.3 that's unknown/atomic-error
    // (yellow), not "rig proven invalid" (red).
    return { v: 'warn', detail: res.error }
  }
  try {
    let { state, detail } = JSON.parse(res.result)
    return { v: state, detail }
  } catch (e) {
    // Malformed JSON from the wasm: again, no verdict. Yellow, not red.
    return { v: 'warn', detail: e.message || String(e) }
  }
}

// Timeout guard. Any checker that exceeds the budget returns a 'warn'
// sentinel rather than hanging the whole bench — rust wasm in particular
// has no JS-side escape if it goes into a Rust infinite loop, and the
// HTTPS checkers can wedge on a stalled response.
function with_timeout(promise, ms, label) {
  return Promise.race([
    promise.catch(e => ({ v: 'bad', detail: e?.message || String(e) })),
    new Promise(r => setTimeout(() => r({ v: 'warn', detail: `${label} timeout (${ms}ms)` }), ms)),
  ])
}

const CHECKER_TIMEOUT_MS = 10000

async function run_all_checkers(ctx) {
  // rust_check already has its own worker-mediated timeout; the others
  // are wrapped here.
  let [js, clj, bb, rust] = await Promise.all([
    with_timeout(js_check(ctx),              CHECKER_TIMEOUT_MS, 'js'),
    with_timeout(server_check(ctx, CLJ_URL), CHECKER_TIMEOUT_MS, 'clj'),
    with_timeout(server_check(ctx, BB_URL),  CHECKER_TIMEOUT_MS, 'bb'),
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
  console.log(`[bench] ▶ ${path}`)
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
  // A few designed-bad fixtures (lashed_non_colinear, self_referential,
  // splice_mismatch) ship a sidecar without a corkline field. Fall back to
  // the file's focus hash: it lets every checker run (rather than skipping
  // the rig entirely) and produces a self-referential rig-check, which is
  // a meaningful test of "does the file pass its own walk?".
  let corkline_orig
  try {
    let res = await fetch(path.replace(/\.toda$/, '.json'))
    if (res.ok) {
      let j = await res.json()
      corkline_orig = j.corkline
      r.expectedColour = j.colour || null
    }
  } catch (_) { /* sidecar missing or malformed — fall through to fallback */ }
  if (!corkline_orig) {
    try {
      let atoms = Atoms.fromBytes(bytes_orig)
      corkline_orig = atoms.focus?.toString()
      r.corklineFallback = 'focus'
    } catch (e) {
      r.error = 'no sidecar corkline and focus parse failed: ' + (e.message || String(e))
      return r
    }
    if (!corkline_orig) { r.error = 'no sidecar corkline and no focus'; return r }
  }

  // --- pass 1: original bytes ---
  let ctx_orig
  try { ctx_orig = build_ctx(bytes_orig, corkline_orig) }
  catch (e) { r.error = 'ctx_orig: ' + (e.message || String(e)); return r }
  r.orig = await run_all_checkers(ctx_orig)
  r.origLen = bytes_orig.length

  // --- decompile → recompile ---
  // 20s budget. async work can be raced, but a tight synchronous loop in
  // decompile/compile will freeze the page; if Run-All halts at a specific
  // rig, check the console for the last "▶" log line — that's the culprit.
  let bytes_rec, corkline_rec
  try {
    let pipeline = (async () => {
      let entities  = await decompile(bytes_orig.buffer)
      let trdl_text = emit_jsonl(entities)
      let parsed    = parse_trdl_string(trdl_text)
      let spec      = trdl_to_spec(parsed)
      let compiled  = await build(spec)
      return { bytes_rec: new Uint8Array(compiled.bytes), corkline_rec: compiled.corkline_h, trdl_text }
    })()
    let result = await Promise.race([
      pipeline,
      new Promise((_, rej) => setTimeout(() => rej(new Error('pipeline timeout (20s)')), 20000)),
    ])
    bytes_rec    = result.bytes_rec
    corkline_rec = result.corkline_rec || null
    r.trdl       = result.trdl_text
  } catch (e) {
    r.recompileError = e.message || String(e)
    console.warn(`[bench]   pipeline failed for ${path}: ${r.recompileError}`)
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

  r.diffs = []
  for (let k of ['js', 'clj', 'bb', 'rust']) {
    if (r.orig[k].v !== r.rec[k].v) {
      r.diffs.push(`${k}: ${r.orig[k].v} → ${r.rec[k].v}`)
    }
  }
  r.rigPerfect = r.diffs.length === 0
  console.log(`[bench] ✓ ${path} → ${r.rigPerfect ? 'PERFECT' : 'DIFF: ' + r.diffs.join(', ')}`)
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
