// Ed25519 signing for reqsat=ed25519 lines, via @noble/ed25519's async API
// (uses Web Crypto SHA-512 internally; no sha512 hook required).
//
// NOTE: differs from twist-maker.ed25519 in toda-twist-maker, which uses
// Java's PKCS#8 / X.509 wrapped keys (44 bytes) inside the req arb. Ours
// uses raw 32-byte public keys, so byte output won't match the Clojure
// server on reqsat=ed25519 rigs. shielded:false rigs in the test set use
// reqsat:"null", so byte-equality testing still works there.

import { random_bytes, hex_to_bytes } from './bytes.js'
import { arb, pairtrie } from './factory.js'

const SYM_ED25519 = '223d5f4f95cdb1cdfc71014efa1a669fd42599a0ce2000d914a409e48bccaed584'

// Lazy-load noble so non-ed25519 rigs can run without the dep (e.g. in Node).
let _ed
async function noble() {
  return _ed ??= await import("@noble/ed25519")
}

export async function keypair() {
  let ed = await noble()
  let secret = random_bytes(32)
  let pub    = await ed.getPublicKeyAsync(secret)
  return { secret, pub }
}

export async function sign(secret, data) {
  let ed = await noble()
  return ed.signAsync(data, secret)
}

export async function req_pairtrie(pub) {
  let pub_arb = await arb(pub)
  return await pairtrie([[SYM_ED25519, pub_arb]])
}

export async function sat_pairtrie(sig) {
  let sig_arb = await arb(sig)
  return await pairtrie([[SYM_ED25519, sig_arb]])
}

// sign-fn factory: returns a fn(body_hash_hex) → sat Lat. The body hash hex
// decodes to 33 bytes (algo + sha256-payload) and we sign those 33 bytes
// directly, matching twist-maker.ed25519.
export function sign_fn(secret) {
  return async function(body_hash_hex) {
    let body_bytes = hex_to_bytes(body_hash_hex)
    let sig = await sign(secret, body_bytes)
    return await sat_pairtrie(sig)
  }
}
