// Atom-grouped hex view. Listens for `workshop:rendered` and paints each atom.
// Two views, toggled in the panel header:
//
// * 'raw' (default) — flat one-line-per-atom: hash · shape · length · content.
//   PAIRTRIE content gets a green highlight. Hashes truncate to first 8 + …
//   + last 8 hex chars.
//
// * 'kiwanoed' — shape-aware multi-line atom blocks modeled after the hand-
//   written reference dumps in XX-*-test.toda.hex. Each atom gets a header
//   row (full hash + position-in-rig annotation), an indented shape+size row,
//   and per-shape content rows: named slots for body/twist, key/value pairs
//   for pairtrie, raw hex chunks for arb. Hashes inside lists carry an
//   annotation pointing at the named atom (or `symbol: NAME` / `?`).

const SHAPE_NAMES = {
  0x48: 'twist',
  0x49: 'body',
  0x60: 'arb',
  0x61: 'hashes',
  0x63: 'pairtrie',
}

const ALG_NULL    = 0x00
const ALG_SYMBOL  = 0x22
const ALG_SHA256  = 0x41
const ALG_UNIT    = 0xff
const TWIST       = 0x48
const BODY        = 0x49
const ARB         = 0x60
const HASHES      = 0x61
const PAIRTRIE    = 0x63
const CONTENT_LIMIT = 32                     // raw view: bytes shown pre-truncate

// Well-known symbols. Symbols are 32-byte hashes (algo 0x22) of UTF-8 strings;
// listing the strings here so pairtrie keys with these values render as
// `symbol: POPTOP` rather than the bare hash. Extend when new ones surface.
const KNOWN_SYMBOLS = {
  'c70173874680c58e5c1d32854bd10486aac6f1aa821b56e3d512fd72e45ac72e': 'POPTOP',
  '3d5f4f95cdb1cdfc71014efa1a669fd42599a0ce2000d914a409e48bccaed584': 'ed25519',
}

// Current view. Persisted to localStorage so the toggle is sticky across
// reloads — saves the user from re-flipping after every refresh.
let _view = (typeof localStorage !== 'undefined'
             && localStorage.getItem('hex_view')) || 'raw'
// Migration: the old 'focused' value (singular twist driven by
// double-click) is now 'highlight' (driven by hover with fallbacks).
if (_view === 'focused') _view = 'highlight'

let _usage = new Map()
let _last_select = []
let _last_env = null              // remembered so the toggle can re-render

function add_use(atom_hash, twist_hash) {
  if (!atom_hash) return
  let s = _usage.get(atom_hash)
  if (!s) { s = new Set(); _usage.set(atom_hash, s) }
  s.add(twist_hash)
}

function build_usage(env) {
  _usage.clear()
  let twists = env.shapes?.[TWIST] || []
  for (let t of twists) {
    add_use(t.hash, t.hash)
    add_use(t.sats_h, t.hash)
    let b = t.body
    if (!b) continue
    add_use(b.hash, t.hash)
    add_use(b.rigs, t.hash)
    add_use(b.reqs, t.hash)
    add_use(b.shld, t.hash)
    add_use(b.carg, t.hash)
  }
}

function broadcast_hashes_for(row) {
  let h = row.dataset.hash
  let users = _usage.get(h)
  return users && users.size ? [h, ...users] : [h]
}

// ---- Hex string helpers ----
function truncate_hash(h) {
  if (h.length <= 20) return h
  return h.slice(0, 8) + '…' + h.slice(-8)
}

function bytes_to_hex(buf, start, end) {
  let u = new Uint8Array(buf, start, end - start)
  let out = ''
  for (let i = 0; i < u.length; i++) out += u[i].toString(16).padStart(2, '0')
  return out
}

function space_hex(h) {                      // "deadbeef" → "de ad be ef"
  return h.match(/.{1,2}/g)?.join(' ') ?? ''
}

// ---- Atom-slot parsing (kiwanoed view) ----
// Read the algo byte at offset and return either '00', 'ff', or a full 33-byte
// hex string (algo + 32-byte digest). pluck_hash() in app.js is the analog;
// reimplemented here so hex.js doesn't depend on app.js internals.
function pluck_slot(buf, offset) {
  let u = new Uint8Array(buf, offset, 1)
  let algo = u[0]
  if (algo === ALG_NULL) return '00'
  if (algo === ALG_UNIT) return 'ff'
  return bytes_to_hex(buf, offset, offset + 33)
}

