import { concat, slice, intToFourByte, fourByteToInt, bytesToHex } from './bytes.js';
import { hashFromBytes, hashToBytes, hashToHex } from './hash.js';
import { TodaError } from './errors.js';
const SHAPE_TWIST = 0x48;
const SHAPE_BODY = 0x49;
const SHAPE_ARB = 0x60;
const SHAPE_HASHES = 0x61;
const SHAPE_PAIRTRIE = 0x63;
const SHAPE_BY_CODE = {
    [SHAPE_TWIST]: 'twist',
    [SHAPE_BODY]: 'body',
    [SHAPE_ARB]: 'arb',
    [SHAPE_HASHES]: 'hashes',
    [SHAPE_PAIRTRIE]: 'pairtrie',
};
const SHAPE_LENGTH = 1;
const SIZE_LENGTH = 4;
const CONTENT_OFFSET = SHAPE_LENGTH + SIZE_LENGTH;
function hashByteLength(firstByte) {
    switch (firstByte) {
        case 0x00: return 1;
        case 0xFF: return 1;
        case 0x22: return 33;
        case 0x41: return 33;
        default: return -1;
    }
}
function parseHashList(content) {
    const hashes = [];
    let offset = 0;
    while (offset < content.length) {
        const firstByte = content[offset];
        const hashLen = hashByteLength(firstByte);
        if (hashLen < 0) {
            hashes.push(hashFromBytes(slice(content, offset, content.length)));
            break;
        }
        if (offset + hashLen > content.length) {
            throw new TodaError('atomic-error', 'Hash must contain at least 1 byte.');
        }
        hashes.push(hashFromBytes(slice(content, offset, offset + hashLen)));
        offset += hashLen;
    }
    return hashes;
}
function serializePacket(shape, content) {
    return concat(new Uint8Array([shape]), intToFourByte(content.length), content);
}
// --- Parsing ---
export function packetFromBytes(bs) {
    if (bs.length < CONTENT_OFFSET) {
        throw new TodaError('atomic-error', 'Packet is not long enough.');
    }
    const shape = bs[0];
    const len = fourByteToInt(slice(bs, SHAPE_LENGTH, CONTENT_OFFSET));
    const headerLen = CONTENT_OFFSET + len;
    if (bs.length < headerLen) {
        throw new TodaError('atomic-error', "Packet's length mismatch.");
    }
    const content = slice(bs, CONTENT_OFFSET, headerLen);
    if (!SHAPE_BY_CODE[shape]) {
        throw new TodaError('nospec-error', `Unknown packet shape: ${bytesToHex(new Uint8Array([shape]))}`);
    }
    const shapeKw = SHAPE_BY_CODE[shape];
    if (len === 0 && shapeKw !== 'hashes' && shapeKw !== 'pairtrie') {
        throw new TodaError('shape-error', "Packet's length cannot be 0.");
    }
    const serialized = slice(bs, 0, headerLen);
    if (shapeKw === 'twist') {
        const hashes = parseHashList(content);
        if (hashes.length !== 2)
            throw new TodaError('shape-error', 'Twist must contain exactly 2 hashes.');
        return { type: 'packet', shape: 'twist', content: { body: hashes[0], sat: hashes[1] }, serialized };
    }
    if (shapeKw === 'body') {
        const hashes = parseHashList(content);
        if (hashes.length !== 6)
            throw new TodaError('shape-error', 'Body must contain exactly 6 hashes.');
        return {
            type: 'packet', shape: 'body',
            content: { prev: hashes[0], tether: hashes[1], shield: hashes[2], req: hashes[3], rigging: hashes[4], cargo: hashes[5] },
            serialized,
        };
    }
    if (shapeKw === 'arb') {
        return { type: 'packet', shape: 'arb', content, serialized };
    }
    if (shapeKw === 'hashes') {
        return { type: 'packet', shape: 'hashes', content: len === 0 ? [] : parseHashList(content), serialized };
    }
    if (shapeKw === 'pairtrie') {
        if (len === 0)
            return { type: 'packet', shape: 'pairtrie', content: [], serialized };
        const hashes = parseHashList(content);
        if (hashes.length % 2 !== 0)
            throw new TodaError('shape-error', 'Pairtrie must contain an even number of hashes.');
        const pairs = [];
        for (let i = 0; i < hashes.length; i += 2)
            pairs.push([hashes[i], hashes[i + 1]]);
        const keyHexes = pairs.map(([k]) => hashToHex(k));
        if (new Set(keyHexes).size !== keyHexes.length)
            throw new TodaError('shape-error', 'Pairtrie cannot contain duplicate keys.');
        for (let i = 1; i < keyHexes.length; i++) {
            if (keyHexes[i] <= keyHexes[i - 1])
                throw new TodaError('shape-error', 'Pairtrie keys must be sorted.');
        }
        return { type: 'packet', shape: 'pairtrie', content: pairs, serialized };
    }
    throw new TodaError('nospec-error', `Unknown packet shape: ${shapeKw}`);
}
// --- Constructors ---
export function twist(bodyHash, satHash) {
    const content = concat(hashToBytes(bodyHash), hashToBytes(satHash));
    return { type: 'packet', shape: 'twist', content: { body: bodyHash, sat: satHash }, serialized: serializePacket(SHAPE_TWIST, content) };
}
export function body(prev, tether, shield, req, rig, cargo) {
    const content = concat(hashToBytes(prev), hashToBytes(tether), hashToBytes(shield), hashToBytes(req), hashToBytes(rig), hashToBytes(cargo));
    return { type: 'packet', shape: 'body', content: { prev, tether, shield, req, rigging: rig, cargo }, serialized: serializePacket(SHAPE_BODY, content) };
}
export function arb(data) {
    return { type: 'packet', shape: 'arb', content: data, serialized: serializePacket(SHAPE_ARB, data) };
}
export function hashes(hashColl) {
    return { type: 'packet', shape: 'hashes', content: hashColl, serialized: serializePacket(SHAPE_HASHES, concat(...hashColl.map(hashToBytes))) };
}
function sortHashPairs(pairs) {
    return [...pairs].sort((a, b) => {
        const aH = hashToHex(a[0]), bH = hashToHex(b[0]);
        return aH < bH ? -1 : aH > bH ? 1 : 0;
    });
}
export function pairtrie(kvs) {
    const sorted = sortHashPairs(kvs);
    const keyHexes = sorted.map(([k]) => hashToHex(k));
    if (new Set(keyHexes).size !== keyHexes.length)
        throw new TodaError('shape-error', 'Pairtrie cannot contain duplicate keys.');
    for (let i = 1; i < keyHexes.length; i++) {
        if (keyHexes[i] <= keyHexes[i - 1])
            throw new TodaError('shape-error', 'Pairtrie keys must be sorted.');
    }
    const content = concat(...sorted.flatMap(([k, v]) => [hashToBytes(k), hashToBytes(v)]));
    return { type: 'packet', shape: 'pairtrie', content: sorted, serialized: serializePacket(SHAPE_PAIRTRIE, content) };
}
// --- Serialization ---
export function packetToBytes(p) { return p.serialized; }
// --- Predicates ---
export function isTwist(p) { return p.shape === 'twist'; }
export function isBody(p) { return p.shape === 'body'; }
export function isArb(p) { return p.shape === 'arb'; }
export function isHashes(p) { return p.shape === 'hashes'; }
export function isPairtrie(p) { return p.shape === 'pairtrie'; }
// --- Accessors ---
export function twistBody(p) { return isTwist(p) ? p.content.body : null; }
export function twistSat(p) { return isTwist(p) ? p.content.sat : null; }
export function bodyPrev(p) { return isBody(p) ? p.content.prev : null; }
export function bodyTether(p) { return isBody(p) ? p.content.tether : null; }
export function bodyShield(p) { return isBody(p) ? p.content.shield : null; }
export function bodyReq(p) { return isBody(p) ? p.content.req : null; }
export function bodyRigging(p) { return isBody(p) ? p.content.rigging : null; }
export function bodyCargo(p) { return isBody(p) ? p.content.cargo : null; }
export function arbContent(p) { return isArb(p) ? p.content : null; }
export function hashesContent(p) { return isHashes(p) ? p.content : null; }
export function pairtrieContent(p) { return isPairtrie(p) ? p.content : null; }
