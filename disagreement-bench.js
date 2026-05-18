// Disagreement bench. For every fixture in todatests/:
//   - Load the .toda bytes as-is (no recompile — this bench is about
//     checker disagreement, not roundtrip behaviour).
//   - Build a ctx (bytes + corkline + focus) and run all 4 checkers on
//     the original bytes.
//   - Fetch the .json sidecar for the canonical declared colour.
//   - Render a row per rig and flag cells where a checker disagrees
//     with canonical.
//
// Modelled after roundtrip-bench.html / .js.

import { Atoms } from './src/core/atoms.js'
import { Interpreter } from './src/core/interpret.js'
import { Line } from './src/core/line.js'
import { Twist } from './src/core/twist.js'
import { Hash } from './src/core/hash.js'

import { check_via_worker } from './toda/rustoda-wasm/client.js'

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
// Rig list. 129 fixtures from todatests/rigging + todatests/reqsat/ed25519-rigs.
// Authoritative colour comes from the sibling .json sidecar; this bench does
// no heuristic guessing.

const RIGS = [
  'todatests/reqsat/ed25519-rigs/twist-chain-with-fields.toda',
  'todatests/reqsat/ed25519-rigs/twist-isolation-multi-line.toda',
  'todatests/rigging/1-splice-no-post.toda',
  'todatests/rigging/11-bottom-fastener-not-fast.toda',
  'todatests/rigging/12-bottom-hoist-not-fast.toda',
  'todatests/rigging/13-bottom-corkline-top-leadline.toda',
  'todatests/rigging/14-bottom-corkline-shorter-than-top-leadline-both-sides.toda',
  'todatests/rigging/15-splicing-hitches-with-identical-toplines.toda',
  'todatests/rigging/17-lashing-2-non-consecutive-hitches-to-15.toda',
  'todatests/rigging/18-lashing-to-2-hitch-splice-with-missing-right-hoist.toda',
  'todatests/rigging/2-right-fast-first.toda',
  'todatests/rigging/21-direct-tether-spliced-to-indirect-tether.toda',
  'todatests/rigging/22-indirect-tether-spliced-to-direct-tether.toda',
  'todatests/rigging/23-indirect-tether-spliced-to-direct-tether-bad-post.toda',
  'todatests/rigging/24-direct-tether-spliced-to-indirect-tether-bad-post.toda',
  'todatests/rigging/25-lashed-rigs-spliced-for-maximal-time-crossing.toda',
  'todatests/rigging/26-like-above-back-and-forth.toda',
  'todatests/rigging/27-intermediate-lines-change-tether-direction-via-corkline.toda',
  'todatests/rigging/28-intermediate-lines-change-tether-direction-via-new-line.toda',
  'todatests/rigging/29a-attempt-to-trigger-false-positive-on-tether-loop-detection.toda',
  'todatests/rigging/3-normally-expected-splice.toda',
  'todatests/rigging/31-irrelevent-tether-loop-after-corkline-reached.toda',
  'todatests/rigging/4-lash-left-non-overlap-null.toda',
  'todatests/rigging/5-lash-left-non-overlap-missing.toda',
  'todatests/rigging/6-lash-right-non-overlap.toda',
  'todatests/rigging/7-corkline-self-tether.toda',
  'todatests/rigging/8-splice-on-mutual-tether.toda',
  'todatests/rigging/9-leadline-equivocal-from-corkline.toda',
  'todatests/rigging/api-valid-lashed-rig.toda',
  'todatests/rigging/basic-half-hitch.toda',
  'todatests/rigging/complex_bad_hoist_direct_to_indirect.toda',
  'todatests/rigging/complex_bad_hoist_indirect_to_direct.toda',
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
  'todatests/rigging/corkline_incomplete_late.toda',
  'todatests/rigging/example_rig_from_spec.toda',
  'todatests/rigging/extra-fast-between-meet-and-post.toda',
  'todatests/rigging/full-hitch-with-post.toda',
  'todatests/rigging/half-hitch-footline-reaches-null.toda',
  'todatests/rigging/half-hitch-lead-mismatch.toda',
  'todatests/rigging/half-hitch-lead-not-fast.toda',
  'todatests/rigging/half-hitch-meet-not-fast.toda',
  'todatests/rigging/half-hitch-topline-fastener-not-found.toda',
  'todatests/rigging/half-hitch-valid.toda',
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
  'todatests/rigging/hitch-lead-footline-reaches-null.toda',
  'todatests/rigging/hitch-post-footline-reaches-null.toda',
  'todatests/rigging/hitch-post-not-fast.toda',
  'todatests/rigging/hitch-valid.toda',
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
  'todatests/rigging/multi-level-rig.toda',
  'todatests/rigging/multiple_hoists_green.toda',
  'todatests/rigging/nested_lash_in_splice.toda',
  'todatests/rigging/post_rigging_missing_post_key.toda',
  'todatests/rigging/rigging-corkline-incomplete-early.toda',
  'todatests/rigging/rigging-corkline-incomplete-late.toda',
  'todatests/rigging/rigging-lash-non-colinear.toda',
  'todatests/rigging/rigging-valid-lash-and-splice.toda',
  'todatests/rigging/rigging-valid-simple-lash.toda',
  'todatests/rigging/rigging-valid-spliced-unit-rigs.toda',
  'todatests/rigging/rigging-valid-unit-rig.toda',
  'todatests/rigging/self_referential.toda',
  'todatests/rigging/simple_lash_f1.toda',
  'todatests/rigging/simple_lash_f2.toda',
  'todatests/rigging/simple_last.toda',
  'todatests/rigging/splice_chain_4hitches.toda',
  'todatests/rigging/splice_mismatch.toda',
  'todatests/rigging/terminating_half_hitches_on_corkline.toda',
  'todatests/rigging/test-suite-complex-rig-21-direct-to-indirect-tether.toda',
  'todatests/rigging/test-suite-complex-rig-22-indirect-to-direct-tether.toda',
  'todatests/rigging/test-suite-complex-rig-25-lashed-maximal-time-crossing.toda',
  'todatests/rigging/test-suite-complex-rig-26-lashed-complex.toda',
  'todatests/rigging/test-suite-half-hitch-invalid-lead-not-tethered.toda',
  'todatests/rigging/test-suite-half-hitch-invalid-meet-not-fast.toda',
  'todatests/rigging/test-suite-half-hitch-valid-null-shield.toda',
  'todatests/rigging/test-suite-half-hitch-valid-with-shield.toda',
  'todatests/rigging/tether_loop.toda',
  'todatests/rigging/three-hitches-horizontal.toda',
  'todatests/rigging/three-hitches-vertical.toda',
  'todatests/rigging/topline_rigs_non_trie.toda',
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
const CHECKER_TIMEOUT_MS = 10000

// ----------------------------------------------------------------------------
// Checker drivers (verdict map: ok/warn/bad for actual checker output,
// broke for "checker couldn't evaluate the request"). Mirrors the
// roundtrip-bench's choices.

async function js_check(ctx) {
  try {
    let line   = Line.fromTwist(ctx.twist)
    let interp = new HalfHitchInterpreter(line, ctx.corklineHash)
    await interp.verifyTopline()
    await interp.verifyHitchLine(ctx.twistHash)
    return { v: 'ok', detail: 'verified' }
  } catch (e) {
    // See app.js CHECKERS[0].run for the rationale; mirror the same
    // classification here. Three "Missing*" classes are actually
    // INVALID-class per spec §9.1.3 and must be red:
    let name = e?.name || e?.constructor?.name || ''
    const JS_INVALID_AS_MISSING = new Set([
      'MissingHoistError', 'MissingPostEntry', 'MissingSuccessor',
    ])
    if (JS_INVALID_AS_MISSING.has(name)) return { v: 'bad',  detail: e.message || String(e) }
    if (/^Missing/.test(name))           return { v: 'warn', detail: e.message || String(e) }
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
  } catch { return { v: 'broke', detail: 'server offline' } }
  if (!res.ok) return { v: 'broke', detail: `HTTP ${res.status}` }
  let { colour } = await res.json()
  return {
    v: colour === 'green' ? 'ok' : colour === 'yellow' ? 'warn' : 'bad',
    detail: colour,
  }
}

async function rust_check(ctx) {
  let bytes = ctx.bytes instanceof Uint8Array ? ctx.bytes : new Uint8Array(ctx.bytes)
  let res = await check_via_worker({ bytes, cork: ctx.corklineHex, twist: ctx.twistHex }, CHECKER_TIMEOUT_MS)
  if (!res.ok) return { v: 'broke', detail: res.error }
  try {
    let { state, detail } = JSON.parse(res.result)
    return { v: state, detail }
  } catch (e) { return { v: 'broke', detail: e.message || String(e) } }
}

function with_timeout(promise, ms, label) {
  return Promise.race([
    promise.catch(e => ({ v: 'broke', detail: e?.message || String(e) })),
    new Promise(r => setTimeout(() => r({ v: 'broke', detail: `${label} timeout (${ms}ms)` }), ms)),
  ])
}

async function run_all_checkers(ctx) {
  let [js, clj, bb, rust] = await Promise.all([
    with_timeout(js_check(ctx),              CHECKER_TIMEOUT_MS, 'js'),
    with_timeout(server_check(ctx, CLJ_URL), CHECKER_TIMEOUT_MS, 'clj'),
    with_timeout(server_check(ctx, BB_URL),  CHECKER_TIMEOUT_MS, 'bb'),
    rust_check(ctx),
  ])
  return { js, clj, bb, rust }
}

// ----------------------------------------------------------------------------
// Per-rig pipeline. Fetch .toda bytes; corkline comes from the sidecar
// .json or, when absent, the file's focus hash.

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

async function fetch_sidecar(path) {
  try {
    let json_url = path.replace(/\.(trdl|toda)$/, '.json')
    let res = await fetch(json_url)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function load_toda_rig(path, sidecar) {
  let res = await fetch(path)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  let bytes = new Uint8Array(await res.arrayBuffer())
  let corkline = sidecar?.corkline || null
  if (!corkline) {
    // Fall back to file's focus hash, same as roundtrip-bench. Loses some
    // canonical-corkline checking, but at least every checker runs.
    let atoms = Atoms.fromBytes(bytes)
    corkline = atoms.focus?.toString() || null
  }
  return { bytes, corkline }
}

async function run_one(path) {
  console.log(`[disagree] ▶ ${path}`)
  let r = { path }
  let sidecar
  try { sidecar = await fetch_sidecar(path) } catch { sidecar = null }
  r.canonical = sidecar?.colour || null
  if (sidecar) {
    if (sidecar.moniker)   r.moniker   = sidecar.moniker
    if (sidecar.invariant) r.invariant = sidecar.invariant
  }

  let bytes, corkline
  try {
    let loaded = await load_toda_rig(path, sidecar)
    bytes = loaded.bytes
    corkline = loaded.corkline
    if (!corkline) { r.error = 'no corkline (no sidecar, no focus)'; return r }
  } catch (e) {
    r.error = e.message || String(e)
    console.warn(`[disagree]   load failed for ${path}: ${r.error}`)
    return r
  }

  let ctx
  try { ctx = build_ctx(bytes, corkline) }
  catch (e) { r.error = 'ctx: ' + (e.message || String(e)); return r }

  r.bytesLen = bytes.length
  r.results = await run_all_checkers(ctx)

  // Map checker verdict letters to spec colours for direct comparison
  // with canonical. ok→green, warn→yellow, bad→red. broke isn't a
  // verdict — the checker didn't evaluate; treat as 'unknown' for
  // disagreement counting (doesn't agree with anything except itself).
  function vToCol(v) {
    return v === 'ok' ? 'green' : v === 'warn' ? 'yellow' : v === 'bad' ? 'red' : v
  }
  r.colours = {
    js:   vToCol(r.results.js.v),
    clj:  vToCol(r.results.clj.v),
    bb:   vToCol(r.results.bb.v),
    rust: vToCol(r.results.rust.v),
  }
  let agreeingCheckers = ['js','clj','bb','rust'].filter(k => r.colours[k] === r.canonical)
  r.canonicalAgreementCount = agreeingCheckers.length
  // Per-checker checker-vs-checker agreement matters too: are all 4
  // verdicts identical? (independent of canonical)
  r.allFourAgree = new Set(Object.values(r.colours)).size === 1
  console.log(`[disagree] ✓ ${path} → canonical=${r.canonical} js=${r.colours.js} clj=${r.colours.clj} bb=${r.colours.bb} rust=${r.colours.rust}`)
  return r
}

// ----------------------------------------------------------------------------
// Rendering

function pill(verdict_obj, canonical) {
  if (!verdict_obj) return ['<span class="v-skip">—</span>', false]
  let v = verdict_obj.v
  let col = v === 'ok' ? 'green' : v === 'warn' ? 'yellow' : v === 'bad' ? 'red' : v
  let disagrees = col !== canonical
  let cls = `v-${v}`
  return [`<span class="${cls}">${v.toUpperCase()}</span>`, disagrees]
}

function canonical_pill(c) {
  if (!c) return '<span class="v-skip">—</span>'
  return `<span class="v-${c}">${c.toUpperCase()}</span>`
}

function render_row(tbody, r) {
  let tr = document.createElement('tr')
  let basename = r.path.replace(/^.*\//, '').replace(/\.(trdl|toda)$/, '')
  let verdict, vClass
  if (r.error) {
    verdict = 'ERR'; vClass = 'error'
  } else if (r.canonicalAgreementCount === 4) {
    verdict = 'PERFECT'; vClass = 'perfect'
  } else if (r.canonicalAgreementCount === 0) {
    verdict = 'NONE AGREE'; vClass = 'imperfect'
  } else {
    verdict = `${r.canonicalAgreementCount}/4`; vClass = 'partial'
  }

  let note = r.error || ''
  if (!r.error && r.results) {
    let disagreers = ['js','clj','bb','rust'].filter(k => r.colours[k] !== r.canonical)
    if (disagreers.length) {
      note = disagreers.map(k => `${k}: ${r.colours[k]} (${escape_html((r.results[k].detail || '').slice(0,80))})`).join('\n')
    } else {
      note = ''
    }
  }
  if (r.moniker) note = (note ? note + '\n\n' : '') + 'moniker: ' + escape_html(r.moniker.slice(0, 200))

  let cells = ['js', 'clj', 'bb', 'rust'].map(k => {
    let [html, disagrees] = pill(r.results?.[k], r.canonical)
    return `<td class="cell ${disagrees ? 'disagrees' : ''}">${html}</td>`
  }).join('')

  tr.innerHTML =
    `<td class="path" title="${escape_html(r.path)}">${escape_html(basename)}</td>` +
    `<td>${canonical_pill(r.canonical)}</td>` +
    cells +
    `<td><span class="verdict ${vClass}">${escape_html(verdict)}</span></td>` +
    `<td class="note">${note}</td>`
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
    ? RIGS.filter(p => p.toLowerCase().includes(filter))
    : RIGS

  _results = []
  let perfect = 0, partial = 0, noneAgree = 0, errs = 0
  for (let i = 0; i < targets.length; i++) {
    progress.textContent = `${i + 1}/${targets.length} · ${targets[i].replace(/^.*\//, '')}`
    let r = await run_one(targets[i])
    _results.push(r)
    render_row(tbody, r)
    if (r.error) errs++
    else if (r.canonicalAgreementCount === 4) perfect++
    else if (r.canonicalAgreementCount === 0) noneAgree++
    else partial++
  }
  progress.textContent = ''
  summary.hidden = false
  summary.innerHTML =
    `<strong>${perfect}</strong> all-4-agree-canonical · ` +
    `<strong>${partial}</strong> partial · ` +
    `<strong>${noneAgree}</strong> none-agree-canonical · ` +
    `<strong>${errs}</strong> error · ` +
    `${targets.length} total`
  download.disabled = _results.length === 0
}

function do_download() {
  let blob = new Blob([JSON.stringify(_results, null, 2)], { type: 'application/json' })
  let a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'disagreement-bench.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

document.getElementById('run').addEventListener('click', run_all)
document.getElementById('download').addEventListener('click', do_download)
document.getElementById('filter').addEventListener('keydown', e => {
  if (e.key === 'Enter') run_all()
})
