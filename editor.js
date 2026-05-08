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
  clear_rig_meta()
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

// Each entry: [trdl_url, colour, json_url?]. trdl_url is relative to the
// workshop root. json_url override is rare; the loader otherwise falls back
// to the sibling .json (same path, .trdl → .json) — so anything under
// tests/<subdir>/ that ships a paired descriptor lights up automatically.
//
// Workshop rigs (rigs/*.trdl) are the unshielded twist-maker examples and
// have no canonical .json in the codebase; their colours are heuristic
// guesses. Test rigs (tests/<subdir>/*.trdl) come paired with a .json that
// declares the canonical expected colour.
const RIGS = [
  ['rigs/1-splice-no-post.trdl',                                                       'green'],
  ['rigs/2-right-fast-first.trdl',                                                     'green'],
  ['rigs/3-normally-expected-splice.trdl',                                             'green'],
  ['rigs/4-lash-left-non-overlap-null.trdl',                                           'green'],
  ['rigs/5-lash-left-non-overlap-missing.trdl',                                        'yellow'],
  ['rigs/6-lash-right-non-overlap.trdl',                                               'green'],
  ['rigs/7-corkline-self-tether.trdl',                                                 'green'],
  ['rigs/8-splice-on-mutual-tether.trdl',                                              'green'],
  ['rigs/9-leadline-equivocal-from-corkline.trdl',                                     'red'],
  ['rigs/10-leadline-has-corkline-predecessor.trdl',                                   'green'],
  ['rigs/11-bottom-fastener-not-fast.trdl',                                            'red'],
  ['rigs/12-bottom-hoist-not-fast.trdl',                                               'red'],
  ['rigs/13-bottom-corkline-top-leadline.trdl',                                        'green'],
  ['rigs/14-bottom-corkline-shorter-than-top-leadline-both-sides.trdl',                'green'],
  ['rigs/15-splicing-hitches-with-identical-toplines.trdl',                            'green'],
  ['rigs/16-lashing-2-hitches-to-15.trdl',                                             'green'],
  ['rigs/17-lashing-2-non-consecutive-hitches-to-15.trdl',                             'green'],
  ['rigs/18-lashing-to-2-hitch-splice-with-missing-right-hoist.trdl',                  'yellow'],
  // 19, 20: spec graph is circular (interlocking lashings). Both the JS
  // compiler and the Clojure server reject these as "Circular dependency
  // in twist specs", so they never even reach rig-check.
  ['rigs/19-fast-line-multiply-lashed-up-to-slow-line.trdl',                           'yellow'],
  ['rigs/20-slow-line-lashed-up-to-fast-line.trdl',                                    'yellow'],
  ['rigs/21-direct-tether-spliced-to-indirect-tether.trdl',                            'green'],
  ['rigs/22-indirect-tether-spliced-to-direct-tether.trdl',                            'yellow'],
  ['rigs/23-indirect-tether-spliced-to-direct-tether-bad-post.trdl',                   'red'],
  ['rigs/24-direct-tether-spliced-to-indirect-tether-bad-post.trdl',                   'red'],
  ['rigs/25-lashed-rigs-spliced-for-maximal-time-crossing.trdl',                       'yellow'],
  ['rigs/26-like-above-back-and-forth.trdl',                                           'red'],
  ['rigs/27-intermediate-lines-change-tether-direction-via-corkline.trdl',             'green'],
  ['rigs/28-intermediate-lines-change-tether-direction-via-new-line.trdl',             'green'],
  ['rigs/29-intermediate-lines-change-tether-direction-via-tether-loop.trdl',          'green'],
  ['rigs/29a-attempt-to-trigger-false-positive-on-tether-loop-detection.trdl',         'green'],
  ['rigs/30-example-rig-from-spec.trdl',                                               'green'],
  ['rigs/31-irrelevent-tether-loop-after-corkline-reached.trdl',                       'green'],

  ['tests/test-suite/complex-rig-21-direct-to-indirect-tether.trdl',                   'green'],
  ['tests/test-suite/complex-rig-22-indirect-to-direct-tether.trdl',                   'yellow'],
  ['tests/test-suite/complex-rig-25-lashed-maximal-time-crossing.trdl',                'yellow'],
  ['tests/test-suite/complex-rig-26-lashed-complex.trdl',                              'red'],
  ['tests/test-suite/half-hitch-invalid-lead-not-tethered.trdl',                       'red'],
  ['tests/test-suite/half-hitch-invalid-meet-not-fast.trdl',                           'red'],
  ['tests/test-suite/half-hitch-valid-null-shield.trdl',                               'red'],
  ['tests/test-suite/half-hitch-valid-with-shield.trdl',                               'red'],

  ['tests/toda-rig-checker/api-valid-lashed-rig.trdl',                                 'yellow'],
  ['tests/toda-rig-checker/half-hitch-footline-reaches-null.trdl',                     'red'],
  ['tests/toda-rig-checker/half-hitch-lead-mismatch.trdl',                             'red'],
  ['tests/toda-rig-checker/half-hitch-lead-not-fast.trdl',                             'red'],
  ['tests/toda-rig-checker/half-hitch-meet-not-fast.trdl',                             'red'],
  ['tests/toda-rig-checker/half-hitch-topline-fastener-not-found.trdl',                'red'],
  ['tests/toda-rig-checker/half-hitch-valid.trdl',                                     'red'],
  ['tests/toda-rig-checker/hitch-lead-footline-reaches-null.trdl',                     'red'],
  ['tests/toda-rig-checker/hitch-post-footline-reaches-null.trdl',                     'red'],
  ['tests/toda-rig-checker/hitch-post-not-fast.trdl',                                  'red'],
  ['tests/toda-rig-checker/hitch-valid.trdl',                                          'red'],
  ['tests/toda-rig-checker/rigging-corkline-incomplete-early.trdl',                    'green'],
  ['tests/toda-rig-checker/rigging-corkline-incomplete-late.trdl',                     'red'],
  ['tests/toda-rig-checker/rigging-lash-non-colinear.trdl',                            'green'],
  ['tests/toda-rig-checker/rigging-valid-lash-and-splice.trdl',                        'red'],
  ['tests/toda-rig-checker/rigging-valid-simple-lash.trdl',                            'red'],
  ['tests/toda-rig-checker/rigging-valid-spliced-unit-rigs.trdl',                      'green'],
  ['tests/toda-rig-checker/rigging-valid-unit-rig.trdl',                               'red'],

  ['tests/toda-graph/basic-half-hitch.trdl',                                           'green'],
  ['tests/toda-graph/extra-fast-between-meet-and-post.trdl',                           'yellow'],
  ['tests/toda-graph/full-hitch-with-post.trdl',                                       'red'],
  ['tests/toda-graph/multi-level-rig.trdl',                                            'yellow'],
  ['tests/toda-graph/three-hitches-horizontal.trdl',                                   'green'],
  ['tests/toda-graph/three-hitches-vertical.trdl',                                     'green'],

  ['tests/toda-abject/delegation-chain-4-level.trdl',                                  'green'],

  ['tests/toda-core/twist-chain-with-fields.trdl',                                     'green'],
  ['tests/toda-core/twist-isolation-multi-line.trdl',                                  'green'],

  // todatests/rigging — pre-compiled .toda + .json pairs (no .trdl source).
  // Loading these goes through decompile to populate the editor.
  ['todatests/rigging/complex_bad_hoist_direct_to_indirect.toda',                      'red'],
  ['todatests/rigging/complex_bad_hoist_indirect_to_direct.toda',                      'red'],
  ['todatests/rigging/complex_direct_to_indirect_splice.toda',                         'green'],
  ['todatests/rigging/complex_indirect_to_direct_splice.toda',                         'green'],
  ['todatests/rigging/complex_maximal_time_crossing.toda',                             'green'],
  ['todatests/rigging/complex_maximal_time_crossing_complex.toda',                     'green'],
  ['todatests/rigging/complex_tether_direction_change.toda',                           'green'],
  ['todatests/rigging/cork_missing_rigging.toda',                                      'yellow'],
  ['todatests/rigging/cork_prev_invalid_green.toda',                                   'green'],
  ['todatests/rigging/cork_prev_invalid_red.toda',                                     'red'],
  ['todatests/rigging/cork_reqsat_fail.toda',                                          'red'],
  ['todatests/rigging/corkline_incomplete_early_red.toda',                             'red'],
  ['todatests/rigging/corkline_incomplete_early_yellow.toda',                          'yellow'],
  ['todatests/rigging/corkline_incomplete_late.toda',                                  'red'],
  ['todatests/rigging/hh_corkline_twist_missing.toda',                                 'red'],
  ['todatests/rigging/hh_footline_prev_gap.toda',                                      'red'],
  ['todatests/rigging/hh_mismatched_s_ss_values.toda',                                 'red'],
  ['todatests/rigging/hh_no_s_lead.toda',                                              'red'],
  ['todatests/rigging/hh_no_ss_lead.toda',                                             'red'],
  ['todatests/rigging/hh_non_fast_meet.toda',                                          'red'],
  ['todatests/rigging/hh_self_referential_rig.toda',                                   'red'],
  ['todatests/rigging/hh_tether_missing.toda',                                         'yellow'],
  ['todatests/rigging/hh_tether_not_twist.toda',                                       'red'],
  ['todatests/rigging/hh_tether_null.toda',                                            'red'],
  ['todatests/rigging/hh_tether_symbol.toda',                                          'red'],
  ['todatests/rigging/hh_valid_lead_root.toda',                                        'green'],
  ['todatests/rigging/hh_valid_self_ref_subsequent_valid.toda',                        'green'],
  ['todatests/rigging/hh_valid_shield_non_null.toda',                                  'green'],
  ['todatests/rigging/hh_valid_shield_null.toda',                                      'green'],
  ['todatests/rigging/hh_wrong_hoist_values.toda',                                     'red'],
  ['todatests/rigging/hh_wrong_shield.toda',                                           'red'],
  ['todatests/rigging/hitch_hoist_rigs_missing.toda',                                  'yellow'],
  ['todatests/rigging/hitch_meet_tether_null.toda',                                    'red'],
  ['todatests/rigging/hitch_splice_post_no_lead_entry.toda',                           'red'],
  ['todatests/rigging/hitch_splice_post_wrong_hoist.toda',                             'red'],
  ['todatests/rigging/hitch_valid_basic_splice.toda',                                  'green'],
  ['todatests/rigging/invalid_rigging_green.toda',                                     'green'],
  ['todatests/rigging/invalid_shielding_green.toda',                                   'green'],
  ['todatests/rigging/lash_succession_missing_prev.toda',                              'yellow'],
  ['todatests/rigging/lash_succession_no_fast_twist.toda',                             'red'],
  ['todatests/rigging/lash_succession_reqsat_fail.toda',                               'red'],
  ['todatests/rigging/lashed_non_colinear.toda',                                       'red'],
  ['todatests/rigging/meets_do_not_match.toda',                                        'red'],
  ['todatests/rigging/missing_rigging.toda',                                           'yellow'],
  ['todatests/rigging/missing_shield.toda',                                            'yellow'],
  ['todatests/rigging/multiple_hoists_green.toda',                                     'green'],
  ['todatests/rigging/post_rigging_missing_post_key.toda',                             'red'],
  ['todatests/rigging/self_referential.toda',                                          'red'],
  ['todatests/rigging/simple_lash_f1.toda',                                            'green'],
  ['todatests/rigging/simple_lash_f2.toda',                                            'green'],
  ['todatests/rigging/simple_last.toda',                                               'green'],
  ['todatests/rigging/splice_mismatch.toda',                                           'red'],
  ['todatests/rigging/unit_rig.toda',                                                  'green'],
  ['todatests/rigging/unit_rig_multi.toda',                                            'green'],
  ['todatests/rigging/valid_kiwano.toda',                                              'green'],
  ['todatests/rigging/valid_kiwano_0.toda',                                            'green'],
  ['todatests/rigging/valid_kiwano_1.toda',                                            'green'],
  ['todatests/rigging/valid_kiwano_f1.toda',                                           'green'],
  ['todatests/rigging/valid_kiwano_f2.toda',                                           'green'],
  ['todatests/rigging/valid_kiwano_f5.toda',                                           'green'],
]

