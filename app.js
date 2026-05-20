//  ______    _________
// / ___/ |  / / ____(_)__ _      _____  _____
// \__ \| | / / / __/ / _ \ | /| / / _ \/ ___/
//___/ /| |/ / /_/ / /  __/ |/ |/ /  __/ /
//____/ |___/\____/_/\___/|__/|__/\___/_/
//
// Adapted for the rigging workshop. Same pipeline as svgiewer; the DOM
// bindings target this app's panels (#viz, #rigcheck, #meta) and a
// `workshop:rendered` event fires when the pipeline finishes so hex.js can
// repaint.

import { Atoms } from './src/core/atoms.js'
import { Interpreter } from './src/core/interpret.js'
import { Line } from './src/core/line.js'
import { Twist } from './src/core/twist.js'
import { Hash } from './src/core/hash.js'
import { rels } from './rels.js'
import { SECP256r1 } from './src/client/secp256r1.js'
import { Abject } from './src/abject/abject.js'
import { DelegableActionable } from './src/abject/actionable.js'
import { DQ } from './src/abject/quantity.js'  // registers DQ interpreter

const TWIST = 0x48
const BODY  = 0x49
const ARB   = 0x60
const PAIRTRIE = 0x63
const HASHLIST = 0x61
const el = document.getElementById.bind(document)
const vp = el('viz')                         // svg canvas
let env = {}

let showpipe = pipe( buff_to_env
                   , start_timer
                   , buff_to_rough
                   , unroll_lists
                   , unzip_tries
                   , untwist_bodies
                   , twist_list
                   , have_successors
                   , get_hitched
                   , body_building
                   , get_in_line
                   , y_the_first_twist
                   , stack_lines
                   , stack_lines
                   , build_segments
                   , plonk_twists
                   , decorate_twists
                   , end_timer
                   , set_limits
                   , render_svg
                   , select_focus
                   , write_stats
                   , notify_rendered
                   )

function buff_to_env(buff) {
    env = {buff, atoms:[], dupes:[], index:{}, shapes:{}, errors:[], firsts:[], vp:{x:0,y:0,s:1}, emojis:0, emhx:1}
    window.env = env
    return env
}

function start_timer(env) {
    env.time = {start: performance.now()}
    return env
}

function buff_to_rough(env) {
    let i = 0, b = env.buff, lb = b.byteLength

    while(i < lb) {
        let afirst = i
        let hash = pluck_hash(b, i)
        if(!hash) {
            env.errors.push({afirst, message: "Improper atom"})
            return env
        }
        i += hash.length/2
        let pfirst = i

        let shape = parseInt(pluck_hex(b, i++, 1), 16)

        let length = pluck_length(b, i)
        i += 4 + length

        let atom = {shape, hash, bin: {length, afirst, pfirst, cfirst: pfirst+5, last: i-1}}
        if(env.index[hash]) {
            env.dupes.push(atom)
            continue
        }
        env.atoms.push(atom)
        env.index[hash] = atom
        ;(env.shapes[shape]||=[]).push(atom)
    }

    return env
}

function unroll_lists(env) {
    env.shapes[HASHLIST]?.forEach(hl => {
        hl.list = []
        for (let i = hl.bin.cfirst; i < hl.bin.last;) {
            let k = pluck_hash(env.buff, i)
            i += leng(k)
            hl.list.push(env.index[k] || k)
        }
    })
    return env
}

function unzip_tries(env) {
    env.shapes[PAIRTRIE]?.forEach(trie => {
        trie.pairs = []
        for (let i = trie.bin.cfirst; i < trie.bin.last;) {
            let k = pluck_hash(env.buff, i)
            i += leng(k)
            let v = pluck_hash(env.buff, i)
            i += leng(v)
            trie.pairs.push([env.index[k] || k, env.index[v] || v])
        }
    })
    return env
}

function untwist_bodies(env) {
    env.shapes[BODY]?.forEach(b => {
        let i = b.bin.cfirst
        let p = pluck_hash(env.buff, i)
        b.prev = env.index[p] || 0
        if(p && !b.prev) b.prevhash = p
        let t = pluck_hash(env.buff, (i += leng(p)))
        b.teth = env.index[t] || 0
        if(t && !b.teth) b.tethhash = t
        b.shld = pluck_hash(env.buff, (i += leng(t)))
        b.reqs = pluck_hash(env.buff, (i += leng(b.shld)))
        b.rigs = pluck_hash(env.buff, (i += leng(b.reqs)))
        b.carg = pluck_hash(env.buff, (i += leng(b.rigs)))
        b.rigtrie = env.index[b.rigs] || 0
        b.cargooo = env.index[b.carg] || 0
    })
    return env
}

function twist_list(env) {
    env.shapes[TWIST]?.forEach(t => {
        let b = pluck_hash(env.buff, t.bin.cfirst)
        t.body = env.index[b] || 0
        if(!t.body) return 0
        t.body.twist = t
        t.sats_h = pluck_hash(env.buff, t.bin.cfirst + leng(b))
        t.innies = []
        t.outies = []
        t.succ = []
        t.prev = t.body.prev
        t.teth = t.body.teth
    })
    return env
}

function have_successors(env) {
    env.shapes[TWIST]?.forEach(t => {
        // Skip when prev isn't a real twist with a successor list — happens
        // for "dangling" prevs in TRDL "missing" rigs, where the body's
        // prev hash points to an arb placeholder instead of a twist atom.
        if(!t.prev || !Array.isArray(t.prev.succ)) return 0
        t.prev.succ.push(t)
        if(t.prev.succ.length > 1)
            env.errors.push({twist: t, message: `Equivocation in "${t.prev.hash}"`})
    })
    return env
}

function get_hitched(env) {
    env.shapes[BODY]?.forEach(b => {
        if(!b.rigtrie) return 0
        b.rigtrie.pairs.forEach(pair => {
            let t = b.twist
            let meet = pair[1]
            if(!meet || meet.shape != TWIST) return 0
            if(pair[0].hash)
                return t.outies.push([meet, 'post'])
            let lead = fastprev(meet)
            if(!lead) return 0
            t.outies.push([lead, 'lead'])
            t.outies.push([meet, 'meet'])
            lead.innies.push([t, 'leadup'])
            meet.innies.push([t, 'meetup'])
        })
    })
    return env
}

function body_building(env) {
    env.shapes[TWIST]?.forEach(t => {
        t.innies = t.innies.concat(t.succ.map(h => [h, "succ"]))
        t.outies = t.outies.concat([[t.body.prev, "prev"], [t.body.teth, "teth"]].filter(([a,b]) => a))
        // Reverse-tether: from the fastener (the topline twist this
        // tethered twist points up at), let consumers walk back down
        // to this twist. Mirrors the succ-as-prev-reverse handling
        // above. Arrow-key nav uses this to navigate from a corkline
        // twist down to the leadlines that tether to it.
        if (t.body.teth) t.body.teth.innies.push([t, "tethdown"])

        let twists = get_twists(t.body.cargooo)
        twists.forEach(t1 => {
            t.outies.push([t1, "cargo"])
            t1.innies.push([t, "cargoup"])
        })
    })
    return env
}

function get_twists(a) {
    if(!a) return []
    if(a.shape == TWIST) return a
    if(a.shape == HASHLIST) return a.list.flatMap(a => get_twists(a))
    if(a.shape == PAIRTRIE) return a.pairs.flatMap(([a,b]) => get_twists(a).concat(get_twists(b)))
    return []
}

function get_in_line(env) {
    env.shapes[TWIST]?.forEach(t => {
        [t.first, t.findex] = get_first(t)
        if(!t.findex)
            env.firsts.push(t)
    })
    return env
}

