import { concat } from './bytes.js';
import { hashFromBytes, hashToBytes, hashVerifies, NULL_HASH, isNullHash as isNullHashH, isSymbolHash as isSymbolHashH, isUnitHash as isUnitHashH, } from './hash.js';
import { packetFromBytes, isTwist as isTwistP, isBody as isBodyP, isArb as isArbP, isHashes as isHashesP, isPairtrie as isPairtrieP, twistBody as twistBodyP, twistSat as twistSatP, bodyPrev as bodyPrevP, bodyTether as bodyTetherP, bodyShield as bodyShieldP, bodyReq as bodyReqP, bodyRigging as bodyRiggingP, bodyCargo as bodyCargoP, arbContent as arbContentP, hashesContent as hashesContentP, pairtrieContent as pairtrieContentP, } from './packet.js';
import { TodaError } from './errors.js';
export const NULL_ATOM = {
    type: 'atom',
    hash: NULL_HASH,
    packet: null,
    serialized: hashToBytes(NULL_HASH),
};
function symbolAtom(symHash) {
    return {
        type: 'atom',
        hash: symHash,
        packet: null,
        serialized: hashToBytes(symHash),
    };
}
export async function atomFromBytes(bs) {
    // Determine hash length from first byte (algo identifier)
    const algo = bs[0];
    let hashLen;
    switch (algo) {
        case 0x00:
            hashLen = 1;
            break; // null: 1 byte
        case 0xFF:
            hashLen = 1;
            break; // unit: 1 byte
        case 0x22:
            hashLen = 33;
            break; // symbol: 1 + 32
        case 0x41:
            hashLen = 33;
            break; // sha256: 1 + 32
        default: throw new TodaError('nospec-error', `Unknown hash algo byte: 0x${algo.toString(16)}`);
    }
    if (bs.length < hashLen) {
        throw new Error('Hash must contain at least 1 byte.');
    }
    const hashBytes = bs.slice(0, hashLen);
    const h = hashFromBytes(hashBytes);
    if (isNullHashH(h))
        return NULL_ATOM;
    if (isSymbolHashH(h))
        return symbolAtom(h);
    if (isUnitHashH(h))
        return { type: 'atom', hash: h, packet: null, serialized: hashToBytes(h) };
    // Parse packet from remaining bytes
    const packetBytes = bs.slice(hashLen);
    const pkt = packetFromBytes(packetBytes);
    // Verify hash matches packet
    if (h.algo === 0x41) { // SHA256
        if (!await hashVerifies(h, pkt.serialized)) {
            throw new TodaError('atomic-error', 'Hash and packet do not match.');
        }
    }
    const serialized = concat(hashBytes, pkt.serialized);
    return {
        type: 'atom',
        hash: h,
        packet: pkt,
        serialized: serialized,
    };
}
export function atomToBytes(a) {
    return a.serialized;
}
export function isNullAtom(a) {
    return isNullHashH(a.hash);
}
export function isSymbolAtom(a) {
    return isSymbolHashH(a.hash);
}
// --- Shape predicates ---
export function isTwist(a) {
    return a.packet !== null && isTwistP(a.packet);
}
export function isBody(a) {
    return a.packet !== null && isBodyP(a.packet);
}
export function isArb(a) {
    return a.packet !== null && isArbP(a.packet);
}
export function isHashes(a) {
    return a.packet !== null && isHashesP(a.packet);
}
export function isPairtrie(a) {
    return a.packet !== null && isPairtrieP(a.packet);
}
// --- Accessors ---
function nullHashOr(a, fn) {
    if (isNullAtom(a))
        return NULL_HASH;
    if (a.packet)
        return fn(a.packet);
    return null;
}
export function twistBody(a) { return nullHashOr(a, twistBodyP); }
export function twistSat(a) { return nullHashOr(a, twistSatP); }
export function bodyPrev(a) { return nullHashOr(a, bodyPrevP); }
export function bodyTether(a) { return nullHashOr(a, bodyTetherP); }
export function bodyShield(a) { return nullHashOr(a, bodyShieldP); }
export function bodyReq(a) { return nullHashOr(a, bodyReqP); }
export function bodyRigging(a) { return nullHashOr(a, bodyRiggingP); }
export function bodyCargo(a) { return nullHashOr(a, bodyCargoP); }
export function arbContent(a) {
    return isArb(a) ? arbContentP(a.packet) : null;
}
export function hashesContent(a) {
    return isHashes(a) ? hashesContentP(a.packet) : null;
}
export function pairtrieContent(a) {
    return isPairtrie(a) ? pairtrieContentP(a.packet) : null;
}
