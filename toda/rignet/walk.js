import { latGet, withFocus } from './lat.js';
import { hashToHex } from './hash.js';
import { isArb, isHashes, isPairtrie, isTwist, isBody, hashesContent, pairtrieContent, twistBody, twistSat, bodyShield, bodyReq, bodyRigging, bodyCargo } from './atom.js';
function collectReachable(acc, l, hexKey) {
    if (hexKey === null || acc.has(hexKey))
        return acc;
    const atm = latGet(l, hexKey);
    if (!atm)
        return acc;
    if (isArb(atm)) {
        acc.set(hexKey, atm);
    }
    else if (isHashes(atm)) {
        acc.set(hexKey, atm);
        const content = hashesContent(atm);
        for (const h of content) {
            collectReachable(acc, l, hashToHex(h));
        }
    }
    else if (isPairtrie(atm)) {
        acc.set(hexKey, atm);
        const content = pairtrieContent(atm);
        for (const [k, v] of content) {
            collectReachable(acc, l, hashToHex(k));
            collectReachable(acc, l, hashToHex(v));
        }
    }
    // twist and body are not walked into (they fall through)
    return acc;
}
export function collectAtoms(l, hexKey) {
    const result = collectReachable(new Map(), l, hexKey);
    return result.size > 0 ? result : null;
}
export function extractTwistAtoms(l, twistHex) {
    const atm = latGet(l, twistHex);
    const isTw = atm !== null && isTwist(atm);
    if (!isTw || !atm) {
        // Not a twist — return minimal result with just focus
        const acc = new Map();
        if (atm)
            acc.set(twistHex, atm);
        return withFocus(acc, twistHex);
    }
    const bodyHash = twistBody(atm);
    const satHash = twistSat(atm);
    const bodyH = bodyHash ? hashToHex(bodyHash) : null;
    const satH = satHash ? hashToHex(satHash) : null;
    const bodyAtm = bodyH !== null ? latGet(l, bodyH) : null;
    const isBd = bodyAtm !== null && isBody(bodyAtm);
    let shieldH = null;
    let reqH = null;
    let riggingH = null;
    let cargoH = null;
    if (isBd && bodyAtm) {
        const sh = bodyShield(bodyAtm);
        const rq = bodyReq(bodyAtm);
        const rg = bodyRigging(bodyAtm);
        const cg = bodyCargo(bodyAtm);
        shieldH = sh ? hashToHex(sh) : null;
        reqH = rq ? hashToHex(rq) : null;
        riggingH = rg ? hashToHex(rg) : null;
        cargoH = cg ? hashToHex(cg) : null;
    }
    const acc = new Map();
    acc.set(twistHex, atm);
    if (bodyAtm && bodyH)
        acc.set(bodyH, bodyAtm);
    for (const h of [shieldH, reqH, riggingH, cargoH, satH]) {
        collectReachable(acc, l, h);
    }
    return withFocus(acc, twistHex);
}