function get_first(a) {
    if (!a.prev)
        return [a, 0]
    else if (a.prev.first)
        return [a.prev.first, a.prev.findex + 1]
    else
        return (([a,b])=>[a,b+1])(get_first(a.prev))
}

function y_the_first_twist(env) {
    env.firsts.forEach((t,i) => t.y = i+1.5)
    return env
}

function stack_lines(env) {
    env.firsts.forEach((t,i) => {
        let min_tether = env.shapes[TWIST].filter(a=>a.first === t)
                            .reduce((acc, a) => Math.min(acc, a.teth?.first?.y||Infinity), Infinity)
        if(min_tether < t.y)
            t.y = +((min_tether + "").slice(0,-1) + "0" + (i+1))
    })
    env.firsts.sort((a,b) => a.y - b.y).forEach((t,i) => t.y = i + .5)
    return env
}

function plonk_twists(env) {
    let x = 0, gas = 5000000, mind = 20
    let lines = env.firsts.slice().reverse()
    while(lines.length) {
        lines = lines.map(t => {
            if(gas-- <= 0 || t.outies.every(t=>t[0].x)) {
                t.x = x += mind
                let seg = t.segment
                if(seg?.collapsed && t === seg.first && seg.twists.length > 2) {
                    for(let i = 1; i < seg.twists.length - 1; i++)
                        seg.twists[i].x = t.x
                    t = seg.last
                } else {
                    t = t.succ[0]
                }
            }
            return t
        }).filter(t => t)
    }
    return env
}

function decorate_twists(env) {
    env.shapes[TWIST]?.forEach(t => {
        t.cx = t.x
        t.cy = 400 - t.first.y * 30
        t.colour = t.first.hash.slice(2, 8)
    })
    return env
}

const MIN_COLLAPSE = 3

function build_segments(env) {
    let edgeTargets = new Set()
    env.shapes[TWIST]?.forEach(t => {
        t.outies.forEach(([target, type]) => {
            if(type !== 'prev') edgeTargets.add(target)
        })
    })

    env.segments = []
    env.segIndex = {}

    function isInteresting(t) {
        return edgeTargets.has(t) || t.outies.some(([_, type]) => type !== 'prev')
    }

    env.firsts.forEach(first => {
        let t = first, seg = []
        while(t) {
            if(isInteresting(t)) {
                if(seg.length) pushSeg(seg)
                pushSeg([t])
                seg = []
            } else {
                seg.push(t)
            }
            t = t.succ[0]
        }
        if(seg.length) pushSeg(seg)
    })

    function pushSeg(twists) {
        let s = { twists, collapsed: twists.length >= MIN_COLLAPSE,
                  first: twists[0], last: twists[twists.length - 1],
                  id: 'seg_' + twists[0].hash.slice(0, 16) }
        twists.forEach(t => t.segment = s)
        env.segments.push(s)
        env.segIndex[s.id] = s
    }

    return env
}

function end_timer(env) {
    env.time.end = performance.now()
    return env
}

function set_limits(env) {
    let l = env.limits = {minx: Infinity, manx: -Infinity, miny: Infinity, many: -Infinity}
    env.shapes[TWIST]?.forEach(t => {
        if (t.cx < l.minx) l.minx = t.cx;
        if (t.cx > l.manx) l.manx = t.cx;
        if (t.cy < l.miny) l.miny = t.cy;
        if (t.cy > l.many) l.many = t.cy;
    })
    return env
}

function render_svg(env) {
    // Toggle a density class on the viz wrapper so the highlight CSS can
    // scale with twist count — the glow that looks great at ~100 twists is
    // comically oversized at 6 and overlaps neighbours at 300+.
    let wrap = vp?.parentElement
    if (wrap) {
        let n = env.shapes[TWIST]?.length || 0
        wrap.classList.toggle('compact', n < 30)
        wrap.classList.toggle('dense',   n >= 200)
    }
    let svgs = '', edgestr = '', edges = []
    let order = ['prev', 'teth', 'lead', 'meet', 'post', 'cargo']
    env.shapes[TWIST]?.forEach(t => {
        if(!t.cx) return 0
        let seg = t.segment
        if(seg?.collapsed && t !== seg.first && t !== seg.last)
            return 0
        // Per-twist group with concentric status rings. Each ring is
        // hidden by default and made visible when the group carries
        // the matching class (.focus / .select / .highlight / .cork /
        // .issue-*). Ascending radii from inner→outer so they stack
        // visibly when several statuses apply at once. The hit-zone
        // circle on top catches pointer events for the whole twist
        // (the small inner dot would be a fiddly click target).
        svgs += `<g class="twist-group" id="${t.hash}">` +
                `<circle class="ring ring-issue"     cx="${t.cx}" cy="${t.cy}" r="17" fill="none"/>` +
                `<circle class="ring ring-cork"      cx="${t.cx}" cy="${t.cy}" r="14" fill="none"/>` +
                `<circle class="ring ring-highlight" cx="${t.cx}" cy="${t.cy}" r="11.5" fill="none"/>` +
                `<circle class="ring ring-select"    cx="${t.cx}" cy="${t.cy}" r="9" fill="none"/>` +
                `<circle class="ring ring-focus"     cx="${t.cx}" cy="${t.cy}" r="7" fill="none"/>` +
                `<circle class="dot"                 cx="${t.cx}" cy="${t.cy}" r="5" fill="#${t.colour}"/>` +
                `<circle class="hit"                 cx="${t.cx}" cy="${t.cy}" r="9" fill="transparent"/>` +
                `</g>`
        // Equivocation marker.
        if (Array.isArray(t.succ) && t.succ.length > 1) {
            svgs += `<text class="viz-conflict" x="${t.cx + 7}" y="${t.cy - 5}" ` +
                    `font-size="11" pointer-events="none">` +
                    `<title>${t.succ.length} conflicting successors</title>⚠</text>`
        }
        edges = edges.concat(t.outies.map(o => [t, o[0], o[1]]))
    })
    edges.sort((a,b) => order.indexOf(a[2]) - order.indexOf(b[2]))
         .forEach(e => {
        let s1 = e[0].segment, s2 = e[1].segment
        if(s1?.collapsed && s1 === s2) return 0
        let fx = e[0].cx, fy = e[0].cy, tx = e[1].cx, ty = e[1].cy
        if(!(fx && fy && tx && ty)) return 0
        let dashed = e[0].cx < e[1].cx ? 'dashed' : ''
        // data-from / data-to let the hover handler light up edges
        // connected to the currently-highlighted twist(s).
        let endpoints = `data-from="${e[0].hash}" data-to="${e[1].hash}"`
        if(e[2] === 'teth')
            edgestr += `<path d="M ${fx} ${fy} Q ${(fx+tx+tx)/3} ${(ty+fy)/2} ${tx} ${ty}" class="${e[2]} ${dashed}" ${endpoints}/>`
        else if(e[2] === 'lead' || e[2] === 'meet')
            edgestr += `<path d="M ${fx} ${fy} Q ${(fx+fx+tx)/3} ${(ty+fy)/2} ${tx} ${ty}" class="${e[2]} ${dashed}" ${endpoints}/>`
        else
            edgestr += `<path d="M ${fx} ${fy} ${tx} ${ty}" class="${e[2]} ${dashed}" ${endpoints}/>`
    })

    env.segments?.forEach(seg => {
        if(!seg.collapsed) return
        let f = seg.first, l = seg.last
        if(!f.cx || !l.cx) return
        edgestr += `<path d="M ${f.cx} ${f.cy} ${l.cx} ${l.cy}" class="prev" data-from="${f.hash}" data-to="${l.hash}"/>`
        let mx = (f.cx + l.cx) / 2, my = f.cy
        svgs += `<circle cx="${mx}" cy="${my}" r="8" fill="#${f.colour}" id="${seg.id}" opacity="0.6" style="pointer-events:auto;cursor:pointer"/>`
        svgs += `<text x="${mx}" y="${my + 3}" text-anchor="middle" font-size="7" fill="#000" style="pointer-events:none">${seg.twists.length}</text>`
    })

    vp.innerHTML = '<g id="gtag" style="will-change:transform">' + edgestr + svgs + '</g>'
    fit_to_view(env)
    return env
}

