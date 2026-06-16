import { latGet, focus as latFocus } from './lat.js';
import { hashToHex, NULL_HEX } from './hash.js';
import { isTwist, isBody, twistBody as atomTwistBody, twistSat as atomTwistSat, bodyPrev as atomBodyPrev, bodyTether, bodyShield, bodyReq, bodyRigging, bodyCargo, } from './atom.js';
const nullHex = NULL_HEX;
function nullHexP(hex) {
    return hex === nullHex;
}
// --- Body field accessors ---
function getInBody(l, twistHex, accessor) {
    if (nullHexP(twistHex))
        return nullHex;
    const bodyHex = getBody(l, twistHex);
    if (!bodyHex)
        return null;
    const bodyAtm = latGet(l, bodyHex);
    if (!bodyAtm)
        return null;
    const h = accessor(bodyAtm);
    return h ? hashToHex(h) : null;
}
export function getBody(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    const atm = latGet(l, hex);
    if (!atm || !isTwist(atm))
        return null;
    const bodyHash = atomTwistBody(atm);
    return bodyHash ? hashToHex(bodyHash) : null;
}
export function getSat(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    const atm = latGet(l, hex);
    if (!atm || !isTwist(atm))
        return null;
    const satHash = atomTwistSat(atm);
    return satHash ? hashToHex(satHash) : null;
}
export function getPrev(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    return getInBody(l, hex, atomBodyPrev);
}
export function getTether(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    return getInBody(l, hex, bodyTether);
}
export function getShield(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    return getInBody(l, hex, bodyShield);
}
export function getReq(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    return getInBody(l, hex, bodyReq);
}
export function getRigging(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    return getInBody(l, hex, bodyRigging);
}
export function getCargo(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return null;
    return getInBody(l, hex, bodyCargo);
}
// --- Predicates ---
export function isFast(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return false;
    const tether = getTether(l, hex);
    return tether !== null && !nullHexP(tether);
}
export function isFirst(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return false;
    const prev = getPrev(l, hex);
    return prev === nullHex;
}
// --- Chain navigation ---
export function lastFast(l, twistHex, skipN = 0) {
    let current = twistHex;
    let n = skipN;
    const seen = new Set();
    while (current !== null && !nullHexP(current) && !seen.has(current)) {
        if (n > 0) {
            if (isFast(l, current)) {
                seen.add(current);
                current = getPrev(l, current);
                n--;
            }
            else {
                seen.add(current);
                current = getPrev(l, current);
            }
        }
        else {
            if (isFast(l, current)) {
                return current;
            }
            seen.add(current);
            current = getPrev(l, current);
        }
    }
    return null;
}
export function safeHistory(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return [];
    const result = [];
    let current = hex;
    while (current !== null && !nullHexP(current) && latGet(l, current) !== null) {
        result.push(current);
        current = getPrev(l, current);
    }
    return result.reverse();
}
// --- Succession ---
export function successorMap(l) {
    // Build body -> twist mapping
    const bodyToTwist = new Map();
    for (const [twistHex, atm] of l) {
        if (isTwist(atm)) {
            const bodyHash = atomTwistBody(atm);
            if (bodyHash) {
                bodyToTwist.set(hashToHex(bodyHash), twistHex);
            }
        }
    }
    // Build prev -> successor mapping
    const succMap = new Map();
    for (const [_bodyHex, atm] of l) {
        if (isBody(atm)) {
            const prevHash = atomBodyPrev(atm);
            if (prevHash) {
                const prevHex = hashToHex(prevHash);
                const bodyHex = hashToHex(atm.hash);
                const twistHex = bodyToTwist.get(bodyHex);
                if (twistHex) {
                    succMap.set(prevHex, twistHex);
                }
            }
        }
    }
    return succMap;
}
export function listSuccessors(l, twistHex, sm) {
    const succ = sm ?? successorMap(l);
    const result = [];
    let current = twistHex;
    while (current !== undefined) {
        result.push(current);
        current = succ.get(current);
    }
    return result;
}
export function getSuccessor(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return undefined;
    return successorMap(l).get(hex);
}
export function getLatest(l, twistHex) {
    const hex = twistHex ?? latFocus(l);
    if (!hex)
        return undefined;
    const succs = listSuccessors(l, hex);
    return succs[succs.length - 1];
}
