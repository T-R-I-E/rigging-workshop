import { hexToBytes } from './bytes.js';
import { hashToHex, NULL_HEX } from './hash.js';
import { isArb, isHashes, isPairtrie, arbContent, hashesContent, pairtrieContent, } from './atom.js';
import { latGet } from './lat.js';
import { getBody, getSat, getReq, } from './twist.js';
import { verifySignature, verifyEd25519 } from './crypto.js';
// Symbol hashes for known interpreters (precomputed with sha256)
const secp256r1Hex = '22eabd2839f9e57cf2c372e686e5856cf651d7f07d0d396b3699d1d228b5931945';
const rslistHex = '22c9bf129a42fd9478fc42c986ba5b8786675ee42109cd3a9fdba208f4e9654148';
const ed25519Hex = '223d5f4f95cdb1cdfc71014efa1a669fd42599a0ce2000d914a409e48bccaed584';
const knownInterpreters = new Set([secp256r1Hex, rslistHex, ed25519Hex]);
const nullHex = NULL_HEX;
const minConsensusWeight = 255;
export function mergeResults(a, b) {
    if (a === 'red' || b === 'red')
        return 'red';
    if (a === 'yellow' || b === 'yellow')
        return 'yellow';
    return 'green';
}
export function worstResult(colours) {
    return colours.reduce(mergeResults, 'green');
}
// --- Atom checking ---
function atomCheck(l, hexKey, pred) {
    const atm = latGet(l, hexKey);
    if (!atm)
        return 'yellow';
    if (pred(atm))
        return 'green';
    return 'red';
}
// --- secp256r1 check ---
async function checkSecp256r1(l, reqHex, satHex, bodyHex) {
    const reqCheck = atomCheck(l, reqHex, isArb);
    const satCheck = atomCheck(l, satHex, isArb);
    if (reqCheck !== 'green' || satCheck !== 'green') {
        return mergeResults(reqCheck, satCheck);
    }
    const publicKey = arbContent(latGet(l, reqHex));
    const signature = arbContent(latGet(l, satHex));
    const bodyBytes = hexToBytes(bodyHex);
    return await verifySignature(publicKey, bodyBytes, signature) ? 'green' : 'red';
}
// --- ed25519 check ---
async function checkEd25519(l, reqHex, satHex, bodyHex) {
    const reqCheck = atomCheck(l, reqHex, isArb);
    const satCheck = atomCheck(l, satHex, isArb);
    if (reqCheck !== 'green' || satCheck !== 'green') {
        return mergeResults(reqCheck, satCheck);
    }
    const publicKey = arbContent(latGet(l, reqHex));
    const signature = arbContent(latGet(l, satHex));
    const bodyBytes = hexToBytes(bodyHex);
    return await verifyEd25519(publicKey, bodyBytes, signature) ? 'green' : 'red';
}
// --- rslist helpers ---
function isWeightAtom(atm) {
    return isArb(atm) && arbContent(atm).length === 1;
}
function readWeight(l, weightHex) {
    const atm = latGet(l, weightHex);
    if (!atm)
        return { weight: null, colour: 'yellow' };
    if (isWeightAtom(atm)) {
        return { weight: arbContent(atm)[0], colour: 'green' };
    }
    return { weight: null, colour: 'red' };
}
function isEntryAtom(atm) {
    return isHashes(atm) && hashesContent(atm).length === 2;
}
function tallyWeights(checkedPairs) {
    const greenSum = checkedPairs
        .filter(p => p.colour === 'green' && p.weight !== null)
        .reduce((s, p) => s + p.weight, 0);
    const greenOrYellow = checkedPairs.filter(p => p.colour === 'green' || p.colour === 'yellow');
    const greenOrYellowSum = greenOrYellow
        .filter(p => p.weight !== null)
        .reduce((s, p) => s + p.weight, 0);
    const unknownWeight = greenOrYellow.some(p => p.weight === null);
    if (greenSum >= minConsensusWeight)
        return 'green';
    if (unknownWeight)
        return 'yellow';
    if (greenOrYellowSum >= minConsensusWeight)
        return 'yellow';
    return 'red';
}
// --- reqsat checking ---
async function checkReqSatRec(l, reqHex, satHex, bodyHex, seen) {
    const pairKey = `${reqHex}:${satHex}`;
    if (seen.has(pairKey))
        return 'red';
    if (reqHex === nullHex && satHex === nullHex)
        return 'green';
    if (reqHex === nullHex || satHex === nullHex)
        return 'red';
    const reqCheck = atomCheck(l, reqHex, isPairtrie);
    const satCheck = atomCheck(l, satHex, isPairtrie);
    if (reqCheck !== 'green' || satCheck !== 'green') {
        return mergeResults(reqCheck, satCheck);
    }
    const reqPairs = pairtrieContent(latGet(l, reqHex));
    const satPairs = pairtrieContent(latGet(l, satHex));
    const reqKeys = new Set(reqPairs.map(([k]) => hashToHex(k)));
    const satKeys = new Set(satPairs.map(([k]) => hashToHex(k)));
    if (reqKeys.size !== satKeys.size || ![...reqKeys].every(k => satKeys.has(k))) {
        return 'red';
    }
    if (![...reqKeys].every(k => knownInterpreters.has(k))) {
        return 'yellow';
    }
    const reqMap = new Map(reqPairs.map(([k, v]) => [hashToHex(k), hashToHex(v)]));
    const satMap = new Map(satPairs.map(([k, v]) => [hashToHex(k), hashToHex(v)]));
    const seen2 = new Set(seen);
    seen2.add(pairKey);
    const results = [];
    for (const key of reqKeys) {
        if (key === secp256r1Hex) {
            results.push(await checkSecp256r1(l, reqMap.get(key), satMap.get(key), bodyHex));
        }
        else if (key === ed25519Hex) {
            results.push(await checkEd25519(l, reqMap.get(key), satMap.get(key), bodyHex));
        }
        else if (key === rslistHex) {
            results.push(await checkRsList(l, reqMap.get(key), satMap.get(key), bodyHex, seen2));
        }
        else {
            results.push('yellow');
        }
    }
    return worstResult(results);
}
async function checkRsList(l, reqHex, satHex, bodyHex, seen) {
    const reqCheck = atomCheck(l, reqHex, isHashes);
    const satCheck = atomCheck(l, satHex, isHashes);
    if (reqCheck !== 'green' || satCheck !== 'green') {
        return mergeResults(reqCheck, satCheck);
    }
    const reqList = hashesContent(latGet(l, reqHex));
    const satList = hashesContent(latGet(l, satHex));
    if (reqList.length !== satList.length)
        return 'red';
    const checkedPairs = [];
    for (let i = 0; i < reqList.length; i++) {
        const reqEntryH = reqList[i];
        const satH = satList[i];
        const entryHex = hashToHex(reqEntryH);
        const entryCheck = atomCheck(l, entryHex, isEntryAtom);
        if (entryCheck !== 'green') {
            checkedPairs.push({ weight: null, colour: entryCheck });
            continue;
        }
        const entryAtm = latGet(l, entryHex);
        const [weightH, subReqH] = hashesContent(entryAtm);
        const { weight: w, colour: wc } = readWeight(l, hashToHex(weightH));
        const subResult = await checkReqSatRec(l, hashToHex(subReqH), hashToHex(satH), bodyHex, seen);
        checkedPairs.push({ weight: w, colour: worstResult([wc, subResult]) });
    }
    return tallyWeights(checkedPairs);
}
export async function checkReqSat(l, reqHex, satHex, bodyHex) {
    return checkReqSatRec(l, reqHex, satHex, bodyHex, new Set());
}
// --- Succession checking ---
function hasTwist(l, twistHex) {
    const bodyHex = getBody(l, twistHex);
    if (!bodyHex)
        return false;
    return latGet(l, bodyHex) !== null;
}
export async function checkSuccession(l, twistHex, prevHex) {
    const succExists = hasTwist(l, twistHex);
    const predExists = hasTwist(l, prevHex);
    if (!succExists || !predExists)
        return 'yellow';
    const reqHex = getReq(l, prevHex);
    const satHex = getSat(l, twistHex);
    const bodyHex = getBody(l, twistHex);
    if (reqHex && satHex && bodyHex) {
        return checkReqSat(l, reqHex, satHex, bodyHex);
    }
    return 'yellow';
}
export async function checkSegment(l, twistHexes) {
    if (twistHexes.length < 2)
        return 'green';
    const results = [];
    for (let i = 0; i < twistHexes.length - 1; i++) {
        results.push(await checkSuccession(l, twistHexes[i + 1], twistHexes[i]));
    }
    return worstResult(results);
}
export async function checkGraphLine(entities) {
    if (entities.length < 2)
        return 'green';
    const results = [];
    for (let i = 0; i < entities.length - 1; i++) {
        const prevT = entities[i];
        const currT = entities[i + 1];
        const merged = new Map([...prevT['twist/lat'], ...currT['twist/lat']]);
        results.push(await checkSuccession(merged, currT['twist/id'], prevT['twist/id']));
    }
    return worstResult(results);
}
export function checkGraphLineStructure(entities) {
    if (entities.length < 2)
        return 'green';
    const results = [];
    for (let i = 0; i < entities.length - 1; i++) {
        const prevT = entities[i];
        const currT = entities[i + 1];
        const merged = new Map([...prevT['twist/lat'], ...currT['twist/lat']]);
        const currOk = hasTwist(merged, currT['twist/id']);
        const prevOk = hasTwist(merged, prevT['twist/id']);
        results.push((currOk && prevOk) ? 'green' : 'yellow');
    }
    return worstResult(results);
}