function fit_to_view(env) {                  // auto-center + scale to viewport
    let l = env.limits
    if(!isFinite(l.minx) || !isFinite(l.manx)) return
    let pad = 30
    let bw = (l.manx - l.minx) || 1, bh = (l.many - l.miny) || 1
    let s = Math.min(vp.clientWidth / (bw + pad*2), vp.clientHeight / (bh + pad*2), 4)
    env.vp.s = s
    scroll_to((l.minx + l.manx) / 2, (l.miny + l.many) / 2)
}

function select_focus(env) {
    if(!env.shapes[TWIST] || !env.shapes[TWIST].length) return env
    env.focus = env.shapes[TWIST][env.shapes[TWIST].length-1]
    let seg = env.focus.segment
    if(seg?.collapsed) seg.collapsed = false
    el(env.focus.hash)?.classList.add('focus')
    return env
}

function write_stats(env) {
    let twistCount = env.shapes[TWIST]?.length || 0
    let dt = (env.time.end - env.time.start).toFixed(0)
    let bytes = env.buff.byteLength.toLocaleString()
    let metaEl = el('meta')
    if(metaEl) {
        let parts = [`${bytes} B`, `${env.atoms.length} atoms`, `${twistCount} twists`]
        if(env.dupes.length) parts.push(`${env.dupes.length} dupes`)
        if(env.errors.length) parts.push(`${env.errors.length} err`)
        parts.push(`${dt}ms`)
        metaEl.textContent = parts.join(' · ')
    }
    let head = el('viz-meta')
    if(head) head.textContent = `${env.firsts.length} lines · ${twistCount} twists · ${env.errors.length} errors`
    return env
}

function notify_rendered(env) {
    document.dispatchEvent(new CustomEvent('workshop:rendered', {detail: env}))
    // Default the corkline to the top-leftmost twist for any rig that
    // didn't come with a sidecar-declared corkline and hasn't been
    // user-overridden by a shift-click. decorate_twists assigns
    // cy = 400 - t.first.y * 30, so LARGER t.y → higher on screen;
    // the topmost line has the maximum y, and within it the leftmost
    // twist has the minimum x.
    //
    // Compile's own corkline_h (from build() in editor.js) is NOT
    // authoritative here — decompile can pick a non-canonical poptop
    // for unusual rigs, and the user's mental model is the visual
    // top-left, not whatever the recompile chose.
    let src = window.workshop?.corkline_source
    if (src !== 'sidecar' && src !== 'user') {
        let twists = env.shapes?.[TWIST] || []
        let cork = null, best_y = -Infinity, best_x = Infinity
        for (let t of twists) {
            if (t.y == null || t.x == null) continue
            if (t.y > best_y || (t.y === best_y && t.x < best_x)) {
                best_y = t.y; best_x = t.x; cork = t.hash
            }
        }
        if (cork) {
            window.workshop.corkline = cork
            window.workshop.corkline_source = 'auto'
        }
    }
    apply_cork_dom()
    // Restore prior click-selection by hash (visual only — focus is a
    // separate concept and arrives below).
    let still = _selected_hashes.filter(h => el(h))
    if (still.length) {
        apply_select_dom(still)
    } else {
        _selected_hashes = []
    }
    // Initial focus on this render: prefer the previously-focused
    // twist if still present in the rebuild, otherwise fall back to
    // the bundle's tail twist (env.focus). focus_node paints the
    // .focus ring, updates window.workshop.focus_hash, and triggers
    // the first rig-check. Also seed the selection to the same twist
    // so the highlight hex view has a sensible fallback target
    // before the user clicks or hovers anywhere.
    let prior = window.workshop?.focus_hash
    let initial_focus = (prior && el(prior)) ? prior : env.focus?.hash
    if (initial_focus && !still.length) {
        select_node(initial_focus)
    }
    if (initial_focus) focus_node(initial_focus)
    return env
}


// helpers

let hexes = Array.from(Array(256)).map((_,i)=>i.toString(16).padStart(2, '0'))

function pluck_hex(b, s, l) {
    let hex = ''
    let uints = new Uint8Array(b, s, l)
    for(let i=0; i<l; i++) hex += hexes[uints[i]]
    return hex
}

function pluck_hash(b, s) {
    let l = 0, ha = pluck_hex(b, s, 1)
    if(ha === '41') l = 32
    else if(ha === '22') l = 32
    else return 0
    return ha + pluck_hex(b, s + 1, l)
}

function pluck_length(b, s) {
    let v = new DataView(b, s, 4)
    return v.getUint32()
}

function leng(h) {
    return h ? h.length/2 : 1
}

function fastprev(t) {
    while(t.prev) {
        if (t.prev.teth) return t.prev
        t = t.prev
    }
    return 0
}


function pipe(...funs) {
  function magic_pipe(env={}) {
    let fun, pc=0

    function inner() {
      fun = funs[pc++]
      if(!fun) return 0
      if(fun.async)
        return new Promise(f => fun.async(env, f)).then(cb)
      return cb(fun(env))
    }

    function cb(new_env) {
      env = new_env
      if(env && env.constructor === Promise)
        return env.then(cb)
      return inner()
    }

    return cb(env)
  }

  return magic_pipe
}


// DOM things — pan/zoom on the SVG canvas

if(vp) {
    vp.addEventListener('wheel', e => {
        let ds = (201+Math.max(-200, Math.min(200, e.deltaY)))/200
        let s = Math.max(0.02, Math.min(200, env.vp.s * ds))
        env.vp.s = s
        scroll_to(env.vp.x, env.vp.y)
        return e.preventDefault() || false
    })

    let panning=false
    vp.addEventListener('mousedown', e => panning = true)
    vp.addEventListener('mouseup', e => panning = false)
    vp.addEventListener('mouseleave', e => panning = false)
    vp.addEventListener('click', e => {
        // Twist click? Walk up to the .twist-group whose id is the
        // hash. (The dot, rings, and hit-zone are all <circle>s
        // inside the group.) A click on the collapsed-segment marker
        // hits a bare <circle id="seg.id"> outside any group; treat
        // it via env.segIndex below.
        let group_id = e.target.closest?.('.twist-group')?.id
        if (group_id) {
            if (e.shiftKey) {
                window.workshop.corkline = group_id
                window.workshop.corkline_source = 'user'
                apply_cork_dom()
                if (window.workshop.focus_hash) show_abject_info(window.workshop.focus_hash)
                return
            }
            select_node(group_id)
            return
        }
        if (e.target.tagName === 'circle' && env.segIndex?.[e.target.id]) {
            expand_segment(env.segIndex[e.target.id])
        }
    })
    vp.addEventListener('dblclick', e => {
        let group_id = e.target.closest?.('.twist-group')?.id
        if (group_id) focus_node(group_id)
    })
    vp.addEventListener('mousemove', e => {
        let group_id = e.target.closest?.('.twist-group')?.id
        let hashes = group_id ? [group_id] : []
        document.dispatchEvent(new CustomEvent('workshop:hover', {
            detail: { hashes, source: 'viz' }
        }))
        if (panning) scroll_to(env.vp.x - e.movementX / env.vp.s, env.vp.y - e.movementY / env.vp.s)
    })
    vp.addEventListener('mouseleave', () => {
        document.dispatchEvent(new CustomEvent('workshop:hover', {
            detail: { hashes: [], source: 'viz' }
        }))
    })
    // Arrow-key navigation when the viz is keyboard-focused (svg has
    // tabindex="0"). Moves the .select state, not the focus — like
    // click-arrowing through a list rather than retargeting the
    // rig-check on every key press. Left/right walk along the
    // selection's line; up/down follow edges. Active only when #viz
    // owns document.activeElement so the examples-list arrow nav
    // keeps working when that pane is focused.
    vp.addEventListener('keydown', e => {
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return
        let pivot_hash = _selected_hashes[0] || window.workshop?.focus_hash
                                             || env.focus?.hash
        let cur = env.index?.[pivot_hash]
        if (!cur) return
        let next = nearest_twist(env, cur, e.key)
        if (next) {
            e.preventDefault()
            select_node(next.hash)
        }
    })
}

