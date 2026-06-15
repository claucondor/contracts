/**
 * precompute-ciphertexts.mjs — Generate ECIES fixtures for JanusFT v0.8 Cadence tests.
 *
 * Approach A (per brief): generate ciphertexts off-line, write to JSON fixture file,
 * hardcode representative bytes into the Cadence test as constants.  A separate
 * verify-decode.mjs step proves the full round-trip.
 *
 * What this script does:
 *   1. Generates a known BabyJub recipient keypair (BOB_PRIVKEY → BOB_PUBKEY).
 *   2. Encrypts note payloads using the SDK ECIES scheme (BabyJub ECDH + AES-GCM).
 *   3. Writes the full fixture to tests/helpers/ecies-fixtures.json.
 *   4. Prints Cadence-ready constant declarations to stdout so they can be
 *      copy-pasted into the Cadence test when regenerating.
 *
 * Run from packages/janus-ft:
 *   node tests/helpers/precompute-ciphertexts.mjs
 *
 * The recipient keypair is FIXED (deterministic) for test stability:
 *   BOB_PRIVKEY = 0x1234...abcd (see below)
 *   BOB_PUBKEY  = derived below
 *
 * Note fields:
 *   amt  = transfer amount in UFix64 internal units (e.g. 30_000_000 = 0.30 MockFT)
 *   bld  = blinding scalar (random per-run — stored in fixture for decode verification)
 *   memo = "JanusFT-v0.8-test"
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createCipheriv, createHmac, randomBytes, createHash } from "crypto";
import { webcrypto } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_FILE = join(__dirname, "ecies-fixtures.json");

// ── BabyJubJub subgroup parameters ───────────────────────────────────────────
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// BASE8 — circomlibjs standard BabyJub subgroup generator
const BASE8_X = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
const BASE8_Y = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;

// ── Deterministic test keypair (BOB) ─────────────────────────────────────────
// PRIVKEY chosen as a valid scalar < SUBORDER.
// Do NOT use this for anything other than tests.
const BOB_PRIVKEY = 123456789012345678901234567890123456789012345678901234567890123n;

// ── BabyJubJub helpers (twisted Edwards curve a=168700, d=168696) ─────────────
function modInv(a, m) {
    let [old_r, r] = [a, m];
    let [old_s, s] = [1n, 0n];
    while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
    }
    return ((old_s % m) + m) % m;
}

function babyAdd(x1, y1, x2, y2) {
    const A = 168700n, D = 168696n;
    const tau = (x1 * x2 % P) * (y1 * y2 % P) % P;
    const dtau = D * tau % P;
    const numX = (x1 * y2 + y1 * x2) % P;
    const denX = (1n + dtau) % P;
    const numY = (y1 * y2 % P + P - A * x1 % P * x2 % P) % P;
    const denY = (1n + P - dtau) % P;
    return [numX * modInv(denX, P) % P, numY * modInv(denY, P) % P];
}

function pointMul(px, py, scalar) {
    let rx = 0n, ry = 1n;
    let ex = px, ey = py;
    let rem = scalar;
    while (rem > 0n) {
        if (rem & 1n) [rx, ry] = babyAdd(rx, ry, ex, ey);
        [ex, ey] = babyAdd(ex, ey, ex, ey);
        rem >>= 1n;
    }
    return [rx, ry];
}

// ── ECIES implementation (mirrors openjanus-sdk encrypt-text.ts) ─────────────

const HKDF_SALT = new TextEncoder().encode("openjanus/memo/v1");
const AES_GCM_IV_LEN = 12;

function fieldElementTo32Bytes(n) {
    const out = new Uint8Array(32);
    let hex = n.toString(16).padStart(64, "0");
    for (let i = 0; i < 32; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

async function deriveAesKey(sharedX) {
    const ikm = fieldElementTo32Bytes(sharedX);
    const baseKey = await webcrypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
    return webcrypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: new Uint8Array(0) },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptNote(payload, recipientPubkeyX, recipientPubkeyY) {
    // 1. Fresh ephemeral keypair
    const ephPriv = BigInt("0x" + randomBytes(31).toString("hex")) % SUBORDER || 1n;
    const [ephX, ephY] = pointMul(BASE8_X, BASE8_Y, ephPriv);

    // 2. ECDH shared secret = ephPriv * recipientPubkey (x-coord)
    const [sharedX] = pointMul(recipientPubkeyX, recipientPubkeyY, ephPriv);

    // 3. HKDF + AES-GCM
    const key = await deriveAesKey(sharedX);
    const iv = randomBytes(AES_GCM_IV_LEN);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = new Uint8Array(await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plaintext
    ));

    const ciphertext = new Uint8Array(AES_GCM_IV_LEN + encrypted.length);
    ciphertext.set(iv, 0);
    ciphertext.set(encrypted, AES_GCM_IV_LEN);

    return { ciphertext, ephX, ephY, ephPriv };
}

async function decryptNote(ciphertextBytes, ephX, ephY, recipPrivkey) {
    const [sharedX] = pointMul(ephX, ephY, recipPrivkey);
    const key = await deriveAesKey(sharedX);
    const iv = ciphertextBytes.slice(0, AES_GCM_IV_LEN);
    const ctAndTag = ciphertextBytes.slice(AES_GCM_IV_LEN);
    const decrypted = new Uint8Array(await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ctAndTag
    ));
    return JSON.parse(new TextDecoder().decode(decrypted));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("Precomputing ECIES fixtures for JanusFT v0.8 tests...\n");

    // Bob's public key
    const [bobPubX, bobPubY] = pointMul(BASE8_X, BASE8_Y, BOB_PRIVKEY);
    console.log(`Bob privkey: ${BOB_PRIVKEY}`);
    console.log(`Bob pubkey X: ${bobPubX}`);
    console.log(`Bob pubkey Y: ${bobPubY}\n`);

    // Fixture 1: 0.30 MockFT transfer note
    const payload1 = { v: 1, amt: "30000000", bld: "98765432109876543210987654", memo: "JanusFT-v0.8-test" };
    const enc1 = await encryptNote(payload1, bobPubX, bobPubY);

    // Verify round-trip
    const dec1 = await decryptNote(enc1.ciphertext, enc1.ephX, enc1.ephY, BOB_PRIVKEY);
    if (dec1.amt !== payload1.amt || dec1.bld !== payload1.bld) {
        throw new Error("FIXTURE 1 ROUND-TRIP FAILED");
    }
    console.log("Fixture 1 round-trip: PASS");

    // Fixture 2: 0.10 MockFT transfer note (second transfer)
    const payload2 = { v: 1, amt: "10000000", bld: "11111111111111111111111111", memo: "JanusFT-v0.8-test-2" };
    const enc2 = await encryptNote(payload2, bobPubX, bobPubY);

    const dec2 = await decryptNote(enc2.ciphertext, enc2.ephX, enc2.ephY, BOB_PRIVKEY);
    if (dec2.amt !== payload2.amt || dec2.bld !== payload2.bld) {
        throw new Error("FIXTURE 2 ROUND-TRIP FAILED");
    }
    console.log("Fixture 2 round-trip: PASS\n");

    const fixtures = {
        version: "0.8.0",
        description: "Pre-computed ECIES note fixtures for JanusFT shielded-recovery Cadence tests",
        recipient: {
            description: "Bob's deterministic BabyJub test keypair",
            privkey: BOB_PRIVKEY.toString(),
            pubkeyX: bobPubX.toString(),
            pubkeyY: bobPubY.toString(),
        },
        fixtures: [
            {
                id: "fixture1",
                payload: payload1,
                ciphertext: Array.from(enc1.ciphertext),
                ephPubkeyX: enc1.ephX.toString(),
                ephPubkeyY: enc1.ephY.toString(),
            },
            {
                id: "fixture2",
                payload: payload2,
                ciphertext: Array.from(enc2.ciphertext),
                ephPubkeyX: enc2.ephX.toString(),
                ephPubkeyY: enc2.ephY.toString(),
            },
        ],
    };

    writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures, null, 2) + "\n");
    console.log(`Fixtures written to: ${FIXTURES_FILE}\n`);

    // Print Cadence constant declarations for copy-paste into test file
    const ct1Hex = Array.from(enc1.ciphertext).map(b => `0x${b.toString(16).padStart(2,"0")}`).join(", ");
    console.log("// ── Cadence constant declarations (paste into test file) ──────────────");
    console.log(`access(all) let FIXTURE_EPH_X: UInt256 = ${enc1.ephX}`);
    console.log(`access(all) let FIXTURE_EPH_Y: UInt256 = ${enc1.ephY}`);
    console.log(`access(all) let FIXTURE_CT: [UInt8] = [`);
    console.log(`    ${ct1Hex}`);
    console.log(`]`);
    console.log(`// Bob pubkey (for publishMemoKey if needed):`);
    console.log(`access(all) let BOB_MEMO_PUBKEY_X: UInt256 = ${bobPubX}`);
    console.log(`access(all) let BOB_MEMO_PUBKEY_Y: UInt256 = ${bobPubY}`);
}

main().catch(err => {
    console.error("FATAL:", err.message);
    process.exit(1);
});