function slot_len(slot) {
  if (!slot || slot === '00' || slot === 'ff') return 1
  return 33                                  // algo byte + 32-byte digest
}

function is_null_slot(slot) { return !slot || slot === '00' || slot === 'ff' }

// ---- Names: position-in-rig labels for every atom ----
// Build a Map<hash → friendly name> by walking the twist prev-chains to
// identify lines, then assigning twist[i] / body of twist[i] / pairtrie
// twist[i]rigs / pairtrie lineNamereqs / etc. The "poptop" line is the one
// containing the workshop's canonical corkline hash; other lines get a, b,
// c, … in discovery order. Anything not nameable that way falls through to
// `arb #N` / `pairtrie #N` numbered by atom discovery order.
function compute_names(env) {
  let names = new Map()
  let counts = {}                            // shape label → next #
  let twists = env.shapes?.[TWIST] || []
  let by_hash = new Map(twists.map(t => [t.hash, t]))

  // The body's `prev` and `teth` fields show up as atom-reference objects
  // (resolved by env.index lookup) when the prev points to a real twist,
  // and as a string `b.prevhash` / `b.tethhash` when the lookup miss-fired
  // (dangling / out-of-file). Normalize to "the prev twist's hash, or null".
  function prev_twist_hash(t) {
    let p = t.prev
    if (p && typeof p === 'object' && p.shape === TWIST) return p.hash
    return null
  }

  let prev_of = new Map()
  let line_starts = new Set(twists.map(t => t.hash))
  for (let t of twists) {
    let ph = prev_twist_hash(t)
    if (ph && by_hash.has(ph)) {
      prev_of.set(t.hash, ph)
      line_starts.delete(ph)                 // ph isn't a head; something prevs to it
    }
  }

  // Walk each lead back through prev to enumerate its line root→head.
  let lines = []
  for (let lead of line_starts) {
    let chain = [lead]
    let cur = lead
    while (prev_of.has(cur)) {
      cur = prev_of.get(cur)
      chain.unshift(cur)
    }
    lines.push(chain)
  }

  // Pick which line is "poptop" (the corkline). The workshop's
  // `window.workshop.corkline` is the canonical poptop twist hash; whichever
  // line contains it is named poptop. The rest get a, b, c, ….
  let corkline = window.workshop?.corkline
  let poptop_idx = -1
  if (corkline) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(corkline)) { poptop_idx = i; break }
    }
  }
  let line_names = new Array(lines.length)
  if (poptop_idx >= 0) line_names[poptop_idx] = 'poptop'
  let next_letter = 'a'.charCodeAt(0)
  for (let i = 0; i < lines.length; i++) {
    if (line_names[i]) continue
    line_names[i] = String.fromCharCode(next_letter++)
  }

  // Twist + body + per-twist + per-line atom names.
  for (let i = 0; i < lines.length; i++) {
    let lname = line_names[i]
    let chain = lines[i]
    for (let j = 0; j < chain.length; j++) {
      let th  = chain[j]
      let t   = by_hash.get(th)
      let pos = `${lname}[${j}]`
      if (!names.has(th)) names.set(th, `twist ${pos}`)
      if (t?.body?.hash && !names.has(t.body.hash))
        names.set(t.body.hash, `twist body ${pos}`)
      if (t?.sats_h && !is_null_slot(t.sats_h) && !names.has(t.sats_h))
        names.set(t.sats_h, `pairtrie ${pos}sat`)
      let b = t?.body
      if (b) {
        if (!is_null_slot(b.rigs) && !names.has(b.rigs))
          names.set(b.rigs, `pairtrie ${pos}rigs`)
        if (!is_null_slot(b.reqs) && !names.has(b.reqs))
          names.set(b.reqs, `pairtrie ${lname}_reqs`)
        if (!is_null_slot(b.carg) && !names.has(b.carg))
          names.set(b.carg, `pairtrie ${lname}_cargo`)
        if (!is_null_slot(b.shld) && !names.has(b.shld))
          names.set(b.shld, null)            // shield gets a sequential #
      }
    }
  }

  // Sequential numbering for everything else, in atom-discovery order.
  for (let a of env.atoms || []) {
    let existing = names.get(a.hash)
    if (existing) continue
    if (existing === null) {
      // Reserved for shield arbs above — gets a shield-specific number.
      counts.shield = (counts.shield || 0) + 1
      names.set(a.hash, `arb shield${counts.shield - 1}`)
      continue
    }
    let kind = SHAPE_NAMES[a.shape] || `shape-${a.shape.toString(16)}`
    counts[kind] = (counts[kind] || 0) + 1
    names.set(a.hash, `${kind} #${counts[kind]}`)
  }
  // Resolve the placeholder-null shield entries (set above) into shieldN.
  for (let [k, v] of names) {
    if (v === null) {
      counts.shield = (counts.shield || 0) + 1
      names.set(k, `arb shield${counts.shield - 1}`)
    }
  }

  return names
}

