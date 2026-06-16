import { bytesToHex, concat, slice, sha256 } from './bytes.js';
import { TodaError } from './errors.js';
// Hash algorithm codes
const ALGO_NULL = 0x00;
const ALGO_SYMBOL = 0x22;
const ALGO_SHA256 = 0x41;
const ALGO_UNIT = 0xFF;
const KNOWN_ALGOS = new Set([ALGO_NULL, ALGO_SYMBOL, ALGO_SHA256, ALGO_UNIT]);
function algoName(algo) {
    switch (algo) {
        case ALGO_NULL: return 'null';
        case ALGO_SYMBOL: return 'symbol';
        case ALGO_SHA256: return 'sha256';
        case ALGO_UNIT: return 'unit';
        default: return `unknown(0x${algo.toString(16)})`;
    }
}
function digestLength(algo) {
    switch (algo) {
        case ALGO_NULL: return 0;
        case ALGO_SYMBOL: return 32;
        case ALGO_SHA256: return 32;
        case ALGO_UNIT: return 0;
        default: throw new TodaError('nospec-error', `Unknown hash algo: ${algoName(algo)}`);
    }
}
function makeHash(algo, payload) {
    if (!KNOWN_ALGOS.has(algo)) {
        throw new TodaError('nospec-error', `Unknown hash algo: ${algoName(algo)}`);
    }
    const expectedLen = digestLength(algo);
    if (payload.length !== expectedLen) {
        throw new TodaError('atomic-error', `Hash had unexpected length: ${payload.length} expected ${expectedLen}`);
    }
    const serialized = concat(new Uint8Array([algo]), payload);
    return {
        type: 'hash',
        algo,
        payload,
        serialized,
        hex: bytesToHex(serialized),
    };
}
export const NULL_HASH = makeHash(ALGO_NULL, new Uint8Array(0));
export const UNIT_HASH = makeHash(ALGO_UNIT, new Uint8Array(0));
export const NULL_HEX = NULL_HASH.hex;
export function hashFromBytes(bs) {
    if (bs.length === 0) {
        throw new TodaError('atomic-error', 'Hash must contain at least 1 byte.');
    }
    const algo = bs[0];
    if (!KNOWN_ALGOS.has(algo)) {
        throw new TodaError('nospec-error', `Unknown hash algo: ${algoName(algo)}`);
    }
    const payloadLen = digestLength(algo);
    const payload = slice(bs, 1, bs.length);
    if (payload.length !== payloadLen) {
        throw new TodaError('atomic-error', `Hash had unexpected length: ${payload.length} expected ${payloadLen}`);
    }
    return makeHash(algo, payload);
}
export async function hashFromData(data, algo = ALGO_SHA256) {
    if (!KNOWN_ALGOS.has(algo)) {
        throw new TodaError('nospec-error', `Unknown hash algo: ${algoName(algo)}`);
    }
    if (algo === ALGO_SHA256) {
        return makeHash(ALGO_SHA256, await sha256(data));
    }
    throw new TodaError('nospec-error', `Cannot hash data using algo: ${algoName(algo)}`);
}
export function hashToBytes(h) {
    return h.serialized;
}
export function hashToHex(h) {
    return h.hex;
}
export function isNullHash(h) {
    return h.algo === ALGO_NULL;
}
export function isSymbolHash(h) {
    return h.algo === ALGO_SYMBOL;
}
export function isUnitHash(h) {
    return h.algo === ALGO_UNIT;
}
export function isSymbolHex(hex) {
    return hex.length >= 2 && hex[0] === '2' && hex[1] === '2';
}
export function isSha256Hex(hex) {
    return hex.length >= 2 && hex[0] === '4' && hex[1] === '1';
}
export async function hashVerifies(h, data) {
    if (h.algo === ALGO_SHA256) {
        const computed = await sha256(data);
        if (computed.length !== h.payload.length)
            return false;
        for (let i = 0; i < computed.length; i++) {
            if (computed[i] !== h.payload[i])
                return false;
        }
        return true;
    }
    return false;
}
