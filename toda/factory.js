// Atom factories. Each returns a Lat with the new atom focused, plus all the
// val Lats merged in. Mirrors lat.factory in toda-core.
//
// Inputs to body/twist may be either a hash hex string (already-built atoms
// referenced by hash) or a Lat (whose focus is what gets included).

import { byte_concat } from './bytes.js'
import {
  SHAPE, NULL_HASH, from_packet, merge_lats, get_hash, hash_to_bytes,
} from './lat.js'

export async function arb(bytes) {
  return await from_packet(SHAPE.arb, bytes)
}

export async function hashes(items) {
  // items = [hex | Lat, ...]
  let hex_keys = items.map(get_hash)
  let content = byte_concat(...hex_keys.map(hash_to_bytes))
  let focus_lat = await from_packet(SHAPE.hashes, content)
  return merge_lats(...items.filter(x => x instanceof Map), focus_lat)
}

export async function pairtrie(pairs) {
  // pairs = [[key_hex|Lat, val_hex|Lat], ...]
  if (!pairs.length) return null
  let resolved = pairs.map(([k, v]) => [get_hash(k), get_hash(v), k, v])
  // sort by key for the packet content (matching pairtrie sorted-by-key invariant)
  let sorted = [...resolved].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  let seen = new Set()
  let unique = sorted.filter(([k]) => seen.has(k) ? false : seen.add(k))
  let content = byte_concat(...unique.flatMap(([k, v]) => [
    hash_to_bytes(k), hash_to_bytes(v),
  ]))
  let focus_lat = await from_packet(SHAPE.pairtrie, content)
  // val_lats are merged in INPUT order (matching Clojure's mapcat-identity over m)
  let val_lats = pairs.flatMap(([k, v]) => [k, v]).filter(x => x instanceof Map)
  return merge_lats(...val_lats, focus_lat)
}

export async function body({prev, tether, shield, req, rig, cargo}) {
  let xs = [prev, tether, shield, req, rig, cargo]
  let hexes = xs.map(x => get_hash(x) ?? NULL_HASH)
  let content = byte_concat(...hexes.map(hash_to_bytes))
  let focus_lat = await from_packet(SHAPE.body, content)
  let val_lats = xs.filter(x => x instanceof Map)
  return merge_lats(...val_lats, focus_lat)
}

// signFn(body_hash_hex) returns either a Lat (sat pairtrie) or a hex string
// (defaults to null_hash). twist returns a Lat focused on the new twist atom.
export async function twist({prev, tether, shield, req, rig, cargo, signFn}) {
  let body_lat   = await body({prev, tether, shield, req, rig, cargo})
  let body_focus = get_hash(body_lat)
  let sat        = signFn ? await signFn(body_focus) : NULL_HASH
  let sat_hex    = get_hash(sat) ?? NULL_HASH
  let content    = byte_concat(hash_to_bytes(body_focus), hash_to_bytes(sat_hex))
  let focus_lat  = await from_packet(SHAPE.twist, content)
  return merge_lats(
    body_lat,
    sat instanceof Map ? sat : null,
    focus_lat,
  )
}