// Lookup a symbol identifier's friendly name (algo 0x22). Falls back to a
// truncated hex prefix when unknown, so a fresh symbol still hints at its
// hash without dumping the whole 32 bytes.
function symbol_label(hash_hex) {
  if (!hash_hex || hash_hex.length < 2) return null
  if (hash_hex.slice(0, 2).toLowerCase() !== '22') return null
  let body = hash_hex.slice(2).toLowerCase()
  let known = KNOWN_SYMBOLS[body]
  return known ? `symbol: ${known}` : `symbol: ${body.slice(0, 8)}…`
}

// ---- Raw view (existing) ----
function content_hex(buf, atom) {
  let { cfirst, last } = atom.bin
  let len = last - cfirst + 1
  if (len <= 0) return ''
  if (len <= CONTENT_LIMIT) return space_hex(bytes_to_hex(buf, cfirst, last + 1))
  let head = bytes_to_hex(buf, cfirst, cfirst + CONTENT_LIMIT)
  return space_hex(head) + ' …'
}

function copy_btn(full_hash) {
  // Inline unicode glyph for the copy icon; a hex-pane-level click
  // handler reads data-copy and writes it to the clipboard. The button
  // is keyboard-focusable so it doesn't slip out of the keyboard nav
  // path inside the otherwise mostly-static dump.
  return `<button class="copy-icon" type="button" data-copy="${full_hash}"` +
         ` title="Copy ${full_hash}" aria-label="Copy full hash">⎘</button>`
}

function render_atom_raw(buf, atom) {
  let shape_label = SHAPE_NAMES[atom.shape] ?? atom.shape.toString(16)
  let length      = atom.bin.length
  let hash_short  = truncate_hash(atom.hash)
  let content     = content_hex(buf, atom)
  let trie_class  = atom.shape === PAIRTRIE ? ' trie' : ''
  // Wrap the hash + copy icon in one cell so the 4-column .atom grid
  // doesn't see a stray 5th child.
  return `<div class="atom" data-hash="${atom.hash}">
    <span class="b-hash-cell"><span class="b-hash" title="${atom.hash}">${hash_short}</span>${copy_btn(atom.hash)}</span>
    <span class="b-tag">${shape_label}</span>
    <span class="b-len">${length}</span>
    <span class="b-content${trie_class}">${content}</span>
  </div>`
}

// ---- Kiwanoed view ----
// Hash formatting: `41  ab6a a695 67b5 …` — algo byte, two spaces, then the
// 32-byte digest as 2-byte (4-hex-char) groups separated by single spaces.
// Matches the reference dumps.
function fmt_hash(slot) {
  if (!slot || slot === '00') return '00'
  if (slot === 'ff') return 'ff'
  let algo = slot.slice(0, 2)
  let rest = slot.slice(2).match(/.{4}/g)?.join(' ') ?? slot.slice(2)
  return `${algo}  ${rest}`
}

// Wrap arb byte data to ROW_BYTES bytes per line, formatted as 4-char hex
// groups. The reference uses 32 bytes/line (== 16 groups of 2 bytes).
function fmt_arb_lines(hex) {
  const ROW_BYTES = 32
  let lines = []
  for (let i = 0; i < hex.length; i += ROW_BYTES * 2) {
    let chunk = hex.slice(i, i + ROW_BYTES * 2)
    lines.push(chunk.match(/.{4}/g)?.join(' ') ?? chunk)
  }
  return lines
}

function comment(name) {
  if (!name) return ''
  return `<span class="kx-comment">% ${escape_attr(name)}</span>`
}

