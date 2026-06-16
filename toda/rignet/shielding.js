import { concat } from './bytes.js';
import { hashFromData, hashToBytes } from './hash.js';
import { isNullAtom, arbContent } from './atom.js';
async function computeShield(shieldBytes, twistHash, hashToShield) {
    return hashFromData(concat(shieldBytes, hashToBytes(hashToShield)), twistHash.algo);
}
export async function shieldAtom(shieldAtom, twistHash, hashToShield) {
    const shieldBytes = isNullAtom(shieldAtom) ? new Uint8Array(0) : arbContent(shieldAtom);
    return computeShield(shieldBytes, twistHash, hashToShield);
}
export async function doubleShieldAtom(shieldAtom, twistHash, hashToShield) {
    const shieldBytes = isNullAtom(shieldAtom) ? new Uint8Array(0) : arbContent(shieldAtom);
    const first = await computeShield(shieldBytes, twistHash, hashToShield);
    return computeShield(shieldBytes, twistHash, first);
}
export async function applyShield(shieldBytes, twistHash, hashToShield) {
    return computeShield(shieldBytes, twistHash, hashToShield);
}
export async function applyDoubleShield(shieldBytes, twistHash, hashToShield) {
    const first = await computeShield(shieldBytes, twistHash, hashToShield);
    return computeShield(shieldBytes, twistHash, first);
}