// Pick the next twist relative to `cur` for the given arrow direction.
// Left/right walk along the focused twist's line (same cy). Up/down
// follow connecting edges — outies (this → other) plus innies (other
// → this) — so navigation tracks the rig's actual graph structure
// instead of teleporting across unconnected lines.
function nearest_twist(env, cur, key) {
    let twists = (env.shapes?.[TWIST] || []).filter(t => {
        if (t === cur || t.cx == null || t.cy == null) return false
        let seg = t.segment
        return !(seg?.collapsed && t !== seg.first && t !== seg.last)
    })
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
        let same_line = twists.filter(t => t.cy === cur.cy)
        if (key === 'ArrowLeft') {
            return same_line.filter(t => t.cx < cur.cx)
                .sort((a, b) => b.cx - a.cx)[0]
        }
        return same_line.filter(t => t.cx > cur.cx)
            .sort((a, b) => a.cx - b.cx)[0]
    }
    // Up/down: gather connected twists via outies + innies. Each entry
    // is [otherTwist, edgeType]. Filter to neighbours that are higher
    // (ArrowUp → cy < cur.cy) or lower (ArrowDown → cy > cur.cy);
    // pick the closest in cy, ties broken by x-proximity.
    let neighbours = new Set()
    for (let [other] of (cur.outies || [])) if (other && other.cy != null) neighbours.add(other)
    for (let [other] of (cur.innies || [])) if (other && other.cy != null) neighbours.add(other)
    let dir = key === 'ArrowUp'
        ? n => n.cy < cur.cy
        : n => n.cy > cur.cy
    let candidates = [...neighbours].filter(dir)
    if (!candidates.length) return null
    candidates.sort((a, b) => {
        let dy = Math.abs(a.cy - cur.cy) - Math.abs(b.cy - cur.cy)
        if (dy !== 0) return dy
        return Math.abs(a.cx - cur.cx) - Math.abs(b.cx - cur.cx)
    })
    return candidates[0]
}

document.addEventListener('workshop:hover', e => {
    if(!vp) return
    let hashes = e.detail.hashes || []
    vp.querySelectorAll('.highlight').forEach(c => c.classList.remove('highlight'))
    for (let h of hashes) el(h)?.classList.add('highlight')
    // Also light up every edge that touches one of the hovered twists,
    // so the structural neighbourhood (prev / teth / hitch role) of the
    // selection pops together with the dot itself.
    if (hashes.length) {
        let set = new Set(hashes)
        vp.querySelectorAll('path[data-from], path[data-to]').forEach(p => {
            if (set.has(p.getAttribute('data-from')) ||
                set.has(p.getAttribute('data-to'))) p.classList.add('highlight')
        })
    }
})

document.addEventListener('workshop:select', e => {
    if(!vp || e.detail.source === 'viz') return
    apply_select_dom(e.detail.hashes || [])
})


// Persistent click-select state, kept by hash so it survives a rebuild
// (the SVG re-renders and the old DOM elements get blown away).
let _selected_hashes = []
let _selected_set = new Set()  // currently .select-flagged DOM elements
let _highlighted = null

function relayout(env) {
    env.shapes[TWIST]?.forEach(t => t.x = 0)
    plonk_twists(env)
    decorate_twists(env)
    set_limits(env)
}

function expand_segment(seg) {
    seg.collapsed = false
    let vx = env.vp.x, vy = env.vp.y
    _selected_set.clear(); _highlighted = null
    relayout(env)
    render_svg(env)
    let focus = env.focus?.hash
    if(focus) el(focus)?.classList.add('focus')
    scroll_to(vx, vy)
    select_node(seg.first.hash)
}

// Apply the .cork CSS class to whichever twist circle matches the
// current window.workshop.corkline. Called after a render, after a
// shift-click override, and any other time the cork hash changes. The
// class is independent of .select / .highlight / .focus so the user
// can see all four states at once.
function apply_cork_dom() {
    if (!vp) return
    vp.querySelectorAll('.cork').forEach(c => c.classList.remove('cork'))
    let cork = window.workshop?.corkline
    if (cork) el(cork)?.classList.add('cork')
}

// Paint a per-colour issue layer on every twist named in rust's
// structured tree, including the green ones — they show the rig's
// healthy structure alongside the broken bits. Edges only paint for
// non-green twists, and only the edge types the structype maps to
// (e.g. a 'lead' failure paints the lead's teth/lead/meet edges
// rather than every edge touching the lead twist). Tooltips on each
// circle aggregate every structype reference for that hash.
//
// Listener fires on every rust check; an empty payload clears stale
// paint from a previous fixture.
document.addEventListener('workshop:issue', e => {
    if (!vp) return
    // Clear all four classes on both circles and edges.
    vp.querySelectorAll('.issue-bad, .issue-warn, .issue-ok').forEach(n => {
        n.classList.remove('issue-bad', 'issue-warn', 'issue-ok')
        n.removeAttribute('data-issue-tooltip')
    })
    let issues = e.detail?.issues || []
    if (!issues.length) return
    // Per-hash: collapse multiple structype references into one tooltip
    // and one colour class (worst wins: bad > warn > ok).
    let by_hash = new Map()
    for (let i of issues) {
        let entry = by_hash.get(i.hash) || { worst: 'ok', lines: [], structypes: [] }
        let rank = { ok: 0, warn: 1, bad: 2 }
        let mycol = i.colour === 'red'   ? 'bad'
                  : i.colour === 'yellow' ? 'warn'
                  : 'ok'
        if (rank[mycol] > rank[entry.worst]) entry.worst = mycol
        entry.lines.push(`${i.structype} [${i.colour}] ${i.issue || ''} ${i.detail || ''}`.trim())
        entry.structypes.push({ structype: i.structype, colour: i.colour })
        by_hash.set(i.hash, entry)
    }
    for (let [hash, entry] of by_hash) {
        let circle = el(hash)
        if (!circle) continue
        circle.classList.add('issue-' + entry.worst)
        circle.setAttribute('data-issue-tooltip', entry.lines.join('\n'))
    }
    // Edges: only paint the ones whose TYPE matches the structype's
    // role at the implicated twist. Two passes by severity so a 'bad'
    // edge wins over an overlapping 'warn'.
    for (let severity of ['warn', 'bad']) {
        for (let i of issues) {
            let sev = i.colour === 'red'    ? 'bad'
                    : i.colour === 'yellow' ? 'warn'
                    : null
            if (sev !== severity) continue
            let edge_types = ISSUE_EDGES_BY_STRUCTYPE[i.structype]
            if (!edge_types || !edge_types.length) continue
            for (let etype of edge_types) {
                vp.querySelectorAll(`path.${etype}[data-from="${i.hash}"]`).forEach(p => {
                    p.classList.remove('issue-warn', 'issue-bad')
                    p.classList.add('issue-' + sev)
                })
            }
        }
    }
})

