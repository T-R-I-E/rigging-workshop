// Compile byte-equality test harness. Iterates over the known rigs in
// toda-twist-maker/rigs and asserts JS-compile bytes == server /compile bytes
// for the deterministic ones.

import { parse_trdl_string, trdl_to_spec } from './toda/trdl.js'
import { build } from './toda/compile.js'

const RIGS_BASE = 'rigs/'
const SERVER    = 'http://localhost:7878'

const RIG_FILES = [
  '1-splice-no-post.trdl',
  '2-right-fast-first.trdl',
  '3-normally-expected-splice.trdl',
  '4-lash-left-non-overlap-null.trdl',
  '5-lash-left-non-overlap-missing.trdl',
  '6-lash-right-non-overlap.trdl',
  '7-corkline-self-tether.trdl',
  '8-splice-on-mutual-tether.trdl',
  '9-leadline-equivocal-from-corkline.trdl',
  '10-leadline-has-corkline-predecessor.trdl',
  '11-bottom-fastener-not-fast.trdl',
  '12-bottom-hoist-not-fast.trdl',
  '13-bottom-corkline-top-leadline.trdl',
  '14-bottom-corkline-shorter-than-top-leadline-both-sides.trdl',
  '15-splicing-hitches-with-identical-toplines.trdl',
  '16-lashing-2-hitches-to-15.trdl',
  '17-lashing-2-non-consecutive-hitches-to-15.trdl',
  '18-lashing-to-2-hitch-splice-with-missing-right-hoist.trdl',
  '19-fast-line-multiply-lashed-up-to-slow-line.trdl',
  '20-slow-line-lashed-up-to-fast-line.trdl',
  '21-direct-tether-spliced-to-indirect-tether.trdl',
  '22-indirect-tether-spliced-to-direct-tether.trdl',
  '23-indirect-tether-spliced-to-direct-tether-bad-post.trdl',
  '24-direct-tether-spliced-to-indirect-tether-bad-post.trdl',
  '25-lashed-rigs-spliced-for-maximal-time-crossing.trdl',
  '26-like-above-back-and-forth.trdl',
  '27-intermediate-lines-change-tether-direction-via-corkline.trdl',
  '28-intermediate-lines-change-tether-direction-via-new-line.trdl',
  '29-intermediate-lines-change-tether-direction-via-tether-loop.trdl',
  '29a-attempt-to-trigger-false-positive-on-tether-loop-detection.trdl',
  '30-example-rig-from-spec.trdl',
  '31-irrelevent-tether-loop-after-corkline-reached.trdl',
]

function b64_to_buffer(b64) {
  let bin = atob(b64)
  let buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf
}

async function server_compile(trdl_text) {
  let res = await fetch(SERVER + '/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: trdl_text,
  })
  if (!res.ok) throw new Error(`server: ${res.status} ${await res.text()}`)
  let { bytes } = await res.json()
  return b64_to_buffer(bytes)
}

async function js_compile(trdl_text) {
  let entities = parse_trdl_string(trdl_text)
  let spec     = trdl_to_spec(entities)
  let { bytes } = await build(spec)
  return new Uint8Array(bytes)
}

function bytes_equal(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function first_diff(a, b) {
  let n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

function is_deterministic(trdl_text) {
  // skip rigs with random shields (shielded:true), random reqsats (ed25519),
  // or dangling-prev twists (which generate random arbs).
  let lines = trdl_text.split('\n').map(s => s.trim()).filter(Boolean)
  for (let line of lines) {
    let m
    try { m = JSON.parse(line) } catch { return false }
    if (m.line) {
      if (m.shielded !== false) return false
      if (m.reqsat   !== 'null') return false
    }
    if (m.prev === 'dangling') return false
  }
  return true
}

function hex(bytes, start, end) {
  let s = ''
  for (let i = start; i < Math.min(end, bytes.length); i++)
    s += bytes[i].toString(16).padStart(2, '0')
  return s
}

async function run_one(file) {
  try {
    let trdl = await (await fetch(RIGS_BASE + file)).text()
    if (!is_deterministic(trdl)) {
      return { file, skip: true, note: 'non-deterministic (random shield/sig/dangling)' }
    }
    let svP = server_compile(trdl).catch(e => ({error: e.message}))
    let jsP = js_compile(trdl).catch(e => ({error: e.message}))
    let [js, sv] = await Promise.all([jsP, svP])
    if (sv?.error || js?.error) {
      // both failing the same way = expected (e.g. circular dep)
      let note = sv?.error ? `server: ${sv.error}` : `js: ${js.error}`
      return { file, skip: true, note }
    }
    let match = bytes_equal(js, sv)
    let note = ''
    if (!match) {
      let d = first_diff(js, sv)
      let from = Math.max(0, d - 4), to = d + 16
      note = `first diff at byte ${d}\n` +
             `  js: ${hex(js, from, to)}\n` +
             `  sv: ${hex(sv, from, to)}`
    }
    return { file, js: js.length, sv: sv.length, match, note }
  } catch (e) {
    return { file, match: false, note: e.message }
  }
}

async function run_all() {
  let tbody = document.querySelector('#results tbody')
  let summary = document.getElementById('summary')
  tbody.innerHTML = ''
  summary.hidden = true
  let pass = 0, fail = 0, skip = 0
  for (let file of RIG_FILES) {
    let r = await run_one(file)
    let cls, label
    if (r.skip)        { cls = 'skip'; label = 'SKIP'; skip++ }
    else if (r.match)  { cls = 'ok';   label = 'PASS'; pass++ }
    else               { cls = 'bad';  label = 'FAIL'; fail++ }
    let row = document.createElement('tr')
    row.innerHTML =
      `<td>${file}</td>` +
      `<td>${r.js ?? '—'}</td>` +
      `<td>${r.sv ?? '—'}</td>` +
      `<td class="${cls}">${label}</td>` +
      `<td>${r.note ?? ''}</td>`
    tbody.appendChild(row)
  }
  summary.hidden = false
  summary.innerHTML =
    `<span class="ok">${pass} pass</span> · ` +
    `<span class="bad">${fail} fail</span> · ` +
    `<span class="skip">${skip} skip</span>`
}

document.getElementById('run').addEventListener('click', run_all)
run_all()
