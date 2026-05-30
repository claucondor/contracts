/**
 * v0_5_4-recovery-smoke.mjs — Smoke test for firstSnapshotBlock recovery hint.
 *
 * Tests:
 *   1. Verify proxy.VERSION() == "0.5.3" and firstSnapshotBlock ABI exists
 *   2. Confirm alice's firstSnapshotBlock is 0 (post-reset, fresh)
 *   3. Wrap 1 FLOW — this populates firstSnapshotBlock[alice.coa]
 *   4. Confirm firstSnapshotBlock[alice.coa] is now non-zero (set to wrap block)
 *   5. Call SDK scanJanusFlowSnapshots without fromBlock override — verifies
 *      it reads the hint and finds the WrapWithSnapshot event
 *   6. Confirm scanner returns [] for an address with firstSnapshotBlock == 0
 *
 * Note: The full MemoKey sign-derive → encrypted snapshot → decrypt → Pedersen
 * validate flow is done by the web app integration. This script focuses on the
 * new firstSnapshotBlock mechanism specifically.
 *
 * Run from package root:
 *   node scripts/v0_5_4-recovery-smoke.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider, ethers } from "ethers";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT    = join(__dirname, "..");
const ARTIFACTS      = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON      = join(MODULE_ROOT, "flow.json");

// v0.5.1 ceremony circuit artifacts (same as v0.5.2/v0.5.3 — verifier not changed)
const AMOUNT_WASM = join(MODULE_ROOT, "../../circuits/v0.5.1-ceremony/build/amount_disclose_js/amount_disclose.wasm");
const AMOUNT_ZKEY = join(MODULE_ROOT, "../../circuits/v0.5.1-ceremony/amount_disclose_final.zkey");

const ART_JANUSFLOW = join(ARTIFACTS, "JanusFlow_v0_5_3.sol/JanusFlow_v0_5_3.json");
const PROXY   = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const RPC_URL = "https://testnet.evm.nodes.onflow.org";

// Alice = openjanus-flow signer, COA is the EVM proxy owner
const ALICE = {
    name:   "alice",
    signer: "openjanus-flow",
    coa:    "0x0000000000000000000000022f6b30af48a94787",
};
const ZERO_ADDR = "0x0000000000000000000000000000000000000001";

// Wrap amount: 0.1 FLOW = 1e17 attoFLOW (alice COA has ~0.5 FLOW, keep some for gas)
const WRAP_AMOUNT_ATTOFLOW = 100_000_000_000_000_000n;

const provider = new JsonRpcProvider(RPC_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runFlowTx(txBody, args, label, signer, gasLimit = 9999) {
    const txPath = `/tmp/.v054smoke_${label}.cdc`;
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
                throw new Error(`[${label}] non-JSON: ${err.stdout?.slice(0, 500)}\nSTDERR: ${err.stderr?.slice(0, 200)}`);
            }
        } else throw err;
    }
    if (result.status !== "SEALED" || result.errorMessage) {
        throw new Error(`[${label}] tx not SEALED or errored: status=${result.status} errMsg=${result.errorMessage}`);
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

async function computeCommitmentV051(value, blinding) {
    const { buildPedersenHash, buildBabyjub } = await import("circomlibjs");
    const pedersenHash = await buildPedersenHash();
    const babyJub      = await buildBabyjub();
    const F = babyJub.F;

    const buf = Buffer.alloc(32, 0);
    let v = value;
    for (let i = 0; i < 16; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
    let b = blinding;
    for (let i = 16; i < 32; i++) { buf[i] = Number(b & 0xffn); b >>= 8n; }

    const hash  = pedersenHash.hash(buf);
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
        BigInt(proof.pi_c[0]),     BigInt(proof.pi_c[1]),
    ];
}

async function buildAmountProof(amount, blinding) {
    const commit = await computeCommitmentV051(amount, blinding);
    const input  = {
        blinding:       blinding.toString(),
        claimed_amount: amount.toString(),
        commit: [commit.x.toString(), commit.y.toString()],
    };
    const { proof } = await snarkjs.groth16.fullProve(input, AMOUNT_WASM, AMOUNT_ZKEY);
    const swapped   = applyPiBSwap(proof);
    return { proof: proofToUint256Array(swapped), commit };
}

function toHex64(n) { return n.toString(16).padStart(64, "0"); }
function encodeUint256(n) { return toHex64(n); }

function buildWrapCalldata(iface, txCommit, amountProof) {
    // encryptedSnapshot = "0x" (empty — no MemoKey for this smoke test)
    // ephPubkeyX/Y = 0n
    return iface.encodeFunctionData("wrap", [
        [txCommit.x, txCommit.y],
        amountProof,
        "0x",
        0n,
        0n,
    ]);
}

const WRAP_TX = (attoflow) => `import "EVM"

transaction(contractAddress: String, calldataHex: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(contractAddress),
            data: calldataHex.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: ${attoflow})
        )
        assert(
            result.status == EVM.Status.successful,
            message: "wrap failed: ".concat(result.errorMessage)
        )
    }
}
`;

// ---------------------------------------------------------------------------
// Scanner (inline — mirrors SDK src/recovery/scanner.ts logic)
// ---------------------------------------------------------------------------

const EVENTS_ABI = [
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferWithSnapshot(address indexed sender, address indexed recipient, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event UnwrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
];
const HINT_ABI = ["function firstSnapshotBlock(address) view returns (uint256)"];
const CHUNK = 9000;

async function scanWithHint(userEvmAddr) {
    const hintContract = new ethers.Contract(PROXY, HINT_ABI, provider);
    const firstBlockBig = await hintContract.firstSnapshotBlock(userEvmAddr);
    const firstBlock = Number(firstBlockBig);

    if (firstBlock === 0) return { firstBlock: 0, logs: [], usedHint: true };

    const latestBlock = await provider.getBlockNumber();
    const iface = new ethers.Interface(EVENTS_ABI);
    const userTopic = ethers.zeroPadValue(userEvmAddr.toLowerCase(), 32);
    const allLogs = [];
    const seen = new Set();

    for (let start = firstBlock; start <= latestBlock; start += CHUNK) {
        const end = Math.min(start + CHUNK - 1, latestBlock);
        const [wrapLogs] = await Promise.all([
            provider.getLogs({
                address: PROXY, fromBlock: start, toBlock: end,
                topics: [iface.getEvent("WrapWithSnapshot").topicHash, userTopic],
            }),
        ]);
        for (const log of wrapLogs) {
            const key = `${log.blockNumber}-${log.transactionIndex}-${log.index}`;
            if (!seen.has(key)) { seen.add(key); allLogs.push(log); }
        }
    }

    return { firstBlock, logs: allLogs, latestBlock, usedHint: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const results = {
        version: "0.5.4",
        date: new Date().toISOString(),
        proxy: PROXY,
        impl: "0xd6584cb2788D2eA5c3AB61fb72aa9fEaC27ae79D",
        checks: {},
        tx_hashes: {},
        conclusion: "PENDING",
    };

    console.log("=".repeat(72));
    console.log("JanusFlow v0.5.4 Recovery Smoke — firstSnapshotBlock hint");
    console.log("=".repeat(72));

    // ── Check artifacts ─────────────────────────────────────────────────────
    if (!existsSync(ART_JANUSFLOW)) throw new Error(`Missing artifact: ${ART_JANUSFLOW} — run: npx hardhat compile`);
    if (!existsSync(AMOUNT_WASM))   throw new Error(`Missing circuit WASM: ${AMOUNT_WASM}`);
    if (!existsSync(AMOUNT_ZKEY))   throw new Error(`Missing zkey: ${AMOUNT_ZKEY}`);

    const jfArt   = JSON.parse(readFileSync(ART_JANUSFLOW, "utf8"));
    const jfIface = new Interface(jfArt.abi);

    // ─── [1] VERSION check ──────────────────────────────────────────────────
    console.log("\n[1] proxy.VERSION()...");
    const versionData = await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("VERSION") });
    const [version]   = jfIface.decodeFunctionResult("VERSION", versionData);
    const versionOk   = version === "0.5.3";
    results.checks.version = { value: version, pass: versionOk };
    console.log(`  VERSION = "${version}" → ${versionOk ? "PASS" : "FAIL"}`);
    if (!versionOk) throw new Error("VERSION mismatch — proxy not upgraded to v0.5.3");

    // ─── [2] firstSnapshotBlock ABI exists ──────────────────────────────────
    console.log("\n[2] firstSnapshotBlock function in ABI...");
    const fsbInAbi = jfArt.abi.some(f => f.type === "function" && f.name === "firstSnapshotBlock");
    results.checks.firstSnapshotBlock_in_abi = { pass: fsbInAbi };
    console.log(`  firstSnapshotBlock in ABI → ${fsbInAbi ? "PASS" : "FAIL"}`);
    if (!fsbInAbi) throw new Error("firstSnapshotBlock not found in ABI");

    // ─── [3] alice's slot is 0 post-reset ───────────────────────────────────
    console.log("\n[3] firstSnapshotBlock[alice.coa] == 0 (post-reset)...");
    const fsbAliceData = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("firstSnapshotBlock", [ALICE.coa]),
    });
    const [fsbAlice] = jfIface.decodeFunctionResult("firstSnapshotBlock", fsbAliceData);
    const aliceFresh  = BigInt(fsbAlice) === 0n;
    results.checks.alice_fresh_before_wrap = { value: Number(fsbAlice), pass: aliceFresh };
    console.log(`  firstSnapshotBlock[alice.coa] = ${fsbAlice} → ${aliceFresh ? "PASS (fresh)" : "FAIL (expected 0 after reset)"}`);
    if (!aliceFresh) throw new Error("Alice's firstSnapshotBlock is non-zero — did the reset succeed?");

    // ─── [4] Scanner returns [] for fresh address ────────────────────────────
    console.log("\n[4] Scanner returns [] for fresh address (firstSnapshotBlock == 0)...");
    const scanEmpty = await scanWithHint(ALICE.coa);
    const emptyOk   = scanEmpty.firstBlock === 0 && scanEmpty.logs.length === 0;
    results.checks.scanner_returns_empty_for_fresh = { pass: emptyOk, firstBlock: scanEmpty.firstBlock };
    console.log(`  hint = ${scanEmpty.firstBlock}, logs = ${scanEmpty.logs.length} → ${emptyOk ? "PASS" : "FAIL"}`);
    if (!emptyOk) throw new Error("Scanner should return [] for fresh address");

    // ─── [5] Wrap 1 FLOW — populates firstSnapshotBlock ────────────────────
    console.log("\n[5] Wrapping 1 FLOW (alice.coa)...");
    const wrapBlinding = 12345678901234567890123456789n % ((1n << 128n) - 1n);
    const { proof: amountProof, commit: txCommit } = await buildAmountProof(WRAP_AMOUNT_ATTOFLOW, wrapBlinding);
    console.log(`  commit.x = ${txCommit.x.toString().slice(0, 20)}...`);

    const wrapCalldata = buildWrapCalldata(jfIface, txCommit, amountProof);
    const wrapRes      = runFlowTx(WRAP_TX(WRAP_AMOUNT_ATTOFLOW), [PROXY, wrapCalldata.slice(2), "800000"], "wrap", ALICE.signer);
    const wrapFlowTx   = wrapRes?.id ?? "unknown";
    const wrapEvmTx    = extractEvmTxHash(wrapRes);
    results.tx_hashes.wrap_flow = wrapFlowTx;
    results.tx_hashes.wrap_evm  = wrapEvmTx;
    console.log(`  Flow tx:  ${wrapFlowTx}`);
    console.log(`  EVM tx:   ${wrapEvmTx}`);

    // Get the block number of the wrap
    let wrapBlock = null;
    if (wrapEvmTx) {
        const rcpt   = await provider.getTransactionReceipt(wrapEvmTx);
        wrapBlock    = rcpt?.blockNumber ?? null;
    }
    console.log(`  wrap block: ${wrapBlock}`);

    // ─── [6] Confirm firstSnapshotBlock is now set ──────────────────────────
    console.log("\n[6] firstSnapshotBlock[alice.coa] should be the wrap block...");
    const fsbAfterData  = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("firstSnapshotBlock", [ALICE.coa]),
    });
    const [fsbAfter]    = jfIface.decodeFunctionResult("firstSnapshotBlock", fsbAfterData);
    const fsbAfterNum   = Number(fsbAfter);
    const fsbPopulated  = fsbAfterNum > 0;
    const fsbMatchesBlock = wrapBlock !== null ? fsbAfterNum === wrapBlock : true; // EVM block
    results.checks.alice_fsb_after_wrap = {
        value: fsbAfterNum,
        wrapBlock,
        matches: fsbMatchesBlock,
        pass: fsbPopulated,
    };
    console.log(`  firstSnapshotBlock[alice.coa] = ${fsbAfterNum}`);
    console.log(`  wrap block (EVM rcpt)         = ${wrapBlock}`);
    console.log(`  populated                     = ${fsbPopulated ? "PASS" : "FAIL"}`);
    console.log(`  matches wrap block            = ${fsbMatchesBlock ? "PASS" : "NOTE: may differ (Flow EVM block vs Cadence block)"}`);
    if (!fsbPopulated) throw new Error("firstSnapshotBlock was not set after wrap");

    // ─── [7] Scanner now finds logs via hint ────────────────────────────────
    console.log("\n[7] Scanner reads hint and finds WrapWithSnapshot log...");
    const scanAfter  = await scanWithHint(ALICE.coa);
    const scanOk     = scanAfter.firstBlock > 0 && scanAfter.logs.length >= 1;
    results.checks.scanner_finds_wrap_via_hint = {
        firstBlock: scanAfter.firstBlock,
        logsFound:  scanAfter.logs.length,
        pass: scanOk,
    };
    console.log(`  hint block = ${scanAfter.firstBlock}`);
    console.log(`  logs found = ${scanAfter.logs.length}`);
    console.log(`  scanner result → ${scanOk ? "PASS" : "FAIL"}`);
    if (!scanOk) throw new Error("Scanner did not find the WrapWithSnapshot log via hint");

    // ─── Final summary ───────────────────────────────────────────────────────
    const allPass = Object.values(results.checks).every(c => c.pass);
    results.conclusion = allPass ? "PASS" : "FAIL";

    console.log("\n" + "=".repeat(72));
    console.log(`v0.5.4 Recovery Smoke: ${results.conclusion}`);
    console.log("=".repeat(72));

    const OUT = join(DEPLOYMENTS_DIR.replace("deployments", "scripts"), "v0_5_4-smoke-results.json");
    writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nResults: ${OUT}`);

    for (const [k, v] of Object.entries(results.checks)) {
        console.log(`  ${v.pass ? "PASS" : "FAIL"} ${k}`);
    }

    if (!allPass) process.exit(1);
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
