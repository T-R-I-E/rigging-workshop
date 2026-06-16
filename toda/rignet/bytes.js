const crypto = globalThis.crypto;
const UINT32_MAX = 4294967295;
export function hexToBytes(s) {
    if (s.length % 2 !== 0) {
        throw new Error(`hexToBytes: odd-length hex string (${s.length} chars)`);
    }
    const len = s.length / 2;
    const result = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        const j = i * 2;
        const hi = parseInt(s[j], 16);
        const lo = parseInt(s[j + 1], 16);
        if (isNaN(hi) || isNaN(lo)) {
            throw new Error(`hexToBytes: invalid hex character at position ${isNaN(lo) ? j + 1 : j}`);
        }
        result[i] = (hi << 4) | lo;
    }
    return result;
}
export function bytesToHex(bs) {
    const hex = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < bs.length; i++) {
        result += hex[bs[i] >> 4] + hex[bs[i] & 0x0f];
    }
    return result;
}
export function concat(...arrays) {
    if (arrays.length === 0)
        return new Uint8Array(0);
    if (arrays.length === 1)
        return arrays[0];
    let totalLen = 0;
    for (const a of arrays)
        totalLen += a.length;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const a of arrays) {
        result.set(a, offset);
        offset += a.length;
    }
    return result;
}
export function slice(bs, start, end) {
    if (start < 0 || end < start || end > bs.length) {
        throw new Error(`slice bounds error: start=${start} end=${end} length=${bs.length}`);
    }
    return bs.slice(start, end);
}
export function split(bs, ...indices) {
    const idxs = [0, ...indices, bs.length];
    const result = [];
    for (let i = 0; i < idxs.length - 1; i++) {
        result.push(slice(bs, idxs[i], idxs[i + 1]));
    }
    return result;
}
export function intToFourByte(x) {
    if (x < 0 || x > UINT32_MAX || !Number.isInteger(x)) {
        throw new Error(`intToFourByte: value out of range: ${x}`);
    }
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint32(0, x, false); // big-endian
    return new Uint8Array(buf);
}
export function fourByteToInt(bs) {
    const buf = bs.buffer.slice(bs.byteOffset, bs.byteOffset + 4);
    const view = new DataView(buf);
    return view.getUint32(0, false); // big-endian
}
export async function sha256(data) {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hash);
}
export function compareBytes(a, b) {
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
        if (a[i] !== b[i]) {
            return a[i] < b[i] ? -1 : 1;
        }
    }
    if (a.length < b.length)
        return -1;
    if (a.length > b.length)
        return 1;
    return 0;
}
