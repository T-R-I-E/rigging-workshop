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

const PAIRTRIE = 0x63
const CONTENT_LIMIT = 32                     // bytes shown before truncation

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
  document.dispatchEvent(new CustomEvent('workshop:highlight', {
    detail: { hashes: [row.dataset.hash], source: 'hex' },
  }))
})

document.addEventListener('workshop:highlight', e => {
  if (!host) return
  host.querySelectorAll('.atom.hi').forEach(r => r.classList.remove('hi'))
  let target = new Set(e.detail.hashes || [])
  if (!target.size) return
  for (let r of host.querySelectorAll('.atom')) {
    if (target.has(r.dataset.hash)) r.classList.add('hi')
  }
})

document.addEventListener('workshop:rendered', e => render_hex(e.detail))
