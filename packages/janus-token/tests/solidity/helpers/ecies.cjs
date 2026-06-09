/**
 * helpers/ecies.cjs — BabyJub ECIES + AES-256-GCM for Solidity tests.
 *
 * Mirrors the SDK algorithm exactly (encrypt-text.ts / decrypt-text.ts /
 * babyjub-keypair.ts) so tests can round-trip ciphertexts that the SDK
 * would produce/consume in production.
 *
 * Construction (identical to SDK):
 *   Encrypt:
 *     1. Fresh ephemeral keypair on BabyJubJub subgroup (BASE8 generator).
 *     2. ECDH: shared = ephPriv · recipientPub  (x-coordinate only).
 *     3. HKDF-SHA256(shared.x.toBytes32(), salt="openjanus/memo/v1"), 32 bytes.
 *     4. AES-256-GCM encrypt with random 12-byte IV.
 *     5. Output: ciphertext = iv(12B) || ct || tag(16B) ; ephemeralPubkey = {x,y}.
 *
 *   Decrypt:
 *     1. ECDH: shared = recipientPriv · ephemeralPub  (x-coordinate only).
 *     2. Same HKDF derivation.
 *     3. AES-256-GCM decrypt; throws on auth-tag failure.
 *
 * Note encoding (mirrors note-schema.ts):
 *   JSON: {"v":1,"amt":"<decimal>","bld":"<decimal>","memo":"..."?}
 *   Encrypted with encryptText; decrypted with decryptText.
 */

"use strict";

const { buildBabyjub } = require("circomlibjs");
const { webcrypto }    = require("crypto");

// ---------------------------------------------------------------------------
// BabyJubJub subgroup order (same constant used in proofGen.cjs)
// ---------------------------------------------------------------------------
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// ---------------------------------------------------------------------------
// HKDF salt — must match SDK exactly
// ---------------------------------------------------------------------------
const HKDF_SALT = Buffer.from("openjanus/memo/v1", "utf8");
const AES_GCM_IV_LEN  = 12;
const AES_GCM_TAG_LEN = 16;
const NOTE_VERSION    = 1;

// ---------------------------------------------------------------------------
// Internal: babyjub instance (lazy singleton)
// ---------------------------------------------------------------------------
let _bj = null;
async function getBabyjub() {
  if (!_bj) _bj = await buildBabyjub();
  return _bj;
}

// ---------------------------------------------------------------------------
// Scalar reduction (uniform: rand % SUBORDER, re-sample if 0)
// ---------------------------------------------------------------------------
async function randomScalar() {
  const crypto = webcrypto;
  while (true) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // Parse big-endian
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    const s = v % SUBORDER;
    if (s !== 0n) return s;
  }
}

// ---------------------------------------------------------------------------
// BabyJub operations
// ---------------------------------------------------------------------------

/**
 * Compute pubkey = privkey * BASE8.
 * @param {bigint} privkey
 * @returns {{x: bigint, y: bigint}}
 */
async function pubkeyFromPrivkey(privkey) {
  const bj = await getBabyjub();
  const pt = bj.mulPointEscalar(bj.Base8, privkey);
  return {
    x: BigInt(bj.F.toString(pt[0])),
    y: BigInt(bj.F.toString(pt[1])),
  };
}

/**
 * Generate a fresh BabyJub keypair (privkey, pubkey).
 * @returns {{privkey: bigint, pubkey: {x: bigint, y: bigint}}}
 */
async function generateKeypair() {
  const privkey = await randomScalar();
  const pubkey  = await pubkeyFromPrivkey(privkey);
  return { privkey, pubkey };
}

/**
 * ECDH shared secret x-coordinate.
 * @param {bigint} privkey
 * @param {{x: bigint, y: bigint}} peerPubkey
 * @returns {bigint}
 */
async function sharedSecret(privkey, peerPubkey) {
  const bj    = await getBabyjub();
  const point = [bj.F.e(peerPubkey.x), bj.F.e(peerPubkey.y)];
  const shared = bj.mulPointEscalar(point, privkey);
  return BigInt(bj.F.toString(shared[0]));
}

// ---------------------------------------------------------------------------
// Internal: HKDF-SHA256 → AES-256-GCM key
// ---------------------------------------------------------------------------

