import { createDb, loadTwists, getTwistByHex, allTwists, nextTwistIds, endTwists, fastTwists, twistsWithRigging, twistsByTether, allHitches, lineRoot, lineTip, sliceSegment, } from './graph.js';
import { hashToHex, NULL_HEX } from './hash.js';
import { latGet, focus as latFocus } from './lat.js';
import { isTwist } from './atom.js';
import { applyShield, applyDoubleShield } from './shielding.js';
import { checkGraphLine, checkGraphLineStructure, worstResult, mergeResults } from './verify.js';
const nullHex = NULL_HEX;
function createLineStore() {
    return { members: new Set(), next: new Map() };
}
function addToStore(store, line) {
    if (line.length === 0)
        return store;
    const members = new Set([...store.members, ...line]);
    const next = new Map(store.next);
    for (let i = 0; i < line.length - 1; i++) {
        next.set(line[i], line[i + 1]);
    }
    return { members, next };
}
function storeHas(store, twistId) {
    return store.members.has(twistId);
}
function nextInStore(store, twistId) {
    return store.next.get(twistId);
}
// ── Spec helper functions ──────────────────────────────
function traceLine(conn, store, startId, endId) {
    let currId = endId;
    const line = [endId];
    const seen = new Set([endId]);
    while (currId !== startId) {
        const t = getTwistByHex(conn, currId);
        if (!t)
            throw Object.assign(new Error('trace-line: missing twist'), { type: 'atomic-error', twistId: currId });
        const prevId = t['twist/prev'];
        if (!prevId)
            throw Object.assign(new Error('trace-line: twist has no prev'), { type: 'atomic-error', twistId: currId });
        if (seen.has(prevId))
            throw Object.assign(new Error('trace-line: cycle detected'), { type: 'atomic-error', twistId: currId });
        line.push(prevId);
        seen.add(prevId);
        currId = prevId;
    }
    return addToStore(store, line.reverse());
}
function nearestFastAncestor(conn, twistId) {
    let id = twistId;
    const seen = new Set();
    while (id && !seen.has(id)) {
        const t = getTwistByHex(conn, id);
        if (!t)
            return undefined;
        if (t['twist/fast'])
            return id;
        seen.add(id);
        id = t['twist/prev'];
    }
    return undefined;
}
function firstFastForward(conn, store, twistId) {
    let id = nextInStore(store, twistId);
    while (id) {
        const t = getTwistByHex(conn, id);
        if (!t)
            return undefined;
        if (t['twist/fast'])
            return id;
        id = nextInStore(store, id);
    }
    return undefined;
}
function furthestFast(conn, store, twistId) {
    let curr = twistId;
    let nxt = firstFastForward(conn, store, curr);
    while (nxt) {
        curr = nxt;
        nxt = firstFastForward(conn, store, curr);
    }
    return curr;
}
// ── Shield key math ────────────────────────────────────
async function makeShieldedKey(conn, leadId) {
    const t = getTwistByHex(conn, leadId);
    if (!t)
        return undefined;
    if (t['twist/s-lead-hex'])
        return t['twist/s-lead-hex'];
    const sb = t['twist/shield-bytes'];
    const th = t['twist/hash'];
    if (!sb)
        return undefined;
    try {
        const sl = await applyShield(sb, th, th);
        return sl ? hashToHex(sl) : undefined;
    }
    catch {
        return undefined;
    }
}
async function checkShieldBinding(conn, leadId, hoistId) {
    const leadT = getTwistByHex(conn, leadId);
    const hoistT = getTwistByHex(conn, hoistId);
    if (!leadT || !hoistT)
        return false;
    const sb = leadT['twist/shield-bytes'];
    const rm = hoistT['twist/rigging'];
    if (!sb || !rm)
        return false;
    const lh = leadT['twist/hash'];
    const ls = await applyShield(sb, lh, lh);
    const lsHex = ls ? hashToHex(ls) : undefined;
    const lss = ls ? await applyDoubleShield(sb, lh, lh) : undefined;
    const lssHex = lss ? hashToHex(lss) : undefined;
    const meetHex = lsHex ? rm.get(lsHex) : undefined;
    const meetsHex = lssHex ? rm.get(lssHex) : undefined;
    const meetT = meetHex ? getTwistByHex(conn, meetHex) : undefined;
    if (!meetT || !meetT['twist/fast'] || !lssHex)
        return false;
    const exp = await applyShield(sb, lh, meetT['twist/hash']);
    return meetsHex === (exp ? hashToHex(exp) : undefined);
}
async function searchForHoist(conn, store, leadId, fastenerId, sLeadHex) {
    let id = nextInStore(store, fastenerId);
    while (id) {
        const t = getTwistByHex(conn, id);
        const rig = t?.['twist/rigging'];
        if (rig && rig.has(sLeadHex) && await checkShieldBinding(conn, leadId, id)) {
            return id;
        }
        id = nextInStore(store, id);
    }
    return undefined;
}
async function walkToplineChain(conn, store, resolveFn, leadId, sLeadHex, startCurrId, startPrevId, initialTophoistId) {
    let ls2 = store;
    let currId = startCurrId;
    let prevId = startPrevId;
    let tophoistId = initialTophoistId;
    const visitedCurrs = new Set();
    while (currId) {
        if (visitedCurrs.has(currId)) {
            conn._tetherCycle = true;
            return null;
        }
        visitedCurrs.add(currId);
        const res = await resolveFn(conn, ls2, currId);
        const [thid, ls3] = res ?? [tophoistId, ls2];
        if (!thid)
            return null;
        tophoistId = thid;
        ls2 = ls3;
        const sCurr = await makeShieldedKey(conn, currId);
        const tophoistT = getTwistByHex(conn, tophoistId);
        const nextId = (sCurr && tophoistT) ? tophoistT['twist/rigging']?.get(sCurr) : undefined;
        if (!nextId)
            return null;
        const nextT = getTwistByHex(conn, nextId);
        const nextRig = nextT?.['twist/rigging'];
        const spliceOk = !prevId || (nextRig && nextRig.get(prevId) === tophoistId);
        if (!spliceOk)
            return null;
        ls2 = traceLine(conn, ls2, currId, nextId);
        const hoist = await searchForHoist(conn, ls2, leadId, currId, sLeadHex);
        if (hoist)
            return [hoist, ls2];
        prevId = currId;
        currId = nextId;
    }
    return null;
}
async function resolveDirectHitch(conn, store, resolveFn, leadId, fastenerId, sLeadHex) {
    const hoist = await searchForHoist(conn, store, leadId, fastenerId, sLeadHex);
    if (hoist)
        return [hoist, store];
    const curr = furthestFast(conn, store, fastenerId);
    const currT = getTwistByHex(conn, curr);
    const prev = currT ? nearestFastAncestor(conn, currT['twist/prev']) : undefined;
    return walkToplineChain(conn, store, resolveFn, leadId, sLeadHex, curr, prev ?? undefined, undefined);
}
async function resolveCascadedHitch(conn, store, resolveFn, leadId, fastenerId, sLeadHex) {
    const topleadId = nearestFastAncestor(conn, fastenerId);
    if (!topleadId)
        return null;
    const res = await resolveFn(conn, store, topleadId);
    if (!res)
        return null;
    const [tophoistId, ls2] = res;
    if (!tophoistId)
        return null;
    const sToplead = await makeShieldedKey(conn, topleadId);
    const tophoistT = getTwistByHex(conn, tophoistId);
    const meetId = (sToplead && tophoistT) ? tophoistT['twist/rigging']?.get(sToplead) : undefined;
    if (!meetId)
        return null;
    const ls3 = traceLine(conn, ls2, topleadId, meetId);
    const h = await searchForHoist(conn, ls3, leadId, topleadId, sLeadHex);
    if (h)
        return [h, ls3];
    return walkToplineChain(conn, ls3, resolveFn, leadId, sLeadHex, meetId, topleadId, tophoistId);
}
async function resolveHitchRec(conn, store, leadId, visited = new Set()) {
    if (visited.has(leadId)) {
        conn._tetherCycle = true;
        return null;
    }
    visited.add(leadId);
    const leadT = getTwistByHex(conn, leadId);
    if (!leadT)
        return null;
    const fastenerId = leadT['twist/tether'];
    const sLeadHex = await makeShieldedKey(conn, leadId);
    if (!fastenerId || !sLeadHex || fastenerId === nullHex)
        return null;
    const recurse = (c, s, l) => resolveHitchRec(c, s, l, visited);
    if (storeHas(store, fastenerId)) {
        return resolveDirectHitch(conn, store, recurse, leadId, fastenerId, sLeadHex);
    }
    else {
        return resolveCascadedHitch(conn, store, recurse, leadId, fastenerId, sLeadHex);
    }
}
export async function verifyHitch(conn, leadId) {
    const res = await resolveHitchRec(conn, createLineStore(), leadId);
    return res ? res[0] : undefined;
}
// ── Half-hitch assessment ──────────────────────────────
function checkFootSegment(conn, leadId, meetId) {
    let t = getTwistByHex(conn, meetId);
    const seen = new Set();
    let fastCount = 0;
    if (t?.['twist/fast'])
        fastCount++; // meet itself
    while (t) {
        if (seen.has(t['twist/id']))
            return 'red'; // cycle
        if (t['twist/id'] === leadId) {
            if (fastCount > 2)
                return 'red'; // extra fast twist between lead and meet
            return 'green';
        }
        seen.add(t['twist/id']);
        const prevId = t['twist/prev'];
        if (prevId) {
            if (prevId === nullHex)
                return 'red'; // explicit NULL sentinel → MISMATCH
            const prevT = getTwistByHex(conn, prevId);
            if (!prevT)
                return 'yellow'; // missing prev atom → incomplete data
            if (prevT['twist/fast'])
                fastCount++;
            t = prevT;
        }
        else {
            return 'red'; // no prev → footline trail ends before lead → broken
        }
    }
    return 'yellow';
}
function checkAllFootlines(conn, corkIds, hitches) {
    const results = [];
    for (const h of hitches) {
        if (!h['hitch/meet'])
            continue;
        // Only check footlines for on-cork hitches — lash hitches have their
        // own verification path and missing atoms there are MISSING data (yellow).
        const leadT = getTwistByHex(conn, h['hitch/lead']);
        const tetherId = leadT?.['twist/tether'];
        if (!tetherId || !corkIds.has(tetherId))
            continue;
        results.push(checkFootSegment(conn, h['hitch/lead'], h['hitch/meet']));
    }
    if (results.length === 0)
        return 'green';
    return worstResult(results);
}
async function assessHitch(conn, leadId, hoistId) {
    const leadT = getTwistByHex(conn, leadId);
    const hoistT = getTwistByHex(conn, hoistId);
    if (!leadT || !hoistT)
        return { colour: 'red', issue: 'missing-entity' };
    // Body shape error checks on consulted twists (§4.1-4.2)
    const leadErrs = leadT['twist/field-atom-invalid'];
    const hoistErrs = hoistT['twist/field-atom-invalid'];
    if (leadErrs?.has('shield-not-arb'))
        return { colour: 'yellow', issue: 'shld-shape-error' };
    if (leadErrs?.has('reqs-not-pairtrie'))
        return { colour: 'yellow', issue: 'reqs-shape-error' };
    if (leadErrs?.has('tether-not-twist'))
        return { colour: 'yellow', issue: 'teth-shape-error' };
    if (hoistErrs?.has('rigging-not-pairtrie'))
        return { colour: 'yellow', issue: 'rigs-shape-error' };
    const sb = leadT['twist/shield-bytes'];
    const rm = hoistT['twist/rigging'];
    const sHex = await makeShieldedKey(conn, leadId);
    if (!sb)
        return { colour: 'yellow', issue: 'missing-shield' };
    if (!rm)
        return { colour: 'yellow', issue: 'missing-rigging' };
    if (!sHex)
        return { colour: 'red', issue: 'shield-computation-failed' };
    const lh = leadT['twist/hash'];
    const lss = await applyDoubleShield(sb, lh, lh);
    const lssHex = lss ? hashToHex(lss) : undefined;
    const meetHex = rm.get(sHex);
    const meetsHex = lssHex ? rm.get(lssHex) : undefined;
    const meetT = meetHex ? getTwistByHex(conn, meetHex) : undefined;
    // §6.1.1: self-referential rigging — rig[s(lead)] = s(lead) → INVALID
    if (meetHex === sHex)
        return { colour: 'red', issue: 'self-referential-rig' };
    if (lssHex && meetsHex === lssHex)
        return { colour: 'red', issue: 'self-referential-rig' };
    if (!rm.has(sHex))
        return { colour: 'red', issue: 'no-s-lead' };
    if (!lssHex)
        return { colour: 'red', issue: 'shield-computation-failed' };
    if (!rm.has(lssHex))
        return { colour: 'yellow', issue: 'no-ss-lead' };
    if (!meetT)
        return { colour: 'yellow', issue: 'meet-missing' };
    if (!meetT['twist/fast'])
        return { colour: 'red', issue: 'non-fast-meet' };
    const exp = await applyShield(sb, lh, meetT['twist/hash']);
    if (meetsHex !== (exp ? hashToHex(exp) : undefined))
        return { colour: 'red', issue: 'mismatched-values' };
    const fl = checkFootSegment(conn, leadId, meetHex);
    if (fl !== 'green')
        return { colour: fl, issue: 'footline-gap' };
    return { colour: 'green', meetId: meetHex };
}
// ── Frame integrity validation ─────────────────────────
function verifySpliceJoints(conn, hitches) {
    const byLead = new Map();
    for (const h of hitches)
        byLead.set(h['hitch/lead'], h);
    const results = [];
    for (const a of hitches) {
        const b = byLead.get(a['hitch/meet']);
        if (!b)
            continue;
        const bMeetT = getTwistByHex(conn, b['hitch/meet']);
        if (!bMeetT) {
            results.push('yellow');
            continue;
        } // can't verify splice
        const bMeetRig = bMeetT['twist/rigging'];
        // Post is optional: no rigging or no entry for this lead → green
        const rigEntry = bMeetRig ? bMeetRig.get(a['hitch/lead']) : undefined;
        if (rigEntry === undefined) {
            results.push('green');
            continue;
        }
        results.push(rigEntry === a['hitch/hoist'] ? 'green' : 'red');
    }
    if (results.length === 0)
        return 'green';
    return worstResult(results);
}
function findOrphanLeads(conn, corkIds, hitchParts) {
    const orphans = [];
    for (const cid of corkIds) {
        const tethered = twistsByTether(conn, cid);
        for (const t of tethered) {
            if (t['twist/fast'] && !hitchParts.has(t['twist/id']) && t['twist/s-lead-hex']) {
                orphans.push(t);
            }
        }
    }
    if (orphans.length === 0)
        return 'green';
    const anyMissing = orphans.some(o => {
        const fId = o['twist/tether'];
        if (!fId)
            return false;
        const f = getTwistByHex(conn, fId);
        if (!f)
            return false;
        const queue = [f];
        const vis = new Set();
        while (queue.length > 0) {
            const c = queue.shift();
            const cid = c['twist/id'];
            if (vis.has(cid))
                continue;
            if (c['twist/missing-atoms'] && [...c['twist/missing-atoms']].some(a => a !== 'sat'))
                return true;
            vis.add(cid);
            const nids = nextTwistIds(conn, cid);
            if (nids)
                for (const nid of nids) {
                    const nt = getTwistByHex(conn, nid);
                    if (nt)
                        queue.push(nt);
                }
        }
        return false;
    });
    return 'yellow'; // orphans → incomplete data (yellow per §9.1.3)
}
function verifyLashChain(conn, corkIds, hitches) {
    const results = [];
    for (const h of hitches) {
        const leadT = getTwistByHex(conn, h['hitch/lead']);
        if (!leadT)
            continue;
        const tetherId = leadT['twist/tether'];
        if (!tetherId || corkIds.has(tetherId))
            continue;
        const fastener = getTwistByHex(conn, tetherId);
        if (!fastener) {
            results.push('yellow');
            continue;
        }
        const root = lineRoot(conn, fastener);
        if (!root)
            continue;
        const end = lineTip(conn, root) ?? root;
        const line = sliceSegment(conn, root, end);
        if (line.length >= 2) {
            results.push(checkGraphLineStructure(line));
        }
    }
    if (results.length === 0)
        return 'green';
    return worstResult(results);
}
function checkMissingAtoms(conn, rigIds) {
    for (const tid of rigIds) {
        const t = getTwistByHex(conn, tid);
        if (t?.['twist/missing-atoms'] && [...t['twist/missing-atoms']].some(a => a !== 'sat'))
            return 'yellow';
    }
    return 'green';
}
function checkCandidateBodyShapes(conn, corkIds) {
    // §9.2 twist-body INVALID: a body slot pointing at a present-but-wrong-shape
    // atom is provably bad (red), regardless of whether the twist is fast. A
    // wrong-shape body strips the tether during parsing, so these twists never
    // appear in fastTwists — scan every twist for this case.
    for (const t of allTwists(conn)) {
        if (t['twist/field-atom-invalid']?.has('body-wrong-shape'))
            return 'red';
    }
    // §4.1-4.2: scan all fast twists for body/shld/reqs/teth errors
    const allFast = fastTwists(conn);
    for (const t of allFast) {
        const errs = t['twist/field-atom-invalid'];
        if (!errs)
            continue;
        if (errs.has('body'))
            return 'red';
        if (errs.has('shield-not-arb'))
            return 'red';
        if (errs.has('reqs-not-pairtrie'))
            return 'red';
        if (errs.has('tether-not-twist'))
            return 'red';
    }
    // rigs errors: scan all twists. When hitches exist, only scan hoists.
    const allTws = allTwists(conn);
    const allHitchesList = allHitches(conn);
    const hoistIds = new Set(allHitchesList.map(h => h['hitch/hoist']));
    for (const t of allTws) {
        const errs = t['twist/field-atom-invalid'];
        if (!errs)
            continue;
        if (errs.has('rigging-not-pairtrie')) {
            // No hitches → all rigs errors are red. With hitches → only hoist rigs errors are red.
            if (hoistIds.size === 0 || hoistIds.has(t['twist/id']))
                return 'red';
        }
    }
    return 'green';
}
function checkFrameIntegrity(conn, corkIds, hitches) {
    function hitchParticipantIds(hitches) {
        const ids = new Set();
        for (const h of hitches) {
            ids.add(h['hitch/lead']);
            ids.add(h['hitch/meet']);
            if (h['hitch/post'])
                ids.add(h['hitch/post']);
            let tid = h['hitch/meet'];
            const seen = new Set();
            while (tid) {
                if (seen.has(tid))
                    break;
                if (tid === h['hitch/lead']) {
                    ids.add(tid);
                    break;
                }
                ids.add(tid);
                seen.add(tid);
                const t = getTwistByHex(conn, tid);
                tid = t?.['twist/prev'];
            }
        }
        return ids;
    }
    const allH = allHitches(conn);
    const allHitchParts = hitchParticipantIds(allH);
    const rigHitchParts = hitchParticipantIds(hitches);
    const rigIds = new Set([...rigHitchParts, ...corkIds]);
    for (const h of hitches)
        rigIds.add(h['hitch/hoist']);
    // Phase 1: provable failures → red (per toda-bb spec)
    const bc = checkCandidateBodyShapes(conn, corkIds);
    if (bc === 'red')
        return 'red';
    const sc = verifySpliceJoints(conn, hitches);
    if (sc === 'red')
        return 'red';
    // Phase 2: incomplete-data issues → yellow
    const results = [];
    if (sc !== 'green')
        results.push('yellow');
    // Footline walk from meet to lead — only red for cycles
    const fgResults = [];
    for (const h of allH) {
        const meetId = h['hitch/meet'];
        const leadId = h['hitch/lead'];
        if (!meetId || !leadId)
            continue;
        const meetT = getTwistByHex(conn, meetId);
        if (!meetT) {
            fgResults.push('yellow');
            continue;
        }
        let t = meetT;
        const seen = new Set();
        while (t) {
            const tid = t['twist/id'];
            if (seen.has(tid)) {
                fgResults.push('red');
                break;
            }
            if (tid === leadId) {
                fgResults.push('green');
                break;
            }
            seen.add(tid);
            const prevId = t['twist/prev'];
            if (!prevId || prevId === nullHex) {
                fgResults.push('yellow');
                break;
            }
            const prevT = getTwistByHex(conn, prevId);
            if (!prevT) {
                fgResults.push('yellow');
                break;
            }
            t = prevT;
        }
        if (!t)
            fgResults.push('yellow');
    }
    if (fgResults.some(r => r === 'red'))
        return 'red';
    if (fgResults.some(r => r !== 'green'))
        results.push('yellow');
    // Post-footline walk from post to lead — red for diverged (NULL/cycle)
    for (const h of allH) {
        const postId = h['hitch/post'];
        const leadId = h['hitch/lead'];
        if (!postId || !leadId)
            continue;
        const postT = getTwistByHex(conn, postId);
        if (!postT)
            continue;
        let t = postT;
        const seen = new Set();
        while (t) {
            const tid = t['twist/id'];
            if (seen.has(tid)) {
                return 'red';
            }
            if (tid === leadId)
                break;
            seen.add(tid);
            const prevId = t['twist/prev'];
            if (!prevId || prevId === nullHex) {
                return 'red';
            }
            const prevT = getTwistByHex(conn, prevId);
            if (!prevT) {
                results.push('yellow');
                break;
            }
            t = prevT;
        }
        if (!t)
            results.push('yellow');
    }
    results.push(findOrphanLeads(conn, corkIds, allHitchParts));
    results.push(verifyLashChain(conn, corkIds, hitches));
    results.push(checkMissingAtoms(conn, rigIds));
    results.push(checkAllFootlines(conn, corkIds, hitches));
    return worstResult(results);
}
// ── Corkline assembly ──────────────────────────────────
function assembleCorkSegment(conn, corkHex) {
    const ct = getTwistByHex(conn, corkHex);
    if (!ct)
        return [];
    const root = lineRoot(conn, ct);
    if (!root)
        return [];
    const end = lineTip(conn, root) ?? root;
    return sliceSegment(conn, root, end);
}
function twistDepth(conn, t) {
    let c = t;
    let d = 0;
    const seen = new Set();
    while (c) {
        if (seen.has(c['twist/id']))
            return d;
        const prevId = c['twist/prev'];
        if (prevId) {
            seen.add(c['twist/id']);
            c = getTwistByHex(conn, prevId);
            if (c)
                d++;
        }
        else {
            return d;
        }
    }
    return d;
}
function earliestLead(conn, corkIds) {
    const cands = [];
    for (const cid of corkIds) {
        const tethered = twistsByTether(conn, cid);
        for (const t of tethered) {
            if (t['twist/fast'])
                cands.push(t);
        }
    }
    if (cands.length === 0)
        return undefined;
    let best = cands[0];
    let bestDepth = twistDepth(conn, best);
    for (let i = 1; i < cands.length; i++) {
        const d = twistDepth(conn, cands[i]);
        if (d < bestDepth) {
            best = cands[i];
            bestDepth = d;
        }
    }
    return best;
}
// ── Failure diagnosis ──────────────────────────────────
function noLeadsReason(conn) {
    const allFast = fastTwists(conn);
    if (allFast.length === 0)
        return { colour: 'red', issue: 'no-fast-twists' };
    if (allFast.some(f => !getTwistByHex(conn, f['twist/tether']))) {
        return { colour: 'yellow', issue: 'tether-missing' };
    }
    if (allFast.some(f => f['twist/shield-bytes'] === null)) {
        return { colour: 'yellow', issue: 'missing-shield' };
    }
    if (allFast.length > 0)
        return { colour: 'red', issue: 'no-leads-on-corkline' };
    return { colour: 'red', issue: 'no-fast-twists' };
}
async function hoistFailureReason(conn, leadId, fastener) {
    const sHex = await makeShieldedKey(conn, leadId);
    if (!sHex)
        return { colour: 'yellow', issue: 'missing-shield' };
    const reachableFull = [];
    {
        const vis = new Set([fastener['twist/id']]);
        const nids = nextTwistIds(conn, fastener['twist/id']) ?? new Set();
        const q = [...nids].map(id => getTwistByHex(conn, id)).filter(Boolean);
        while (q.length > 0) {
            const c = q.shift();
            const cid = c['twist/id'];
            if (vis.has(cid))
                continue;
            vis.add(cid);
            reachableFull.push(c);
            const nids = nextTwistIds(conn, cid);
            if (nids)
                for (const nid of nids) {
                    const nt = getTwistByHex(conn, nid);
                    if (nt)
                        q.push(nt);
                }
        }
    }
    const reachableWithS = sHex && reachableFull.some(t => t['twist/rigging']?.has(sHex));
    const allRig = twistsWithRigging(conn);
    const globalWithS = sHex && allRig.some(t => t['twist/rigging']?.has(sHex));
    // §9.5: when s(lead) is reachable but ss(lead) binding is incomplete → yellow
    if (reachableWithS) {
        const leadT = getTwistByHex(conn, leadId);
        if (leadT) {
            const sb = leadT['twist/shield-bytes'];
            const lh = leadT['twist/hash'];
            if (sb) {
                const lss = await applyDoubleShield(sb, lh, lh);
                const lssHex = lss ? hashToHex(lss) : undefined;
                if (!lssHex || !reachableFull.some(t => t['twist/rigging']?.has(lssHex))) {
                    return { colour: 'yellow', issue: 'no-ss-lead' };
                }
            }
        }
        return { colour: 'red', issue: 'no-valid-hoist' };
    }
    if (globalWithS)
        return { colour: 'yellow', issue: 'topline-gap' };
    return { colour: 'yellow', issue: 'hoist-rigging-missing' };
}
// ── Lead chain traversal ───────────────────────────────
async function traverseLeadChain(conn, ls, corkResult, firstLeadId, meetId, hoistId) {
    let store = traceLine(conn, ls, firstLeadId, meetId);
    let currId = firstLeadId;
    let prevId;
    let currHoistId = hoistId;
    while (true) {
        const hoistT = getTwistByHex(conn, currHoistId);
        const sCurr = await makeShieldedKey(conn, currId);
        const nextId = (sCurr && hoistT) ? hoistT['twist/rigging']?.get(sCurr) : undefined;
        if (!nextId)
            return { colour: corkResult, lead: firstLeadId, meet: nextId, ls: store };
        // Tether loop during hitch resolution
        if (conn._tetherCycle)
            return { colour: 'yellow', issue: 'tether-cycle', lead: firstLeadId, meet: nextId, ls: store };
        const nextHoistResult = await resolveHitchRec(conn, store, nextId);
        if (!nextHoistResult)
            return { colour: corkResult, lead: firstLeadId, meet: nextId, ls: store };
        const [nextHoist, ls3] = nextHoistResult;
        if (!nextHoist)
            return { colour: corkResult, lead: firstLeadId, meet: nextId, ls: store };
        const sNext = await makeShieldedKey(conn, nextId);
        const nextHoistT = getTwistByHex(conn, nextHoist);
        const nextNextId = (sNext && nextHoistT) ? nextHoistT['twist/rigging']?.get(sNext) : undefined;
        if (!nextNextId)
            return { colour: corkResult, lead: firstLeadId, meet: nextId, ls: store };
        const nextNextT = getTwistByHex(conn, nextNextId);
        if (!nextNextT) {
            // Next-next twist missing → incomplete data, not provably broken
            return { colour: corkResult, lead: firstLeadId, meet: nextId, ls: store };
        }
        const nextNextRig = nextNextT['twist/rigging'];
        const spliceOk = !prevId || (nextNextRig && nextNextRig.get(currId) === currHoistId);
        if (!spliceOk)
            return { colour: corkResult, lead: firstLeadId, meet: nextId, ls: store };
        store = traceLine(conn, ls3, nextId, nextNextId);
        prevId = currId;
        currId = nextId;
        currHoistId = nextHoist;
    }
}
// ── Core evaluation ────────────────────────────────────
async function evalRigCore(conn, corkHex) {
    conn._tetherCycle = false;
    const corkEntities = assembleCorkSegment(conn, corkHex);
    const corkResult = checkGraphLineStructure(corkEntities);
    const corkIds = new Set(corkEntities.map(e => e['twist/id']));
    if (corkResult === 'red')
        return { colour: 'red', issue: 'corkline-failed', ls: createLineStore() };
    if (corkIds.size === 0)
        return { colour: 'yellow', issue: 'no-corkline', ls: createLineStore() };
    // §9.6 corkline MISMATCH: the supporting twist (corkHex) is itself the oldest
    // reachable twist on its line, and that line is truncated there — its prev
    // names an atom that was not provided, as opposed to reaching genesis (NULL).
    // The corkline cannot be walked back, and any hitch support lies forward of
    // the specified supporting twist, so the corkline provably does not support
    // the leadline. (A clean genesis start, or corkHex sitting forward of the
    // truncation, is merely incomplete and stays yellow via the focus check.)
    {
        const root = corkEntities[0];
        const rootPrev = root['twist/prev'];
        if (root['twist/id'] === corkHex && rootPrev && rootPrev !== nullHex
            && !getTwistByHex(conn, rootPrev)) {
            // corkHex is the oldest reachable twist and its line is truncated here.
            // This is only fatal if corkHex is not itself a support anchor: if a lead
            // tethers into it, the corkline is properly anchored at the specified
            // support and the absent predecessor is just z_a's unincluded parent. If
            // nothing tethers into corkHex, the real anchor lies forward of the
            // specified support and the corkline cannot extend back to reach it.
            const anchoredAtCork = twistsByTether(conn, corkHex).some(t => t['twist/fast']);
            if (!anchoredAtCork) {
                return { colour: 'red', issue: 'corkline-truncated-at-support', ls: createLineStore() };
            }
        }
    }
    const store = traceLine(conn, createLineStore(), corkEntities[0]['twist/id'], corkEntities[corkEntities.length - 1]['twist/id']);
    const firstLead = earliestLead(conn, corkIds);
    if (!firstLead)
        return { ...noLeadsReason(conn), ls: store };
    const teth = firstLead['twist/tether'];
    const fastener = teth ? getTwistByHex(conn, teth) : undefined;
    if (!teth)
        return { colour: 'yellow', issue: 'lead-no-tether', ls: store };
    if (teth === nullHex)
        return { colour: 'yellow', issue: 'tether-null', ls: store };
    if (!fastener)
        return { colour: 'yellow', issue: 'tether-missing', ls: store };
    const hoistResult = await resolveHitchRec(conn, store, firstLead['twist/id']);
    if (!hoistResult) {
        if (conn._tetherCycle)
            return { colour: 'yellow', issue: 'tether-cycle', ls: store };
        return { ...await hoistFailureReason(conn, firstLead['twist/id'], fastener), ls: store };
    }
    const [hoistId, nextStore] = hoistResult;
    if (!hoistId)
        return { ...await hoistFailureReason(conn, firstLead['twist/id'], fastener), ls: nextStore };
    const hh = await assessHitch(conn, firstLead['twist/id'], hoistId);
    if (hh.colour !== 'green') {
        // If the resolved hoist doesn't serve this lead (s(lead) not in rigging,
        // ss(lead) missing, meet missing), the hoist wasn't properly resolved.
        // Fall through to hoistFailureReason which returns yellow when s(lead)
        // isn't reachable at all (MISSING rather than MISMATCH).
        if (hh.issue === 'no-s-lead' || hh.issue === 'no-ss-lead' || hh.issue === 'meet-missing') {
            return { ...await hoistFailureReason(conn, firstLead['twist/id'], fastener), ls: nextStore };
        }
        if (hh.issue === 'footline-gap') {
            return { colour: hh.colour, issue: 'footline-gap', ls: nextStore };
        }
        return { ...hh, ls: nextStore };
    }
    return traverseLeadChain(conn, nextStore, corkResult, firstLead['twist/id'], hh.meetId, hoistId);
}
// ── Public API ─────────────────────────────────────────
// Does the focus sit on the footline of some hitch — i.e. on the prev-chain
// from that hitch's meet back to (but excluding) its lead? Footline twists are
// genuine leadline members, so a focus there is supported by the rig.
function focusOnFootline(conn, focusHex, hitches) {
    for (const h of hitches) {
        const meet = h['hitch/meet'];
        const lead = h['hitch/lead'];
        if (!meet || !lead)
            continue;
        let id = meet;
        const seen = new Set();
        while (id && !seen.has(id)) {
            if (id === lead)
                break;
            if (id === focusHex)
                return true;
            seen.add(id);
            id = getTwistByHex(conn, id)?.['twist/prev'];
        }
    }
    return false;
}
// §7.3 main returns "the last successor of f_a supported by z_w". The rig is
// green only if that walk actually reached the focus — i.e. the focus lies ON
// the verified leadline. A focus that is a lead, meet, or footline member of a
// hitch is reached. A focus that is only a hoist/post/fastener, or a successor
// beyond the frontier, was NOT reached: the rig supports up to some twist but
// not the focus, which is a MISSING/UNKNOWN result (yellow), not green.
function focusReachedColour(conn, focusHex, meetHex, ls, hitches, rigTwistIds) {
    if (!focusHex)
        return 'green';
    if (meetHex && focusHex === meetHex)
        return 'green'; // focus IS the frontier meet
    if (ls.members.has(focusHex))
        return 'green'; // traversed as a verified leadline twist
    for (const h of hitches) {
        if (h['hitch/lead'] === focusHex || h['hitch/meet'] === focusHex)
            return 'green';
    }
    if (focusOnFootline(conn, focusHex, hitches))
        return 'green';
    // Not on the verified leadline. Distinguish "beyond the frontier" (yellow)
    // from "on a disconnected line" (red) by walking the focus's prev chain. If
    // it meets a rig twist, the focus is a descendant the walk simply hasn't
    // reached yet — MISSING data (yellow). If it reaches NULL (or cycles) without
    // ever touching the rig, the focus is provably on a different line: §9.4/§9.5
    // "NULL is reached" is a MISMATCH → red.
    let id = focusHex;
    const seen = new Set();
    while (id) {
        if (rigTwistIds.has(id))
            return 'yellow'; // connects to the rig → MISSING
        if (seen.has(id))
            return 'yellow'; // cycle, no disproof → inconclusive
        seen.add(id);
        const t = getTwistByHex(conn, id);
        if (!t)
            return 'yellow'; // missing atom → incomplete data
        const prev = t['twist/prev'];
        if (!prev || prev === nullHex)
            return 'red'; // reached NULL → MISMATCH
        id = prev;
    }
    return 'yellow';
}
export async function evalRig(conn, corkHex, focusHex) {
    try {
        const r = await evalRigCore(conn, corkHex);
        let baseColour = r.colour;
        const meetHex = r.meet;
        const corkEntities = assembleCorkSegment(conn, corkHex);
        const corkIds = new Set(corkEntities.map(e => e['twist/id']));
        const hitches = allHitches(conn);
        const structColour = corkIds.size > 0 ? checkFrameIntegrity(conn, corkIds, hitches) : 'green';
        const rigTwistIds = new Set(corkIds);
        for (const h of hitches) {
            if (h['hitch/lead'])
                rigTwistIds.add(h['hitch/lead']);
            if (h['hitch/meet'])
                rigTwistIds.add(h['hitch/meet']);
            if (h['hitch/hoist'])
                rigTwistIds.add(h['hitch/hoist']);
            if (h['hitch/fastener'])
                rigTwistIds.add(h['hitch/fastener']);
            if (h['hitch/post'])
                rigTwistIds.add(h['hitch/post']);
        }
        const focusReachedResult = baseColour === 'green' ? focusReachedColour(conn, focusHex, meetHex, r.ls, hitches, rigTwistIds) : undefined;
        let focusColour = focusReachedResult ?? 'green';
        // Equivocation (§1): focus=meet, and the focus's tether points to a
        // cork-entity that is also a hitch lead (not the first lead).
        if (baseColour === 'green' && meetHex === focusHex) {
            const ft = getTwistByHex(conn, focusHex);
            const tether = ft?.['twist/tether'];
            if (tether && corkIds.has(tether)) {
                const leadSet = new Set(hitches.map(h => h['hitch/lead']));
                if (leadSet.has(tether)) {
                    baseColour = 'red';
                }
            }
        }
        // Cork-root unsupported (§9.6): yellow hoist-rigging-missing, single
        // cork-id, cork-hex has no rigging but fast tethered twists exist → red.
        if (baseColour === 'yellow' && r.issue === 'hoist-rigging-missing' && corkIds.size === 1) {
            const corkT = getTwistByHex(conn, corkHex);
            if (corkT && !corkT['twist/rigging']) {
                const hasFastTethered = [...corkIds].some(cid => {
                    const tt = twistsByTether(conn, cid);
                    return tt.some(t => t['twist/fast']);
                });
                if (hasFastTethered)
                    baseColour = 'red';
            }
        }
        if (globalThis.process?.env?.RIGDEBUG) {
            // eslint-disable-next-line no-console
            const focusT2 = getTwistByHex(conn, focusHex);
            console.error('[RIGDEBUG]', JSON.stringify({
                base: r.colour, issue: r.issue, meet: meetHex?.slice(0, 10), lead: r.lead?.slice(0, 10),
                focus: focusHex?.slice(0, 10), focusReached: focusReachedResult, struct: structColour,
                baseAfter: baseColour, lsMembers: r.ls.members.size,
                focusInLs: r.ls.members.has(focusHex), focusInRig: rigTwistIds.has(focusHex),
                focusFast: !!focusT2?.['twist/fast'], focusIsMeet: focusHex === meetHex,
                nHitches: hitches.length,
            }));
        }
        const merged = mergeResults(baseColour, mergeResults(structColour, focusColour));
        // §7.2: a tethering loop encountered during traversal. This implementation
        // avoids infinite loops with cycle detection (a height-limit analogue), so
        // per the spec the loop is UNKNOWN, not a provable MISMATCH — the rig can
        // be at best yellow, never green. (A provable loop strictly before the
        // corkline would be red, but cycle-avoidance cannot prove that.)
        if (merged === 'green' && conn._tetherCycle)
            return 'yellow';
        return merged;
    }
    catch (e) {
        if (globalThis.process?.env?.RIGDEBUG)
            console.error('[RIGDEBUG] threw', e);
        return 'red';
    }
}
// ── Test harness entry point ───────────────────────────
export async function checkRig(l, corklineHex) {
    const focus = latFocus(l);
    const conn = createDb();
    try {
        await loadTwists(conn, l);
    }
    catch {
        // If population fails, try to continue anyway
    }
    if (!corklineHex) {
        if (fastTwists(conn).length > 0)
            return 'red';
        const ends = endTwists(conn);
        // Anchor on the focus twist when available: a file may contain several
        // disjoint lines (e.g. an unrelated loose twist plus the segment under
        // test), and the focus identifies which line the test is about. Falling
        // back to an arbitrary end twist examines the wrong line (e.g. R264, where
        // the non-twist prev is on the focus's line, not on ends[0]).
        const focusT = focus ? getTwistByHex(conn, focus) : undefined;
        const end = focusT ?? (ends.length > 0 ? ends[0] : undefined);
        if (!end)
            return 'green';
        const root = lineRoot(conn, end);
        if (!root)
            return 'green';
        const line = sliceSegment(conn, root, end);
        // Prev-chain validation for line-segment tests (§4.1-4.2, §6)
        if (line.length > 0) {
            const leftmost = line[0];
            const prev = leftmost['twist/prev'];
            if (!prev) {
                // No prev property at all → can't determine prev status
                if (line.length >= 2)
                    return 'red';
                // Single twist, no prev → green (valid root)
            }
            else if (prev === nullHex) {
                // NULL_HEX "00" may collide with null atom in LAT.
                // Check if atom exists at this hex — if yes, it's a non-twist prev (r264).
                const atomAtPrev = latGet(l, prev);
                if (atomAtPrev) {
                    // Only flag red if this is a NON-null atom (genuine prev pointer).
                    // Null atom at "00" is the LAT's own null sentinel, not a prev.
                    if (atomAtPrev.packet !== null)
                        return 'red';
                }
                // True sentinel: no prev atom →
                if (line.length >= 2)
                    return 'red';
                return 'yellow';
            }
            else if (prev !== 'ff') {
                const prevT = getTwistByHex(conn, prev);
                if (!prevT) {
                    // prev is not a twist — check if atom exists at that hex in the full LAT
                    if (latGet(l, prev))
                        return 'red'; // non-twist atom (including null) → INVALID (r264)
                    return 'yellow'; // genuinely missing → MISSING (r263)
                }
                // prev is a valid twist → structural error
                if (!leftmost['twist/fast'])
                    return 'red';
            }
            // Walk fast-twist segments for body-shape errors
            if (leftmost['twist/fast'] && line.length >= 2) {
                for (const t of line) {
                    if (t['twist/field-atom-invalid']?.has('body'))
                        return 'red';
                    if (t['twist/missing-atoms'] && [...t['twist/missing-atoms']].some(a => a !== 'sat'))
                        return 'yellow';
                }
            }
        }
        if (line.length < 2)
            return 'green';
        return await checkGraphLine(line);
    }
    if (!focus)
        return 'red';
    // §9.2 twist INVALID ("Not a twist"): the focus identifies the twist whose
    // support is being verified. If the focus atom is present but is not a twist
    // shape (e.g. its body slot was made to point at an arb/hashes atom that then
    // became the focus), that is a provable construction error — red — and it is
    // caught before any corkline check. A focus atom that is simply absent stays
    // a MISSING (yellow) case handled downstream.
    const focusAtom = latGet(l, focus);
    if (focusAtom && focusAtom.packet !== null && !isTwist(focusAtom))
        return 'red';
    return await evalRig(conn, corklineHex, focus);
}