// Apply .select to the given hashes (clearing any previous selection).
// Pure DOM update — does NOT run a rig-check. Focus + rig-check are
// driven by focus_node (double-click), kept separate from selection
// so a single click can't accidentally retarget the checker pipeline.
function apply_select_dom(hashes) {
    _selected_hashes = [...hashes]
    _selected_set.forEach(d => d.classList.remove('select'))
    _selected_set.clear()
    for (let h of hashes) {
        let dom = el(h)
        if (dom) {
            dom.classList.add('select')
            _selected_set.add(dom)
        }
    }
}

function select_node(id) {
    let t = env.index?.[id]
    if(!t) return 0
    let seg = t.segment
    if(seg?.collapsed && t !== seg.first && t !== seg.last)
        return expand_segment(seg)
    apply_select_dom([id])
    document.dispatchEvent(new CustomEvent('workshop:select', {
        detail: { hashes: [id], source: 'viz' }
    }))
}

// Set THE focus — singular — to the named twist. Repaints the .focus
// ring (clearing any prior), updates window.workshop.focus_hash so
// other callers (the cork shift-click handler, the rust-check pipeline)
// can find it, runs the rig-check against the new focus, and
// broadcasts a workshop:focus event so other panes (the hex 'focused'
// view) can sync.
function focus_node(id) {
    let t = env.index?.[id]
    if (!t) return
    let seg = t.segment
    if (seg?.collapsed && t !== seg.first && t !== seg.last)
        return expand_segment(seg)
    if (!vp) return
    vp.querySelectorAll('.focus').forEach(d => d.classList.remove('focus'))
    el(id)?.classList.add('focus')
    if (!window.workshop) window.workshop = {}
    window.workshop.focus_hash = id
    show_abject_info(id)
    document.dispatchEvent(new CustomEvent('workshop:focus', { detail: { hash: id } }))
}

function highlight_node(id) {                // legacy single-node entry point
    document.dispatchEvent(new CustomEvent('workshop:hover', {
        detail: { hashes: id ? [id] : [], source: 'viz' }
    }))
}

// Hash literals inside the rust rig-check JSON are rendered as
// .rc-hash spans (see pretty_json_with_hash_links above). Wire them
// into the same hover/select/focus model that the viz uses, so the
// user can chase a reference from the failure tree right into the
// graph. Delegated handlers on the rig-check pane.
let _rc_host = el('rigcheck')
if (_rc_host) {
    _rc_host.addEventListener('mouseover', e => {
        let span = e.target.closest('.rc-hash')
        if (!span) return
        document.dispatchEvent(new CustomEvent('workshop:hover', {
            detail: { hashes: [span.dataset.hash], source: 'rigcheck' },
        }))
    })
    _rc_host.addEventListener('mouseout', e => {
        // mouseout fires per-span; only clear hover when the cursor truly
        // left every span — checked via relatedTarget. If it's still on a
        // span (e.g., crossed to an adjacent .rc-hash) the next mouseover
        // will repaint correctly anyway.
        if (e.relatedTarget?.closest?.('.rc-hash')) return
        document.dispatchEvent(new CustomEvent('workshop:hover', {
            detail: { hashes: [], source: 'rigcheck' },
        }))
    })
    _rc_host.addEventListener('click', e => {
        let span = e.target.closest('.rc-hash')
        if (!span) return
        // Plain click → select. Double-click is handled below; the
        // browser fires both click AND dblclick on a fast double, so
        // the dblclick handler stops propagation and we never reach
        // here in that path.
        e.stopPropagation()
        select_node(span.dataset.hash)
    })
    _rc_host.addEventListener('dblclick', e => {
        let span = e.target.closest('.rc-hash')
        if (!span) return
        e.stopPropagation()
        focus_node(span.dataset.hash)
    })
}

function scroll_to(x, y) {
    env.vp.x = x
    env.vp.y = y
    let tx = -x * env.vp.s + vp.clientWidth / 2
    let ty = -y * env.vp.s + vp.clientHeight / 2
    set_transform(tx, ty, env.vp.s)
}

let _raf = 0, _tx = 0, _ty = 0, _ts = 1
function set_transform(x, y, s) {
    _tx = x; _ty = y; _ts = s
    if(_raf) return
    _raf = requestAnimationFrame(() => {
        _raf = 0
        let g = el('gtag')
        if(!g) return
        g.style.transform = `translate(${_tx}px,${_ty}px) scale(${_ts})`
    })
}

// Subclass that supports half-hitch test rigs in this workshop's example
// set. Two relaxations vs canonical:
//   1. Test rigs use post:"none" to model the last hitch on a corkline
//      (e.g. rigs/1-splice-no-post). The canonical hitchPost throws
//      MissingPostEntry whenever a post twist exists but carries no rig
//      entry pointing back at the lead. We treat that case as "no post"
//      and return null, which lets the hitch pass as a half-hitch.
//   2. Once half-hitches are allowed mid-line, the recursive walk-back can
//      reach a twist whose prev() exists but has no prior tethered twist
//      (start of a tether chain). The canonical null-derefs there because
//      its "must be full hitch" check would have short-circuited first;
//      we null-guard and stop the recursion. We also skip that full-hitch
//      check itself, since the whole point of the relaxation is to permit
//      half-hitches.
class HalfHitchInterpreter extends Interpreter {
    constructor(...args) {
        super(...args)
        // Cycle guard. Some test rigs (e.g. rigs/29 with intentional tether
        // loops) cause _verifyHitchLine to recurse back through the same
        // (lead, optLastSupported) state, freezing the page. We dedupe.
        this._visited = new Set()
    }
    hitchPost(hash) {
        let meet = this.hitchMeet(hash)
        let post = this.nextTetheredTwist(meet.hash)
        if (!post) return null
        let hoistHash = post.rig(hash)
        if (!hoistHash) return null                // treat missing entry as "no post"
        if (hoistHash.equals(this.hitchHoist(hash).hash)) return post
        throw new Error('post rig entry conflict')
    }
    async _verifyHitchLine(unverifiedFast, optLastSupported, optFirst) {
        let key = String(unverifiedFast) + '|' + String(optLastSupported)
        if (this._visited.has(key)) return         // already verified this state
        this._visited.add(key)
        await this._verifyHitch(unverifiedFast)
        if (optLastSupported && this.inSegment(unverifiedFast,
            this.nextTetheredTwist(unverifiedFast).hash, optLastSupported)) {
            return
        }
        // Twist.prev() throws MissingPrevError when the prev hash isn't in
        // the atoms — happens for incomplete .toda fixtures. Treat it as
        // "no prev" and stop the walk-back rather than letting it surface
        // as a workshop-level rig-check failure.
        let hasPrev = false
        try { hasPrev = !!this.twist(unverifiedFast).prev() } catch {}
        if (hasPrev) {
            let prevFast = this.prevTetheredTwist(unverifiedFast)
            if (prevFast) {
                return this._verifyHitchLine(prevFast.hash, optLastSupported, false)
            }
        }
    }
}

async function check_rigs(line, corklineHash, twistHash) {
    let interp = new HalfHitchInterpreter(line, corklineHash)
    await interp.verifyTopline()
    await interp.verifyHitchLine(twistHash)
}

