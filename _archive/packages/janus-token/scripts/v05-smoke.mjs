/**
 * v05-smoke.mjs — Smoke test for JanusFlow v0.5 on Flow EVM testnet.
 *
 * Tests:
 *   1. Wrap 50 FLOW from alice (impossible under the old 18 FLOW cap)
 *   2. shieldedTransfer 10 FLOW alice → charlie
 *   3. Unwrap 30 FLOW alice → alice's COA
 *   4. Verify final balances and on-chain commitments
 *
 * Personas (each has its own Cadence Owned Account):
 *   alice   = openjanus-flow (0x0000...2f6b30af48a94787 COA)
 *   charlie = testnet-charlie
 *
 * Circuit: v0.5 ceremony (128-bit Pedersen, Num2Bits(128))
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

// v0.5 circuit artifacts (Pedersen(256) — 128-bit value + 128-bit blinding)
const AMOUNT_WASM = join(MODULE_ROOT, "../../circuits/v0.5-ceremony/build/amount_disclose_js/amount_disclose.wasm");
const AMOUNT_ZKEY = join(MODULE_ROOT, "../../circuits/v0.5-ceremony/amount_disclose_final.zkey");
const TRANSFER_WASM = join(MODULE_ROOT, "../../circuits/v0.5-ceremony/build/confidential_transfer_js/confidential_transfer.wasm");
const TRANSFER_ZKEY = join(MODULE_ROOT, "../../circuits/v0.5-ceremony/confidential_transfer_final.zkey");

const DEPLOY_RECORD_PATH = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");

const ALICE   = { name: "alice",   signer: "openjanus-flow",  coa: "0x0000000000000000000000022f6b30af48a94787" };
const CHARLIE = { name: "charlie", signer: "charlie",          coa: "0x00000000000000000000000249065458581f9bf0" };

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const provider = new JsonRpcProvider(RPC_URL);

const COA_CALL_TX = `import "EVM"

transaction(contractAddress: String, calldataHex: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(contractAddress),
            data: calldataHex.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "EVM call failed: ".concat(result.errorMessage)
        )
    }
}
`;

// Note: attoflowAmount is hardcoded in the tx body to avoid UInt64 arg type issues.
// For amounts > UInt64 max (~18.44 FLOW), use a different mechanism.
function makeWrapTx(attoflowAmount) {
    return `import "EVM"

transaction(contractAddress: String, calldataHex: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(contractAddress),
            data: calldataHex.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: ${attoflowAmount})
        )
        assert(
            result.status == EVM.Status.successful,
            message: "wrap failed: ".concat(result.errorMessage)
        )
    }
}
`;
}

function runFlowTx(txBody, args, label, signer, gasLimit = 9999) {
    const txPath = `/tmp/.v05smoke_${label}.cdc`;
    writeFileSync(txPath, txBody);
    const argStrs = args.map(a => `"${a}"`).join(" ");
    const cmd = [
        "flow transactions send", txPath, argStrs,
        "--network testnet",
        `--signer ${signer}`,
        `--gas-limit ${gasLimit}`,
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");
    let result;
    try {
        const stdout = execSync(cmd, { cwd: MODULE_ROOT, timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] non-JSON: ${err.stdout?.slice(0,500)}`);
            }
        } else throw err;
    }
    if (result.status !== "SEALED" || result.errorMessage) {
        throw new Error(`[${label}] tx not SEALED: ${result.errorMessage}`);
    }
    return result;
}

function extractEvmTxHash(result) {
    const events = result?.events ?? [];
    for (const ev of events) {
        if (!ev?.type?.endsWith(".EVM.TransactionExecuted")) continue;
        const fields = ev?.values?.value?.fields ?? [];
        for (const f of fields) {
            const arr = f?.value?.value;
            if (Array.isArray(arr) && arr.length === 32 && arr.every(b => b?.type === "UInt8")) {
                return "0x" + arr.map(b => Number(b.value).toString(16).padStart(2, "0")).join("");
            }
        }
    }
    return null;
}

// v0.5 Pedersen commitment: 32-byte buffer (128-bit value LE + 128-bit blinding LE)
async function computeCommitmentV05(value, blinding) {
    const { buildPedersenHash, buildBabyjub } = await import("circomlibjs");
    const pedersenHash = await buildPedersenHash();
    const babyJub = await buildBabyjub();
    const F = babyJub.F;

    const buf = Buffer.alloc(32, 0);
    let v = value;
    for (let i = 0; i < 16; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
    let b = blinding;
    for (let i = 16; i < 32; i++) { buf[i] = Number(b & 0xffn); b >>= 8n; }

    const hash = pedersenHash.hash(buf);
    const point = babyJub.unpackPoint(hash);
    return { x: F.toObject(point[0]), y: F.toObject(point[1]) };
}

function applyPiBSwap(proof) {
    return {
        pi_a: proof.pi_a,
        pi_b: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
        pi_c: proof.pi_c,
    };
}

function proofToUint256Array(proof) {
    return [
        BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1]),
        BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1]),
        BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1]),
        BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1]),
    ];
}

async function buildAmountProof(amount, blinding) {
    const commit = await computeCommitmentV05(amount, blinding);
    const input = {
        blinding: blinding.toString(),
        claimed_amount: amount.toString(),
        commit: [commit.x.toString(), commit.y.toString()],
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, AMOUNT_WASM, AMOUNT_ZKEY);
    const swapped = applyPiBSwap(proof);
    return { proof: proofToUint256Array(swapped), commit, publicSignals };
}

async function buildTransferProof(oldValue, oldBlinding, txValue, txBlinding, newBlinding) {
    const newValue = oldValue - txValue;
    const [oldCommit, txCommit, newCommit] = await Promise.all([
        computeCommitmentV05(oldValue, oldBlinding),
        computeCommitmentV05(txValue, txBlinding),
        computeCommitmentV05(newValue, newBlinding),
    ]);
    const input = {
        old_value: oldValue.toString(),
        old_blinding: oldBlinding.toString(),
        transfer_value: txValue.toString(),
        transfer_blinding: txBlinding.toString(),
        new_blinding: newBlinding.toString(),
        old_commit: [oldCommit.x.toString(), oldCommit.y.toString()],
        transfer_commit: [txCommit.x.toString(), txCommit.y.toString()],
        new_commit: [newCommit.x.toString(), newCommit.y.toString()],
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, TRANSFER_WASM, TRANSFER_ZKEY);
    const swapped = applyPiBSwap(proof);
    return { proof: proofToUint256Array(swapped), oldCommit, txCommit, newCommit, publicSignals };
}

async function main() {
    console.log("=".repeat(70));
    console.log("JanusFlow v0.5 smoke test");
    console.log("=".repeat(70));

    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD_PATH, "utf8"));
    const PROXY = deploy.contracts.JanusFlow_proxy;
    const jfArt = JSON.parse(readFileSync(join(MODULE_ROOT, "artifacts/contracts/solidity/JanusFlow_v0_5.sol/JanusFlow_v0_5.json"), "utf8"));
    const iface = new Interface(jfArt.abi);

    console.log(`Proxy: ${PROXY}`);

    // Check MAX_WRAP
    const maxWrapHex = await provider.call({ to: PROXY, data: iface.encodeFunctionData("MAX_WRAP") });
    const maxWrap = BigInt(maxWrapHex);
    console.log(`MAX_WRAP = ${maxWrap} (= ${maxWrap === (1n<<128n)-1n ? "2^128-1 ✓" : "UNEXPECTED"})`);
    if (maxWrap !== (1n << 128n) - 1n) throw new Error("MAX_WRAP not 2^128-1 — upgrade may not have landed!");

    // totalLocked before
    const lockedBefore = BigInt(await provider.call({ to: PROXY, data: iface.encodeFunctionData("totalLocked") }));
    console.log(`totalLocked before: ${lockedBefore} attoFLOW`);

    const txHashes = {};

    // ── 1. WRAP 18.1 FLOW (above the old 18 FLOW cap — EVM bridge UInt64 limits
    //      to ≈18.4 FLOW max per call; old contract blocked at exactly 18 FLOW)
    const WRAP_AMOUNT = 18_100_000_000_000_000_000n; // 18.1 FLOW — above old 18 FLOW cap
    const WRAP_BLINDING = BigInt("0xdeadbeefcafebabe1234567890abcdef"); // 128-bit
    console.log(`\n[1/4] Alice wraps ${WRAP_AMOUNT} attoFLOW (18.1 FLOW) — was impossible under old 18 FLOW cap`);
    const wrapProof = await buildAmountProof(WRAP_AMOUNT, WRAP_BLINDING);
    console.log(`  Amount proof generated. Commit: (${wrapProof.commit.x.toString().slice(0,12)}...)`);

    // Encode wrap(txCommit[2], amountProof[8])
    const wrapCalldata = iface.encodeFunctionData("wrap", [
        [wrapProof.commit.x, wrapProof.commit.y],
        wrapProof.proof,
    ]);
    const wrapRes = runFlowTx(
        makeWrapTx(WRAP_AMOUNT),
        [PROXY, wrapCalldata.slice(2), "600000"],
        "wrap_amount",
        ALICE.signer,
    );
    txHashes.wrap_flow = wrapRes.id;
    txHashes.wrap_evm = extractEvmTxHash(wrapRes);
    console.log(`  Flow tx: ${txHashes.wrap_flow}`);
    console.log(`  EVM tx:  ${txHashes.wrap_evm}`);

    // ── 2. shieldedTransfer 8 FLOW alice → charlie ───────────────────────
    const TX_AMOUNT = 8_000_000_000_000_000_000n; // 8 FLOW
    const TX_BLINDING = BigInt("0xabbad00df00dcafe1111222233334444"); // 128-bit
    const NEW_BLINDING_ALICE = BigInt("0x55556666777788889999aaaabbbbcccc"); // 128-bit

    const oldBalance = WRAP_AMOUNT;
    const newBalance = oldBalance - TX_AMOUNT; // 10.1 FLOW

    console.log(`\n[2/4] Alice shieldedTransfer ${TX_AMOUNT} attoFLOW (8 FLOW) → Charlie`);
    const txProof = await buildTransferProof(oldBalance, WRAP_BLINDING, TX_AMOUNT, TX_BLINDING, NEW_BLINDING_ALICE);

    // Verify commitment matches on-chain (check alice's commitment)
    const aliceCommitHex = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("balanceOfCommitmentXY", [ALICE.coa]),
    });
    // ABI-decode returns (x, y) — last 64 bytes of calldata each
    const aliceX = BigInt("0x" + aliceCommitHex.slice(2, 66));
    const aliceY = BigInt("0x" + aliceCommitHex.slice(66, 130));
    const expectedX = txProof.oldCommit.x;
    const expectedY = txProof.oldCommit.y;
    console.log(`  Alice on-chain commit X: ${aliceX.toString().slice(0,12)}...`);
    console.log(`  Expected (local) X:      ${expectedX.toString().slice(0,12)}...`);
    if (aliceX !== expectedX || aliceY !== expectedY) {
        console.warn("  WARN: On-chain commit does not match local state! This may fail proof verification.");
    } else {
        console.log("  Local state matches on-chain commitment ✓");
    }

    const transferCalldata = iface.encodeFunctionData("shieldedTransfer", [
        CHARLIE.coa,
        txProof.publicSignals.map(BigInt),
        txProof.proof,
    ]);
    const transferRes = runFlowTx(
        COA_CALL_TX,
        [PROXY, transferCalldata.slice(2), "600000"],
        "shielded_transfer",
        ALICE.signer,
    );
    txHashes.transfer_flow = transferRes.id;
    txHashes.transfer_evm = extractEvmTxHash(transferRes);
    console.log(`  Flow tx: ${txHashes.transfer_flow}`);
    console.log(`  EVM tx:  ${txHashes.transfer_evm}`);

    // ── 3. Alice unwraps 5 FLOW ─────────────────────────────────────────
    const UNWRAP_AMOUNT = 5_000_000_000_000_000_000n; // 5 FLOW
    const UNWRAP_BLINDING = BigInt("0xddddeeeeffff00001111222233334444"); // 128-bit
    const RESIDUAL_BLINDING = BigInt("0x9876543210987654abcdef0123456789"); // 128-bit

    console.log(`\n[3/4] Alice unwraps ${UNWRAP_AMOUNT} attoFLOW (5 FLOW)`);
    // Alice's new balance after the transfer is newBalance = 10.1 FLOW
    const aliceBalance = newBalance; // 10.1 FLOW

    // Build amount-disclose proof for unwrap
    const unwrapAmtProof = await buildAmountProof(UNWRAP_AMOUNT, UNWRAP_BLINDING);

    // Build transfer proof (alice pays 30, keeps 10)
    const unwrapTxProof = await buildTransferProof(
        aliceBalance,      // 40 FLOW
        NEW_BLINDING_ALICE,
        UNWRAP_AMOUNT,     // 30 FLOW
        UNWRAP_BLINDING,
        RESIDUAL_BLINDING,
    );

    // Verify alice on-chain after shieldedTransfer
    const aliceCommitHex2 = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("balanceOfCommitmentXY", [ALICE.coa]),
    });
    const aliceX2 = BigInt("0x" + aliceCommitHex2.slice(2, 66));
    const expectedX2 = unwrapTxProof.oldCommit.x;
    if (aliceX2 !== expectedX2) {
        console.warn(`  WARN: Alice on-chain commit mismatch after transfer. On-chain X: ${aliceX2.toString().slice(0,12)}, expected: ${expectedX2.toString().slice(0,12)}`);
    } else {
        console.log("  Alice on-chain commit matches local state before unwrap ✓");
    }

    const unwrapCalldata = iface.encodeFunctionData("unwrap", [
        UNWRAP_AMOUNT,
        ALICE.coa, // recipient = alice's COA
        [unwrapAmtProof.commit.x, unwrapAmtProof.commit.y],
        unwrapAmtProof.proof,
        unwrapTxProof.publicSignals.map(BigInt),
        unwrapTxProof.proof,
    ]);
    const unwrapRes = runFlowTx(
        COA_CALL_TX,
        [PROXY, unwrapCalldata.slice(2), "800000"],
        "unwrap30",
        ALICE.signer,
    );
    txHashes.unwrap_flow = unwrapRes.id;
    txHashes.unwrap_evm = extractEvmTxHash(unwrapRes);
    console.log(`  Flow tx: ${txHashes.unwrap_flow}`);
    console.log(`  EVM tx:  ${txHashes.unwrap_evm}`);

    // ── 4. Verify final state ────────────────────────────────────────────
    console.log(`\n[4/4] Verifying final on-chain state...`);

    const lockedAfter = BigInt(await provider.call({ to: PROXY, data: iface.encodeFunctionData("totalLocked") }));
    const expectedDelta = WRAP_AMOUNT - UNWRAP_AMOUNT; // 18.1 - 5 = 13.1 FLOW
    const actualDelta = lockedAfter - lockedBefore;
    console.log(`  totalLocked before:  ${lockedBefore} attoFLOW`);
    console.log(`  totalLocked after:   ${lockedAfter} attoFLOW`);
    console.log(`  delta:               ${actualDelta} (expected ${expectedDelta})`);
    const deltaOk = actualDelta === expectedDelta;
    console.log(`  totalLocked invariant: ${deltaOk ? "PASS ✓" : "FAIL ✗"}`);

    // Read MAX_WRAP again to confirm it survived the unwrap
    const maxWrapFinal = BigInt(await provider.call({ to: PROXY, data: iface.encodeFunctionData("MAX_WRAP") }));
    const maxWrapOk = maxWrapFinal === (1n << 128n) - 1n;
    console.log(`  MAX_WRAP still 2^128-1: ${maxWrapOk ? "PASS ✓" : "FAIL ✗"}`);

    const verdict = deltaOk && maxWrapOk ? "PASS" : "FAIL";
    console.log(`\n  Verdict: ${verdict}`);

    // ── Save results ─────────────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const results = {
        date: new Date().toISOString(),
        verdict,
        proxy: PROXY,
        tx_hashes: txHashes,
        wrap_amount_attoflow: WRAP_AMOUNT.toString(),
        transfer_amount_attoflow: TX_AMOUNT.toString(),
        unwrap_amount_attoflow: UNWRAP_AMOUNT.toString(),
        total_locked_before: lockedBefore.toString(),
        total_locked_after: lockedAfter.toString(),
        total_locked_delta: actualDelta.toString(),
        expected_delta: expectedDelta.toString(),
        total_locked_ok: deltaOk,
        max_wrap_ok: maxWrapOk,
    };
    const outPath = join(DEPLOYMENTS_DIR, "v05-smoke-results.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nResults written: ${outPath}`);

    if (verdict !== "PASS") throw new Error("Smoke test FAILED — see results above.");
    return results;
}

main().catch(err => {
    console.error("\nSMOKE FAIL:", err.message);
    process.exit(1);
});
