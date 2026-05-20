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
const set_issue  = StateEffect.define()  // payload: Set<lineNumber>
const hover_field  = decoration_field(set_hover,  'cm-hl-hover')
const select_field = decoration_field(set_select, 'cm-hl-select')
const issue_field  = decoration_field(set_issue,  'cm-hl-issue')

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
    issue_field,
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

// Highlight TRDL lines whose entity emits any twist the rust checker
// flagged. Same lines_for() lookup the hover/select machinery already
// uses — issue is just a separate decoration layer so it can coexist
// with click-selection and hover. Cache the last payload so build()
// can re-apply after line_hashes lands; rust fires its issue event
// during the initial render (synchronous), which happens ~300ms
// before the debounced auto-build populates line_hashes.
let _last_issue_hashes = new Set()
document.addEventListener('workshop:issue', e => {
  let issues = e.detail?.issues || []
  // Editor only highlights non-green failures — green leaves are
  // structural confirmations rust gives along the way; surfacing
  // them in the TRDL pane would be noise.
  _last_issue_hashes = new Set(
    issues.filter(i => i.colour !== 'green').map(i => i.hash)
  )
  view.dispatch({ effects: set_issue.of(lines_for(_last_issue_hashes)) })
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

// Workshop-level status (compile / load failures, idle). When the panel
// is already showing per-checker rows (rig-check-list mode), the status
// is rendered as a banner above them rather than replacing them — so an
// edit-time compile error doesn't wipe out the prior pass's results,
// which is the user-visible "flash". When the panel hasn't rendered any
// per-checker rows yet (initial load, fresh editor) we fall back to the
// original single full-width row.
// Update the rig-check panel's section header. Called from each load path
// so the user can see which example is currently being checked. Truncated
// to keep the header from wrapping; full label available on hover.
function set_loaded_label(label) {
  let titleEl = document.querySelector('#rig-check-section .section-title')
  if (!titleEl) return
  if (!label) { titleEl.textContent = 'Rig check'; titleEl.removeAttribute('title'); return }
  const MAX = 30
  let shown = label.length > MAX ? label.slice(0, MAX - 1) + '…' : label
  titleEl.textContent = `Rig check for ${shown}`
  titleEl.title = label
}

function set_rigcheck(klass, label, msg) {
  let rc = document.getElementById('rigcheck')
  if (rc.classList.contains('rig-check-list')) {
    let existing = rc.querySelector('[data-section="workshop-status"]')
    if (existing) existing.remove()
    // Insert at the end so the workshop status always sits visually
    // *after* the per-checker rows, regardless of whether the initial
    // pass has finished rendering. The user reads the rig-check results
    // first; the compile/render error is secondary context below them.
    rc.insertAdjacentHTML('beforeend',
      `<div class="rig-check ${klass}" data-section="workshop-status">` +
      `<span class="badge">${label}</span>` +
      `<div>${escape_html(msg)}</div></div>`)
    return
  }
  rc.className = 'rig-check ' + klass
  rc.innerHTML = `<span class="badge">${label}</span><div>${escape_html(msg)}</div>`
}

async function build() {
  let my = ++build_seq
  let bytes, lineHashes, corkline
  try {
    ({ bytes, lineHashes, corkline } = await compile(get_doc()))
  } catch (e) {
    if (my !== build_seq) return
    set_rigcheck('bad', 'TRDL COMPILE ERROR', e.message)
    console.error(e)
    return
  }
  if (my !== build_seq) return                  // stale: a newer build is queued
  last_built_bytes = bytes
  line_hashes = lineHashes
  // line_hashes is what lines_for() consults to translate twist hashes
  // back to editor line numbers. If a workshop:issue event came in
  // before the build finished (rust fires its event during the synch
  // viz render, ~300ms ahead of this debounced compile), the lines_for
  // lookup found nothing and the editor stayed unpainted. Now that
  // line_hashes is current, re-apply.
  if (_last_issue_hashes.size) {
    view.dispatch({ effects: set_issue.of(lines_for(_last_issue_hashes)) })
  }
  // .toda load lifecycle: load_bytes ran decompile and stashed the resulting
  // TRDL text on initial_toda_load.decompile_text. If the editor still shows
  // exactly that text, the user hasn't edited — the build that fired here is
  // the auto-build triggered by load_bytes's set_doc(text). Re-rendering with
  // the recompiled bytes would replace viz/hex/rig-check with a lossy
  // reconstruction of what the user just loaded (v1 decompile loses shield
  // bytes, regenerates random shields, etc.). Skip the render and leave the
  // canonical .json corkline alone. Once the user actually edits the TRDL,
  // get_doc() will differ from decompile_text and rendering resumes.
  let init = window.workshop?.initial_toda_load
  if (init && init.decompile_text != null && get_doc() === init.decompile_text) {
    return
  }
  // Don't overwrite a sidecar-supplied corkline with compile's idea —
  // sidecar is the authoritative source. Auto-default (top-left twist,
  // applied by app.js's notify_rendered) is also preserved across
  // rebuilds, since the same TRDL keeps producing the same top-left.
  if (corkline && window.workshop.corkline_source !== 'sidecar') {
    window.workshop.corkline = corkline
    window.workshop.corkline_source = 'compile'
  }
  try {
    window.workshop.render(bytes)
  } catch (e) {
    set_rigcheck('bad', 'RENDER ERROR', e.message)
    console.error(e)
  }
}

async function load_bytes(buf) {
  // Fail-fast: detect abjects and oversized files BEFORE running decompile,
  // the visualizer, or the hex dump. The workshop is for single test rigs;
  // abjects and big files belong in abject-workshop (see abject-workshop.md).
  // Even a multi-MB abject should bail in milliseconds — Atoms.fromBytes plus
  // one Line walk is the only work done here.
  let bytes = new Uint8Array(buf)
  let check = window.workshop.check_supported(bytes)
  if (check.bailReason) {
    window.workshop.initial_toda_load = null
    window.workshop.render_unsupported(check.bailReason)
    return
  }
  // setting the doc fires the auto-build via the updateListener; render the
  // original bytes immediately for instant feedback while the rebuild runs.
  // Also pin this as the "initial toda load" so the rig-check panel can
  // detect lossy decompile→recompile round-trips: if the recompile produces
  // different bytes, we want to surface that rather than overwriting the
  // first-pass rig-check results.
  try {
    // window.workshop.corkline was just set by load_rig_meta (when the
    // sidecar carries a corkline hash). Pass it as a hint to decompile
    // so the corkline-line identification doesn't fall back to the
    // heuristic on rigs with non-canonical poptop topologies.
    let text = await decompile(buf, window.workshop?.corkline || null)
    window.workshop.initial_toda_load = {
      bytes,
      rig_id:  active_rig,
      results: new Map(),       // checker_id → {state, badge, detail}
      workshop_check: check,    // reuse fail-fast result; show_abject_info caches off this
      decompile_text: text,     // baseline for "has the user edited?" check in build()
    }
    set_doc(text)
    last_built_bytes = buf
    window.workshop.render(buf)
  } catch (e) {
    window.workshop.initial_toda_load = null
    set_rigcheck('bad', 'DECOMPILE ERROR', e.message)
    console.error(e)
  }
}

function deselect_rig() {
  active_rig = null
  render_rigs_list()
  clear_rig_meta()
  window.workshop.initial_toda_load = null
  // Drop any sidecar-derived corkline from the previously-loaded rig.
  // For upload/URL loads (no sidecar), app.js's notify_rendered will
  // default it to the top-leftmost twist after the viz lays out.
  window.workshop.corkline = null
  window.workshop.corkline_source = null
}

async function load_file(file) {
  deselect_rig()
  set_loaded_label(file.name)
  if (file.name.toLowerCase().endsWith('.trdl')) {
    set_doc(await file.text())          // auto-build kicks in
  } else {
    await load_bytes(await file.arrayBuffer())
  }
}

async function load_url(url) {
  deselect_rig()
  set_loaded_label(url.split('/').pop() || url)
  try {
    let res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (url.toLowerCase().endsWith('.trdl')) {
      set_doc(await res.text())
    } else {
      await load_bytes(await res.arrayBuffer())
    }
  } catch (e) {
    set_rigcheck('bad', 'LOAD ERROR', e.message)
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

// Each entry is a path relative to the workshop root. The loader fetches
// the sibling .json sidecar (same path, .toda → .json or .trdl → .json)
// for moniker / corkline / canonical colour. Dot colours render after the
// list is built, via update_dot_colours() fanning out to all sidecars.
//
// Workshop rigs that used to live as bare rigs/*.trdl (with no sidecar)
// are imported into todatests/rigging/ as .toda + .json pairs. Open those
// — decompile populates the editor with the reconstructed TRDL, which
// can then be edited and recompiled.
const RIGS = [
  // todatests/rigging + todatests/reqsat/ed25519-rigs — pre-compiled
  // .toda + .json pairs. Loading these goes through decompile.
  // Colour reflects the sibling .json sidecar.
  ['todatests/reqsat/ed25519-rigs/ed25519-req-val-non-arb.toda',                        'red'],
  ['todatests/reqsat/ed25519-rigs/ed25519-sat-atom-missing.toda',                       'yellow'],
  ['todatests/reqsat/ed25519-rigs/ed25519-sat-val-non-arb.toda',                        'red'],
  ['todatests/reqsat/ed25519-rigs/ed25519-signature-not-verifying.toda',                'red'],
  ['todatests/reqsat/ed25519-rigs/ed25519-valid.toda',                                  'green'],
  ['todatests/reqsat/ed25519-rigs/twist-chain-with-fields.toda',                        'green'],
  ['todatests/reqsat/ed25519-rigs/twist-isolation-multi-line.toda',                     'green'],
  ['todatests/rigging/1-splice-no-post.toda',                                           'green'],
  ['todatests/rigging/11-bottom-fastener-not-fast.toda',                                'green'],
  ['todatests/rigging/12-bottom-hoist-not-fast.toda',                                   'green'],
  ['todatests/rigging/13-bottom-corkline-top-leadline.toda',                            'green'],
  ['todatests/rigging/14-bottom-corkline-shorter-than-top-leadline-both-sides.toda',    'green'],
  ['todatests/rigging/15-splicing-hitches-with-identical-toplines.toda',                'green'],
  ['todatests/rigging/17-lashing-2-non-consecutive-hitches-to-15.toda',                 'green'],
  ['todatests/rigging/18-lashing-to-2-hitch-splice-with-missing-right-hoist.toda',      'yellow'],
  ['todatests/rigging/2-right-fast-first.toda',                                         'green'],
  ['todatests/rigging/21-direct-tether-spliced-to-indirect-tether.toda',                'green'],
  ['todatests/rigging/22-indirect-tether-spliced-to-direct-tether.toda',                'green'],
  ['todatests/rigging/23-indirect-tether-spliced-to-direct-tether-bad-post.toda',       'green'],
  ['todatests/rigging/24-direct-tether-spliced-to-indirect-tether-bad-post.toda',       'green'],
  ['todatests/rigging/25-lashed-rigs-spliced-for-maximal-time-crossing.toda',           'green'],
  ['todatests/rigging/26-like-above-back-and-forth.toda',                               'yellow'],
  ['todatests/rigging/27-intermediate-lines-change-tether-direction-via-corkline.toda', 'green'],
  ['todatests/rigging/28-intermediate-lines-change-tether-direction-via-new-line.toda', 'green'],
  ['todatests/rigging/29a-attempt-to-trigger-false-positive-on-tether-loop-detection.toda', 'green'],
  ['todatests/rigging/3-normally-expected-splice.toda',                                 'green'],
  ['todatests/rigging/31-irrelevent-tether-loop-after-corkline-reached.toda',           'yellow'],
  ['todatests/rigging/4-lash-left-non-overlap-null.toda',                               'green'],
  ['todatests/rigging/5-lash-left-non-overlap-missing.toda',                            'green'],
  ['todatests/rigging/6-lash-right-non-overlap.toda',                                   'yellow'],
  ['todatests/rigging/7-corkline-self-tether.toda',                                     'yellow'],
  ['todatests/rigging/8-splice-on-mutual-tether.toda',                                  'yellow'],
  ['todatests/rigging/9-leadline-equivocal-from-corkline.toda',                         'red'],
  ['todatests/rigging/api-valid-lashed-rig.toda',                                       'green'],
  ['todatests/rigging/basic-half-hitch.toda',                                           'green'],
  ['todatests/rigging/body-carg-shape-arb.toda',                                        'green'],
  ['todatests/rigging/body-carg-shape-body.toda',                                       'green'],
  ['todatests/rigging/body-carg-shape-twist.toda',                                      'green'],
  ['todatests/rigging/body-reqs-shape-arb.toda',                                        'red'],
  ['todatests/rigging/body-reqs-shape-hashes.toda',                                     'red'],
  ['todatests/rigging/body-reqs-shape-twist.toda',                                      'red'],
  ['todatests/rigging/body-rigs-shape-arb-on-hoist.toda',                               'red'],
  ['todatests/rigging/body-rigs-shape-hashes-on-hoist.toda',                            'red'],
  ['todatests/rigging/body-rigs-shape-twist-on-hoist.toda',                             'red'],
  ['todatests/rigging/body-shld-shape-body.toda',                                       'red'],
  ['todatests/rigging/body-shld-shape-pairtrie.toda',                                   'red'],
  ['todatests/rigging/body-shld-shape-twist.toda',                                      'red'],
  ['todatests/rigging/complex_bad_hoist_direct_to_indirect.toda',                       'red'],
  ['todatests/rigging/complex_bad_hoist_indirect_to_direct.toda',                       'red'],
  ['todatests/rigging/complex_direct_to_indirect_splice.toda',                          'green'],
  ['todatests/rigging/complex_indirect_to_direct_splice.toda',                          'green'],
  ['todatests/rigging/complex_maximal_time_crossing.toda',                              'green'],
  ['todatests/rigging/complex_maximal_time_crossing_complex.toda',                      'green'],
  ['todatests/rigging/complex_tether_direction_change.toda',                            'green'],
  ['todatests/rigging/conflicting_successors.toda',                                     'red'],
  ['todatests/rigging/cork_missing_rigging.toda',                                       'yellow'],
  ['todatests/rigging/cork_prev_invalid_green.toda',                                    'green'],
  ['todatests/rigging/cork_prev_invalid_red.toda',                                      'yellow'],
  ['todatests/rigging/cork_reqsat_fail.toda',                                           'green'],
  ['todatests/rigging/corkline_incomplete_early_red.toda',                              'red'],
  ['todatests/rigging/corkline_incomplete_late.toda',                                   'yellow'],
  ['todatests/rigging/example_rig_from_spec.toda',                                      'green'],
  ['todatests/rigging/extra-fast-between-meet-and-post.toda',                           'red'],
  ['todatests/rigging/full-hitch-with-post.toda',                                       'yellow'],
  ['todatests/rigging/half-hitch-footline-reaches-null.toda',                           'yellow'],
  ['todatests/rigging/half-hitch-lead-mismatch.toda',                                   'green'],
  ['todatests/rigging/half-hitch-lead-not-fast.toda',                                   'green'],
  ['todatests/rigging/half-hitch-meet-not-fast.toda',                                   'green'],
  ['todatests/rigging/half-hitch-topline-fastener-not-found.toda',                      'green'],
  ['todatests/rigging/half-hitch-valid.toda',                                           'green'],
  ['todatests/rigging/hh_corkline_twist_missing.toda',                                  'yellow'],
  ['todatests/rigging/hh_footline_prev_gap.toda',                                       'red'],
  ['todatests/rigging/hh_mismatched_s_ss_values.toda',                                  'red'],
  ['todatests/rigging/hh_no_s_lead.toda',                                               'yellow'],
  ['todatests/rigging/hh_no_ss_lead.toda',                                              'yellow'],
  ['todatests/rigging/hh_non_fast_meet.toda',                                           'red'],
  ['todatests/rigging/hh_self_referential_rig.toda',                                    'red'],
  ['todatests/rigging/hh_tether_missing.toda',                                          'yellow'],
  ['todatests/rigging/hh_tether_not_twist.toda',                                        'red'],
  ['todatests/rigging/hh_tether_null.toda',                                             'yellow'],
  ['todatests/rigging/hh_tether_symbol.toda',                                           'red'],
  ['todatests/rigging/hh_valid_lead_root.toda',                                         'green'],
  ['todatests/rigging/hh_valid_self_ref_subsequent_valid.toda',                         'green'],
  ['todatests/rigging/hh_valid_shield_non_null.toda',                                   'green'],
  ['todatests/rigging/hh_valid_shield_null.toda',                                       'green'],
  ['todatests/rigging/hh_wrong_hoist_values.toda',                                      'red'],
  ['todatests/rigging/hh_wrong_shield.toda',                                            'yellow'],
  ['todatests/rigging/hitch-lead-footline-reaches-null.toda',                           'green'],
  ['todatests/rigging/hitch-post-footline-reaches-null.toda',                           'red'],
  ['todatests/rigging/hitch-post-not-fast.toda',                                        'green'],
  ['todatests/rigging/hitch-valid.toda',                                                'green'],
  ['todatests/rigging/hitch_extra_fast_in_footline.toda',                               'red'],
  ['todatests/rigging/hitch_hoist_rigs_missing.toda',                                   'yellow'],
  ['todatests/rigging/hitch_meet_tether_null.toda',                                     'red'],
  ['todatests/rigging/hitch_splice_post_no_lead_entry.toda',                            'green'],
  ['todatests/rigging/hitch_splice_post_wrong_hoist.toda',                              'red'],
  ['todatests/rigging/hitch_valid_basic_splice.toda',                                   'green'],
  ['todatests/rigging/invalid_rigging_green.toda',                                      'green'],
  ['todatests/rigging/invalid_shielding_green.toda',                                    'green'],
  ['todatests/rigging/lash_succession_missing_prev.toda',                               'yellow'],
  ['todatests/rigging/lash_succession_no_fast_twist.toda',                              'red'],
  ['todatests/rigging/lash_succession_reqsat_fail.toda',                                'green'],
  ['todatests/rigging/lashed_non_colinear.toda',                                        'red'],
  ['todatests/rigging/lead_shield_non_arb.toda',                                        'red'],
  ['todatests/rigging/meets_do_not_match.toda',                                         'red'],
  ['todatests/rigging/missing_rigging.toda',                                            'yellow'],
  ['todatests/rigging/missing_shield.toda',                                             'yellow'],
  ['todatests/rigging/multi-level-rig.toda',                                            'green'],
  ['todatests/rigging/multiple_hoists_green.toda',                                      'green'],
  ['todatests/rigging/nested_lash_in_splice.toda',                                      'green'],
  ['todatests/rigging/post_rigging_missing_post_key.toda',                              'green'],
  ['todatests/rigging/r104-lead-twist-body-arb.toda',                                   'red'],
  ['todatests/rigging/r104-lead-twist-body-hashes.toda',                                'red'],
  ['todatests/rigging/r104-lead-twist-body-twist.toda',                                 'yellow'],
  ['todatests/rigging/r269-lead-teth-shape-nospec-low.toda',                            'yellow'],
  ['todatests/rigging/r270-lead-teth-shape-body.toda',                                  'red'],
  ['todatests/rigging/r271-lead-teth-shape-nospec-mid.toda',                            'yellow'],
  ['todatests/rigging/r272-lead-teth-shape-arb.toda',                                   'red'],
  ['todatests/rigging/r272-lead-teth-shape-hashes.toda',                                'red'],
  ['todatests/rigging/r272-lead-teth-shape-pairtrie.toda',                              'red'],
  ['todatests/rigging/r273-lead-teth-shape-nospec-high.toda',                           'yellow'],
  ['todatests/rigging/r297-intermediate-twist-other-meet-not-declared.toda',            'yellow'],
  ['todatests/rigging/r298-intermediate-twist-also-proper-hoist.toda',                  'green'],
  ['todatests/rigging/r299-intermediate-twist-other-meet.toda',                         'green'],
  ['todatests/rigging/r300-intermediate-rigs-atom-missing.toda',                        'yellow'],
  ['todatests/rigging/r301-intermediate-rigs-non-trie-arb.toda',                        'green'],
  ['todatests/rigging/r302-hoist-prev-chain-null.toda',                                 'green'],
  ['todatests/rigging/r304-meet-prev-chain-null.toda',                                  'red'],
  ['todatests/rigging/r305-meet-prev-chain-non-twist.toda',                             'yellow'],
  ['todatests/rigging/r306-meet-prev-chain-other-fast.toda',                            'red'],
  ['todatests/rigging/r321-hitch-post-rigs-atom-missing.toda',                          'yellow'],
  ['todatests/rigging/r322-hitch-post-rigs-non-trie-arb.toda',                          'yellow'],
  ['todatests/rigging/r323-hitch-post-rigs-no-lead-entry.toda',                         'yellow'],
  ['todatests/rigging/r324-hitch-post-rigs-lead-maps-wrong.toda',                       'yellow'],
  ['todatests/rigging/r51-lead-prev-shape-body.toda',                                   'green'],
  ['todatests/rigging/r53-lead-prev-shape-arb.toda',                                    'green'],
  ['todatests/rigging/r53-lead-prev-shape-hashes.toda',                                 'green'],
  ['todatests/rigging/r53-lead-prev-shape-pairtrie.toda',                               'green'],
  ['todatests/rigging/r56-lead-prev-alg-unit.toda',                                     'green'],
  ['todatests/rigging/r71-lead-shld-alg-unit.toda',                                     'yellow'],
  ['todatests/rigging/r80-lead-reqs-alg-unit.toda',                                     'red'],
  ['todatests/rigging/r89-hoist-rigs-alg-unit.toda',                                    'yellow'],
  ['todatests/rigging/r98-lead-carg-alg-unit.toda',                                     'red'],
  ['todatests/rigging/rigging-corkline-incomplete-early.toda',                          'yellow'],
  ['todatests/rigging/rigging-corkline-incomplete-late.toda',                           'yellow'],
  ['todatests/rigging/rigging-lash-non-colinear.toda',                                  'red'],
  ['todatests/rigging/rigging-valid-lash-and-splice.toda',                              'green'],
  ['todatests/rigging/rigging-valid-simple-lash.toda',                                  'green'],
  ['todatests/rigging/rigging-valid-spliced-unit-rigs.toda',                            'green'],
  ['todatests/rigging/rigging-valid-unit-rig.toda',                                     'yellow'],
  ['todatests/rigging/self_referential.toda',                                           'red'],
  ['todatests/rigging/simple_lash_f1.toda',                                             'green'],
  ['todatests/rigging/simple_lash_f2.toda',                                             'green'],
  ['todatests/rigging/simple_last.toda',                                                'green'],
  ['todatests/rigging/splice_chain_4hitches.toda',                                      'green'],
  ['todatests/rigging/splice_mismatch.toda',                                            'red'],
  ['todatests/rigging/terminating_half_hitches_on_corkline.toda',                       'green'],
  ['todatests/rigging/test-suite-complex-rig-21-direct-to-indirect-tether.toda',        'green'],
  ['todatests/rigging/test-suite-complex-rig-22-indirect-to-direct-tether.toda',        'green'],
  ['todatests/rigging/test-suite-complex-rig-25-lashed-maximal-time-crossing.toda',     'green'],
  ['todatests/rigging/test-suite-complex-rig-26-lashed-complex.toda',                   'green'],
  ['todatests/rigging/test-suite-half-hitch-invalid-lead-not-tethered.toda',            'green'],
  ['todatests/rigging/test-suite-half-hitch-invalid-meet-not-fast.toda',                'yellow'],
  ['todatests/rigging/test-suite-half-hitch-valid-null-shield.toda',                    'green'],
  ['todatests/rigging/test-suite-half-hitch-valid-with-shield.toda',                    'green'],
  ['todatests/rigging/tether_loop.toda',                                                'yellow'],
  ['todatests/rigging/three-hitches-horizontal.toda',                                   'green'],
  ['todatests/rigging/three-hitches-vertical.toda',                                     'yellow'],
  ['todatests/rigging/topline_rigs_non_trie.toda',                                      'red'],
  ['todatests/rigging/twist-sats-shape-arb.toda',                                       'green'],
  ['todatests/rigging/twist-sats-shape-hashes.toda',                                    'green'],
  ['todatests/rigging/twist-sats-shape-twist.toda',                                     'green'],
  ['todatests/rigging/unit_rig.toda',                                                   'green'],
  ['todatests/rigging/unit_rig_multi.toda',                                             'green'],
  ['todatests/rigging/valid_kiwano.toda',                                               'green'],
  ['todatests/rigging/valid_kiwano_0.toda',                                             'green'],
  ['todatests/rigging/valid_kiwano_1.toda',                                             'green'],
  ['todatests/rigging/valid_kiwano_f1.toda',                                            'green'],
  ['todatests/rigging/valid_kiwano_f2.toda',                                            'green'],
  ['todatests/rigging/valid_kiwano_f5.toda',                                            'green'],
]

function group_label(path) {
  let m = path.match(/^todatests\/([^/]+)/)
  return m ? `todatests/${m[1]}` : 'other'
}

function rig_label(path) {
  let basename = path.replace(/^.*\//, '').replace(/\.(trdl|toda)$/, '')
  return basename.replace(/^(\d+a?)-/, '$1 · ')
}

let active_rig = null
// Cache of sidecar colour by rig path, populated by update_dot_colours().
// render_rigs_list reads this on each call; cells whose sidecar hasn't
// resolved yet render with an empty dot, which fills in once the fetch
// lands and update_dot_colours triggers a re-render via patch_dot.
const sidecar_colour = new Map()

function render_rigs_list() {
  let host = document.getElementById('rigs-list')
  if (!host) return
  let last_group = null
  let html = ''
  for (let path of RIGS) {
    let g = group_label(path)
    if (g !== last_group) {
      html += `<div class="rig-group">${escape_html(g)}</div>`
      last_group = g
    }
    let label  = rig_label(path)
    let active = path === active_rig ? ' active' : ''
    let colour = sidecar_colour.get(path) || ''
    html += `<div class="rig-item${active}" data-file="${escape_html(path)}">` +
            `<span class="rig-dot ${colour}"></span>${label}</div>`
  }
  host.innerHTML = html
}

// Patch the dot for a single rig in-place — cheaper than re-rendering
// the whole list as each of the 129 sidecar fetches resolves.
function patch_dot(path, colour) {
  let host = document.getElementById('rigs-list')
  if (!host) return
  let item = host.querySelector(`.rig-item[data-file="${CSS.escape(path)}"] .rig-dot`)
  if (!item) return
  item.classList.remove('green', 'yellow', 'red')
  if (colour) item.classList.add(colour)
}

// Fan out to every rig's .json sidecar in parallel; update the dot
// colours as each lands. Errors are swallowed silently — a missing or
// malformed sidecar just leaves the dot blank, which surfaces the gap
// without breaking the rest of the list.
async function update_dot_colours() {
  await Promise.all(RIGS.map(async path => {
    try {
      let json_url = path.replace(/\.(trdl|toda)$/, '.json')
      let res = await fetch(json_url)
      if (!res.ok) return
      let m = await res.json()
      if (m.colour) {
        sidecar_colour.set(path, m.colour)
        patch_dot(path, m.colour)
      }
    } catch {}
  }))
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
    // `issue` historically was a flat string ('INVALID', 'MISSING'); newer
    // sidecars use a structured tree. Render either — JSON-stringify the
    // tree form so it's at least visible in the header rather than dropped.
    if (m.issue != null) {
      let s = typeof m.issue === 'string' ? m.issue : JSON.stringify(m.issue)
      parts.push(`<span class="rm-issue">issue: ${escape_html(s)}</span>`)
    }
    if (m.invariant) {
      let s = typeof m.invariant === 'string' ? m.invariant : JSON.stringify(m.invariant)
      parts.push(`<span class="rm-invariant">invariant: ${escape_html(s)}</span>`)
    }
    if (m.notes != null) {
      let s = Array.isArray(m.notes) ? m.notes.join(' • ')
            : typeof m.notes === 'string' ? m.notes
            : JSON.stringify(m.notes)
      parts.push(`<span class="rm-notes">notes: ${escape_html(s)}</span>`)
    }
    // Update only the title span, not the whole H4 — the H4 also contains
    // the chevron used by the collapsible toggle.
    let title = header?.querySelector('.section-title')
    if (title) title.textContent = json_url.replace(/^.*\//, '')
    // Mirror the rig's declared colour into the h4 status pill so it stays
    // visible when the section is collapsed.
    let status = header?.querySelector('.section-status')
    if (status) {
      status.classList.remove('green', 'yellow', 'red')
      if (m.colour) {
        status.classList.add(m.colour)
        status.textContent = m.colour
      } else {
        status.textContent = ''
      }
    }
    host.innerHTML = parts.join('')
    section.hidden = parts.length === 0
    // Use the JSON's canonical corkline when available — for .toda loads
    // (todatests/rigging) the immediate render runs before the decompile
    // → recompile cycle finishes, and without this the rig-check panel
    // shows "No corkline available". For .trdl loads the auto-build also
    // sets workshop.corkline, but they should agree round-trip.
    if (m.corkline) {
      window.workshop.corkline = m.corkline
      window.workshop.corkline_source = 'sidecar'
    }
  } catch {
    section.hidden = true
  }
}

async function load_rig(path) {
  active_rig = path
  render_rigs_list()
  set_loaded_label(rig_label(path))
  // Await the meta fetch so that workshop.corkline is set from the canonical
  // JSON before load_bytes triggers an immediate render — otherwise the
  // .toda rig-check fires with no corkline yet.
  await load_rig_meta(path)
  // Stale .toda baseline must be cleared when switching rigs. load_bytes
  // resets it for the new .toda load; .trdl loads have no baseline.
  window.workshop.initial_toda_load = null
  try {
    let res = await fetch(path)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (path.toLowerCase().endsWith('.trdl')) {
      set_doc(await res.text())                 // auto-build picks it up
    } else {
      await load_bytes(await res.arrayBuffer()) // .toda → decompile path
    }
  } catch (err) {
    set_rigcheck('bad', 'LOAD ERROR', `${path}: ${err.message}`)
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
  let path = items[next].dataset.file
  load_rig(path)
  // load_rig synchronously re-renders the list (active class moves), so
  // the previous DOM nodes are detached. Scroll the *new* active item
  // into view, but only within the rigs-list — using scrollIntoView would
  // also scroll the surrounding panel and was jolting the page.
  let live = rigs_list_el.querySelector(`.rig-item[data-file="${CSS.escape(path)}"]`)
  if (live) {
    let list_rect = rigs_list_el.getBoundingClientRect()
    let item_rect = live.getBoundingClientRect()
    if (item_rect.top < list_rect.top) {
      rigs_list_el.scrollTop += item_rect.top - list_rect.top
    } else if (item_rect.bottom > list_rect.bottom) {
      rigs_list_el.scrollTop += item_rect.bottom - list_rect.bottom
    }
  }
})

// Collapsible sections: clicking an H4.collapsible toggles a
// .collapsed class on its enclosing .section (CSS hides the body).
for (let h4 of document.querySelectorAll('h4.collapsible')) {
  h4.addEventListener('click', () => {
    h4.closest('.section')?.classList.toggle('collapsed')
  })
}

// Mirror rig-check state into the rig-check h4 so it remains visible when
// the section is collapsed. In list mode, render one mini pill per checker
// — at a glance the user sees pass/warn/fail for js, clj, bb, rust. In
// single-row mode (workshop-status banner from set_rigcheck), render one
// pill matching the global state.
//
// Many code paths mutate #rigcheck (set_rigcheck here, show_abject_info /
// update_check_row in app.js), so a MutationObserver is the simplest way
// to stay in sync.
function refresh_rigcheck_status_indicator() {
  let host = document.querySelector('#rig-check-section .section-checkers')
  if (!host) return
  let rc = document.getElementById('rigcheck')
  if (!rc) { host.innerHTML = ''; return }
  let state_of = el => el.classList.contains('bad')  ? 'bad'
                     : el.classList.contains('warn') ? 'warn'
                     : el.classList.contains('ok')   ? 'ok'
                     : ''
  let pills
  if (rc.classList.contains('rig-check-list')) {
    pills = [...rc.querySelectorAll('[data-checker]')].map(row =>
      ({ label: row.dataset.checker, state: state_of(row) }))
  } else {
    pills = [{ label: rc.querySelector('.badge')?.textContent.trim() || '',
               state: state_of(rc) }]
  }
  host.innerHTML = pills.map(p =>
    `<span class="check-pill ${p.state}">${escape_html(p.label)}</span>`
  ).join('')
}
let rc_el = document.getElementById('rigcheck')
if (rc_el) {
  new MutationObserver(refresh_rigcheck_status_indicator).observe(rc_el, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['class'],
  })
  refresh_rigcheck_status_indicator()
}

render_rigs_list()
// Kick off sidecar fetches in parallel so each rig's dot fills in as
// its .json arrives. Independent of the example-rig load below.
update_dot_colours()
// On first load, select the spec's appendix B example. Sets active_rig
// so arrow-key navigation works, loads the sidecar metadata, and seeds
// the editor with the decompiled TRDL. The fetch is synchronous from
// the user's perspective (single round-trip to localhost).
load_rig('todatests/rigging/example_rig_from_spec.toda').catch(e => {
  console.warn('initial example load failed; falling back to inline STARTER doc', e)
  schedule_build()
})