// Each checker is independent — given a context with the .toda bytes plus
// a few derived shapes (svgiewer Twist, hash hex strings), it returns
// { state, detail }. Adding a third checker (e.g. toda-bb via SCI or via
// a second server endpoint) is one entry in this list.
const CHECKERS = [
    {
        id: 'js',
        label: 'js · todajs',
        async run(ctx) {
            try {
                let line   = Line.fromTwist(ctx.twist)
                let interp = new HalfHitchInterpreter(line, ctx.corklineHash)
                await interp.verifyTopline()
                await interp.verifyHitchLine(ctx.twistHash)
                return { state: 'ok', detail: 'verified' }
            } catch (e) {
                // Spec §9.1.3 (p.30): MISSING / UNKNOWN issues are yellow,
                // INVALID / MISMATCH issues are red. svgiewer/src names a
                // few INVALID-class invariant violations with a "Missing"
                // prefix even though all relevant atoms are present and a
                // structural rule was broken. We classify those as red here
                // until the JS hierarchy is cleaned up — see
                // js-rig-checker-surgical-changes.md.
                //
                //   MissingHoistError  — no hoist exists for this lead (e.g.
                //                        hh_tether_null: NULL teth → not fast)
                //   MissingPostEntry   — post twist exists but its rigs lack
                //                        the canonical entry for the lead
                //   MissingSuccessor   — line ends before reaching stop
                //
                // Everything else with a "Missing" prefix (MissingError,
                // MissingHashPacketError, MissingPrevError, MissingPrevious)
                // is a genuine atom-not-in-bundle situation → yellow.
                // MissingPrevious stays yellow only because the wrapper in
                // interpret.js:prev() currently swallows the inner type;
                // see surgical-changes.md §2 for the upstream fix.
                let name = e?.name || e?.constructor?.name || ''
                const JS_INVALID_AS_MISSING = new Set([
                    'MissingHoistError',
                    'MissingPostEntry',
                    'MissingSuccessor',
                ])
                if (JS_INVALID_AS_MISSING.has(name)) {
                    return { state: 'bad', detail: e?.message || String(e) }
                }
                if (/^Missing/.test(name)) {
                    return { state: 'warn', detail: e?.message || String(e) }
                }
                throw e
            }
        },
    },
    {
        id: 'clj',
        label: 'clj · toda-rig-checker',
        // async run(ctx) { return server_check(ctx, 'http://localhost:7878/rigcheck') },
        async run(ctx) { return server_check(ctx, 'https://d2ttoitg64tuy9.cloudfront.net/rigcheck-clj') },
    },
    {
        id: 'bb',
        label: 'clj · toda-bb',
        // async run(ctx) { return server_check(ctx, 'http://localhost:7879/rigcheck-bb') },
        async run(ctx) { return server_check(ctx, 'https://d2ttoitg64tuy9.cloudfront.net/rigcheck-bb') },
    },
    {
        id: 'rust',
        label: 'rust · rustoda',
        async run(ctx) { return rust_check(ctx) },
    },
]

// Shared server-checker driver. The two server endpoints take the same
// shape (.toda bytes body + cork=&twist= query params, returning
// {colour: green|yellow|red}) but live behind different paths because they
// run in separate JVMs (toda-bb's namespaces conflict with toda-core's,
// so they can't share a process).
async function server_check(ctx, base) {
    let url = `${base}?cork=${ctx.corklineHex}&twist=${ctx.twistHex}`
    let res
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: ctx.bytes,
        })
    } catch {
        return { state: 'broke', detail: 'server offline' }
    }
    if (!res.ok) {
        // Server didn't successfully evaluate the rig — broke, not bad.
        // Spec-wise this is in the yellow / unknown bucket per §9.1.3,
        // but we visually distinguish it from a real yellow so the user
        // can see "checker failed to process" cases separately.
        let detail = `HTTP ${res.status}`
        try {
            let err = await res.json()
            detail = err.type && err.message
                ? `${err.type}: ${err.message}`.slice(0, 120)
                : JSON.stringify(err).slice(0, 120)
        } catch (_) { /* body isn't JSON — fall through to status-only */ }
        return { state: 'broke', detail }
    }
    let { colour, trace } = await res.json()
    let state = colour === 'green'  ? 'ok'
              : colour === 'yellow' ? 'warn'
              : 'bad'
    // When the server supplied a structured trace, return it as a JSON
    // string in `detail` so format_check_detail pretty-prints it the
    // same way it does the rust checker's tree (with hash links and
    // structype tints). Older servers that only emit `{colour}` fall
    // through to the bare colour string.
    let detail = trace ? JSON.stringify(trace) : colour
    return { state, detail }
}

// Rust-backed checker. Runs rustoda's `check_rig` inside the page via
// wasm-bindgen — no server, no extra process. Bundle lives at
// toda/rustoda-wasm/ (output of `wasm-pack build --target web` over the
// rustoda crate). Loaded lazily on first invocation so it doesn't slow
// down initial paint. A failed load degrades to a `warn` row instead of
// breaking the panel, mirroring server_check's offline handling.
let _rustoda_load
async function load_rustoda() {
    if (!_rustoda_load) _rustoda_load = (async () => {
        try {
            let mod = await import('./toda/rustoda-wasm/rigcheck.js')
            await mod.default()
            return { mod }
        } catch (e) {
            return { error: e }
        }
    })()
    return _rustoda_load
}
async function rust_check(ctx) {
    let { mod, error } = await load_rustoda()
    if (error) return { state: 'broke', detail: `wasm load failed: ${error.message || error}` }
    try {
        let bytes = ctx.bytes instanceof Uint8Array ? ctx.bytes : new Uint8Array(ctx.bytes)
        // Pass ctx.twistHex as the focus so the rust checker pivots around
        // the user-selected twist, matching the js / clj / bb checkers.
        // Without this it falls back to parse_lat's last-twist heuristic
        // (the CLI default) and reports "rig supports up to X but focus is Y"
        // whenever the user clicks anything other than the file's tail twist.
        let { state, detail } = JSON.parse(mod.check_rig(bytes, ctx.corklineHex, ctx.twistHex))
        // Broadcast structured issues from the rust tree so viz / editor
        // can paint red highlights on the implicated twists. Dispatched
        // here (and not in the panel renderer) so the broadcast lands
        // even when the panel's 'rebuild-same' path short-circuits the
        // render. Always emits an event — green/empty payload clears
        // any stale issue paint from a previous check.
        let issues = state === 'ok' ? [] : extract_rust_issues(detail)
        document.dispatchEvent(new CustomEvent('workshop:issue', {
            detail: { issues, focus: ctx.twistHex },
        }))
        return { state, detail }
    } catch (e) {
        // wasm threw or produced malformed JSON — broke, not bad.
        return { state: 'broke', detail: e.message || String(e) }
    }
}

// Walk rust's structured tree, collecting every node with a reference
// twist — including green ones. Each entry carries the structype so
// the viz can paint edges specifically involved in the failure rather
// than every edge touching the implicated twist. The 'rig' umbrella
// is skipped when it has children (the colour comes from one of them).
function extract_rust_issues(detail_str) {
    if (typeof detail_str !== 'string') return []
    let tree
    try { tree = JSON.parse(detail_str) } catch { return [] }
    let issues = []
    function walk(node) {
        if (!node || typeof node !== 'object') return
        let { structype, colour, reference, issue, detail, children } = node
        let kids = children && Object.values(children)
        let is_leaf = !kids || kids.length === 0
        let skip = structype === 'rig' && !is_leaf
        if (!skip && colour && reference) {
            issues.push({ hash: reference, structype, issue, detail, colour })
        }
        if (kids) for (let k of kids) walk(k)
    }
    walk(tree)
    return issues
}

