// Keypair generation + signing for named reqsat entities.
//
// Uses WebCrypto (`crypto.subtle`), available in modern browsers and
// Node 19+ for both Ed25519 and ECDSA-P256. Avoids the @noble dep that
// the legacy `line.reqsat: "ed25519"` path still uses for back-compat
// with esm.sh.
//
// Per rustoda/src/reqsat.rs ed25519 verifier (`reqsat.rs:251–255`),
// ed25519 keys are the canonical raw 32-byte octet string — no SPKI
// wrap. secp256r1 keys ARE SPKI-encoded (matches todaadot's pattern).
// Signature formats: ed25519 = raw 64 bytes (no wrap); secp256r1 =
// DER-encoded ECDSA-Sig (which is what todaadot's `_toDER` emits and
// what the Clojure / Rust verifiers expect).

import { hex_to_bytes, byte_concat } from './bytes.js'
import { arb, pairtrie, hashes } from './factory.js'
import { lat_focus, NULL_HASH } from './lat.js'

const SYM_ED25519   = '223d5f4f95cdb1cdfc71014efa1a669fd42599a0ce2000d914a409e48bccaed584'
const SYM_SECP256R1 = '22eabd2839f9e57cf2c372e686e5856cf651d7f07d0d396b3699d1d228b5931945'
const SYM_RSLIST    = '22c9bf129a42fd9478fc42c986ba5b8786675ee42109cd3a9fdba208f4e9654148'

export async function generate_reqsat_key(type) {
  if (type === 'ed25519')   return generate_ed25519()
  if (type === 'secp256r1') return generate_secp256r1()
  throw new Error(`generate_reqsat_key: unsupported type ${type}`)
}

async function generate_ed25519() {
  let kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  let pub_raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return {
    type:    'ed25519',
    sym:     SYM_ED25519,
    pub:     pub_raw,
    // Wrap the WebCrypto private CryptoKey in a sign-fn that produces
    // a sat lat (pairtrie {sym → arb(sig)}) when given a body-hash hex.
    sign_fn: async function ed25519_sign(body_hash_hex) {
      let body_bytes = hex_to_bytes(body_hash_hex)
      let sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, body_bytes))
      return await sat_arb_pairtrie(SYM_ED25519, sig)
    },
  }
}

async function generate_secp256r1() {
  let kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  // SPKI = SubjectPublicKeyInfo — the canonical secp256r1 pubkey form
  // per todaadot / Clojure (Java's KeyPairGenerator getEncoded for EC).
  let pub_spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))
  return {
    type:    'secp256r1',
    sym:     SYM_SECP256R1,
    pub:     pub_spki,
    sign_fn: async function secp256r1_sign(body_hash_hex) {
      let body_bytes = hex_to_bytes(body_hash_hex)
      // WebCrypto returns the raw r||s IEEE-P1363 form (64 bytes).
      // Canonical TODA sig is DER-encoded ECDSA-Sig (the same format
      // todaadot's `_toDER` produces).
      let raw_sig = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, body_bytes))
      let der = p1363_to_der(raw_sig)
      return await sat_arb_pairtrie(SYM_SECP256R1, der)
    },
  }
}

// Build the req lat for a single-key reqsat (ed25519 / secp256r1):
//   PairtrieAtom { sym → ArbAtom(pubkey_bytes) }
export async function single_key_req_lat(reqsat_info) {
  let pub_arb = await arb(reqsat_info.pub)
  return await pairtrie([[reqsat_info.sym, pub_arb]])
}

