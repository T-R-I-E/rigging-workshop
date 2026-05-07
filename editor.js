// Editor + UI wiring. Mounts CodeMirror 6 on #editor; recompiles automatically
// (debounced) on every doc change. Open/Load route by extension (.trdl into the
// editor, .toda decompiled and re-built).

import { EditorView, lineNumbers, keymap, Decoration } from "@codemirror/view"
import { StateField, StateEffect } from "@codemirror/state"
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands"
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language"
import { json } from "@codemirror/lang-json"
import { compile, decompile } from "./bridge.js"

const STARTER = `{"rig":"Example rig from spec"}
{"line":"poptop","twists":6,"shielded":false,"reqsat":"null"}
{"line":"a","twists":5,"shielded":false,"reqsat":"null"}
{"line":"b","twists":2,"shielded":false,"reqsat":"null"}
{"line":"c","twists":3,"shielded":false,"reqsat":"null"}
{"line":"d","twists":5,"shielded":false,"reqsat":"null"}
{"line":"e","twists":3,"shielded":false,"reqsat":"null"}
{"line":"f","twists":7,"shielded":false,"reqsat":"null"}
{"line":"abject","twists":6,"shielded":false,"reqsat":"null"}
{"hitch":"Pb1","lead":"abject[0]","meet":"abject[1]","fastener":"f[1]","hoist":"f[4]"}
{"hitch":"Pb2","lead":"abject[1]","meet":"abject[2]","fastener":"f[2]","hoist":"f[5]"}
{"hitch":"Pb3","lead":"abject[2]","meet":"abject[3]","fastener":"e[1]","hoist":"e[2]"}
{"hitch":"Pb4","lead":"abject[3]","meet":"abject[4]","fastener":"d[0]","hoist":"d[2]"}
{"hitch":"Pb5","lead":"abject[4]","meet":"abject[5]","fastener":"d[1]","hoist":"d[3]"}
{"hitch":"F1","lead":"f[0]","meet":"f[3]","fastener":"c[0]","hoist":"c[1]","post":"none"}
{"hitch":"F2","lead":"f[3]","meet":"f[6]","fastener":"b[0]","hoist":"b[1]"}
{"hitch":"C1","lead":"c[0]","meet":"c[2]","fastener":"poptop[1]","hoist":"poptop[3]"}
{"hitch":"D1","lead":"d[0]","meet":"d[4]","fastener":"a[1]","hoist":"a[3]"}
{"hitch":"B1","lead":"b[0]","meet":"b[1]","fastener":"poptop[0]","hoist":"poptop[4]"}
{"hitch":"E1","lead":"e[0]","meet":"e[2]","fastener":"a[0]","hoist":"a[2]"}
{"hitch":"A1","lead":"a[0]","meet":"a[4]","fastener":"poptop[2]","hoist":"poptop[5]"}`

let last_built_bytes = null
let line_hashes = []                         // entityIdx → [hash, ...]; from /compile

// --- highlight machinery -----------------------------------------------------
// Two independent decoration fields so a transient hover doesn't replace the
// persistent click-select. CodeMirror layers both into the same DOM line.

function decoration_field(set_effect, css_class) {
  return StateField.define({
    create() { return Decoration.none },
    update(deco, tr) {
      deco = deco.map(tr.changes)
      for (let e of tr.effects) if (e.is(set_effect)) {
        let lns = [...e.value].sort((a, b) => a - b)
        let ranges = []
        for (let n of lns) {
          if (n >= 1 && n <= tr.state.doc.lines) {
            let line = tr.state.doc.line(n)
            ranges.push(Decoration.line({ class: css_class }).range(line.from))
          }
        }
        deco = Decoration.set(ranges)
      }
      return deco
    },
    provide: f => EditorView.decorations.from(f),
  })
}

const set_hover  = StateEffect.define()  // payload: Set<lineNumber>
const set_select = StateEffect.define()  // payload: Set<lineNumber>
const hover_field  = decoration_field(set_hover,  'cm-hl-hover')
const select_field = decoration_field(set_select, 'cm-hl-select')