// Map a structype to the edge types in the viz that participate in
// that role. Used to paint just the edges actually implicated by a
// failure (rather than every edge touching the implicated twist).
// Container structypes (rig / half-hitch / hitch / lash / splice)
// have no edges of their own — the leaves under them carry the
// specifics.
const ISSUE_EDGES_BY_STRUCTYPE = {
    'lead':         ['teth', 'lead', 'meet'],
    'meet':         ['meet', 'teth', 'prev'],
    'post':         ['post', 'prev'],
    'hoist':        ['meet', 'prev', 'post'],
    'fastener':     ['teth', 'lead'],
    'corkline':     ['prev', 'teth'],
    'succession':   ['prev'],
    'topline-key':  [],
    'rig':          [],
    'half-hitch':   [],
    'hitch':        [],
    'lash':         [],
    'splice':       [],
}

function escape_text(s) {
    return String(s).replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')
}

function render_check_row(c, state, badge, detail) {
    // Pretty-print structured JSON details (rust returns its
    // structype/colour/reference tree as a JSON string). Falls back to
    // plain escaped text when detail isn't parseable JSON or isn't an
    // object/array. Call sites append a trailing " · Nms" timing
    // suffix; strip it before parsing so JSON.parse doesn't choke.
    let body = format_check_detail(detail)
    return `<div class="rig-check ${state}" data-checker="${c.id}">` +
           `<span class="badge">${badge}</span>` +
           `<div><span class="rc-source">${c.label}</span> ${body}</div>` +
           `</div>`
}

function format_check_detail(detail) {
    if (typeof detail !== 'string') return escape_text(String(detail ?? ''))
    // Split off the trailing timing suffix " · 12ms" that call sites
    // append. The JSON sits before it; render the JSON pretty and the
    // timing as plain text trailing the <pre>.
    let timing = ''
    let m = detail.match(/\s*·\s*\d+ms\s*$/)
    let body = detail
    if (m) {
        timing = m[0].trim()
        body = detail.slice(0, m.index)
    }
    let trimmed = body.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            let parsed = JSON.parse(trimmed)
            if (parsed && typeof parsed === 'object') {
                let pretty = `<pre class="rc-json">${pretty_json_with_hash_links(parsed)}</pre>`
                return timing ? `${pretty}<span class="rc-timing">${escape_text(timing)}</span>` : pretty
            }
        } catch {}
    }
    return escape_text(detail)
}

// TODA hash literal: algo byte 0x41 (sha-256-trimmed) + 32-byte digest,
// hex-encoded → 66 chars total. The rust check tree carries these in
// 'reference' fields and embeds them in free-text 'detail' messages.
// Two patterns: HASH_FULL_RE anchors the whole string; HASH_RE_GLOBAL
// finds embedded hashes inside larger text. Each call to either uses
// the regex fresh — never depend on lastIndex.
const HASH_FULL_RE   = /^41[0-9a-f]{64}$/i
function hash_re_global() { return /\b41[0-9a-f]{64}\b/gi }

function hash_span(hash) {
    return `<span class="rc-hash" data-hash="${hash}">${escape_text(hash)}</span>`
}

// Wrap any 66-char TODA hash found in a free-text string as a
// rc-hash span. Leaves other text untouched. JSON-escapes the
// non-hash spans separately so the surrounding text doesn't break
// the <pre>.
function linkify_hashes_in_text(s) {
    let out = ''
    let last = 0
    for (let m of s.matchAll(hash_re_global())) {
        out += escape_text(s.slice(last, m.index))
        out += hash_span(m[0])
        last = m.index + m[0].length
    }
    out += escape_text(s.slice(last))
    return out
}

// JSON.stringify-with-2-spaces, but every string value that matches a
// full TODA hash is rendered as a hoverable/clickable span; long
// 'detail' strings have any embedded hashes linkified too. Object
// keys, numbers, booleans, and nulls render exactly as
// JSON.stringify would.
function pretty_json_with_hash_links(value) {
    function emit(v, indent) {
        if (v === null) return 'null'
        if (typeof v === 'boolean') return String(v)
        if (typeof v === 'number') return String(v)
        if (typeof v === 'string') {
            // Full-hash string value → clickable span (with surrounding
            // quotes for JSON parity). Otherwise, look for embedded
            // hashes inside the text (rust's 'detail' often quotes
            // hashes inline like "no candidate hoist on corkline for
            // lead 41abc…").
            if (HASH_FULL_RE.test(v)) return `"${hash_span(v)}"`
            return `"${linkify_hashes_in_text(v)}"`
        }
        if (Array.isArray(v)) {
            if (!v.length) return '[]'
            let next = indent + '  '
            let body = v.map(x => `${next}${emit(x, next)}`).join(',\n')
            return `[\n${body}\n${indent}]`
        }
        if (v && typeof v === 'object') {
            let keys = Object.keys(v)
            if (!keys.length) return '{}'
            let next = indent + '  '
            let body = keys.map(k => `${next}"${escape_text(k)}": ${emit(v[k], next)}`).join(',\n')
            return `{\n${body}\n${indent}}`
        }
        return escape_text(String(v))
    }
    return emit(value, '')
}

function update_check_row(checker_id, state, badge, detail) {
    let host = el('rigcheck')
    if (!host) return
    let row = host.querySelector(`[data-checker="${checker_id}"]`)
    let c   = CHECKERS.find(x => x.id === checker_id)
    if (!row || !c) return
    row.outerHTML = render_check_row(c, state, badge, detail)
}

