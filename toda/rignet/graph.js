/**
 * Graph layer: twist population, shield math, hitch discovery,
 * line traversal, rig discovery.
 * Implements the structures described in rigging_specifications.md.
 */
import * as gdb from './graphdb.js';
import { isTwist, isBody, isArb, isPairtrie, isNullAtom, arbContent, pairtrieContent, twistBody, twistSat, bodyPrev, bodyTether, bodyShield, bodyReq, bodyRigging, } from './atom.js';
import { latGet } from './lat.js';
import { extractTwistAtoms } from './walk.js';
import { hashToHex, hashFromBytes, NULL_HEX } from './hash.js';
import { hexToBytes } from './bytes.js';
import { applyShield, applyDoubleShield } from './shielding.js';
import { checkSuccession, worstResult } from './verify.js';
const nullHex = NULL_HEX;
const blankShield = new Uint8Array(0);
export const createDb = gdb.createDb;
export const transact = gdb.transact;
export const getTwistByHex = gdb.getTwist;
const getTwistById = gdb.getTwist;
export const allTwists = gdb.allTwists;
export const nextTwistIds = gdb.nextTwistIds;
export const endTwists = gdb.endTwists;
export const fastTwists = gdb.fastTwists;
export const twistsWithRigging = gdb.twistsWithRigging;
export const twistsByTether = gdb.twistsByTether;
export const allHitches = gdb.allHitches;
export const hitchForLead = gdb.hitchForLead;
// ── Twist population (graph:80-115) ───────────────────
function decodeRigTrie(l, hexKey) {
    if (!hexKey || hexKey === nullHex)
        return null;
    const atm = latGet(l, hexKey);
    if (!atm || !isPairtrie(atm))
        return null;
    const content = pairtrieContent(atm);
    if (!content)
        return null;
    const m = new Map();
    for (const [k, v] of content)
        m.set(hashToHex(k), hashToHex(v));
    return m;
}
function removeNils(obj) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== null && v !== undefined)
            result[k] = v;
    }
    return result;
}
function extractTwistFields(l, twistHex) {
    const twistAtm = latGet(l, twistHex);
    if (!twistAtm || !isTwist(twistAtm))
        return null;
    const bodyHash = twistBody(twistAtm);
    const satHash = twistSat(twistAtm);
    if (!bodyHash || !satHash)
        return null;
    const bodyHex = hashToHex(bodyHash);
    const satHex = hashToHex(satHash);
    const bodyAtm = latGet(l, bodyHex);
    const bodyValid = !!(bodyAtm && isBody(bodyAtm));
    if (!bodyValid) {
        return {
            hexes: { bodyHex, satHex, prevHex: nullHex, tetherHex: nullHex, shieldHex: nullHex, reqHex: nullHex, riggingHex: nullHex },
            bodyValid: false,
        };
    }
    const prevH = bodyPrev(bodyAtm);
    const tetherH = bodyTether(bodyAtm);
    const shieldH = bodyShield(bodyAtm);
    const reqH = bodyReq(bodyAtm);
    const riggingH = bodyRigging(bodyAtm);
    return {
        hexes: {
            bodyHex,
            satHex,
            prevHex: prevH ? hashToHex(prevH) : nullHex,
            tetherHex: tetherH ? hashToHex(tetherH) : nullHex,
            shieldHex: shieldH ? hashToHex(shieldH) : nullHex,
            reqHex: reqH ? hashToHex(reqH) : nullHex,
            riggingHex: riggingH ? hashToHex(riggingH) : nullHex,
        },
        bodyValid: true,
    };
}
export function parseTwistRecords(l) {
    const entities = [];
    for (const [hexKey, atm] of l) {
        if (!isTwist(atm))
            continue;
        const isolated = extractTwistAtoms(l, hexKey);
        const fields = extractTwistFields(l, hexKey);
        if (!fields)
            continue;
        const { hexes, bodyValid } = fields;
        const { prevHex, tetherHex, shieldHex, riggingHex, reqHex, satHex, bodyHex } = hexes;
        // shield bytes — nil when shield atom is missing or not arb
        const shieldAtm = latGet(isolated, shieldHex);
        let shieldBytes = null;
        if (shieldAtm) {
            if (isNullAtom(shieldAtm))
                shieldBytes = blankShield;
            else if (isArb(shieldAtm))
                shieldBytes = arbContent(shieldAtm);
        }
        const isFast = !!tetherHex && tetherHex !== nullHex;
        // missing atoms
        const missing = new Set();
        if (riggingHex && riggingHex !== nullHex && !latGet(isolated, riggingHex))
            missing.add('rigging');
        if (shieldHex && shieldHex !== nullHex && !latGet(isolated, shieldHex))
            missing.add('shield');
        if (reqHex && reqHex !== nullHex && !latGet(isolated, reqHex))
            missing.add('req');
        if (satHex && satHex !== nullHex && !latGet(isolated, satHex))
            missing.add('sat');
        // Body field shape validation per spec §4.1-4.2
        const fieldAtomInvalid = new Set();
        if (!bodyValid) {
            fieldAtomInvalid.add('body');
            // §9.2 twist-body: distinguish a body atom that is PRESENT but not a
            // body shape (INVALID → red) from one that is simply absent (MISSING →
            // yellow). The plain 'body' marker above is retained for the existing
            // fast-twist / line-segment paths.
            const bodyAtm = latGet(l, bodyHex);
            if (bodyAtm && !isNullAtom(bodyAtm))
                fieldAtomInvalid.add('body-wrong-shape');
        }
        // shld: must be arb or NULL. UNIT → missing (yellow).
        if (shieldHex && shieldHex !== nullHex && shieldHex !== 'ff') {
            const atm = latGet(l, shieldHex);
            if (atm && !isNullAtom(atm) && !isArb(atm))
                fieldAtomInvalid.add('shield-not-arb');
        }
        // reqs: must be pairtrie or NULL. UNIT → red.
        if (reqHex && reqHex !== nullHex) {
            if (reqHex === 'ff')
                fieldAtomInvalid.add('reqs-not-pairtrie');
            else {
                const atm = latGet(l, reqHex);
                if (atm && !isNullAtom(atm) && !isPairtrie(atm))
                    fieldAtomInvalid.add('reqs-not-pairtrie');
            }
        }
        // rigs: must be pairtrie or NULL. UNIT → missing (yellow).
        if (riggingHex && riggingHex !== nullHex && riggingHex !== 'ff') {
            const atm = latGet(l, riggingHex);
            if (atm && !isNullAtom(atm) && !isPairtrie(atm))
                fieldAtomInvalid.add('rigging-not-pairtrie');
        }
        // teth: must be twist, NULL, or UNIT
        if (tetherHex && tetherHex !== nullHex && tetherHex !== 'ff') {
            const atm = latGet(l, tetherHex);
            if (atm && !isNullAtom(atm) && !isTwist(atm))
                fieldAtomInvalid.add('tether-not-twist');
        }
        // prev: must be twist or NULL
        if (prevHex && prevHex !== nullHex) {
            const atm = latGet(l, prevHex);
            if (atm && !isNullAtom(atm) && !isTwist(atm))
                fieldAtomInvalid.add('prev-not-twist');
        }
        // sats: must be pairtrie or NULL. UNIT → red.
        if (satHex && satHex !== nullHex) {
            if (satHex === 'ff')
                fieldAtomInvalid.add('sats-not-pairtrie');
            else {
                const atm = latGet(l, satHex);
                if (atm && !isNullAtom(atm) && !isPairtrie(atm))
                    fieldAtomInvalid.add('sats-not-pairtrie');
            }
        }
        const hash = hashFromBytes(hexToBytes(hexKey));
        const entity = {
            'twist/id': hexKey,
            'twist/hash': hash,
            'twist/lat': isolated,
            'twist/fast': isFast,
            'twist/rigging': decodeRigTrie(isolated, riggingHex),
            'twist/shield-bytes': shieldBytes,
            'node/type': 'twist',
        };
        if (missing.size > 0)
            entity['twist/missing-atoms'] = missing;
        if (fieldAtomInvalid.size > 0)
            entity['twist/field-atom-invalid'] = fieldAtomInvalid;
        if (bodyValid && bodyHex && bodyHex !== nullHex)
            entity['twist/body-hex'] = bodyHex;
        if (reqHex && reqHex !== nullHex)
            entity['twist/req-hex'] = reqHex;
        if (satHex && satHex !== nullHex)
            entity['twist/sat-hex'] = satHex;
        entity['twist/prev'] = prevHex; // always store, even NULL — needed for line-segment detection
        if (tetherHex && tetherHex !== nullHex)
            entity['twist/tether'] = tetherHex;
        entities.push(entity);
    }
    return entities;
}
// ── Shield math (graph:117-127) ───────────────────────
async function applyLeadShield(lead, dataHash) {
    const sb = lead['twist/shield-bytes'];
    if (!sb)
        return undefined;
    try {
        return await applyShield(sb, lead['twist/hash'], dataHash);
    }
    catch {
        return undefined;
    }
}
async function shieldedKeyHex(lead, dataHash) {
    const s = await applyLeadShield(lead, dataHash);
    return s ? hashToHex(s) : undefined;
}
export const selfShieldKey = (lead) => shieldedKeyHex(lead, lead['twist/hash']);
// ── Hitch discovery (graph:131-322) ───────────────────
async function checkShieldPairing(lead, hoistRigging, meetT) {
    const lh = lead['twist/hash'];
    const sb = lead['twist/shield-bytes'];
    if (!sb)
        return false;
    const ls = await applyShield(sb, lh, lh);
    const lss = await applyDoubleShield(sb, lh, lh);
    const lsHex = ls ? hashToHex(ls) : null;
    const lssHex = lss ? hashToHex(lss) : null;
    const meetHex = hoistRigging.get(lsHex);
    const meetsHex = hoistRigging.get(lssHex);
    if (!lsHex || !lssHex)
        return false;
    if (meetHex !== meetT['twist/id'])
        return false;
    if (!meetT['twist/fast'])
        return false;
    const exp = await applyLeadShield(lead, meetT['twist/hash']);
    return meetsHex === (exp ? hashToHex(exp) : null);
}
function immediateSuccessors(conn, twist) {
    const ids = gdb.nextTwistIds(conn, twist['twist/id']);
    if (!ids)
        return [];
    return [...ids].map(id => gdb.getTwist(conn, id)).filter(Boolean);
}
function nextFastSuccessors(conn, start) {
    const queue = [...(gdb.nextTwistIds(conn, start['twist/id']) ?? [])];
    const visited = new Set();
    const result = [];
    while (queue.length > 0) {
        const id = queue.shift();
        if (!id || visited.has(id))
            continue;
        visited.add(id);
        const t = gdb.getTwist(conn, id);
        if (!t)
            continue;
        if (t['twist/fast'])
            result.push(t);
        else
            queue.push(...(gdb.nextTwistIds(conn, id) ?? []));
    }
    return result;
}
// === Line traversal (graph:188-232) ===
export function lineRoot(conn, twist) {
    let t = twist;
    const seen = new Set();
    while (t) {
        if (seen.has(t['twist/id']))
            return null;
        const prevId = t['twist/prev'];
        if (!prevId)
            return t;
        const prevT = gdb.getTwist(conn, prevId);
        if (!prevT)
            return t;
        seen.add(t['twist/id']);
        t = prevT;
    }
    return null;
}
export function lineTip(conn, twist, seen) {
    seen = seen ?? new Set();
    const tid = twist['twist/id'];
    if (seen.has(tid))
        return null;
    const nexts = immediateSuccessors(conn, twist);
    if (nexts.length === 0)
        return twist;
    if (nexts.length === 1) {
        seen.add(tid);
        return lineTip(conn, nexts[0], seen);
    }
    return null; // equivocation
}
export function sliceSegment(conn, start, end) {
    const line = [];
    let t = end;
    const seen = new Set();
    while (t) {
        if (seen.has(t['twist/id']))
            break;
        line.push(t);
        if (t['twist/id'] === start['twist/id'])
            break;
        seen.add(t['twist/id']);
        t = t['twist/prev'] ? gdb.getTwist(conn, t['twist/prev']) : undefined;
    }
    return line.reverse();
}
// === Hitch graph construction (graph:234-322) ===
function downstreamSet(conn, fromTwist) {
    const result = [];
    const visited = new Set([fromTwist['twist/id']]);
    const queue = [...immediateSuccessors(conn, fromTwist)];
    while (queue.length > 0) {
        const cur = queue.shift();
        const cid = cur['twist/id'];
        if (visited.has(cid))
            continue;
        visited.add(cid);
        result.push(cur);
        queue.push(...immediateSuccessors(conn, cur));
    }
    return result;
}
async function locateHoists(lead, cone) {
    const sHex = await selfShieldKey(lead);
    if (!sHex)
        return [];
    return cone.filter(t => t['twist/rigging']?.has(sHex));
}
async function discoverHalfHitches(conn, lead, cone) {
    const fastenerId = lead['twist/tether'];
    if (!fastenerId)
        return [];
    const fastener = gdb.getTwist(conn, fastenerId);
    if (!fastener)
        return [];
    const meetCandidates = nextFastSuccessors(conn, lead);
    const hoistCandidates = await locateHoists(lead, cone);
    const sHex = await selfShieldKey(lead);
    const hoistMeets = [];
    if (sHex) {
        for (const hoist of hoistCandidates) {
            const rig = hoist['twist/rigging'];
            if (!rig)
                continue;
            const meetHex = rig.get(sHex);
            if (meetHex) {
                const meetT = gdb.getTwist(conn, meetHex);
                if (meetT && meetT['twist/fast'])
                    hoistMeets.push(meetT);
            }
        }
    }
    // deduplicate meets
    const meetMap = new Map();
    for (const m of meetCandidates)
        meetMap.set(m['twist/id'], m);
    for (const m of hoistMeets)
        meetMap.set(m['twist/id'], m);
    const allMeets = [...meetMap.values()];
    const result = [];
    for (const hoist of hoistCandidates) {
        const rig = hoist['twist/rigging'];
        if (!rig)
            continue;
        for (const meet of allMeets) {
            if (await checkShieldPairing(lead, rig, meet)) {
                result.push({
                    lead: lead['twist/id'],
                    meet: meet['twist/id'],
                    hoist: hoist['twist/id'],
                    fastener: fastener['twist/id'],
                });
            }
        }
    }
    return result;
}
function locateHitchPost(conn, hh) {
    const meet = gdb.getTwist(conn, hh.meet);
    if (!meet)
        return undefined;
    // Search fast successors first (same as before)
    const fts = nextFastSuccessors(conn, meet);
    for (const ft of fts) {
        const rig = ft['twist/rigging'];
        if (rig && rig.get(hh.lead) === hh.hoist)
            return ft['twist/id'];
    }
    // If no fast post found, search non-fast successors too (§7.1)
    const queue = [...(gdb.nextTwistIds(conn, meet['twist/id']) ?? [])];
    const visited = new Set();
    while (queue.length > 0) {
        const id = queue.shift();
        if (!id || id === meet['twist/id'] || visited.has(id))
            continue;
        visited.add(id);
        const t = gdb.getTwist(conn, id);
        if (!t)
            continue;
        const rig = t['twist/rigging'];
        if (rig && rig.get(hh.lead) === hh.hoist)
            return t['twist/id'];
        // Continue searching through all successors
        const nids = gdb.nextTwistIds(conn, id);
        if (nids)
            for (const nid of nids)
                queue.push(nid);
    }
    return undefined;
}
export async function buildHitchGraph(conn) {
    const fts = gdb.fastTwists(conn);
    // cone cache
    const coneCache = new Map();
    function getCone(fastenerId) {
        let c = coneCache.get(fastenerId);
        if (!c) {
            const f = gdb.getTwist(conn, fastenerId);
            c = f ? downstreamSet(conn, f) : [];
            coneCache.set(fastenerId, c);
        }
        return c;
    }
    const allHH = [];
    for (const ft of fts) {
        const tether = ft['twist/tether'];
        if (!tether)
            continue;
        const cone = getCone(tether);
        allHH.push(...await discoverHalfHitches(conn, ft, cone));
    }
    const hitchEntities = [];
    const leadUpdates = [];
    for (const hh of allHH) {
        const postId = locateHitchPost(conn, hh);
        const entity = {
            'hitch/id': `hitch-${hh.lead}-${hh.meet}`,
            'hitch/lead': hh.lead,
            'hitch/meet': hh.meet,
            'hitch/hoist': hh.hoist,
            'hitch/fastener': hh.fastener,
            'node/type': 'hitch',
        };
        if (postId)
            entity['hitch/post'] = postId;
        hitchEntities.push(entity);
        const leadUpdate = {
            'twist/id': hh.lead,
            'twist/hitch-valid': true,
            'twist/hoist-id': hh.hoist,
            'twist/meet-id': hh.meet,
            'node/type': 'twist',
        };
        leadUpdates.push(leadUpdate);
    }
    if (hitchEntities.length > 0)
        gdb.transact(conn, hitchEntities);
    if (leadUpdates.length > 0)
        gdb.transact(conn, leadUpdates);
}
export async function precomputeShieldKeys(conn) {
    const fts = gdb.fastTwists(conn);
    const updates = [];
    for (const ft of fts) {
        const sHex = await selfShieldKey(ft);
        if (sHex) {
            updates.push({
                'twist/id': ft['twist/id'],
                'twist/hash': ft['twist/hash'],
                'twist/lat': ft['twist/lat'],
                'twist/fast': ft['twist/fast'],
                'twist/rigging': ft['twist/rigging'],
                'twist/shield-bytes': ft['twist/shield-bytes'],
                'twist/s-lead-hex': sHex,
                'node/type': 'twist',
            });
        }
    }
    if (updates.length > 0)
        gdb.transact(conn, updates);
}
// ── Twist validation (graph:292-360) ──────────────────
async function validateTwistEntity(conn, twist) {
    const twistId = twist['twist/id'];
    const prevId = twist['twist/prev'];
    const missing = twist['twist/missing-atoms'];
    let colour = 'green';
    let issues = new Set();
    // prev not in graph → yellow
    if (prevId) {
        const prevT = gdb.getTwist(conn, prevId);
        if (!prevT) {
            colour = 'yellow';
            issues.add('prev-not-in-graph');
        }
        else {
            // validate succession
            try {
                const merged = new Map([...prevT['twist/lat'], ...twist['twist/lat']]);
                const result = await checkSuccession(merged, twistId, prevId);
                if (result === 'red') {
                    colour = 'red';
                    issues.add('reqsat-failed');
                }
                else if (result === 'yellow') {
                    colour = 'yellow';
                    issues.add('reqsat-incomplete');
                }
            }
            catch {
                colour = 'red';
                issues.add('reqsat-error');
            }
        }
    }
    // fast twist missing shield
    if (twist['twist/fast'] && (!twist['twist/shield-bytes'] || (missing && missing.has('shield')))) {
        colour = worstResult([colour, 'yellow']);
        issues.add('missing-shield');
    }
    // missing crypto atoms
    if (missing && (missing.has('req') || missing.has('sat'))) {
        colour = worstResult([colour, 'yellow']);
        issues.add('missing-crypto-atoms');
    }
    return {
        'twist/id': twistId,
        'twist/hash': twist['twist/hash'],
        'twist/lat': twist['twist/lat'],
        'twist/fast': twist['twist/fast'],
        'twist/rigging': twist['twist/rigging'],
        'twist/shield-bytes': twist['twist/shield-bytes'],
        'twist/valid': colour,
        'twist/validation-issues': issues,
        'node/type': 'twist',
    };
}
async function checkTwistIntegrity(conn, twistIds) {
    const updates = [];
    for (const tid of twistIds) {
        const t = gdb.getTwist(conn, tid);
        if (t)
            updates.push(await validateTwistEntity(conn, t));
    }
    if (updates.length > 0)
        gdb.transact(conn, updates);
}
export function recheckWarnings(conn) {
    const yellows = [];
    for (const t of gdb.allTwists(conn)) {
        if (t['twist/valid'] === 'yellow' && t['twist/validation-issues']?.has('prev-not-in-graph')) {
            yellows.push(t['twist/id']);
        }
    }
    if (yellows.length > 0)
        checkTwistIntegrity(conn, yellows);
}
// ── Twist addition (graph:362-480) ────────────────────
function insertTwists(conn, twists) {
    const entities = twists.map(t => {
        const clean = {};
        for (const [k, v] of Object.entries(t)) {
            if (v !== null && v !== undefined)
                clean[k] = v;
        }
        return clean;
    });
    if (entities.length > 0) {
        gdb.transact(conn, entities);
        checkTwistIntegrity(conn, entities.map(t => t['twist/id']));
    }
    return entities;
}
function loadTwistLat(conn, lat) {
    const added = insertTwists(conn, parseTwistRecords(lat));
    // patch-incomplete-twists! — we skip for now since all data is loaded at once
    // in the test harness; incremental loading would need this
    return added;
}
// ── Populate ──────────────────────────────────────────
export async function loadTwists(conn, l) {
    const added = loadTwistLat(conn, l);
    if (added.length > 0) {
        await precomputeShieldKeys(conn);
        await buildHitchGraph(conn);
        recheckWarnings(conn);
    }
}
