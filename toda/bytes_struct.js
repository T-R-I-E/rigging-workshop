// Atom-level structural comparison of two .toda byte streams. The full
// compile pipeline produces fresh random shields, ed25519 keypairs, and
// signatures every run, so byte-equality between a decompile→recompile
// pair is almost never possible. This module asks the looser question:
// do the two byte streams have the same atom structure?
//
// v1 is just shape counts. Catches the "decompile silently dropped a
// hitch" failure mode where the atom mix shifts. Doesn't catch deeper
// topology differences yet — we'll grow this as we find the gaps.

import { parse_atoms } from './decompile.js'

const SHAPE_NAMES = {
  0x22: 'symbol',
  0x41: 'sha256',
  0x48: 'twist',
  0x49: 'body',
  0x60: 'arb',
  0x61: 'hashlist',
  0x63: 'pairtrie',
}

function shape_counts(env) {
  let out = {}
  for (let [shape, atoms] of Object.entries(env.shapes)) {
    out[SHAPE_NAMES[shape] || `0x${(+shape).toString(16)}`] = atoms.length
  }
  return out
}

export function bytes_struct_equal(a, b) {
  let envA = parse_atoms(a)
  let envB = parse_atoms(b)
  let countsA = shape_counts(envA)
  let countsB = shape_counts(envB)
  let keys = new Set([...Object.keys(countsA), ...Object.keys(countsB)])
  let diff = {}
  for (let k of keys) {
    let ca = countsA[k] || 0, cb = countsB[k] || 0
    if (ca !== cb) diff[k] = { a: ca, b: cb }
  }
  if (Object.keys(diff).length === 0) {
    return { equal: true }
  }
  return { equal: false, reason: 'shape-counts-differ',
           counts: { a: countsA, b: countsB }, diff }
}