function bytes_equal(a, b) {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

function results_differ(a, b) {
    if (!a || !b) return true
    return a.state !== b.state || a.detail !== b.detail
}

function badge_for(state) {
    return state === 'ok'    ? 'OK'
         : state === 'warn'  ? 'WARN'
         : state === 'bad'   ? 'FAIL'
         : state === 'broke' ? 'BROKE'
         : '—'
}

// Determine which "pass" we're in for the current render. For .toda loads
// we keep a baseline (the original bytes + the first-pass rig-check
// results) so a lossy decompile→recompile cycle doesn't clobber the
// baseline result; instead we surface the divergence below. The
// load-rig lifecycle clears initial_toda_load whenever the user switches
// rigs, so init being non-null already means "user hasn't moved on".
function classify_pass(ctx) {
    let init = window.workshop?.initial_toda_load
    if (!init) return 'no-init'                         // .trdl / fresh editor / moved on
    if (bytes_equal(ctx.bytes, init.bytes)) {
        if (init.results.size === 0)                   return 'initial'
        // Same bytes but the focus changed (user clicked a different twist
        // in the viz) — the cached per-checker results are for the old
        // focus and need to be re-run for the new one. Cork override
        // (shift-click) also lands here via a different corkline.
        if (init.last_focus !== ctx.twistHex)          return 'initial'
        if (init.last_cork  !== ctx.corklineHex)       return 'initial'
        return 'rebuild-same'
    }
    return 'rebuild-diff'
}

// Rigging Workshop is for single test rigs (TRDL authoring). Abjects and
// large files need multi-rig validation (delegation chains, sub-rigs) which
// belongs in abject-workshop — see abject-workshop.md. Detect and bail out
// rather than running the single-rig checkers and reporting misleading
// per-rig results.
const WORKSHOP_TWIST_LIMIT = 500

// Fail-fast check on raw .toda bytes. Used by editor.js load_bytes BEFORE
// decompile / render run, so abjects and oversized files don't trigger any
// of the expensive pipeline. Returns { twistCount, isAbject, bailReason }.
// bailReason is non-null when the workshop cannot meaningfully handle the
// file — caller should render the banner and stop.
function check_workshop_supported(bytes) {
    let twistCount = 0, isAbject = false
    try {
        let atoms = Atoms.fromBytes(bytes)
        let focusTwist = atoms.focus ? new Twist(atoms, atoms.focus) : null
        twistCount = Line.fromAtoms(atoms).twistList().length
        isAbject = !!(focusTwist && Abject.fromTwist(focusTwist))
    } catch (_e) {
        // Malformed bytes — let the normal pipeline surface the error.
    }
    return { twistCount, isAbject, bailReason: bail_message(twistCount, isAbject) }
}

function bail_message(twistCount, isAbject) {
    if (twistCount > WORKSHOP_TWIST_LIMIT) {
        return {
            label: 'FILE TOO BIG ERROR',
            msg: `Rigging Workshop supports rigs ≤ ${WORKSHOP_TWIST_LIMIT} twists. ` +
                 `This file has ${twistCount}. Use abject-workshop for larger files ` +
                 `(see abject-workshop.md).`,
        }
    }
    if (isAbject) {
        return {
            label: 'ABJECT ERROR',
            msg: `This file looks like an abject. Rigging Workshop only checks ` +
                 `single rigs and does not implement full abject checking ` +
                 `(delegation chains, multi-rig walks). Use abject-workshop for ` +
                 `abjects (see abject-workshop.md).`,
        }
    }
    return null
}

// Defensive check for the show_abject_info path (TRDL author rebuilds; clicks
// after a .toda load). Uses the cached check on initial_toda_load when present;
// otherwise falls back to env.shapes for the count (TRDL-authored rigs aren't
// abjects, so no abject check needed there).
function workshop_bail_reason() {
    let init = window.workshop?.initial_toda_load
    if (init) {
        if (init.workshop_check === undefined) {
            init.workshop_check = check_workshop_supported(init.bytes)
        }
        return init.workshop_check.bailReason
    }
    let twistCount = env.shapes?.[TWIST]?.length || 0
    return bail_message(twistCount, false)
}

function render_workshop_unsupported(rc, info) {
    rc.className = 'rig-check warn'
    rc.innerHTML = `<span class="badge">${escape_text(info.label)}</span>` +
                   `<div>${escape_text(info.msg)}</div>`
}

function show_abject_info(id) {
    let rc = el('rigcheck')
    if (!rc) return
    let bail = workshop_bail_reason()
    if (bail) {
        render_workshop_unsupported(rc, bail)
        return
    }
    let corkline = window.workshop?.corkline
    if (!corkline) {
        rc.className = 'rig-check-list'
        rc.innerHTML = CHECKERS.map(c =>
            render_check_row(c, 'warn', 'N/A', 'No corkline available')).join('')
        return
    }

    let ctx
    try {
        if (!env.abject_atoms) {
            env.abject_atoms = Atoms.fromBytes(new Uint8Array(env.buff))
        }
        let twist = new Twist(env.abject_atoms, id)
        ctx = {
            twist,
            corklineHash: Hash.fromHex(corkline),
            twistHash:    twist.getHash(),
            bytes:        new Uint8Array(env.buff),
            corklineHex:  corkline,
            twistHex:     id,
        }
    } catch (e) {
        // Fatal-for-everyone: can't even build the Twist. Show one error in
        // each row — keeps the panel layout consistent.
        let msg = escape_text((e?.message || String(e)).slice(0, 120))
        rc.className = 'rig-check-list'
        rc.innerHTML = CHECKERS.map(c =>
            render_check_row(c, 'bad', 'FAIL', msg)).join('')
        console.error(e)
        return
    }

    let pass = classify_pass(ctx)

    // Recompile produced the same bytes the user loaded — the first-pass
    // results are still authoritative; clear any stale diff section from
    // an earlier divergent rebuild plus any workshop-status banner left
    // behind by a transient compile error, and otherwise leave the rows
    // alone.
    if (pass === 'rebuild-same') {
        rc.querySelectorAll('[data-section="diff"], [data-section="workshop-status"]')
            .forEach(e => e.remove())
        return
    }

    if (pass === 'rebuild-diff') {
        // Append a divergence note + per-checker rows that differ from the
        // initial pass. Don't touch the initial rows above. Replace any
        // previously-rendered diff section so re-edits show fresh output,
        // and drop any stale workshop-status banner now that we have new
        // results to show.
        let init = window.workshop.initial_toda_load
        rc.querySelectorAll('[data-section="diff"], [data-section="workshop-status"]')
            .forEach(e => e.remove())
        rc.insertAdjacentHTML('beforeend',
            `<div class="rig-diff-note" data-section="diff">` +
            `recompiled bytes differ from the loaded .toda — re-running checkers</div>`)
        // Run all checkers in parallel, render the differing rows in
        // CHECKERS registry order. Pre-Promise.all this appended rows in
        // finish-time order, so the panel reshuffled across re-edits as
        // some checkers warmed up faster than others.
        Promise.all(CHECKERS.map(async c => {
            let t0 = performance.now()
            try {
                let { state, detail } = await c.run(ctx)
                return { c, state, detail, dt: performance.now() - t0 }
            } catch (e) {
                console.error(`[${c.label}]`, e)
                return {
                    c, state: 'bad',
                    detail: (e?.message || String(e)).slice(0, 120),
                    dt: performance.now() - t0,
                }
            }
        })).then(results => {
            for (let { c, state, detail, dt } of results) {
                let init_res = init.results.get(c.id)
                if (!results_differ(init_res, { state, detail })) continue
                rc.insertAdjacentHTML('beforeend',
                    render_check_row(c, state, badge_for(state),
                                     `${detail} · ${dt.toFixed(0)}ms`)
                        .replace('class="rig-check',
                                 'data-section="diff" class="rig-check'))
            }
        })
        return
    }

    // pass === 'initial' or 'no-init': fresh full render.
    // Stash the focus + corkline this pass used so classify_pass can
    // distinguish a click-driven focus change from a same-bytes rebuild.
    if (window.workshop?.initial_toda_load) {
        window.workshop.initial_toda_load.last_focus = ctx.twistHex
        window.workshop.initial_toda_load.last_cork  = ctx.corklineHex
        // A new initial pass invalidates the cached per-checker results
        // (they were for the previous focus/cork).
        if (pass === 'initial') {
            window.workshop.initial_toda_load.results.clear()
        }
    }
    rc.className = 'rig-check-list'
    rc.innerHTML = CHECKERS.map(c =>
        render_check_row(c, '', 'CHECK', 'verifying…')).join('')

    for (let c of CHECKERS) {
        let t0 = performance.now()
        c.run(ctx)
            .then(({state, detail}) => {
                let dt = (performance.now() - t0).toFixed(0)
                update_check_row(c.id, state, badge_for(state), `${detail} · ${dt}ms`)
                // Snapshot the initial pass so future rebuilds can compare.
                if (pass === 'initial') {
                    window.workshop.initial_toda_load.results.set(c.id, {state, detail})
                }
            })
            .catch(e => {
                let dt  = (performance.now() - t0).toFixed(0)
                let msg = escape_text((e?.message || String(e)).slice(0, 120))
                update_check_row(c.id, 'bad', 'FAIL', `${msg} · ${dt}ms`)
                if (pass === 'initial') {
                    window.workshop.initial_toda_load.results.set(c.id, {state: 'bad', detail: msg})
                }
                console.error(`[${c.label}]`, e)
            })
    }
}


// Public API
window.workshop = {
    render(buffer) { return showpipe(buffer) },
    select_node, highlight_node,
    check_supported: check_workshop_supported,
    render_unsupported(info) {
        let rc = el('rigcheck')
        if (rc) render_workshop_unsupported(rc, info)
    },
}