function escape_attr(s) {
  return String(s).replace(/[<&"]/g, c => ({'<':'&lt;','&':'&amp;','"':'&quot;'}[c]))
}

function annotate_slot(slot, names) {
  if (is_null_slot(slot)) return null
  return symbol_label(slot) || names.get(slot) || null
}

function render_slot_row(field, slot, names, extra_cls = '', link_set = null) {
  if (is_null_slot(slot)) {
    let field_html = field ? `<span class="kx-fieldname">${field}</span>` : ''
    return `<div class="kx-row kx-field ${extra_cls}">${field_html}<span class="kx-null">00</span></div>`
  }
  let field_html = field ? `<span class="kx-fieldname">${field}</span>` : ''
  let name_html  = comment(annotate_slot(slot, names))
  // link_set holds the set of hashes that, when seen as slot values,
  // should render as clickable links (used by the highlight view to
  // hop between twists without rendering each as its own atom card).
  let link = link_set?.has(slot)
  let value_cls  = link ? 'kx-value kx-twist-link' : 'kx-value'
  let value_attr = link ? ` data-link-hash="${slot}" tabindex="0" role="link"` : ''
  return `<div class="kx-row kx-field ${extra_cls}">${field_html}<span class="${value_cls}"${value_attr}>${fmt_hash(slot)}</span>${copy_btn(slot)}${name_html}</div>`
}

function render_body_fields(env, atom, names, link_set) {
  let fields = ['prev', 'teth', 'shld', 'reqs', 'rigs', 'carg']
  let i = atom.bin.cfirst
  let end = atom.bin.last + 1
  let parts = []
  for (let f of fields) {
    if (i >= end) break
    let s = pluck_slot(env.buff, i)
    parts.push(render_slot_row(f, s, names, '', link_set))
    i += slot_len(s)
  }
  return parts.join('')
}

function render_twist_fields(env, atom, names, link_set) {
  let fields = ['body', 'sats']
  let i = atom.bin.cfirst
  let end = atom.bin.last + 1
  let parts = []
  for (let f of fields) {
    if (i >= end) break
    let s = pluck_slot(env.buff, i)
    parts.push(render_slot_row(f, s, names, '', link_set))
    i += slot_len(s)
  }
  return parts.join('')
}

function render_pairtrie(env, atom, names, link_set) {
  let i = atom.bin.cfirst
  let end = atom.bin.last + 1
  let parts = []
  while (i < end) {
    let k = pluck_slot(env.buff, i); i += slot_len(k)
    if (i > end) break
    let v = pluck_slot(env.buff, i); i += slot_len(v)
    parts.push(
      `<div class="kx-pair">` +
        render_slot_row('', k, names, 'kx-key', link_set) +
        render_slot_row('', v, names, 'kx-val', link_set) +
      `</div>`)
  }
  return parts.join('')
}

function render_hashes(env, atom, names, link_set) {
  let i = atom.bin.cfirst
  let end = atom.bin.last + 1
  let parts = []
  while (i < end) {
    let h = pluck_slot(env.buff, i); i += slot_len(h)
    parts.push(render_slot_row('', h, names, 'kx-listitem', link_set))
  }
  return parts.join('')
}

function render_arb(env, atom) {
  let hex = bytes_to_hex(env.buff, atom.bin.cfirst, atom.bin.last + 1)
  return fmt_arb_lines(hex)
    .map(l => `<div class="kx-row kx-data">${l}</div>`).join('')
}

function render_atom_kiwanoed(env, atom, names, link_set = null) {
  let name      = names.get(atom.hash)
  let header    = `<div class="kx-row kx-header">` +
                  `<span class="kx-hash" title="${atom.hash}">${fmt_hash(atom.hash)}</span>` +
                  `${copy_btn(atom.hash)}${comment(name)}</div>`
  let body_len  = (atom.bin.last - atom.bin.cfirst + 1)
  let len_hex   = body_len.toString(16).padStart(8, '0').match(/.{4}/g).join(' ')
  let shape_hex = atom.shape.toString(16).padStart(2, '0')
  let shape     = `<div class="kx-row kx-shape">${shape_hex} ${len_hex}</div>`
  let payload
  switch (atom.shape) {
    case BODY:     payload = render_body_fields(env, atom, names, link_set);  break
    case TWIST:    payload = render_twist_fields(env, atom, names, link_set); break
    case PAIRTRIE: payload = render_pairtrie(env, atom, names, link_set);     break
    case HASHES:   payload = render_hashes(env, atom, names, link_set);       break
    case ARB:      payload = render_arb(env, atom);                           break
    default:       payload = render_arb(env, atom)                            // fallback: bytes
  }
  return `<div class="atom kx-atom" data-shape="${atom.shape.toString(16)}" data-hash="${atom.hash}">` +
         header + shape + payload + `</div>`
}

// ---- Render entry ----
function render_hex(env) {
  _last_env = env
  let host = document.getElementById('hex')
  if (!host) return
  build_usage(env)
  // 'highlight' shares the kiwanoed styling (multi-line atom cards),
  // narrowed to one twist + its body. Keep the .kiwanoed class on
  // the host for both.
  let kiwano_like = _view === 'kiwanoed' || _view === 'highlight'
  host.classList.toggle('kiwanoed', kiwano_like)
  if (!env.atoms?.length) {
    host.innerHTML = '<div class="empty">no atoms</div>'
    return
  }
  if (_view === 'highlight') {
    render_highlight_view(host, env)
  } else if (_view === 'kiwanoed') {
    let names = compute_names(env)
    host.innerHTML = env.atoms.map(a => render_atom_kiwanoed(env, a, names)).join('')
  } else {
    host.innerHTML = env.atoms.map(a => render_atom_raw(env.buff, a)).join('')
  }
  // Restore click-selection across rebuilds. Any hashes no longer present
  // are silently skipped by paint(), so this is safe even when a rebuild
  // changes the atom set.
  paint('select', _last_select)
}

// Render the highlight view: the click-selected twist, falling back to
// the focused twist. Mouseover deliberately does NOT change the target —
// the panel locks to a click/focus pick so it doesn't chase the cursor
// while the user looks around. Re-renders on workshop:select and
// workshop:focus only.
let _last_hover = []
function render_highlight_view(host, env) {
  let names = compute_names(env)
  let by_hash = new Map(env.atoms.map(a => [a.hash, a]))
  let candidates = [..._last_select,
                    window.workshop?.focus_hash].filter(Boolean)
  let target = null
  for (let h of candidates) {
    let a = by_hash.get(h)
    if (a) { target = a; break }
  }
  if (!target) {
    host.innerHTML = '<div class="empty">click a twist</div>'
    return
  }
  let atoms, link_set
  if (target.shape === TWIST) {
    atoms = gather_referenced_atoms(env, target, by_hash)
    // Other twists in env aren't rendered as atom cards here — instead
    // their hash references render as clickable links so the user can
    // jump to them. Exclude the root since it IS the rendered card.
    link_set = new Set((env.shapes?.[TWIST] || [])
      .map(t => t.hash)
      .filter(h => h !== target.hash))
  } else {
    atoms = [target]
    link_set = null
  }
  host.innerHTML = atoms.map(a => render_atom_kiwanoed(env, a, names, link_set)).join('')
}

// BFS the atoms reachable from `root` (a twist) by following hash slots.
// Expands into body / pairtries / hashes; stops at arb (no refs) and at
// other twists (those are surfaced as clickable hash links inside slot
// rows, not as their own atom cards). Symbol slots and dangling refs
// fall through the by_hash miss and are simply skipped.
function gather_referenced_atoms(env, root, by_hash) {
  let visited = new Set()
  let ordered = []
  let queue = [root.hash]
  while (queue.length) {
    let h = queue.shift()
    if (!h || is_null_slot(h) || visited.has(h)) continue
    let a = by_hash.get(h)
    if (!a) continue
    visited.add(h)
    if (a.shape === TWIST && a.hash !== root.hash) continue
    ordered.push(a)
    if (a.shape === ARB) continue
    let i = a.bin.cfirst, end = a.bin.last + 1
    while (i < end) {
      let s = pluck_slot(env.buff, i)
      i += slot_len(s)
      if (!is_null_slot(s)) queue.push(s)
    }
  }
  return ordered
}

const host = document.getElementById('hex')

// While the user scrolls the panel-body, rows pass under a stationary
// cursor and mouseover would otherwise keep firing — making the
// .hover highlight chase the scroll, which reads as 'the highlighting
// changes while I scroll'. Suppress hover dispatch for a short window
// after every scroll event. Cleared after 200ms of idle so a real
// mouse move resumes immediately.
let _scrolling_until = 0
function on_scroll() { _scrolling_until = Date.now() + 200 }
host?.parentElement?.addEventListener('scroll', on_scroll, { passive: true })
host?.addEventListener('scroll', on_scroll, { passive: true })

host?.addEventListener('mouseover', e => {
  if (Date.now() < _scrolling_until) return
  let row = e.target.closest('.atom')
  if (!row) return
  document.dispatchEvent(new CustomEvent('workshop:hover', {
    detail: { hashes: broadcast_hashes_for(row), source: 'hex' },
  }))
})

host?.addEventListener('mouseleave', () => {
  document.dispatchEvent(new CustomEvent('workshop:hover', {
    detail: { hashes: [], source: 'hex' },
  }))
})

host?.addEventListener('click', e => {
  // Copy-icon clicks fire before the select-on-atom click — pull the
  // hash off data-copy, write to clipboard, flash a brief 'copied!'
  // state on the button, and stop propagation so the atom doesn't
  // also re-select.
  let copy = e.target.closest('.copy-icon')
  if (copy) {
    let hash = copy.dataset.copy
    if (hash) {
      navigator.clipboard?.writeText(hash).then(() => {
        copy.classList.add('copied')
        let prior = copy.textContent
        copy.textContent = '✓'
        setTimeout(() => {
          copy.classList.remove('copied')
          copy.textContent = prior
        }, 900)
      }).catch(() => {})
    }
    e.stopPropagation()
    return
  }
  // Twist-link clicks (highlight view only): hash text inside a slot row
  // that points at another twist. Re-select to that twist; the highlight
  // view's select-listener handles the rebuild. Stop propagation so the
  // enclosing .atom doesn't also fire a select for the parent atom.
  let link = e.target.closest('.kx-twist-link')
  if (link) {
    let hash = link.dataset.linkHash
    if (hash) {
      document.dispatchEvent(new CustomEvent('workshop:select', {
        detail: { hashes: [hash], source: 'hex-link' },
      }))
    }
    e.stopPropagation()
    return
  }
  let row = e.target.closest('.atom')
  if (!row) return
  document.dispatchEvent(new CustomEvent('workshop:select', {
    detail: { hashes: broadcast_hashes_for(row), source: 'hex' },
  }))
})

function paint(klass, hashes) {
  if (!host) return
  host.querySelectorAll('.atom.' + klass).forEach(r => r.classList.remove(klass))
  let target = new Set(hashes || [])
  if (!target.size) return
  for (let r of host.querySelectorAll('.atom')) {
    if (target.has(r.dataset.hash)) r.classList.add(klass)
  }
}

document.addEventListener('workshop:hover', e => {
  _last_hover = e.detail.hashes || []
  paint('hover', _last_hover)
  // Highlight view deliberately does NOT re-render on hover — see
  // render_highlight_view for the rationale.
})
document.addEventListener('workshop:select', e => {
  _last_select = e.detail.hashes || []
  paint('select', _last_select)
  if (_view === 'highlight' && _last_env) render_hex(_last_env)
})

document.addEventListener('workshop:rendered', e => render_hex(e.detail))

// ---- View toggle ----
// Wired to the .hex-toggle buttons in the panel header. Persists the choice
// to localStorage so the user doesn't have to re-pick after every reload.
function set_view(v) {
  // Migrate the old 'focused' localStorage value to the new name.
  if (v === 'focused') v = 'highlight'
  if (v !== 'raw' && v !== 'kiwanoed' && v !== 'highlight') return
  _view = v
  try { localStorage.setItem('hex_view', v) } catch {}
  document.querySelectorAll('.hex-toggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === v))
  if (_last_env) render_hex(_last_env)
}

// Re-render the hex pane whenever focus changes — only matters when
// the highlight view is active (and only as the third fallback).
document.addEventListener('workshop:focus', () => {
  if (_view === 'highlight' && _last_env) render_hex(_last_env)
})

document.querySelectorAll('.hex-toggle button').forEach(b => {
  b.classList.toggle('active', b.dataset.view === _view)
  b.addEventListener('click', () => set_view(b.dataset.view))
})