// Build an rslist reqsat from a spec and a map of already-built
// sub-reqsats (name → reqsat-info). Returns the same { type, sym,
// req_lat, sign_fn } shape as single-key reqsats so the rest of the
// build pipeline stays uniform.
//
// Layout (matches Clojure rslist.clj + todaadot RequirementList):
//   req_lat: PairtrieAtom { sym(reqsatlist) → HashesAtom[entry…] }
//   each entry: HashesAtom[weight_arb_h, sub_req_pairtrie_h]
//   weight_arb: Arb(1 byte)
//
// sign_fn aggregates each sub-reqsat's sat and wraps the resulting
// hashes-atom in a pairtrie keyed by sym(reqsatlist). A `null`
// sub-reqsat reference uses NULL_HASH on both sides — matches the
// spec's default-list entry { reqsat: null, weight: 255 }.
export async function build_rslist_reqsat(spec, sub_map) {
  let list = spec.list ?? [{ reqsat: null, weight: 255 }]
  let resolved = []
  for (let item of list) {
    let weight = item.weight
    if (typeof weight !== 'number' || weight < 0 || weight > 255)
      throw new Error(`rslist "${spec.name}": weight must be 0..255, got ${weight}`)
    let sub_info = null
    let sub_h    = NULL_HASH
    if (item.reqsat != null && item.reqsat !== 'null') {
      sub_info = sub_map.get(item.reqsat)
      if (!sub_info)
        throw new Error(`rslist "${spec.name}": unknown sub-reqsat "${item.reqsat}"`)
      sub_h = lat_focus(sub_info.req_lat)
    }
    let weight_lat = await arb(new Uint8Array([weight]))
    // Entry = hashes-shape over [weight_arb, sub_req].
    let entry_lat = await hashes(
      sub_info ? [weight_lat, sub_info.req_lat] : [weight_lat, sub_h])
    resolved.push({ weight, sub_info, entry_lat })
  }
  let master_entries_lat = await hashes(resolved.map(r => r.entry_lat))
  let req_lat = await pairtrie([[SYM_RSLIST, master_entries_lat]])

  async function rslist_sign(body_hash_hex) {
    let sub_sats = []
    for (let r of resolved) {
      if (r.sub_info) {
        let sat = await r.sub_info.sign_fn(body_hash_hex)
        sub_sats.push(sat)
      } else {
        sub_sats.push(NULL_HASH)
      }
    }
    let master_sats_lat = await hashes(sub_sats)
    return await pairtrie([[SYM_RSLIST, master_sats_lat]])
  }

  return { type: 'rslist', sym: SYM_RSLIST, req_lat, sign_fn: rslist_sign }
}

async function sat_arb_pairtrie(sym_hex, bytes) {
  let sig_arb = await arb(bytes)
  return await pairtrie([[sym_hex, sig_arb]])
}

// IEEE-P1363 (raw r||s, fixed 64 bytes) → DER ECDSA-Sig.
// SEQUENCE { INTEGER r, INTEGER s } with leading-zero padding when
// the high bit of either integer would otherwise sign-flip the DER
// encoding. Matches todaadot/src/client/keypair.js:_toDER but
// expressed more directly.
function p1363_to_der(raw) {
  let r = raw.subarray(0, 32)
  let s = raw.subarray(32, 64)
  let r_enc = der_integer(r)
  let s_enc = der_integer(s)
  let inner = byte_concat(r_enc, s_enc)
  // SEQUENCE tag (0x30) + length
  return byte_concat(new Uint8Array([0x30]), der_length(inner.length), inner)
}

function der_integer(bytes) {
  // Trim leading zero bytes (but keep at least one byte).
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  let body = bytes.subarray(start)
  // Add a leading zero if the high bit is set, to prevent negative
  // interpretation in DER.
  let needs_pad = (body[0] & 0x80) !== 0
  let content = needs_pad
    ? byte_concat(new Uint8Array([0x00]), body)
    : body.slice()
  return byte_concat(new Uint8Array([0x02]), der_length(content.length), content)
}

function der_length(n) {
  if (n < 0x80) return new Uint8Array([n])
  // Long-form length — first byte is 0x80 | num-octets, then the
  // length itself as big-endian. For ECDSA-P256 sigs this is at most
  // 2 length bytes (sigs fit comfortably under 256 bytes).
  let out = []
  let m = n
  while (m > 0) { out.unshift(m & 0xff); m >>>= 8 }
  return new Uint8Array([0x80 | out.length, ...out])
}