const cursor_broadcast = EditorView.updateListener.of(update => {
  if (update.docChanged) schedule_build()
  // Broadcast select ONLY on explicit cursor moves (click, arrow keys) — not
  // on typing-induced moves. Typing both moves the cursor and changes the
  // doc, and re-broadcasting on every keystroke would clobber whatever the
  // user click-selected in viz/hex with the typed-in cursor's line hashes.
  if (!update.selectionSet || update.docChanged) return
  let hashes = current_line_hashes()
  document.dispatchEvent(new CustomEvent('workshop:select', {
    detail: { hashes, source: 'editor' },
  }))
})

let build_timer = null
let build_seq   = 0
function schedule_build() {
  if (build_timer) clearTimeout(build_timer)
  build_timer = setTimeout(() => { build_timer = null; build() }, 300)
}

const view = new EditorView({
  doc: STARTER,
  parent: document.getElementById('editor'),
  extensions: [
    lineNumbers(),
    history(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    json(),
    hover_field,
    select_field,
    cursor_broadcast,
  ],
})

function current_line_hashes() {
  let cur = view.state.doc.lineAt(view.state.selection.main.head)
  if (cur.text.trim() === '') return []
  let i = 0
  for (let n = 1; n < cur.number; n++) {
    if (view.state.doc.line(n).text.trim() !== '') i++
  }
  return line_hashes[i] || []
}

function lines_for(target) {
  let lines = new Set()
  if (!target.size) return lines
  let n = 0
  let doc = view.state.doc
  for (let i = 1; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '') continue
    let hs = line_hashes[n] || []
    if (hs.some(h => target.has(h))) lines.add(i)
    n++
  }
  return lines
}

document.addEventListener('workshop:hover', e => {
  let target = new Set(e.detail.hashes || [])
  view.dispatch({ effects: set_hover.of(lines_for(target)) })
})

document.addEventListener('workshop:select', e => {
  if (e.detail.source === 'editor') return
  let target = new Set(e.detail.hashes || [])
  view.dispatch({ effects: set_select.of(lines_for(target)) })
})

// Hover dispatch: mousemove over the editor → broadcast that line's hashes.
// Mirrors the hex pane's hover semantics so cross-pane sync works the same
// way no matter which pane the cursor is in.
function hashes_at_coords(x, y) {
  let pos = view.posAtCoords({x, y}, false)
  if (pos == null) return []
  let line = view.state.doc.lineAt(pos)
  if (line.text.trim() === '') return []
  let n = 0
  for (let i = 1; i < line.number; i++) {
    if (view.state.doc.line(i).text.trim() !== '') n++
  }
  return line_hashes[n] || []
}

view.dom.addEventListener('mousemove', e => {
  let hashes = hashes_at_coords(e.clientX, e.clientY)
  document.dispatchEvent(new CustomEvent('workshop:hover', {
    detail: { hashes, source: 'editor' },
  }))
})

view.dom.addEventListener('mouseleave', () => {
  document.dispatchEvent(new CustomEvent('workshop:hover', {
    detail: { hashes: [], source: 'editor' },
  }))
})

function get_doc() { return view.state.doc.toString() }

function set_doc(text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  })
}