function group_label(path) {
  if (path.startsWith('rigs/'))      return 'workshop'
  if (path.startsWith('todatests/')) {
    let m = path.match(/^todatests\/([^/]+)/)
    return m ? `todatests/${m[1]}` : 'todatests'
  }
  let m = path.match(/^tests\/([^/]+)/)
  return m ? m[1] : 'other'
}

function rig_label(path) {
  let basename = path.replace(/^.*\//, '').replace(/\.(trdl|toda)$/, '')
  return basename.replace(/^(\d+a?)-/, '$1 · ')
}

let active_rig = null
function render_rigs_list() {
  let host = document.getElementById('rigs-list')
  if (!host) return
  let last_group = null
  let html = ''
  for (let entry of RIGS) {
    let [path, colour] = entry
    let g = group_label(path)
    if (g !== last_group) {
      html += `<div class="rig-group">${escape_html(g)}</div>`
      last_group = g
    }
    let label  = rig_label(path)
    let active = path === active_rig ? ' active' : ''
    html += `<div class="rig-item${active}" data-file="${escape_html(path)}">` +
            `<span class="rig-dot ${colour}"></span>${label}</div>`
  }
  host.innerHTML = html
}

function truncate_hash(h, head=10, tail=8) {
  if (!h || h.length <= head + tail + 1) return h
  return h.slice(0, head) + '…' + h.slice(-tail)
}

function clear_rig_meta() {
  let section = document.getElementById('rig-meta-section')
  if (section) section.hidden = true
}

async function load_rig_meta(rig_url, explicit_json_url) {
  let section = document.getElementById('rig-meta-section')
  let header  = document.getElementById('rig-meta-filename')
  let host    = document.getElementById('rig-meta')
  if (!section || !host) return
  let json_url = explicit_json_url || rig_url?.replace(/\.(trdl|toda)$/, '.json')
  if (!json_url) { section.hidden = true; return }
  try {
    let res = await fetch(json_url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    let m = await res.json()
    let parts = []
    if (m.moniker)  parts.push(`<span class="rm-moniker">${escape_html(m.moniker)}</span>`)
    if (m.colour)   parts.push(`<span class="rm-colour ${escape_html(m.colour)}">${escape_html(m.colour)}</span>`)
    if (m.corkline) parts.push(`<span class="rm-cork" title="${escape_html(m.corkline)}">cork: ${escape_html(truncate_hash(m.corkline))}</span>`)
    if (m.issue)    parts.push(`<span class="rm-issue">issue: ${escape_html(m.issue)}</span>`)
    if (header) header.textContent = json_url.replace(/^.*\//, '')
    host.innerHTML = parts.join('')
    section.hidden = parts.length === 0
    // Use the JSON's canonical corkline when available — for .toda loads
    // (todatests/rigging) the immediate render runs before the decompile
    // → recompile cycle finishes, and without this the rig-check panel
    // shows "No corkline available". For .trdl loads the auto-build also
    // sets workshop.corkline, but they should agree round-trip.
    if (m.corkline) window.workshop.corkline = m.corkline
  } catch {
    section.hidden = true
  }
}

async function load_rig(path) {
  active_rig = path
  render_rigs_list()
  let entry = RIGS.find(r => r[0] === path)
  // Await the meta fetch so that workshop.corkline is set from the canonical
  // JSON before load_bytes triggers an immediate render — otherwise the
  // .toda rig-check fires with no corkline yet.
  await load_rig_meta(path, entry?.[2])
  try {
    let res = await fetch(path)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (path.toLowerCase().endsWith('.trdl')) {
      set_doc(await res.text())                 // auto-build picks it up
    } else {
      await load_bytes(await res.arrayBuffer()) // .toda → decompile path
    }
  } catch (err) {
    set_rigcheck('bad', 'FAIL', `load ${path}: ${err.message}`)
  }
}

let rigs_list_el = document.getElementById('rigs-list')
if (rigs_list_el) rigs_list_el.tabIndex = 0      // focusable so it can take key events

rigs_list_el?.addEventListener('click', async e => {
  let item = e.target.closest('.rig-item')
  if (!item) return
  load_rig(item.dataset.file)
})

rigs_list_el?.addEventListener('keydown', e => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  let items = [...rigs_list_el.querySelectorAll('.rig-item')]
  if (!items.length) return
  let cur = items.findIndex(i => i.dataset.file === active_rig)
  let next
  if      (e.key === 'ArrowDown') next = cur < 0 ? 0 : Math.min(items.length - 1, cur + 1)
  else if (e.key === 'ArrowUp')   next = cur < 0 ? items.length - 1 : Math.max(0, cur - 1)
  else if (e.key === 'Home')      next = 0
  else if (e.key === 'End')       next = items.length - 1
  let target = items[next]
  target.scrollIntoView({ block: 'nearest' })
  load_rig(target.dataset.file)
})

render_rigs_list()
schedule_build()                                // initial build of the starter doc