function fieldElemTo32Bytes(n) {
  let hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

async function deriveAesKey(secretX) {
  const ikm = fieldElemTo32Bytes(secretX);
  const baseKey = await webcrypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return webcrypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: new Uint8Array(0),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ---------------------------------------------------------------------------
// Public API — text
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` to `recipientPubkey`.
 * @param {string} plaintext
 * @param {{x: bigint, y: bigint}} recipientPubkey
 * @returns {{ciphertext: Buffer, ephemeralPubkey: {x: bigint, y: bigint}}}
 */
async function encryptText(plaintext, recipientPubkey) {
  const eph    = await generateKeypair();
  const secret = await sharedSecret(eph.privkey, recipientPubkey);
  const key    = await deriveAesKey(secret);

  const iv             = new Uint8Array(AES_GCM_IV_LEN);
  webcrypto.getRandomValues(iv);

  const ptBytes  = Buffer.from(plaintext, "utf8");
  const ctAndTag = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ptBytes)
  );

  const frame = Buffer.concat([Buffer.from(iv), Buffer.from(ctAndTag)]);
  return { ciphertext: frame, ephemeralPubkey: eph.pubkey };
}

/**
 * Decrypt a ciphertext blob produced by encryptText.
 * @param {Buffer|Uint8Array} ciphertext  iv(12B) || ct || tag(16B)
 * @param {{x: bigint, y: bigint}} ephemeralPubkey
 * @param {bigint} privkey  Recipient's BabyJub private scalar.
 * @returns {string}  Decoded UTF-8 plaintext.
 */
async function decryptText(ciphertext, ephemeralPubkey, privkey) {
  const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  if (buf.length < AES_GCM_IV_LEN + AES_GCM_TAG_LEN) {
    throw new Error(`ecies.decryptText: ciphertext too short (${buf.length}B)`);
  }

  const secret = await sharedSecret(privkey, ephemeralPubkey);
  const key    = await deriveAesKey(secret);

  const iv       = buf.subarray(0, AES_GCM_IV_LEN);
  const ctAndTag = buf.subarray(AES_GCM_IV_LEN);

  let plainBytes;
  try {
    plainBytes = new Uint8Array(
      await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ctAndTag)
    );
  } catch {
    throw new Error("ecies.decryptText: authentication failed (wrong key or corrupted ciphertext)");
  }

  return Buffer.from(plainBytes).toString("utf8");
}

// ---------------------------------------------------------------------------
// Public API — note (mirrors note-schema.ts)
// ---------------------------------------------------------------------------

/**
 * Encrypt a note payload { amount, blinding, memo? } to `recipientPubkey`.
 * @param {{amount: bigint, blinding: bigint, memo?: string}} note
 * @param {{x: bigint, y: bigint}} recipientPubkey
 * @returns {{ciphertext: Buffer, ephemeralPubkey: {x: bigint, y: bigint}}}
 */
async function encryptNote(note, recipientPubkey) {
  const wire = { v: NOTE_VERSION, amt: note.amount.toString(), bld: note.blinding.toString() };
  if (note.memo !== undefined) wire.memo = note.memo;
  return encryptText(JSON.stringify(wire), recipientPubkey);
}

/**
 * Decrypt a note blob produced by encryptNote.
 * @param {Buffer|Uint8Array} ciphertext
 * @param {{x: bigint, y: bigint}} ephemeralPubkey
 * @param {bigint} privkey
 * @returns {{amount: bigint, blinding: bigint, memo?: string}}
 */
async function decryptNote(ciphertext, ephemeralPubkey, privkey) {
  const plain = await decryptText(ciphertext, ephemeralPubkey, privkey);
  let w;
  try { w = JSON.parse(plain); } catch { throw new Error("ecies.decryptNote: not valid JSON"); }
  if (!w || w.v !== NOTE_VERSION || !w.amt || !w.bld) {
    throw new Error(`ecies.decryptNote: invalid note format (v=${w?.v})`);
  }
  const result = { amount: BigInt(w.amt), blinding: BigInt(w.bld) };
  if (w.memo !== undefined) result.memo = w.memo;
  return result;
}

module.exports = {
  generateKeypair,
  pubkeyFromPrivkey,
  sharedSecret,
  encryptText,
  decryptText,
  encryptNote,
  decryptNote,
  SUBORDER,
};
