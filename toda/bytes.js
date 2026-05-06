// Byte primitives: hex ↔ Uint8Array, SHA-256, concat, big-endian int32, random.

export function hex_to_bytes(hex) {
  if (hex.length % 2) throw new Error('odd-length hex')
  let out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

const HEX = Array.from({length: 256}, (_, i) => i.toString(16).padStart(2, '0'))

export function bytes_to_hex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]]
  return s
}

export async function sha256(bytes) {
  let buf = await crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(buf)
}

export function byte_concat(...parts) {
  let n = 0
  for (let p of parts) n += p.length
  let out = new Uint8Array(n)
  let i = 0
  for (let p of parts) { out.set(p, i); i += p.length }
  return out
}

export function be32(n) {
  let out = new Uint8Array(4)
  out[0] = (n >>> 24) & 0xff
  out[1] = (n >>> 16) & 0xff
  out[2] = (n >>>  8) & 0xff
  out[3] =  n         & 0xff
  return out
}

export function read_be32(bytes, offset = 0) {
  return ((bytes[offset]   << 24) |
          (bytes[offset+1] << 16) |
          (bytes[offset+2] <<  8) |
           bytes[offset+3]) >>> 0
}

export function random_bytes(n) {
  let out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}
