/**
 * verify-decode.mjs — Verify ECIES round-trip for JanusFT v0.8 ShieldedInbox fixtures.
 *
 * Reads the pre-computed fixtures from tests/helpers/ecies-fixtures.json and proves
 * that each ciphertext decrypts to the original note payload using the recipient's
 * known private key.
 *
 * This script is the "Approach A" decode-side proof:
 *   - Cadence tests deposit the fixture bytes to the ShieldedInbox and verify
 *     the bytes are stored/retrieved faithfully (Cadence plumbing test).
 *   - This script proves those same bytes decrypt to the correct note fields
 *     (ECIES correctness proof).
 *
 * Run standalone (no jest):
 *   node tests/helpers/verify-decode.mjs
 *
 * Or invoked from JanusFT.ecies-decode.test.js via import.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { webcrypto } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_FILE = join(__dirname, "ecies-fixtures.json");

// ── BabyJubJub helpers (same as precompute-ciphertexts.mjs) ──────────────────
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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

// ── ECIES decryption (mirrors openjanus-sdk decrypt-text.ts) ─────────────────

const HKDF_SALT = new TextEncoder().encode("openjanus/memo/v1");
const AES_GCM_IV_LEN = 12;
const AES_GCM_TAG_LEN = 16;

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

/**
 * Decrypt an ECIES ciphertext blob.
 *
 * @param {Uint8Array} ciphertextBytes  iv || ct || tag (as stored in ShieldedInbox)
 * @param {bigint}     ephX             ephemeral pubkey X
 * @param {bigint}     ephY             ephemeral pubkey Y
 * @param {bigint}     recipPrivkey     recipient's BabyJub private scalar
 * @returns {object}   parsed JSON note payload
 */
export async function decryptNoteFromInbox(ciphertextBytes, ephX, ephY, recipPrivkey) {
    if (ciphertextBytes.length < AES_GCM_IV_LEN + AES_GCM_TAG_LEN) {
        throw new Error(`decryptNoteFromInbox: ciphertext too short (${ciphertextBytes.length} bytes)`);
    }
    const [sharedX] = pointMul(ephX, ephY, recipPrivkey);
    const key = await deriveAesKey(sharedX);
    const iv = ciphertextBytes.slice(0, AES_GCM_IV_LEN);
    const ctAndTag = ciphertextBytes.slice(AES_GCM_IV_LEN);
    let plaintext;
    try {
        plaintext = new Uint8Array(await webcrypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            ctAndTag
        ));
    } catch {
        throw new Error("decryptNoteFromInbox: AES-GCM authentication failed");
    }
    return JSON.parse(new TextDecoder().decode(plaintext));
}

// ── Main (standalone verification) ───────────────────────────────────────────

async function main() {
    let fixtures;
    try {
        fixtures = JSON.parse(readFileSync(FIXTURES_FILE, "utf8"));
    } catch {
        throw new Error(
            `Fixtures file not found: ${FIXTURES_FILE}\n` +
            "Run 'node tests/helpers/precompute-ciphertexts.mjs' first."
        );
    }

    const recipPriv = BigInt(fixtures.recipient.privkey);
    console.log(`Recipient privkey: ${recipPriv.toString().slice(0,20)}...`);
    console.log(`Verifying ${fixtures.fixtures.length} fixture(s)...\n`);

    let allPassed = true;
    for (const fix of fixtures.fixtures) {
        const ct   = new Uint8Array(fix.ciphertext);
        const ephX = BigInt(fix.ephPubkeyX);
        const ephY = BigInt(fix.ephPubkeyY);

        let decoded;
        try {
            decoded = await decryptNoteFromInbox(ct, ephX, ephY, recipPriv);
        } catch (e) {
            console.error(`FAIL [${fix.id}]: ${e.message}`);
            allPassed = false;
            continue;
        }

        const amtMatch = decoded.amt === fix.payload.amt;
        const bldMatch = decoded.bld === fix.payload.bld;
        const memoMatch = decoded.memo === fix.payload.memo;

        if (!amtMatch || !bldMatch || !memoMatch) {
            console.error(`FAIL [${fix.id}]: payload mismatch`);
            console.error(`  expected amt=${fix.payload.amt}  got=${decoded.amt}`);
            console.error(`  expected bld=${fix.payload.bld}  got=${decoded.bld}`);
            allPassed = false;
        } else {
            console.log(`PASS [${fix.id}]: amt=${decoded.amt}  bld=${decoded.bld.slice(0,10)}...  memo="${decoded.memo}"`);
        }
    }

    if (!allPassed) {
        throw new Error("One or more ECIES decode verifications FAILED");
    }
    console.log("\nAll ECIES decode verifications PASSED.");
}

// Only run main() when called directly (not when imported as a module)
if (import.meta.url === `file://${fileURLToPath(import.meta.url)}`) {
    main().catch(err => {
        console.error("FATAL:", err.message);
        process.exit(1);
    });
}