function escape_html(s) {
  return s.replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function set_rigcheck(klass, label, msg) {
  let rc = document.getElementById('rigcheck')
  rc.className = 'rig-check ' + klass
  rc.innerHTML = `<span class="badge">${label}</span><div>${escape_html(msg)}</div>`
}

async function build() {
  let my = ++build_seq
  try {
    let { bytes, lineHashes, corkline } = await compile(get_doc())
    if (my !== build_seq) return                // stale: a newer build is queued
    last_built_bytes = bytes
    line_hashes = lineHashes
    window.workshop.corkline = corkline         // read by app.js's rig-check
    window.workshop.render(bytes)
  } catch (e) {
    if (my !== build_seq) return
    set_rigcheck('bad', 'FAIL', `compile: ${e.message}`)
    console.error(e)
  }
}

async function load_bytes(buf) {
  // setting the doc fires the auto-build via the updateListener; render the
  // original bytes immediately for instant feedback while the rebuild runs.
  try {
    let text = await decompile(buf)
    set_doc(text)
    last_built_bytes = buf
    window.workshop.render(buf)
  } catch (e) {
    set_rigcheck('bad', 'FAIL', `decompile: ${e.message}`)
    console.error(e)
  }
}

function deselect_rig() {
  active_rig = null
  render_rigs_list()
  load_rig_meta(null)
}

async function load_file(file) {
  deselect_rig()
  if (file.name.toLowerCase().endsWith('.trdl')) {
    set_doc(await file.text())          // auto-build kicks in
  } else {
    await load_bytes(await file.arrayBuffer())
  }
}

async function load_url(url) {
  deselect_rig()
  try {
    let res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (url.toLowerCase().endsWith('.trdl')) {
      set_doc(await res.text())
    } else {
      await load_bytes(await res.arrayBuffer())
    }
  } catch (e) {
    set_rigcheck('bad', 'FAIL', `load: ${e.message}`)
  }
}

function download(data, name, mime) {
  let blob = new Blob([data], { type: mime })
  let a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

function save_trdl() {
  download(get_doc(), 'rig.trdl', 'application/json')
}

function save_toda() {
  if (!last_built_bytes) {
    set_rigcheck('warn', 'NOPE', 'build first')
    return
  }
  download(last_built_bytes, 'rig.toda', 'application/octet-stream')
}

document.getElementById('btn-save-trdl').addEventListener('click', save_trdl)
document.getElementById('btn-save-toda').addEventListener('click', save_toda)
document.getElementById('btn-open').addEventListener('click',
  () => document.getElementById('file-input').click())
document.getElementById('file-input').addEventListener('change', e => {
  let f = e.target.files[0]
  if (f) load_file(f)
})
document.getElementById('btn-load').addEventListener('click', () => {
  let url = document.getElementById('url-input').value.trim()
  if (url) load_url(url)
})
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-load').click()
})

// --- examples panel ---------------------------------------------------------

const RIGS_BASE = 'rigs/'
// Expected rig-check colour: green = pass, yellow = missing, red = fail.
// Authoritative source: todaclj/toda-clj-tests/test-suite/*.json (matches
// our shielded:false trdl rigs). complex_rigs.clj is the *shielded* form
// of these rigs and uses different colours, so it doesn't apply here.
// Rigs without a JSON in test-suite/ are still pattern-based guesses.
const RIGS = [
  ['1-splice-no-post.trdl',                                                       'green'],
  ['2-right-fast-first.trdl',                                                     'green'],
  ['3-normally-expected-splice.trdl',                                             'green'],
  ['4-lash-left-non-overlap-null.trdl',                                           'green'],
  ['5-lash-left-non-overlap-missing.trdl',                                        'yellow'],
  ['6-lash-right-non-overlap.trdl',                                               'green'],
  ['7-corkline-self-tether.trdl',                                                 'green'],
  ['8-splice-on-mutual-tether.trdl',                                              'green'],
  ['9-leadline-equivocal-from-corkline.trdl',                                     'red'],
  ['10-leadline-has-corkline-predecessor.trdl',                                   'green'],
  ['11-bottom-fastener-not-fast.trdl',                                            'red'],
  ['12-bottom-hoist-not-fast.trdl',                                               'red'],
  ['13-bottom-corkline-top-leadline.trdl',                                        'green'],
  ['14-bottom-corkline-shorter-than-top-leadline-both-sides.trdl',                'green'],
  ['15-splicing-hitches-with-identical-toplines.trdl',                            'green'],
  ['16-lashing-2-hitches-to-15.trdl',                                             'green'],
  ['17-lashing-2-non-consecutive-hitches-to-15.trdl',                             'green'],
  ['18-lashing-to-2-hitch-splice-with-missing-right-hoist.trdl',                  'yellow'],
  // 19, 20: spec graph is circular (interlocking lashings). Both the JS
  // compiler and the Clojure server reject these as "Circular dependency
  // in twist specs", so they never even reach rig-check.
  ['19-fast-line-multiply-lashed-up-to-slow-line.trdl',                           'yellow'],
  ['20-slow-line-lashed-up-to-fast-line.trdl',                                    'yellow'],
  ['21-direct-tether-spliced-to-indirect-tether.trdl',                            'green',  'complex-rig-21-direct-to-indirect-tether.json'],
  ['22-indirect-tether-spliced-to-direct-tether.trdl',                            'yellow', 'complex-rig-22-indirect-to-direct-tether.json'],
  ['23-indirect-tether-spliced-to-direct-tether-bad-post.trdl',                   'red'],
  ['24-direct-tether-spliced-to-indirect-tether-bad-post.trdl',                   'red'],
  ['25-lashed-rigs-spliced-for-maximal-time-crossing.trdl',                       'yellow', 'complex-rig-25-lashed-maximal-time-crossing.json'],
  ['26-like-above-back-and-forth.trdl',                                           'red',    'complex-rig-26-lashed-complex.json'],
  ['27-intermediate-lines-change-tether-direction-via-corkline.trdl',             'green'],
  ['28-intermediate-lines-change-tether-direction-via-new-line.trdl',             'green'],
  ['29-intermediate-lines-change-tether-direction-via-tether-loop.trdl',          'green'],
  ['29a-attempt-to-trigger-false-positive-on-tether-loop-detection.trdl',         'green'],
  ['30-example-rig-from-spec.trdl',                                               'green'],
  ['31-irrelevent-tether-loop-after-corkline-reached.trdl',                       'green'],
]

