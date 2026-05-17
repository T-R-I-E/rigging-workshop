// Shape extractor for rig roundtrip comparison.
//
// Given a .toda byte stream, runs the workshop's deterministic graph
// layout (lifted from app.js's `showpipe` pipeline) and returns a
// canonical JSON string describing the rig's shape:
//   - twists sorted by (x asc, y asc), re-indexed in sort order
//   - edges typed {prev,teth,lead,meet,post,cargo,succ}, with from/to
//     pointing at twist indices in the sorted list
//   - colours, labels, and reverse-edge tags (leadup/meetup/cargoup)
//     stripped: they're either rendering concerns or redundant
//
// Two extractions of the same bytes return identical strings, so
// `extract_shape(a) === extract_shape(b)` is a sound test of "are
// these two byte streams the same rig at the layout level". Use case:
// the roundtrip bench compares original vs. decompile→recompile bytes
// to surface silent decompile drift that doesn't change checker
// verdicts but reshapes the rig.
//
// TODO: this duplicates ~100 lines of layout logic from app.js. The
// algorithms are identical; merge once app.js's render is split into
// "layout (pure, returns env)" and "emit (writes SVG to DOM)". Until
// then keep the two in sync by hand. See plan mighty-kindling-sky.

import { parse_atoms } from './decompile.js'

const TWIST = 0x48, BODY = 0x49, HASHLIST = 0x61, PAIRTRIE = 0x63

export function extract_shape(buf) {
  let env = parse_atoms(buf)
  unroll_lists(env)
  unzip_tries(env)
  untwist_bodies(env)
  twist_list(env)
  have_successors(env)
  get_hitched(env)
  body_building(env)
  env.firsts = []
  get_in_line(env)
  // Sort firsts by twist hash so y assignment is determined by the rig's
  // content rather than the byte order they happened to appear in the
  // file. Without this, two byte streams that encode structurally
  // equivalent rigs but interleave atoms differently get different y
  // values for the same line → false NEQ.
  env.firsts.sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  y_the_first_twist(env)
  stack_lines(env)
  stack_lines(env)
  plonk_twists(env)
  return canonicalize(env)
}

// ---- helpers shared with app.js layout ------------------------------------

function pluck_hash(bytes, i) {
  let algo = bytes[i]
  if (algo === 0x41 || algo === 0x22) return bytes_to_hex(bytes, i, 33)
  if (algo === 0x00) return '00'
  if (algo === 0xff) return 'ff'
  return 0
}

function bytes_to_hex(bytes, i, n) {
  let h = ''
  for (let k = 0; k < n; k++) {
    let b = bytes[i + k]
    h += (b < 16 ? '0' : '') + b.toString(16)
  }
  return h
}

function leng(h) { return h ? h.length / 2 : 1 }

// ---- pipeline stages (ported from app.js, DOM-free) -----------------------

function unroll_lists(env) {
  env.shapes[HASHLIST]?.forEach(hl => {
    hl.list = []
    for (let i = hl.cfirst; i <= hl.last;) {
      let k = pluck_hash(env.bytes, i)
      i += leng(k)
      hl.list.push(env.index[k] || k)
    }
  })
}

function unzip_tries(env) {
  env.shapes[PAIRTRIE]?.forEach(trie => {
    trie.pairs = []
    for (let i = trie.cfirst; i <= trie.last;) {
      let k = pluck_hash(env.bytes, i); i += leng(k)
      let v = pluck_hash(env.bytes, i); i += leng(v)
      trie.pairs.push([env.index[k] || k, env.index[v] || v])
    }
  })
}

function untwist_bodies(env) {
  env.shapes[BODY]?.forEach(b => {
    let i = b.cfirst
    let p = pluck_hash(env.bytes, i)
    b.prev = env.index[p] || 0
    let t = pluck_hash(env.bytes, (i += leng(p)))
    b.teth = env.index[t] || 0
    b.shld = pluck_hash(env.bytes, (i += leng(t)))
    b.reqs = pluck_hash(env.bytes, (i += leng(b.shld)))
    b.rigs = pluck_hash(env.bytes, (i += leng(b.reqs)))
    b.carg = pluck_hash(env.bytes, (i += leng(b.rigs)))
    b.rigtrie = env.index[b.rigs] || 0
    b.cargooo = env.index[b.carg] || 0
  })
}

function twist_list(env) {
  env.shapes[TWIST]?.forEach(t => {
    let b = pluck_hash(env.bytes, t.cfirst)
    t.body = env.index[b] || 0
    if (!t.body) return
    t.body.twist = t
    t.innies = []
    t.outies = []
    t.succ = []
    t.prev = t.body.prev
    t.teth = t.body.teth
  })
}

function have_successors(env) {
  env.shapes[TWIST]?.forEach(t => {
    if (!t.prev || !Array.isArray(t.prev.succ)) return
    t.prev.succ.push(t)
  })
}

