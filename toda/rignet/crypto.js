const subtle = globalThis.crypto.subtle;
const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' };
// P-256 signatures are 32-byte r and s. The TODA corpus (and most tooling)
// stores ECDSA signatures DER-encoded, but SubtleCrypto.verify expects the raw
// r‖s (IEEE P-1363) form. Convert DER → raw; pass raw input through unchanged.
const P256_COORD_BYTES = 32;
function leftPadCoord(coord) {
    // DER integers may carry a leading 0x00 (sign bit) or be shorter than 32
    // bytes. Strip leading zeros, then left-pad to a fixed 32-byte field.
    let start = 0;
    while (start < coord.length - 1 && coord[start] === 0)
        start++;
    const trimmed = coord.subarray(start);
    const out = new Uint8Array(P256_COORD_BYTES);
    out.set(trimmed, P256_COORD_BYTES - trimmed.length);
    return out;
}
function derToRawSignature(sig) {
    // Already raw r‖s.
    if (sig.length === P256_COORD_BYTES * 2 && sig[0] !== 0x30)
        return sig;
    // Not a DER SEQUENCE — hand back unchanged and let verify reject it.
    if (sig[0] !== 0x30)
        return sig;
    let offset = 2;
    if (sig[1] & 0x80)
        offset += sig[1] & 0x7f; // long-form length (unusual for P-256)
    if (sig[offset] !== 0x02)
        return sig;
    const rLen = sig[offset + 1];
    const r = sig.subarray(offset + 2, offset + 2 + rLen);
    offset += 2 + rLen;
    if (sig[offset] !== 0x02)
        return sig;
    const sLen = sig[offset + 1];
    const s = sig.subarray(offset + 2, offset + 2 + sLen);
    const out = new Uint8Array(P256_COORD_BYTES * 2);
    out.set(leftPadCoord(r), 0);
    out.set(leftPadCoord(s), P256_COORD_BYTES);
    return out;
}
export async function generateKeypair(curve = 'P-256') {
    const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']);
    const publicKey = await subtle.exportKey('spki', keyPair.publicKey);
    const privateKey = await subtle.exportKey('pkcs8', keyPair.privateKey);
    return {
        publicKey: new Uint8Array(publicKey),
        privateKey: new Uint8Array(privateKey),
    };
}
export async function sign(privateKey, data) {
    const key = await subtle.importKey('pkcs8', privateKey, ECDSA_PARAMS, false, ['sign']);
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
    return new Uint8Array(sig);
}
export async function verifySignature(publicKey, data, signature) {
    try {
        const key = await subtle.importKey('spki', publicKey, ECDSA_PARAMS, false, ['verify']);
        return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRawSignature(signature), data);
    }
    catch {
        return false;
    }
}
export async function verifyEd25519(publicKey, data, signature) {
    try {
        // A bare 32-byte key is the raw Ed25519 public key; anything longer is SPKI.
        const format = publicKey.length === 32 ? 'raw' : 'spki';
        const key = await subtle.importKey(format, publicKey, { name: 'Ed25519' }, false, ['verify']);
        return await subtle.verify({ name: 'Ed25519' }, key, signature, data);
    }
    catch {
        return false;
    }
}