let active_rig = null
function render_rigs_list() {
  let host = document.getElementById('rigs-list')
  if (!host) return
  host.innerHTML = RIGS.map(([f, colour]) => {
    let label = f.replace(/\.trdl$/, '').replace(/^(\d+a?)-/, '$1 · ')
    let active = f === active_rig ? ' active' : ''
    return `<div class="rig-item${active}" data-file="${f}">` +
           `<span class="rig-dot ${colour}"></span>${label}</div>`
  }).join('')
}

const TEST_SUITE_BASE = 'test-suite/'

function truncate_hash(h, head=10, tail=8) {
  if (!h || h.length <= head + tail + 1) return h
  return h.slice(0, head) + '…' + h.slice(-tail)
}

async function load_rig_meta(json_file) {
  let host = document.getElementById('rig-meta')
  if (!host) return
  if (!json_file) { host.hidden = true; host.innerHTML = ''; return }
  try {
    let res = await fetch(TEST_SUITE_BASE + json_file)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    let m = await res.json()
    let parts = []
    if (m.moniker)  parts.push(`<span class="rm-moniker">${escape_html(m.moniker)}</span>`)
    if (m.colour)   parts.push(`<span class="rm-colour ${escape_html(m.colour)}">${escape_html(m.colour)}</span>`)
    if (m.corkline) parts.push(`<span class="rm-cork" title="${escape_html(m.corkline)}">cork: ${escape_html(truncate_hash(m.corkline))}</span>`)
    if (m.issue)    parts.push(`<span class="rm-issue">issue: ${escape_html(m.issue)}</span>`)
    host.innerHTML = parts.join('')
    host.hidden = parts.length === 0
  } catch {
    host.hidden = true
    host.innerHTML = ''
  }
}

document.getElementById('rigs-list')?.addEventListener('click', async e => {
  let item = e.target.closest('.rig-item')
  if (!item) return
  let file = item.dataset.file
  active_rig = file
  render_rigs_list()
  let entry = RIGS.find(r => r[0] === file)
  load_rig_meta(entry?.[2])                     // hides if no JSON for this rig
  try {
    let res = await fetch(RIGS_BASE + file)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    set_doc(await res.text())                   // auto-build picks it up
  } catch (err) {
    set_rigcheck('bad', 'FAIL', `load ${file}: ${err.message}`)
  }
})

render_rigs_list()
schedule_build()                                // initial build of the starter doc
