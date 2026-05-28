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
import { list_rigs } from './rig-manifest.js'

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
// Rig list. Discovered at run-time via list_rigs() walking todatests/
// directory indexes; authoritative colour comes from the sibling .json
// sidecar. Adding a fixture under todatests/rigging/ or todatests/reqsat/
// shows up in the bench on next page load.

let RIGS = []

const CLJ_URL = 'https://rigchecker.todaq.net/rigcheck-clj'
const BB_URL  = 'https://rigchecker.todaq.net/rigcheck-bb'
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
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      let err = await res.json()
      detail = err.type && err.message
        ? `${err.type}: ${err.message}`.slice(0, 120)
        : JSON.stringify(err).slice(0, 120)
    } catch (_) { /* body isn't JSON — fall through to status-only */ }
    return { v: 'broke', detail }
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

  if (RIGS.length === 0) {
    progress.textContent = 'discovering rigs…'
    // Bench loads bytes as .toda; .trdl files would fail Atoms.fromBytes.
    RIGS = await list_rigs(undefined, ['.toda'])
  }

  let targets = filter
    ? RIGS.filter(p => p.toLowerCase().includes(filter))
    : RIGS

  _results = []
  let perfect = 0, partial = 0, noneAgree = 0, errs = 0
  let perChecker = { js: 0, clj: 0, bb: 0, rust: 0 }
  for (let i = 0; i < targets.length; i++) {
    progress.textContent = `${i + 1}/${targets.length} · ${targets[i].replace(/^.*\//, '')}`
    let r = await run_one(targets[i])
    _results.push(r)
    render_row(tbody, r)
    if (r.error) errs++
    else if (r.canonicalAgreementCount === 4) perfect++
    else if (r.canonicalAgreementCount === 0) noneAgree++
    else partial++
    if (r.colours && r.canonical) {
      for (let k of ['js','clj','bb','rust']) {
        if (r.colours[k] !== r.canonical) perChecker[k]++
      }
    }
  }
  progress.textContent = ''
  summary.hidden = false
  summary.innerHTML =
    `<strong>${perfect}</strong> all-4-agree-canonical · ` +
    `<strong>${partial}</strong> partial · ` +
    `<strong>${noneAgree}</strong> none-agree-canonical · ` +
    `<strong>${errs}</strong> error · ` +
    `${targets.length} total<br>` +
    `disagrees vs canonical: ` +
    ['js','clj','bb','rust'].map(k =>
      `${k}=<strong>${perChecker[k]}</strong>`).join(' · ')
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
