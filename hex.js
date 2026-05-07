// Atom-grouped hex view. Listens for `workshop:rendered` and paints each atom
// as one row: hash · shape · length · content. PAIRTRIE content gets a green
// highlight. Hashes truncate to first 8 + … + last 8 hex chars.

const SHAPE_NAMES = {
  0x48: 'twist',
  0x49: 'body',
  0x60: 'arb',
  0x61: 'hashlist',
  0x63: 'pairtrie',
}

const TWIST    = 0x48
const PAIRTRIE = 0x63
const CONTENT_LIMIT = 32                     // bytes shown before truncation

// atom hash → set of twist hashes that "use" it. A twist uses its own body,
// and (transitively via that body) the body's rig pairtrie, reqs trie,
// shield, and cargo. Hovering a body/pairtrie/arb row picks up every twist
// pointing at it. Built once per render in build_usage().
let _usage = new Map()

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

function content_hex(buf, atom) {
  let { cfirst, last } = atom.bin
  let len = last - cfirst + 1
  if (len <= 0) return ''
  if (len <= CONTENT_LIMIT) return space_hex(bytes_to_hex(buf, cfirst, last + 1))
  let head = bytes_to_hex(buf, cfirst, cfirst + CONTENT_LIMIT)
  return space_hex(head) + ' …'
}

function render_atom(buf, atom) {
  let shape_label = SHAPE_NAMES[atom.shape] ?? atom.shape.toString(16)
  let length      = atom.bin.length
  let hash_short  = truncate_hash(atom.hash)
  let content     = content_hex(buf, atom)
  let trie_class  = atom.shape === PAIRTRIE ? ' trie' : ''
  return `<div class="atom" data-hash="${atom.hash}">
    <span class="b-hash" title="${atom.hash}">${hash_short}</span>
    <span class="b-tag">${shape_label}</span>
    <span class="b-len">${length}</span>
    <span class="b-content${trie_class}">${content}</span>
  </div>`
}

function render_hex(env) {
  let host = document.getElementById('hex')
  if (!host) return
  build_usage(env)
  if (!env.atoms?.length) {
    host.innerHTML = '<div class="empty">no atoms</div>'
    return
  }
  host.innerHTML = env.atoms.map(a => render_atom(env.buff, a)).join('')
}

const host = document.getElementById('hex')

host?.addEventListener('mouseover', e => {
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

document.addEventListener('workshop:hover',  e => paint('hover',  e.detail.hashes))
document.addEventListener('workshop:select', e => paint('select', e.detail.hashes))

document.addEventListener('workshop:rendered', e => render_hex(e.detail))
