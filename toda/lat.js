// Atom + Lat byte-level construction.
//
// A hash is represented as a lowercase hex string of its serialized form:
//   null_hash  → "00"           (1 byte: algo=0x00, no payload)
//   sha256     → "41" + 64 hex  (33 bytes: algo=0x41 || sha256-payload)
//   symbol     → "22" + 64 hex  (33 bytes: algo=0x22 || symbol-payload)
//
// A packet's serialized form is: shape byte || lenBE32 || content.
// An atom = hash-bytes || packet-bytes,  where
//          atom-hash = 0x41 || sha256(packet-bytes).
//
// A Lat is an insertion-ordered Map<hex-hash, atom-bytes>. focus = last key.
// Re-conjing an existing key moves it to the end (matches Clojure's lat conj).

import { byte_concat, be32, sha256, bytes_to_hex, hex_to_bytes } from './bytes.js'

export const NULL_HASH = '00'

export const SHAPE = {
  twist:    0x48,
  body:     0x49,
  arb:      0x60,
  hashes:   0x61,
  pairtrie: 0x63,
}

const HASH_PREFIX = new Uint8Array([0x41])

function packet_bytes(shape, content) {
  return byte_concat(new Uint8Array([shape]), be32(content.length), content)
}

// Build an atom from a (shape, content); return a Lat containing it (focused).
export async function from_packet(shape, content) {
  let pkt        = packet_bytes(shape, content)
  let digest     = await sha256(pkt)
  let hash_b     = byte_concat(HASH_PREFIX, digest)
  let atom_bytes = byte_concat(hash_b, pkt)
  let hex        = bytes_to_hex(hash_b)
  let lat        = new Map()
  lat.set(hex, atom_bytes)
  return lat
}

export function new_lat() { return new Map() }

export function lat_focus(lat) {
  if (!lat || !lat.size) return null
  let last
  for (let k of lat.keys()) last = k
  return last
}

export function lat_to_bytes(lat) {
  let parts = []
  for (let v of lat.values()) parts.push(v)
  return byte_concat(...parts)
}

export function lat_conj(lat, hash_hex, atom_bytes) {
  if (lat.has(hash_hex)) lat.delete(hash_hex)
  lat.set(hash_hex, atom_bytes)
  return lat
}

// Merge any number of Lats together (in order); ignore non-Lat inputs.
// Returns a fresh Lat.
export function merge_lats(...inputs) {
  let out = new Map()
  for (let l of inputs) {
    if (!l || !(l instanceof Map)) continue
    for (let [k, v] of l) lat_conj(out, k, v)
  }
  return out
}

// Resolve x to a hash hex string. x may be a hex string already, or a Lat.
export function get_hash(x) {
  if (typeof x === 'string') return x
  if (x instanceof Map)      return lat_focus(x)
  return null
}

// Convert a hash hex string back to its serialized bytes (variable length:
// 1 byte for null/unit, 33 bytes for sha256/symbol).
export function hash_to_bytes(hash_hex) {
  return hex_to_bytes(hash_hex)
}
