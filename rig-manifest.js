// Dynamic rig manifest. Walks the static-server's directory index pages
// (Python http.server style: <ul><li><a href="name"> entries, trailing
// slash marks a directory) under the configured roots and returns a
// sorted list of rig paths. Used by the sidebar (editor.js) and both
// benches so that adding a fixture under todatests/ shows up without
// editing a hardcoded array.

// v1-tests/ is the spec-conformance corpus: ~6.6k .trdl fixtures nested
// two levels deep (<Structure>/<Property>/<Condition>.trdl). It carries no
// .json sidecars — expectations live in each file's comment header.
const DEFAULT_ROOTS = ['todatests/rigging/', 'todatests/reqsat/',
                       'todatests/v1-tests/']
const DEFAULT_EXTS  = ['.toda', '.trdl']

async function fetch_index(url) {
  let res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  let html = await res.text()
  let doc  = new DOMParser().parseFromString(html, 'text/html')
  return [...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
}

// Index pages percent-encode hrefs, and 5.7k v1-tests fixtures have `=` in
// their names (`carg_shape=0x00.trdl` → `carg_shape%3D0x00.trdl`). Decode so
// the manifest holds real paths — otherwise sidebar labels show the escapes
// and text filtering on them fails. No fixture name contains #, % or ?, so
// the decoded form stays safe to hand back to fetch().
function decode_href(href) {
  try { return decodeURIComponent(href) } catch { return href }
}

async function walk(prefix, exts) {
  let hrefs
  try { hrefs = await fetch_index(prefix) }
  catch (e) { console.warn(`[rig-manifest] skipping ${prefix}: ${e.message}`); return [] }
  let files = [], dirs = []
  for (let raw of hrefs) {
    if (!raw || raw.startsWith('.') || raw.startsWith('/') ||
        raw.startsWith('?') || raw === '..' || raw === '../') continue
    let href = decode_href(raw)
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
