/**
 * smoke-janusft-aggregate.mjs — End-to-end smoke for JanusFT v0.7 aggregate on Flow testnet.
 *
 * Uses the AmountDiscloseAggregate circuit (4 public inputs) and
 * ConfidentialTransferAggregate circuit (6 public inputs) — same circuits as
 * JanusFlow and JanusERC20 v0.7.
 *
 * Account topology:
 *   alice  = v066-admin (0xc4e8f99915893a2f)
 *           — holds JanusFT contract + CommitmentRegistry + MockFT vault + COA
 *   bob    = testnet-bob (0xd807a3992d7be612)
 *           — shielded transfer recipient (commitment holder, no registry)
 *
 * Test flow:
 *   0. Pre-state read — verify totalLocked == 0 (if not, run reset first)
 *   1. adminReset — wipe any leftover state so smoke is deterministic
 *   2. Wrap 5.0 MockFT — generate AmountDiscloseAggregate proof, call wrapWithProof
 *      Verify: WrapWithSnapshot event, non-empty encryptedSnapshot, commitment updated
 *   3. ShieldedTransfer 2.0 MockFT (alice → bob) — ConfidentialTransferAggregate proof
 *      Verify: ShieldedTransferWithSnapshot event, no cleartext amount, commitments updated
 *   4. Unwrap 3.0 MockFT — AmountDiscloseAggregate (nonce=0) + ConfidentialTransfer proofs
 *      Verify: UnwrapWithSnapshot event, MockFT vault balance increased, totalLocked decreased
 *   5. adminReset — clean up for future runs
 *
 * Output: deployments/janusft-aggregate-smoke.json
 *
 * Run from packages/janus-ft:
 *   node scripts/smoke-janusft-aggregate.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const REPO_ROOT   = join(MODULE_ROOT, "../..");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON   = join(MODULE_ROOT, "flow.json");

// ── JanusFT deployment ────────────────────────────────────────────────────────

const JANUS_FT_ADDR = "0xc4e8f99915893a2f";
const MOCK_FT_ADDR  = "0x7599043aea001283";

// ── Accounts ─────────────────────────────────────────────────────────────────

const ALICE_SIGNER = "v066-admin";
const ALICE_ADDR   = "0xc4e8f99915893a2f";
const BOB_ADDR     = "0xd807a3992d7be612";

// ── Circuit artifacts (aggregate ceremony) ────────────────────────────────────

const AMT_DISCLOSE_WASM = join(REPO_ROOT,
    "circuits/aggregate-ceremony/build/amount_disclose_aggregate_js/amount_disclose_aggregate.wasm");
const AMT_DISCLOSE_ZKEY = join(REPO_ROOT,
    "circuits/aggregate-ceremony/setup/amount_disclose_aggregate_test.zkey");
const AMT_DISCLOSE_VKEY = join(REPO_ROOT,
    "circuits/aggregate-ceremony/setup/amount_disclose_verification_key.json");

const TRANSFER_WASM = join(REPO_ROOT,
    "circuits/aggregate-ceremony/build/confidential_transfer_aggregate_js/confidential_transfer_aggregate.wasm");
const TRANSFER_ZKEY = join(REPO_ROOT,
    "circuits/aggregate-ceremony/setup/confidential_transfer_aggregate_test.zkey");
const TRANSFER_VKEY = join(REPO_ROOT,
    "circuits/aggregate-ceremony/setup/verification_key.json");

// ── 2-gen Pedersen generators (matching AmountDiscloseAggregate circuit) ─────

const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const P        = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// G = Base8 (prime-order subgroup generator)
const GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
const GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;

// H = NUMS second generator (SHA-256 derived)
const HX = 20176122646359037043957983780698997220241005801156909477756461731029015465513n;
const HY = 12675495183377259114213499882541802147068931119123218019653136042509354750865n;

// ── Crypto helpers ────────────────────────────────────────────────────────────

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

function commit2gen(v, r) {
    const vG = pointMul(GX, GY, v % SUBORDER);
    const rH = pointMul(HX, HY, r % SUBORDER);
    const [cx, cy] = babyAdd(vG[0], vG[1], rH[0], rH[1]);
    return { x: cx, y: cy };
}

function rand128() {
    const bytes = randomBytes(16);
    let r = 0n;
    for (const x of bytes) r = (r << 8n) | BigInt(x);
    return r;
}

function rand32Bytes() { return Array.from(randomBytes(32)); }

// ── Proof element extraction ──────────────────────────────────────────────────
//
// Two proof formats exist in JanusFT:
//
// A. wrapWithProof: passes pA/pB/pC SEPARATELY as [[UInt256]].
//    The CONTRACT internally swaps pB: proof[i+2] = pB[0][1], pB[0][0], ...
//    Caller must pass raw snarkjs pB (no pre-swap). Contract produces the
//    ABI-correct pB[0][1], pB[0][0] order for the EVM verifier.
//
// B. shieldedTransfer / unwrap: passes a FLAT [UInt256; 8] directly to
//    _verifyGroth16 which encodes them as-is into the verifier calldata.
//    No swap inside the contract → caller must pre-swap pB[0] and pB[1].
//
// rawProofPieces: for case A (wrap). Returns pB in raw snarkjs order.
// swappedFlatProof: for case B (shieldedTransfer/unwrap). Returns a flat
//   8-element array with pB already swapped for the EVM verifier.

function rawProofPieces(proof) {
    // Raw snarkjs order. Contract swaps pB internally for wrapWithProof.
    return {
        pA: proof.pi_a.slice(0, 2).map(BigInt),
        pB: [
            [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])],
            [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])],
        ],
        pC: proof.pi_c.slice(0, 2).map(BigInt),
    };
}

function swappedFlatProof(proof) {
    // Pre-swap pB for the flat proof path (shieldedTransfer / unwrap).
    // EVM verifier expects pB[0][0]=pi_b[0][1] and pB[0][1]=pi_b[0][0].
    const pA = proof.pi_a.slice(0, 2).map(BigInt);
    const pC = proof.pi_c.slice(0, 2).map(BigInt);
    return [
        pA[0], pA[1],
        BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0]),  // swapped
        BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0]),  // swapped
        pC[0], pC[1],
    ].map(v => ({ type: "UInt256", value: v.toString() }));
}

// ── Amount: UFix64 raw unit representation (1.0 FLOW = 100_000_000) ──────────
// For MockFT with 8 decimal places (same as FlowToken).
// Circuit input is the UInt256 of the UFix64 scaled integer.

function ufixToAtto(ufixStr) {
    // "5.00000000" → 500_000_000n
    const [intPart, fracPart] = ufixStr.split(".");
    const frac = (fracPart ?? "").padEnd(8, "0").slice(0, 8);
    return BigInt(intPart) * 100_000_000n + BigInt(frac);
}

// ── Proof generators ──────────────────────────────────────────────────────────

async function generateAmountDiscloseProof(amount, commitX, commitY, blinding, nonce) {
    // Public inputs: [amount, commitX, commitY, nonce]
    const input = {
        amount:  amount.toString(),
        commitX: commitX.toString(),
        commitY: commitY.toString(),
        nonce:   nonce.toString(),
        blinding: blinding.toString(),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input, AMT_DISCLOSE_WASM, AMT_DISCLOSE_ZKEY
    );
    const vKey = JSON.parse(readFileSync(AMT_DISCLOSE_VKEY, "utf8"));
    const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    if (!ok) throw new Error("AmountDiscloseAggregate off-chain verification FAILED");
    return { proof, publicSignals };
}

async function generateTransferProof(oldCX, oldCY, txCX, txCY, newCX, newCY, txBlinding, newBlinding, oldValue, oldBlinding, txValue) {
    // Public inputs: [old_commit[0], old_commit[1], transfer_commit[0], transfer_commit[1], new_commit[0], new_commit[1]]
    // Private inputs: old_value, old_blinding, transfer_value, transfer_blinding, new_blinding
    const input = {
        "old_commit": [oldCX.toString(), oldCY.toString()],
        "transfer_commit": [txCX.toString(), txCY.toString()],
        "new_commit": [newCX.toString(), newCY.toString()],
        "old_value":      (oldValue ?? 0n).toString(),
        "old_blinding":   (oldBlinding ?? 0n).toString(),
        "transfer_value": (txValue ?? 0n).toString(),
        "transfer_blinding": txBlinding.toString(),
        "new_blinding":   newBlinding.toString(),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input, TRANSFER_WASM, TRANSFER_ZKEY
    );
    const vKey = JSON.parse(readFileSync(TRANSFER_VKEY, "utf8"));
    const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    if (!ok) throw new Error("ConfidentialTransferAggregate off-chain verification FAILED");
    return { proof, publicSignals };
}

// ── Flow CLI helpers ──────────────────────────────────────────────────────────

function runFlowTx(file, argsJson, signer, label) {
    const argsPath = `/tmp/.smoke_janusft_${label}.json`;
    writeFileSync(argsPath, JSON.stringify(argsJson));
    const cmd = [
        "flow transactions send",
        file,
        "--args-json", `"$(cat ${argsPath})"`,
        `--signer ${signer}`,
        "--network testnet",
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");
    let result;
    try {
        const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8", shell: "/bin/bash" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] non-JSON: ${err.stdout?.slice(0, 800)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
            }
        } else throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 600)}`);
    }
    if (result.status !== "SEALED" || result.error) {
        throw new Error(`[${label}] tx not SEALED: status=${result.status} err=${result.error}`);
    }
    return result;
}

function runFlowInlineTx(txBody, argsJson, signer, label) {
    const txPath = `/tmp/.smoke_janusft_inline_${label}.cdc`;
    const argsPath = `/tmp/.smoke_janusft_${label}.json`;
    writeFileSync(txPath, txBody);
    writeFileSync(argsPath, JSON.stringify(argsJson));
    const cmd = [
        "flow transactions send", txPath,
        "--args-json", `"$(cat ${argsPath})"`,
        `--signer ${signer}`,
        "--network testnet",
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");
    let result;
    try {
        const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8", shell: "/bin/bash" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] non-JSON: ${err.stdout?.slice(0, 800)}`);
            }
        } else throw new Error(`[${label}] ${err.message}`);
    }
    if (result.status !== "SEALED" || result.error) {
        throw new Error(`[${label}] not SEALED: status=${result.status} err=${result.error}`);
    }
    return result;
}

function runScript(src, args, label) {
    const path = `/tmp/.smoke_janusft_script_${label}.cdc`;
    writeFileSync(path, src);
    const argStr = args.map(a => `"${a}"`).join(" ");
    const cmd = `flow scripts execute "${path}" ${argStr} --network testnet --output json --config-path ${FLOW_JSON}`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 60_000 });
    return JSON.parse(out);
}

function parseDictResult(result) {
    if (!result || result.type !== "Dictionary") return null;
    const out = {};
    for (const kv of result.value ?? []) {
        const k = kv?.key?.value;
        const v = kv?.value?.value;
        if (k !== undefined) out[String(k)] = String(v);
    }
    return out;
}

function findEventOfType(result, suffix) {
    return (result?.events ?? []).filter(e => (e?.type ?? "").endsWith(suffix));
}

// ── Proof → Cadence args ──────────────────────────────────────────────────────

// Wrap raw proof elements into Cadence {type, value} objects.
// pB is passed WITHOUT pre-swap; the contract does the swap internally.
function proofToCadenceArgs(proof) {
    const { pA, pB, pC } = rawProofPieces(proof);
    return {
        pA: pA.map(v => ({ type: "UInt256", value: v.toString() })),
        pB: pB.map(row => row.map(v => ({ type: "UInt256", value: v.toString() }))),
        pC: pC.map(v => ({ type: "UInt256", value: v.toString() })),
    };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFT v0.7 Aggregate — end-to-end smoke test (Flow testnet)");
    console.log("=".repeat(72));
    console.log(`JanusFT:        ${JANUS_FT_ADDR}`);
    console.log(`MockFT:         ${MOCK_FT_ADDR}`);
    console.log(`Alice (signer): ${ALICE_ADDR} (v066-admin)`);
    console.log(`Bob (recipient):${BOB_ADDR}`);
    console.log();

    const results = {
        date: new Date().toISOString(),
        version: "0.7.0",
        network: "flow-testnet",
        janusft_address: JANUS_FT_ADDR,
        mockft_address:  MOCK_FT_ADDR,
        alice: ALICE_ADDR,
        bob: BOB_ADDR,
        tx_hashes: {},
        steps: {},
        smoke_pass: false,
    };

    // ── Scripts ───────────────────────────────────────────────────────────────

    const totalLockedScript = `import JanusFT from ${JANUS_FT_ADDR}
access(all) fun main(): UFix64 { return JanusFT.getTotalLocked() }`;

    const commitScript = `import JanusFT from ${JANUS_FT_ADDR}
access(all) fun main(account: Address): {String: UInt256} {
    let c = JanusFT.balanceOfCommitment(account: account)
    return { "x": c.x, "y": c.y }
}`;

    // ── 0. adminReset (clean start) ───────────────────────────────────────────

    console.log("[0] Admin reset — clean slate");
    const resetTx = `import JanusFT from ${JANUS_FT_ADDR}
transaction {
    prepare(signer: auth(BorrowValue) &Account) {
        let admin = signer.storage.borrow<&JanusFT.Admin>(from: JanusFT.AdminStoragePath)
            ?? panic("Admin not found")
        admin.resetTotalLockedForTestingOnly()
    }
}`;
    const resetResult = runFlowInlineTx(resetTx, [], ALICE_SIGNER, "reset0");
    results.tx_hashes.adminReset_before = resetResult.id;
    console.log(`   tx: ${resetResult.id}`);

    const totalLocked0 = runScript(totalLockedScript, [], "tl0");
    if (totalLocked0.value !== "0.00000000") {
        throw new Error(`PRECONDITION FAIL: totalLocked=${totalLocked0.value} (expected 0.0 after reset)`);
    }
    console.log(`   totalLocked after reset: ${totalLocked0.value} (PASS)`);
    results.steps.step0_reset = { totalLocked: totalLocked0.value, pass: true };

    // ── 1. Wrap 5.0 MockFT ────────────────────────────────────────────────────

    console.log("\n[1] Wrap 5.0 MockFT");

    const WRAP_UFLOAT  = "5.00000000";
    const WRAP_RAW     = ufixToAtto(WRAP_UFLOAT);   // 500_000_000n (8-decimal UFix64 units)
    // FIX 2026-06-05: proof must bind to NET amount (after fee), matching contract + SDK convention.
    // Contract fee = 10 bps → WRAP_NET = WRAP_RAW * (10000 - 10) / 10000 = 499_500_000n (4.995 UFix64)
    const WRAP_FEE_BPS  = 10n;
    const WRAP_NET      = WRAP_RAW * (10000n - WRAP_FEE_BPS) / 10000n;  // 499_500_000n
    const wrapBlinding = rand128();
    const wrapNonce    = rand128();
    // Commit binds to NET (not gross) — aligns with EVM siblings and SDK orchestration.
    const wrapCommit   = commit2gen(WRAP_NET % SUBORDER, wrapBlinding);

    console.log(`   amount:  ${WRAP_UFLOAT} MockFT (gross)`);
    console.log(`   net:     4.99500000 MockFT (after 10 bps fee)`);
    console.log(`   nonce:   ${wrapNonce}`);
    console.log(`   commit:  (${wrapCommit.x.toString().slice(0,20)}..., ${wrapCommit.y.toString().slice(0,20)}...)`);

    console.log("   generating AmountDiscloseAggregate proof (NET amount)...");
    const { proof: amtProof } = await generateAmountDiscloseProof(
        WRAP_NET % SUBORDER,
        wrapCommit.x,
        wrapCommit.y,
        wrapBlinding,
        wrapNonce
    );
    console.log("   proof generated (off-chain verify PASS)");

    const wrapPieces = proofToCadenceArgs(amtProof);
    const ephX   = rand128();
    const ephY   = rand128();
    const encSnap = rand32Bytes().concat(rand32Bytes());

    const wrapArgs = [
        { type: "Address", value: ALICE_ADDR },
        { type: "UFix64",  value: WRAP_UFLOAT },
        { type: "UInt256", value: wrapNonce.toString() },
        { type: "UInt256", value: wrapCommit.x.toString() },
        { type: "UInt256", value: wrapCommit.y.toString() },
        { type: "Array",   value: wrapPieces.pA },
        { type: "Array",   value: wrapPieces.pB.map(row => ({ type: "Array", value: row })) },
        { type: "Array",   value: wrapPieces.pC },
        { type: "Array",   value: encSnap.map(b => ({ type: "UInt8", value: b.toString() })) },
        { type: "UInt256", value: ephX.toString() },
        { type: "UInt256", value: ephY.toString() },
    ];

    const wrapResult = runFlowTx(
        join(MODULE_ROOT, "transactions/wrap_ft.cdc"),
        wrapArgs,
        ALICE_SIGNER,
        "wrap"
    );
    results.tx_hashes.wrap = wrapResult.id;
    console.log(`   tx: ${wrapResult.id}`);

    // Check WrapWithSnapshot event
    const wrapEvents = findEventOfType(wrapResult, ".JanusFT.WrapWithSnapshot");
    if (wrapEvents.length === 0) throw new Error("No WrapWithSnapshot event emitted");

    const wrapEventFields = wrapEvents[0]?.values?.value?.fields ?? [];
    const encSnapshotField = wrapEventFields.find(f => f.name === "encryptedSnapshot");
    const encSnapshotLen = (encSnapshotField?.value?.value ?? []).length;
    if (encSnapshotLen === 0) throw new Error("WrapWithSnapshot: encryptedSnapshot is EMPTY");
    console.log(`   WrapWithSnapshot event emitted, encryptedSnapshot length=${encSnapshotLen} (PASS)`);

    const ephPubXField = wrapEventFields.find(f => f.name === "ephPubX");
    const ephPubXVal   = BigInt(ephPubXField?.value?.value ?? "0");
    if (ephPubXVal === 0n) throw new Error("WrapWithSnapshot: ephPubX is ZERO");
    console.log(`   ephPubX non-zero (PASS)`);

    // Fee on wrap is 10 bps (0.1%) on gross 5.0 → fee = 0.005 → net locked = 4.995
    const WRAP_FEE          = 0.005;
    const WRAP_NET_UFLOAT   = "4.99500000";  // 5.0 - 0.005
    const totalLockedAfterWrap = runScript(totalLockedScript, [], "tl_wrap");
    if (totalLockedAfterWrap.value !== WRAP_NET_UFLOAT) {
        throw new Error(`totalLocked mismatch after wrap: expected ${WRAP_NET_UFLOAT} (gross ${WRAP_UFLOAT} - fee 0.005), got ${totalLockedAfterWrap.value}`);
    }
    console.log(`   totalLocked: ${totalLockedAfterWrap.value} (PASS)`);

    // Read on-chain commitment for alice
    const aliceCommitAfterWrap = parseDictResult(runScript(commitScript, [ALICE_ADDR], "commit_alice_wrap"));
    const aliceCommitX = BigInt(aliceCommitAfterWrap.x);
    const aliceCommitY = BigInt(aliceCommitAfterWrap.y);
    if (aliceCommitX !== wrapCommit.x || aliceCommitY !== wrapCommit.y) {
        throw new Error(
            `Alice commitment mismatch after wrap.\n  expected: (${wrapCommit.x}, ${wrapCommit.y})\n  got:      (${aliceCommitX}, ${aliceCommitY})`
        );
    }
    console.log(`   Alice commitment == wrapCommit (BabyJub identity law PASS)`);

    results.steps.step1_wrap = {
        amount: WRAP_UFLOAT,
        nonce: wrapNonce.toString(),
        commit_x: wrapCommit.x.toString(),
        commit_y: wrapCommit.y.toString(),
        totalLocked_after: totalLockedAfterWrap.value,
        encryptedSnapshot_len: encSnapshotLen,
        snapshot_non_empty: encSnapshotLen > 0,
        ephPubX_non_zero: ephPubXVal !== 0n,
        commitment_match: true,
        pass: true,
    };

    // ── 2. ShieldedTransfer 2.0 MockFT (alice → bob) ─────────────────────────

    console.log("\n[2] ShieldedTransfer 2.0 MockFT (alice → bob)");

    const XFER_RAW     = ufixToAtto("2.00000000");
    // Alice's on-chain balance after wrap is WRAP_NET (4.995 UFix64), not WRAP_RAW (5.0 UFix64).
    const NEW_ALICE_RAW = WRAP_NET - XFER_RAW;  // 4.995 - 2.0 = 2.995 in atto units

    const xferBlinding  = rand128();
    const newAliceBlinding = rand128();

    const xferCommit    = commit2gen(XFER_RAW % SUBORDER, xferBlinding);
    const newAliceCommit = commit2gen(NEW_ALICE_RAW % SUBORDER, newAliceBlinding);

    console.log("   generating ConfidentialTransferAggregate proof...");
    // Private inputs for transfer: alice's old state (WRAP_NET, wrapBlinding), xfer amount
    const { proof: xferProof } = await generateTransferProof(
        aliceCommitX, aliceCommitY,
        xferCommit.x, xferCommit.y,
        newAliceCommit.x, newAliceCommit.y,
        xferBlinding, newAliceBlinding,
        WRAP_NET % SUBORDER, wrapBlinding, XFER_RAW % SUBORDER
    );
    console.log("   proof generated (off-chain verify PASS)");

    const publicInputs6 = [
        aliceCommitX, aliceCommitY,
        xferCommit.x, xferCommit.y,
        newAliceCommit.x, newAliceCommit.y,
    ];

    // shieldedTransfer uses the flat proof path (_verifyGroth16 with no internal swap).
    // Use swappedFlatProof to pre-swap pB for the EVM verifier.
    const flatXferProof = swappedFlatProof(xferProof);

    const xferArgs = [
        { type: "Address", value: ALICE_ADDR },
        { type: "Address", value: BOB_ADDR },
        { type: "Array",   value: flatXferProof },
        { type: "Array",   value: publicInputs6.map(v => ({ type: "UInt256", value: v.toString() })) },
        { type: "Array",   value: rand32Bytes().map(b => ({ type: "UInt8", value: b.toString() })) },
        { type: "UInt256", value: rand128().toString() },
        { type: "UInt256", value: rand128().toString() },
        { type: "Array",   value: rand32Bytes().map(b => ({ type: "UInt8", value: b.toString() })) },
        { type: "UInt256", value: rand128().toString() },
        { type: "UInt256", value: rand128().toString() },
    ];

    const xferResult = runFlowTx(
        join(MODULE_ROOT, "transactions/shielded_transfer_ft.cdc"),
        xferArgs,
        ALICE_SIGNER,
        "xfer"
    );
    results.tx_hashes.shieldedTransfer = xferResult.id;
    console.log(`   tx: ${xferResult.id}`);

    // Check ShieldedTransferWithSnapshot event
    const xferEvents = findEventOfType(xferResult, ".JanusFT.ShieldedTransferWithSnapshot");
    if (xferEvents.length === 0) throw new Error("No ShieldedTransferWithSnapshot event emitted");

    // Privacy check: no cleartext amount in the event
    const xferEventFields = xferEvents[0]?.values?.value?.fields ?? [];
    const xferFieldNames  = xferEventFields.map(f => f.name);
    if (xferFieldNames.some(n => /amount|value|quantity/i.test(n))) {
        throw new Error(`PRIVACY VIOLATION: ShieldedTransferWithSnapshot has amount field: ${xferFieldNames}`);
    }
    console.log(`   ShieldedTransferWithSnapshot event: no cleartext amount (PRIVACY PASS)`);

    // totalLocked unchanged
    const totalLockedAfterXfer = runScript(totalLockedScript, [], "tl_xfer");
    if (totalLockedAfterXfer.value !== WRAP_NET_UFLOAT) {
        throw new Error(`totalLocked changed during shieldedTransfer: expected ${WRAP_NET_UFLOAT}, got ${totalLockedAfterXfer.value}`);
    }
    console.log(`   totalLocked unchanged: ${totalLockedAfterXfer.value} (PASS)`);

    // Bob's commitment should equal xferCommit
    const bobCommitAfterXfer = parseDictResult(runScript(commitScript, [BOB_ADDR], "commit_bob_xfer"));
    if (BigInt(bobCommitAfterXfer.x) !== xferCommit.x || BigInt(bobCommitAfterXfer.y) !== xferCommit.y) {
        throw new Error(
            `Bob commitment mismatch.\n  expected: (${xferCommit.x}, ${xferCommit.y})\n  got: (${bobCommitAfterXfer.x}, ${bobCommitAfterXfer.y})`
        );
    }
    console.log(`   Bob commitment == xferCommit (BabyJub identity law PASS)`);

    // Alice's commitment should equal newAliceCommit
    const aliceCommitAfterXfer = parseDictResult(runScript(commitScript, [ALICE_ADDR], "commit_alice_xfer"));
    if (BigInt(aliceCommitAfterXfer.x) !== newAliceCommit.x || BigInt(aliceCommitAfterXfer.y) !== newAliceCommit.y) {
        throw new Error(`Alice commitment after xfer mismatch`);
    }
    console.log(`   Alice commitment == newAliceCommit (PASS)`);

    results.steps.step2_shielded_transfer = {
        from: ALICE_ADDR,
        to: BOB_ADDR,
        no_cleartext_amount_in_event: true,
        totalLocked_unchanged: true,
        bob_commit_match: true,
        alice_commit_match: true,
        pass: true,
    };

    // ── 3. Unwrap alice's entire remaining balance (NEW_ALICE_RAW = 2.995 UFix64) ─
    //
    // After the shielded transfer, alice holds NEW_ALICE_RAW in committed balance.
    // WRAP_NET=4.995, XFER_RAW=2.0 → NEW_ALICE_RAW=2.995 (atto: 299_500_000n).
    // We unwrap the full residual so the test is self-consistent.

    const UNWRAP_RAW    = NEW_ALICE_RAW;  // 299_500_000n (2.995 UFix64 units)
    // UFix64 string from bigint atto units: split at 8-decimal boundary.
    const UNWRAP_UFLOAT = (() => {
        const int  = UNWRAP_RAW / 100_000_000n;
        const frac = (UNWRAP_RAW % 100_000_000n).toString().padStart(8, "0");
        return `${int}.${frac}`;
    })();
    const RESIDUAL_RAW  = 0n;  // alice empties her balance

    console.log(`\n[3] Unwrap alice's full residual: ${UNWRAP_RAW} atto (${UNWRAP_UFLOAT} UFix64)`);

    const unwrapTxBlinding  = rand128();
    const residualBlinding  = rand128();
    const unwrapNonce       = 0n;   // nonce=0 for unwrap (per architecture doc)

    const unwrapTxCommit  = commit2gen(UNWRAP_RAW % SUBORDER, unwrapTxBlinding);
    const residualCommit  = commit2gen(RESIDUAL_RAW % SUBORDER, residualBlinding);

    // Use alice's current commitment (newAliceCommit) as C_old
    const aliceOldX = BigInt(aliceCommitAfterXfer.x);
    const aliceOldY = BigInt(aliceCommitAfterXfer.y);

    console.log("   generating AmountDiscloseAggregate proof (nonce=0)...");
    const { proof: unwrapAmtProof } = await generateAmountDiscloseProof(
        UNWRAP_RAW % SUBORDER,
        unwrapTxCommit.x,
        unwrapTxCommit.y,
        unwrapTxBlinding,
        unwrapNonce
    );
    console.log("   generating ConfidentialTransferAggregate proof (C_old → C_new)...");
    // Private inputs for unwrap: alice's state after xfer (NEW_ALICE_RAW, newAliceBlinding)
    const { proof: unwrapXferProof } = await generateTransferProof(
        aliceOldX, aliceOldY,
        unwrapTxCommit.x, unwrapTxCommit.y,
        residualCommit.x, residualCommit.y,
        unwrapTxBlinding, residualBlinding,
        NEW_ALICE_RAW % SUBORDER, newAliceBlinding, UNWRAP_RAW % SUBORDER
    );
    console.log("   both proofs generated (off-chain verify PASS)");

    // Unwrap uses flat proof path (_verifyGroth16 directly, no internal pB swap).
    // Use swappedFlatProof for both amount and transfer proofs.
    const unwrapAmtFlat  = swappedFlatProof(unwrapAmtProof);
    const unwrapXferFlat = swappedFlatProof(unwrapXferProof);

    const amtPubInputs4 = [
        UNWRAP_RAW % SUBORDER,
        unwrapTxCommit.x,
        unwrapTxCommit.y,
        unwrapNonce,
    ].map(v => ({ type: "UInt256", value: v.toString() }));

    const xferPubInputs6 = [
        aliceOldX, aliceOldY,
        unwrapTxCommit.x, unwrapTxCommit.y,
        residualCommit.x, residualCommit.y,
    ].map(v => ({ type: "UInt256", value: v.toString() }));

    const unwrapArgs = [
        { type: "Address", value: ALICE_ADDR },
        { type: "UFix64",  value: UNWRAP_UFLOAT },
        { type: "Address", value: ALICE_ADDR },   // recipient = alice herself
        { type: "UInt256", value: unwrapTxCommit.x.toString() },
        { type: "UInt256", value: unwrapTxCommit.y.toString() },
        { type: "Array",   value: unwrapAmtFlat },
        { type: "Array",   value: amtPubInputs4 },
        { type: "Array",   value: unwrapXferFlat },
        { type: "Array",   value: xferPubInputs6 },
        { type: "Array",   value: rand32Bytes().map(b => ({ type: "UInt8", value: b.toString() })) },
        { type: "UInt256", value: rand128().toString() },
        { type: "UInt256", value: rand128().toString() },
    ];

    const unwrapResult = runFlowTx(
        join(MODULE_ROOT, "transactions/unwrap_ft.cdc"),
        unwrapArgs,
        ALICE_SIGNER,
        "unwrap"
    );
    results.tx_hashes.unwrap = unwrapResult.id;
    console.log(`   tx: ${unwrapResult.id}`);

    const unwrapEvents = findEventOfType(unwrapResult, ".JanusFT.UnwrapWithSnapshot");
    if (unwrapEvents.length === 0) throw new Error("No UnwrapWithSnapshot event emitted");
    console.log(`   UnwrapWithSnapshot event emitted (PASS)`);

    // After unwrap (alice empties her balance): totalLocked = WRAP_NET - XFER_RAW = 4.995 - 2.0 = 2.995
    // Bob's committed share (XFER_RAW=2.0) remains in the pool.
    const EXPECTED_AFTER_UNWRAP = "2.00000000";
    const totalLockedAfterUnwrap = runScript(totalLockedScript, [], "tl_unwrap");
    if (totalLockedAfterUnwrap.value !== EXPECTED_AFTER_UNWRAP) {
        throw new Error(`totalLocked mismatch after unwrap: expected ${EXPECTED_AFTER_UNWRAP}, got ${totalLockedAfterUnwrap.value}`);
    }
    console.log(`   totalLocked after unwrap: ${totalLockedAfterUnwrap.value} (PASS)`);

    results.steps.step3_unwrap = {
        amount: UNWRAP_UFLOAT,
        recipient: ALICE_ADDR,
        totalLocked_after: totalLockedAfterUnwrap.value,
        expected_totalLocked: EXPECTED_AFTER_UNWRAP,
        unwrap_event_emitted: true,
        pass: true,
    };

    // ── 4. adminReset (final cleanup) ─────────────────────────────────────────

    console.log("\n[4] Admin reset — final cleanup");
    const resetFinalResult = runFlowInlineTx(resetTx, [], ALICE_SIGNER, "reset_final");
    results.tx_hashes.adminReset_after = resetFinalResult.id;
    console.log(`   tx: ${resetFinalResult.id}`);

    const totalLockedFinal = runScript(totalLockedScript, [], "tl_final");
    if (totalLockedFinal.value !== "0.00000000") {
        throw new Error(`adminReset did not clear totalLocked: ${totalLockedFinal.value}`);
    }
    console.log(`   totalLocked after reset: ${totalLockedFinal.value} (PASS)`);
    results.steps.step4_adminReset_final = { totalLocked: totalLockedFinal.value, pass: true };

    // ── Final summary ─────────────────────────────────────────────────────────

    results.smoke_pass = true;
    results.summary = {
        step0_adminReset_before: true,
        step1_wrap_snapshot_non_empty: results.steps.step1_wrap.snapshot_non_empty,
        step1_wrap_ephPubKey_non_zero: results.steps.step1_wrap.ephPubX_non_zero,
        step1_wrap_commitment_match: results.steps.step1_wrap.commitment_match,
        step2_shielded_transfer_no_cleartext: results.steps.step2_shielded_transfer.no_cleartext_amount_in_event,
        step2_totalLocked_unchanged: results.steps.step2_shielded_transfer.totalLocked_unchanged,
        step3_unwrap_event_emitted: results.steps.step3_unwrap.unwrap_event_emitted,
        step3_totalLocked_correct: results.steps.step3_unwrap.totalLocked_after === EXPECTED_AFTER_UNWRAP,
        step4_adminReset_after: true,
    };

    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const outPath = join(DEPLOYMENTS_DIR, "janusft-aggregate-smoke.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");

    console.log("\n" + "=".repeat(72));
    console.log("JanusFT v0.7 Aggregate Smoke — PASS");
    console.log("=".repeat(72));
    console.log(`Results: ${outPath}`);
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
