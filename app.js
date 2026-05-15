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
        svgs += `<circle cx="${t.cx}" cy="${t.cy}" r="5" fill="#${t.colour}" id="${t.hash}" />`
        edges = edges.concat(t.outies.map(o => [t, o[0], o[1]]))
    })
    edges.sort((a,b) => order.indexOf(a[2]) - order.indexOf(b[2]))
         .forEach(e => {
        let s1 = e[0].segment, s2 = e[1].segment
        if(s1?.collapsed && s1 === s2) return 0
        let fx = e[0].cx, fy = e[0].cy, tx = e[1].cx, ty = e[1].cy
        if(!(fx && fy && tx && ty)) return 0
        let dashed = e[0].cx < e[1].cx ? 'dashed' : ''
        if(e[2] === 'teth')
            edgestr += `<path d="M ${fx} ${fy} Q ${(fx+tx+tx)/3} ${(ty+fy)/2} ${tx} ${ty}" class="${e[2]} ${dashed}"/>`
        else if(e[2] === 'lead' || e[2] === 'meet')
            edgestr += `<path d="M ${fx} ${fy} Q ${(fx+fx+tx)/3} ${(ty+fy)/2} ${tx} ${ty}" class="${e[2]} ${dashed}"/>`
        else
            edgestr += `<path d="M ${fx} ${fy} ${tx} ${ty}" class="${e[2]} ${dashed}"/>`
    })

    env.segments?.forEach(seg => {
        if(!seg.collapsed) return
        let f = seg.first, l = seg.last
        if(!f.cx || !l.cx) return
        edgestr += `<path d="M ${f.cx} ${f.cy} ${l.cx} ${l.cy}" class="prev"/>`
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
    // Restore prior click-selection by hash; falls back to env.focus when
    // none of the previously-selected hashes are in this render.
    let still = _selected_hashes.filter(h => el(h))
    if (still.length) {
        apply_select_dom(still)
    } else {
        _selected_hashes = []
        if (env.focus) show_abject_info(env.focus.hash)
    }
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
        if(e.target.tagName === 'circle') {
            let seg = env.segIndex?.[e.target.id]
            if(seg) return expand_segment(seg)
            select_node(e.target.id)
        }
    })
    vp.addEventListener('mousemove', e => {
        let hashes = e.target.tagName === 'circle' ? [e.target.id] : []
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
}

document.addEventListener('workshop:hover', e => {
    if(!vp) return
    let hashes = e.detail.hashes || []
    vp.querySelectorAll('.highlight').forEach(c => c.classList.remove('highlight'))
    for (let h of hashes) el(h)?.classList.add('highlight')
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

// Apply .select to the given hashes (clearing any previous selection).
// Pure DOM update — does NOT broadcast a select event. show_abject_info
// runs against the first hash so the rig-check panel reflects the click.
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
    if (hashes[0]) show_abject_info(hashes[0])
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

function highlight_node(id) {                // legacy single-node entry point
    document.dispatchEvent(new CustomEvent('workshop:hover', {
        detail: { hashes: id ? [id] : [], source: 'viz' }
    }))
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
                // Spec §9.1.3 (p.30): MISSING / UNKNOWN issues are yellow, not
                // red. svgiewer/src exposes the MISSING family via class names
                // beginning with "Missing" (MissingError, MissingHoistError,
                // MissingPrevious, MissingSuccessor, MissingPostEntry,
                // MissingHashPacketError). Map those to warn; let everything
                // else propagate so the outer pipeline still renders FAIL.
                let name = e?.name || e?.constructor?.name || ''
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
        async run(ctx) { return server_check(ctx, 'https://d3myckc3w6ekfv.cloudfront.net/rigcheck-clj') },
    },
    {
        id: 'bb',
        label: 'clj · toda-bb',
        // async run(ctx) { return server_check(ctx, 'http://localhost:7879/rigcheck-bb') },
        async run(ctx) { return server_check(ctx, 'https://d3myckc3w6ekfv.cloudfront.net/rigcheck-bb') },
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
        return { state: 'warn', detail: 'server offline' }
    }
    if (!res.ok) {
        return { state: 'bad',
                 detail: `HTTP ${res.status}: ${(await res.text()).slice(0,120)}` }
    }
    let { colour } = await res.json()
    return {
        state: colour === 'green'  ? 'ok'
             : colour === 'yellow' ? 'warn'
             : 'bad',
        detail: colour,
    }
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
    if (error) return { state: 'warn', detail: `wasm load failed: ${error.message || error}` }
    try {
        let bytes = ctx.bytes instanceof Uint8Array ? ctx.bytes : new Uint8Array(ctx.bytes)
        // Pass ctx.twistHex as the focus so the rust checker pivots around
        // the user-selected twist, matching the js / clj / bb checkers.
        // Without this it falls back to parse_lat's last-twist heuristic
        // (the CLI default) and reports "rig supports up to X but focus is Y"
        // whenever the user clicks anything other than the file's tail twist.
        let { state, detail } = JSON.parse(mod.check_rig(bytes, ctx.corklineHex, ctx.twistHex))
        return { state, detail }
    } catch (e) {
        return { state: 'bad', detail: e.message || String(e) }
    }
}

function escape_text(s) {
    return String(s).replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')
}

function render_check_row(c, state, badge, detail) {
    return `<div class="rig-check ${state}" data-checker="${c.id}">` +
           `<span class="badge">${badge}</span>` +
           `<div><span class="rc-source">${c.label}</span> ${escape_text(detail)}</div>` +
           `</div>`
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
    return state === 'ok'   ? 'OK'
         : state === 'warn' ? 'WARN'
         : state === 'bad'  ? 'FAIL'
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
        return init.results.size === 0 ? 'initial' : 'rebuild-same'
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