function get_hitched(env) {
  env.shapes[BODY]?.forEach(b => {
    // Body's rigs slot can point at a non-pairtrie atom in "invalid_rigging"
    // fixtures (test rigs designed to wire the rigs hash at a non-trie
    // shape). Skip those — there are no rig pairs to walk.
    if (!b.rigtrie || !b.rigtrie.pairs) return
    b.rigtrie.pairs.forEach(pair => {
      let t = b.twist
      let meet = pair[1]
      if (!meet || meet.shape !== TWIST) return
      if (pair[0].hash) return t.outies.push([meet, 'post'])
      let lead = fastprev(meet)
      if (!lead) return
      t.outies.push([lead, 'lead'])
      t.outies.push([meet, 'meet'])
      lead.innies.push([t, 'leadup'])
      meet.innies.push([t, 'meetup'])
    })
  })
}

function fastprev(t) {
  while (t.prev) {
    if (t.prev.teth) return t.prev
    t = t.prev
  }
  return 0
}

function body_building(env) {
  env.shapes[TWIST]?.forEach(t => {
    t.innies = t.innies.concat(t.succ.map(h => [h, 'succ']))
    t.outies = t.outies.concat(
      [[t.body.prev, 'prev'], [t.body.teth, 'teth']].filter(([a]) => a))
    let twists = get_twists(t.body.cargooo)
    twists.forEach(t1 => {
      t.outies.push([t1, 'cargo'])
      t1.innies.push([t, 'cargoup'])
    })
  })
}

function get_twists(a) {
  if (!a) return []
  if (a.shape === TWIST) return [a]
  if (a.shape === HASHLIST) return a.list.flatMap(x => get_twists(x))
  if (a.shape === PAIRTRIE) return a.pairs.flatMap(([k,v]) => get_twists(k).concat(get_twists(v)))
  return []
}

function get_in_line(env) {
  env.shapes[TWIST]?.forEach(t => {
    [t.first, t.findex] = get_first(t)
    if (!t.findex) env.firsts.push(t)
  })
}

function get_first(a) {
  if (!a.prev) return [a, 0]
  if (a.prev.first) return [a.prev.first, a.prev.findex + 1]
  return (([x, n]) => [x, n + 1])(get_first(a.prev))
}

function y_the_first_twist(env) {
  env.firsts.forEach((t, i) => t.y = i + 1.5)
}

function stack_lines(env) {
  env.firsts.forEach((t, i) => {
    let min_tether = env.shapes[TWIST].filter(a => a.first === t)
      .reduce((acc, a) => Math.min(acc, a.teth?.first?.y || Infinity), Infinity)
    if (min_tether < t.y)
      t.y = +((min_tether + '').slice(0, -1) + '0' + (i + 1))
  })
  env.firsts.sort((a, b) => a.y - b.y).forEach((t, i) => t.y = i + 0.5)
}

function plonk_twists(env) {
  let x = 0, gas = 5000000, mind = 20
  let lines = env.firsts.slice().reverse()
  while (lines.length) {
    lines = lines.map(t => {
      if (gas-- <= 0 || t.outies.every(o => o[0].x)) {
        t.x = x += mind
        t = t.succ[0]
      }
      return t
    }).filter(t => t)
  }
}

// ---- canonical serialization ----------------------------------------------
//
// After layout, env.shapes[TWIST] holds every twist with .x set (sometimes
// 0 if it never reached the head of the queue — preserve those too so a
// drift that introduces a stranded twist shows up). We sort by (x, y),
// reassign indices in sort order, rewrite edge endpoints to use those
// indices, then sort edges within each twist by (type, to-index). The
// resulting JSON is canonical: identical bytes → identical string.

const EMIT_EDGE_TYPES = new Set(['prev', 'teth', 'lead', 'meet', 'post', 'cargo', 'succ'])

function canonicalize(env) {
  let twists = (env.shapes[TWIST] || []).slice()
  // Sort by (x asc, y asc). y is sourced from first.y * 2 to convert the
  // i+0.5 grid into integers without losing relative order. x is already
  // a multiple of mind=20 (integer).
  twists.sort((a, b) => {
    let dx = (a.x || 0) - (b.x || 0)
    if (dx !== 0) return dx
    return ((a.first?.y || 0) - (b.first?.y || 0))
  })

  let idx_of = new Map()
  twists.forEach((t, i) => idx_of.set(t, i))

  let nodes = twists.map((t, i) => ({
    i,
    x: t.x | 0,
    y: Math.round((t.first?.y || 0) * 2),
  }))

  let edges = []
  twists.forEach((t, i) => {
    let typed = []
    // outies: forward edges, drop reverse tags (leadup/meetup/cargoup
    // duplicate information from the forward edge).
    t.outies?.forEach(([target, type]) => {
      if (!EMIT_EDGE_TYPES.has(type)) return
      let j = idx_of.get(target)
      if (j === undefined) return
      typed.push({ from: i, to: j, type })
    })
    // succ is a derived forward edge — included for completeness; it's
    // an alias for the inverse of `prev`, but useful to keep so a
    // missing successor link surfaces.
    t.succ?.forEach(s => {
      let j = idx_of.get(s)
      if (j === undefined) return
      typed.push({ from: i, to: j, type: 'succ' })
    })
    typed.sort((a, b) => {
      if (a.type !== b.type) return a.type < b.type ? -1 : 1
      return a.to - b.to
    })
    edges.push(...typed)
  })

  return JSON.stringify({ twists: nodes, edges })
}
