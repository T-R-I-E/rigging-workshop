// Dynamic rig manifest. Walks the static-server's directory index pages
// (Python http.server style: <ul><li><a href="name"> entries, trailing
// slash marks a directory) under the configured roots and returns a
// sorted list of rig paths. Used by the sidebar (editor.js) and both
// benches so that adding a fixture under todatests/ shows up without
// editing a hardcoded array.

const DEFAULT_ROOTS = ['todatests/rigging/', 'todatests/reqsat/']
const DEFAULT_EXTS  = ['.toda', '.trdl']

async function fetch_index(url) {
  let res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  let html = await res.text()
  let doc  = new DOMParser().parseFromString(html, 'text/html')
  return [...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
}

async function walk(prefix, exts) {
  let hrefs
  try { hrefs = await fetch_index(prefix) }
  catch (e) { console.warn(`[rig-manifest] skipping ${prefix}: ${e.message}`); return [] }
  let files = [], dirs = []
  for (let href of hrefs) {
    if (!href || href.startsWith('.') || href.startsWith('/') ||
        href.startsWith('?') || href === '..' || href === '../') continue
    if (href.endsWith('/'))                    dirs.push(prefix + href)
    else if (exts.some(e => href.endsWith(e))) files.push(prefix + href)
  }
  let sub = await Promise.all(dirs.map(d => walk(d, exts)))
  return [...files, ...sub.flat()]
}

export async function list_rigs(roots = DEFAULT_ROOTS, exts = DEFAULT_EXTS) {
  let lists = await Promise.all(roots.map(r => walk(r, exts)))
  return lists.flat().sort()
}
