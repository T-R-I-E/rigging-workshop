import { hexToBytes } from './bytes.js';
import { hashFromBytes, hashToHex, hashToBytes, NULL_HEX, isSymbolHex } from './hash.js';
import { NULL_ATOM, isNullAtom, isSymbolAtom } from './atom.js';
// Map cannot carry extra metadata. We use a private WeakMap for focus.
const focusMap = new WeakMap();
export function lat(atoms) {
    const m = new Map();
    let lastHex = null;
    for (const atm of atoms) {
        const hex = hashToHex(atm.hash);
        m.set(hex, atm);
        lastHex = hex;
    }
    focusMap.set(m, atoms.length > 0 ? lastHex : null);
    return m;
}
export function focus(l) {
    return focusMap.get(l) ?? null;
}
function specialAtom(hexKey) {
    if (hexKey === NULL_HEX)
        return NULL_ATOM;
    if (isSymbolHex(hexKey)) {
        // Symbol atoms carry no packet — build directly so this stays synchronous
        // (atomFromBytes is async now that hash verification uses SubtleCrypto).
        const symHash = hashFromBytes(hexToBytes(hexKey));
        return { type: 'atom', hash: symHash, packet: null, serialized: hashToBytes(symHash) };
    }
    return null;
}
export function latGet(l, hexKey) {
    return specialAtom(hexKey) ?? l.get(hexKey) ?? null;
}
export function latConj(l, atm) {
    if (isNullAtom(atm) || isSymbolAtom(atm))
        return l;
    const hex = hashToHex(atm.hash);
    const m = new Map(l);
    m.set(hex, atm);
    focusMap.set(m, hex);
    return m;
}
export function withFocus(l, hexKey) {
    const m = new Map(l);
    focusMap.set(m, hexKey);
    return m;
}
export function safeMerge(...lats) {
    const nonNil = lats.filter((l) => l != null);
    if (nonNil.length === 0) {
        const m = new Map();
        focusMap.set(m, null);
        return m;
    }
    const merged = new Map();
    for (const l of nonNil) {
        for (const [k, v] of l) {
            merged.set(k, v);
        }
    }
    const lastFocus = focus(nonNil[nonNil.length - 1]);
    focusMap.set(merged, lastFocus);
    return merged;
}
