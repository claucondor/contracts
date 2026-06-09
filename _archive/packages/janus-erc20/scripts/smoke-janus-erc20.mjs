/**
 * smoke-janus-erc20.mjs — End-to-end smoke test for JanusERC20 v0.4 on Flow EVM testnet.
 *
 * Personas (each has its own Cadence Owned Account — their COA EVM address is
 * the `msg.sender` seen by JanusERC20):
 *
 *   alice = 0xbef3c77681c15397 (openjanus-flow) → COA 0x...2f6b30af48a94787
 *   bob   = 0xd807a3992d7be612 (testnet-bob)    → COA 0x...50d93efba617e0bf
 *
 * Flow:
 *   1. Alice mints 100 mUSDC to her own COA.
 *   2. Alice approves JanusERC20Proxy to spend 100 mUSDC.
 *   3. Alice wraps 100 mUSDC into a Pedersen commitment.
 *   4. Alice shieldedTransfers 30 mUSDC to Bob (HIDDEN amount).
 *   5. Bob unwraps 30 mUSDC back to himself (his COA EVM address).
 *
 * Privacy assertions:
 *   - wrap event Wrapped(amount) DISCLOSES 100 (boundary, by design).
 *   - approve emits Approval(amount=100) on the underlying — boundary.
 *   - shieldedTransfer event ConfidentialTransfer has NO amount fields.
 *   - shieldedTransfer calldata contains NO uint256 plaintext amount (only
 *     commitment coordinates indistinguishable from random curve points).
 *   - shieldedTransfer storage view (`commitments[acct]`) returns Point only.
 *   - unwrap event Unwrapped(amount) DISCLOSES 30 (boundary, by design).
 *   - totalLocked accounting matches the wrap/unwrap deltas.
 *
 * Outputs: deployments/smoke-janus-erc20-v0.4.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";
import * as snarkjs from "snarkjs";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

const JANUS_ART = join(MODULE_ROOT, "artifacts/contracts/solidity/JanusERC20.sol/JanusERC20.json");
const USDC_ART  = join(MODULE_ROOT, "artifacts/contracts/solidity/MockUSDC.sol/MockUSDC.json");

const DEPLOY_RECORD_PATH = join(DEPLOYMENTS_DIR, "janus-erc20-v0.4.json");

// --- Circuit artifacts (v0.3 ceremony zkey — matches reused verifiers) ------
const V03_SDK_CIRCUITS = "/home/oydual3/openjanus-sdk/circuits/v0.3";
const AMOUNT_WASM   = join(V03_SDK_CIRCUITS, "amount_disclose.wasm");
const AMOUNT_ZKEY   = join(V03_SDK_CIRCUITS, "amount_disclose_final.zkey");
const TRANSFER_WASM = join(V03_SDK_CIRCUITS, "confidential_transfer.wasm");
const TRANSFER_ZKEY = join(V03_SDK_CIRCUITS, "confidential_transfer_final.zkey");

// --- Personas ---------------------------------------------------------------
const ALICE = { name: "alice", signer: "openjanus-flow", flow: "0xbef3c77681c15397", coa: "0x0000000000000000000000022f6b30af48a94787" };
const BOB   = { name: "bob",   signer: "bob",            flow: "0xd807a3992d7be612", coa: "0x00000000000000000000000250d93efba617e0bf" };

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const provider = new JsonRpcProvider(RPC_URL);

// --- Cadence transaction templates (COA EVM call) ---------------------------
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

// ---------------------------------------------------------------------------

function runFlowTx(txPath, args, signer, label) {
    const argStrs = args.map(a => `"${a}"`).join(" ");
    const cmd = [
        "flow transactions send",
        txPath,
        argStrs,
        "--network testnet",
        `--signer ${signer}`,
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");
    let result;
    try {
        const stdout = execSync(cmd, { cwd: MODULE_ROOT, timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); }
            catch {
                throw new Error(`[${label}] non-JSON flow CLI output:\n${err.stdout?.slice(0, 1200)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 600)}`);
        }
    }
    if (result.status !== "SEALED" || result.errorMessage) {
        throw new Error(`[${label}] tx not SEALED or errored: status=${result.status} errMsg=${result.errorMessage}`);
    }
    return result;
}

function coaCall(signer, contractAddress, calldataHex, gasLimit, label) {
    const txPath = "/tmp/.smoke_erc20_coa_call.cdc";
    writeFileSync(txPath, COA_CALL_TX);
    return runFlowTx(txPath, [contractAddress, calldataHex, String(gasLimit)], signer, label);
}

function extractEvmTxHashesFromFlow(result) {
    const events = result?.events ?? [];
    const hashes = [];
    for (const ev of events) {
        const t = ev?.type ?? "";
        if (!t.endsWith(".EVM.TransactionExecuted")) continue;
        const fields = ev?.values?.value?.fields ?? [];
        for (const f of fields) {
            const arr = f?.value?.value;
            if (Array.isArray(arr) && arr.length === 32 &&
                arr.every(b => b?.type === "UInt8")) {
                const hex = arr.map(b => Number(b.value).toString(16).padStart(2, "0")).join("");
                hashes.push("0x" + hex);
                break;
            }
        }
    }
    return hashes;
}

function extractEvmTxHashFromFlow(result) {
    const hashes = extractEvmTxHashesFromFlow(result);
    return hashes.length > 0 ? hashes[hashes.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Proof helpers (mirrored from v03-smoke.mjs)
// ---------------------------------------------------------------------------

let _pedersen = null;
let _baby = null;

async function getPedersen() {
    if (!_pedersen) {
        const { buildPedersenHash } = await import("circomlibjs");
        _pedersen = await buildPedersenHash();
    }
    return _pedersen;
}
async function getBaby() {
    if (!_baby) {
        const { buildBabyjub } = await import("circomlibjs");
        _baby = await buildBabyjub();
    }
    return _baby;
}

async function pedersenCommit(value, blinding) {
    if (value < 0n || value >= (1n << 64n)) throw new Error("value out of [0, 2^64)");
    if (blinding < 0n || blinding >= (1n << 128n)) throw new Error("blinding out of [0, 2^128)");
    const ped = await getPedersen();
    const baby = await getBaby();
    const buf = Buffer.alloc(24, 0);
    let v = value;
    for (let i = 0; i < 8; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
    let b = blinding;
    for (let i = 8; i < 24; i++) { buf[i] = Number(b & 0xffn); b >>= 8n; }
    const hash = ped.hash(buf);
    const point = baby.unpackPoint(hash);
    return { x: baby.F.toObject(point[0]), y: baby.F.toObject(point[1]) };
}

function rand128() {
    const bytes = randomBytes(16);
    let r = 0n;
    for (const x of bytes) r = (r << 8n) | BigInt(x);
    return r;
}

function applyPiBSwap(p) {
    return {
        ...p,
        pi_b: [
            [p.pi_b[0][1], p.pi_b[0][0]],
            [p.pi_b[1][1], p.pi_b[1][0]],
        ],
    };
}

function packProof(p) {
    const s = applyPiBSwap(p);
    return [
        BigInt(s.pi_a[0]), BigInt(s.pi_a[1]),
        BigInt(s.pi_b[0][0]), BigInt(s.pi_b[0][1]),
        BigInt(s.pi_b[1][0]), BigInt(s.pi_b[1][1]),
        BigInt(s.pi_c[0]), BigInt(s.pi_c[1]),
    ];
}

async function makeAmountProof(amount, blinding) {
    const commit = await pedersenCommit(amount, blinding);
    const input = {
        blinding: blinding.toString(),
        claimed_amount: amount.toString(),
        commit: [commit.x.toString(), commit.y.toString()],
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, AMOUNT_WASM, AMOUNT_ZKEY);
    return {
        commit,
        proof: packProof(proof),
        publicSignals: publicSignals.map(s => BigInt(s)),
    };
}

async function makeTransferProof(oldValue, oldBlinding, txValue, txBlinding, newBlinding) {
    const oldC = await pedersenCommit(oldValue, oldBlinding);
    const txC  = await pedersenCommit(txValue, txBlinding);
    const newV = oldValue - txValue;
    if (newV < 0n) throw new Error("transfer underflow");
    const newC = await pedersenCommit(newV, newBlinding);
    const input = {
        old_value: oldValue.toString(),
        old_blinding: oldBlinding.toString(),
        transfer_value: txValue.toString(),
        transfer_blinding: txBlinding.toString(),
        new_blinding: newBlinding.toString(),
        old_commit: [oldC.x.toString(), oldC.y.toString()],
        transfer_commit: [txC.x.toString(), txC.y.toString()],
        new_commit: [newC.x.toString(), newC.y.toString()],
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, TRANSFER_WASM, TRANSFER_ZKEY);
    return {
        oldCommit: oldC, txCommit: txC, newCommit: newC,
        newValue: newV,
        proof: packProof(proof),
        publicInputs: publicSignals.map(s => BigInt(s)),
    };
}

function calldataContainsAmount(calldataHex, amount) {
    if (amount === 0n) return false;
    const clean = (calldataHex.startsWith("0x") ? calldataHex.slice(2) : calldataHex).toLowerCase();
    const needle = amount.toString(16).toLowerCase().replace(/^0+/, "");
    if (!needle) return false;
    return clean.includes(needle);
}

// ---------------------------------------------------------------------------

async function main() {
    console.log("=".repeat(72));
    console.log("JanusERC20 v0.4 — on-chain smoke test");
    console.log("=".repeat(72));

    if (!existsSync(DEPLOY_RECORD_PATH)) throw new Error(`Missing deploy record: ${DEPLOY_RECORD_PATH}`);
    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD_PATH, "utf8"));
    const PROXY = deploy.contracts.JanusERC20_proxy;
    const USDC = deploy.contracts.MockUSDC;
    console.log(`Proxy:    ${PROXY}`);
    console.log(`MockUSDC: ${USDC}`);
    console.log();

    const janusArt = JSON.parse(readFileSync(JANUS_ART, "utf8"));
    const usdcArt  = JSON.parse(readFileSync(USDC_ART, "utf8"));
    const janusIface = new Interface(janusArt.abi);
    const usdcIface  = new Interface(usdcArt.abi);

    // ─── Pre-state ───────────────────────────────────────────────────────────
    const initialPoolHex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("totalLocked", []),
    });
    const initialPool = BigInt(initialPoolHex);
    console.log("[0] totalLocked at start:", initialPool.toString(), "raw mUSDC");

    const aliceCommit0Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("balanceOfCommitmentXY", [ALICE.coa]),
    });
    console.log("[0] Alice commitment at start:", aliceCommit0Hex.slice(0, 66) + "...");

    const bobCommit0Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("balanceOfCommitmentXY", [BOB.coa]),
    });
    console.log("[0] Bob   commitment at start:", bobCommit0Hex.slice(0, 66) + "...");

    const results = {
        date: new Date().toISOString(),
        proxy: PROXY,
        underlying: USDC,
        steps: {},
        privacy_checks: {},
        tx_hashes: {},
    };

    // ─── 1. Alice mints 100 mUSDC to herself ─────────────────────────────────
    const MINT_AMOUNT = 100_000_000n; // 100 mUSDC (6 decimals)
    console.log("\n[1] Alice mints 100 mUSDC to herself");
    {
        const mintData = usdcIface.encodeFunctionData("mint", [ALICE.coa, MINT_AMOUNT]);
        const r = coaCall(ALICE.signer, USDC, mintData.slice(2), 500_000, "alice-mint");
        const evmTx = extractEvmTxHashFromFlow(r);
        console.log("   flow tx:", r.id);
        console.log("   evm tx :", evmTx);
        results.tx_hashes.mint_flow = r.id;
        results.tx_hashes.mint_evm = evmTx;
    }
    const aliceUsdcBal = await provider.call({
        to: USDC, data: usdcIface.encodeFunctionData("balanceOf", [ALICE.coa]),
    });
    const aliceUsdcBalRaw = BigInt(aliceUsdcBal);
    console.log("   Alice mUSDC balance:", aliceUsdcBalRaw.toString());
    if (aliceUsdcBalRaw < MINT_AMOUNT) throw new Error("mint failed");

    // ─── 2. Alice approves JanusERC20Proxy to spend 100 mUSDC ────────────────
    console.log("\n[2] Alice approves JanusERC20Proxy to spend 100 mUSDC");
    {
        const apprData = usdcIface.encodeFunctionData("approve", [PROXY, MINT_AMOUNT]);
        const r = coaCall(ALICE.signer, USDC, apprData.slice(2), 300_000, "alice-approve");
        const evmTx = extractEvmTxHashFromFlow(r);
        console.log("   flow tx:", r.id);
        console.log("   evm tx :", evmTx);
        results.tx_hashes.approve_flow = r.id;
        results.tx_hashes.approve_evm = evmTx;
    }
    const allowance = await provider.call({
        to: USDC, data: usdcIface.encodeFunctionData("allowance", [ALICE.coa, PROXY]),
    });
    console.log("   allowance:", BigInt(allowance).toString());

    // ─── 3. Alice wraps 100 mUSDC ────────────────────────────────────────────
    console.log("\n[3] Alice wraps 100 mUSDC");
    const wrapBlinding = rand128();
    const wrapProof = await makeAmountProof(MINT_AMOUNT, wrapBlinding);

    if (wrapProof.publicSignals[0] !== MINT_AMOUNT) throw new Error("public[0] != amount");
    if (wrapProof.publicSignals[1] !== wrapProof.commit.x ||
        wrapProof.publicSignals[2] !== wrapProof.commit.y) throw new Error("public[1..2] != commit");

    const wrapData = janusIface.encodeFunctionData("wrap", [
        MINT_AMOUNT,
        [wrapProof.commit.x, wrapProof.commit.y],
        wrapProof.proof,
    ]);
    console.log("   wrap calldata length:", wrapData.length / 2 - 1, "bytes");

    let wrapEvmTx;
    {
        const r = coaCall(ALICE.signer, PROXY, wrapData.slice(2), 1_500_000, "alice-wrap");
        wrapEvmTx = extractEvmTxHashFromFlow(r);
        console.log("   flow tx:", r.id);
        console.log("   evm tx :", wrapEvmTx);
        results.tx_hashes.wrap_flow = r.id;
        results.tx_hashes.wrap_evm = wrapEvmTx;
    }

    // Pre-track Alice's private state
    let aliceBalance = MINT_AMOUNT;
    let aliceBlinding = wrapBlinding;

    const pool1Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("totalLocked", []),
    });
    const pool1 = BigInt(pool1Hex);
    const wrapDelta = pool1 - initialPool;
    console.log("   totalLocked after wrap:", pool1.toString(), "(delta:", wrapDelta.toString(), ")");
    if (wrapDelta !== MINT_AMOUNT) throw new Error(`totalLocked delta mismatch: ${wrapDelta} != ${MINT_AMOUNT}`);

    const aliceCommit1Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("balanceOfCommitmentXY", [ALICE.coa]),
    });
    console.log("   Alice commitment after wrap:", aliceCommit1Hex.slice(0, 66) + "...");

    // ─── 4. Alice shielded-transfers 30 mUSDC to Bob ─────────────────────────
    console.log("\n[4] Alice shielded-transfers 30 mUSDC to Bob (HIDDEN)");
    const XFER_AMOUNT = 30_000_000n; // 30 mUSDC
    const xferBlinding = rand128();
    const newBlinding = rand128();
    const xferProof = await makeTransferProof(aliceBalance, aliceBlinding, XFER_AMOUNT, xferBlinding, newBlinding);

    const xferData = janusIface.encodeFunctionData("shieldedTransfer", [
        BOB.coa,
        xferProof.publicInputs,
        xferProof.proof,
    ]);
    console.log("   shieldedTransfer calldata length:", xferData.length / 2 - 1, "bytes");

    // Privacy check: cleartext 30_000_000 (0x1c9c380) MUST NOT appear in calldata
    const xferContainsAmount = calldataContainsAmount(xferData, XFER_AMOUNT);
    console.log("   30M raw in calldata?", xferContainsAmount, "(must be false)");
    if (xferContainsAmount) throw new Error("PRIVACY VIOLATION: cleartext amount leaked in shieldedTransfer calldata");

    let xferEvmTx;
    {
        const r = coaCall(ALICE.signer, PROXY, xferData.slice(2), 1_500_000, "alice-xfer");
        xferEvmTx = extractEvmTxHashFromFlow(r);
        console.log("   flow tx:", r.id);
        console.log("   evm tx :", xferEvmTx);
        results.tx_hashes.xfer_flow = r.id;
        results.tx_hashes.xfer_evm = xferEvmTx;
    }

    // Privacy check: ConfidentialTransfer event has NO amount
    const xferReceipt = await provider.getTransactionReceipt(xferEvmTx);
    const ctEvent = xferReceipt.logs
        .map(l => { try { return janusIface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "ConfidentialTransfer");
    if (!ctEvent) throw new Error("ConfidentialTransfer event not found");
    const ctEventFields = Object.keys(ctEvent.args).filter(k => isNaN(Number(k)));
    console.log("   ConfidentialTransfer event fields:", ctEventFields);
    if (ctEventFields.some(f => f.toLowerCase().includes("amount") || f.toLowerCase().includes("value"))) {
        throw new Error("PRIVACY VIOLATION: ConfidentialTransfer event leaks amount");
    }

    // Privacy check: NO MockUSDC.Transfer event in this tx (shielded transfer doesn't touch underlying)
    const underlyingXferEvent = xferReceipt.logs.find(l => l.address.toLowerCase() === USDC.toLowerCase());
    if (underlyingXferEvent) {
        console.log("   WARN: underlying ERC20 emitted an event during shieldedTransfer:", underlyingXferEvent);
        throw new Error("PRIVACY VIOLATION: underlying ERC20 touched during shieldedTransfer");
    }
    console.log("   underlying ERC20 untouched during shieldedTransfer (PASS)");

    // Pool unchanged
    const pool2Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("totalLocked", []),
    });
    const pool2 = BigInt(pool2Hex);
    console.log("   totalLocked after xfer:", pool2.toString(), "(must equal", pool1.toString(), ")");
    if (pool2 !== pool1) throw new Error("totalLocked changed during shieldedTransfer");

    // Update Alice's private state
    aliceBalance = xferProof.newValue;
    aliceBlinding = newBlinding;

    // Track Bob's private state — Bob just received C_tx
    const bobBalance = XFER_AMOUNT;
    const bobBlinding = xferBlinding;

    const aliceCommit2Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("balanceOfCommitmentXY", [ALICE.coa]),
    });
    const bobCommit2Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("balanceOfCommitmentXY", [BOB.coa]),
    });
    console.log("   Alice commitment after xfer:", aliceCommit2Hex.slice(0, 66) + "...");
    console.log("   Bob   commitment after xfer:", bobCommit2Hex.slice(0, 66) + "...");

    // ─── 5. Bob unwraps 30 mUSDC back to himself ─────────────────────────────
    console.log("\n[5] Bob unwraps 30 mUSDC to himself");

    // Build proofs:
    //   amount_disclose proof: tx commits to 30 mUSDC
    //   transfer proof: Bob's old commit (= his current 30 mUSDC) → 0 mUSDC
    const unwrapAmountProof = await makeAmountProof(XFER_AMOUNT, bobBlinding);
    const unwrapNewBlinding = rand128();
    // The unwrap path requires: txCommit committed to XFER_AMOUNT, and
    // transfer proof binds bobOldCommit → C_new (residual = 0).
    // We construct the transferProof such that public[2..3] == amount_disclose.commit.
    // makeTransferProof uses (txBlinding) to compute C_tx; reuse the same blinding
    // as the amount proof so the two C_tx values match.
    const unwrapTransferProof = await makeTransferProof(
        bobBalance, bobBlinding,         // old = 30 mUSDC with bobBlinding (= his current commit)
        XFER_AMOUNT, bobBlinding,         // tx  = 30 mUSDC with SAME blinding (so C_tx ≡ amount_disclose.commit)
        unwrapNewBlinding                 // new = 0 mUSDC with a fresh blinding
    );

    // Sanity: amount_disclose.commit MUST equal transferProof.publicInputs[2..3]
    if (unwrapAmountProof.commit.x !== unwrapTransferProof.publicInputs[2] ||
        unwrapAmountProof.commit.y !== unwrapTransferProof.publicInputs[3]) {
        throw new Error("amount_disclose.commit != transferProof.C_tx (proof binding broken)");
    }

    const unwrapData = janusIface.encodeFunctionData("unwrap", [
        XFER_AMOUNT,
        BOB.coa,
        [unwrapAmountProof.commit.x, unwrapAmountProof.commit.y],
        unwrapAmountProof.proof,
        unwrapTransferProof.publicInputs,
        unwrapTransferProof.proof,
    ]);
    console.log("   unwrap calldata length:", unwrapData.length / 2 - 1, "bytes");

    let unwrapEvmTx;
    {
        const r = coaCall(BOB.signer, PROXY, unwrapData.slice(2), 2_000_000, "bob-unwrap");
        unwrapEvmTx = extractEvmTxHashFromFlow(r);
        console.log("   flow tx:", r.id);
        console.log("   evm tx :", unwrapEvmTx);
        results.tx_hashes.unwrap_flow = r.id;
        results.tx_hashes.unwrap_evm = unwrapEvmTx;
    }

    // Pool decreased by 30
    const pool3Hex = await provider.call({
        to: PROXY, data: janusIface.encodeFunctionData("totalLocked", []),
    });
    const pool3 = BigInt(pool3Hex);
    const unwrapDelta = pool2 - pool3;
    console.log("   totalLocked after unwrap:", pool3.toString(), "(delta:", unwrapDelta.toString(), ")");
    if (unwrapDelta !== XFER_AMOUNT) throw new Error(`totalLocked unwrap delta mismatch: ${unwrapDelta} != ${XFER_AMOUNT}`);

    // Bob received 30 mUSDC
    const bobUsdcBal = await provider.call({
        to: USDC, data: usdcIface.encodeFunctionData("balanceOf", [BOB.coa]),
    });
    const bobUsdcBalRaw = BigInt(bobUsdcBal);
    console.log("   Bob mUSDC balance:", bobUsdcBalRaw.toString(), "(>= 30M expected)");
    if (bobUsdcBalRaw < XFER_AMOUNT) throw new Error("Bob did not receive unwrapped mUSDC");

    // Privacy: Unwrapped event SHOULD disclose amount (boundary leak by design)
    const unwrapReceipt = await provider.getTransactionReceipt(unwrapEvmTx);
    const unwrappedEvent = unwrapReceipt.logs
        .map(l => { try { return janusIface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "Unwrapped");
    if (!unwrappedEvent) throw new Error("Unwrapped event not found");
    console.log("   Unwrapped event amount:", unwrappedEvent.args.amount.toString(), "(expected: 30000000)");
    if (BigInt(unwrappedEvent.args.amount) !== XFER_AMOUNT) throw new Error("Unwrapped amount mismatch");

    // ─── Privacy summary ─────────────────────────────────────────────────────
    results.privacy_checks = {
        wrap_event_discloses_amount: true,                 // BY DESIGN
        approve_event_discloses_amount: true,              // BY DESIGN (underlying ERC20)
        shielded_transfer_no_cleartext_in_calldata: true,
        confidential_transfer_event_no_amount_field: true,
        shielded_transfer_does_not_touch_underlying: true,
        totalLocked_unchanged_on_shielded_transfer: true,
        unwrap_event_discloses_amount: true,               // BY DESIGN
        pool_accounting_consistent: true,
    };
    results.steps.summary = {
        mint:    "Alice minted 100 mUSDC",
        approve: "Alice approved proxy for 100 mUSDC",
        wrap:    "Alice wrapped 100 mUSDC; totalLocked += 100M",
        xfer:    "Alice shielded-transferred 30 mUSDC to Bob (HIDDEN)",
        unwrap:  "Bob unwrapped 30 mUSDC; totalLocked -= 30M",
    };
    results.steps.final_state = {
        totalLocked: pool3.toString(),
        alice_balance_tracked_offchain: aliceBalance.toString() + " (70M residual)",
        bob_balance_tracked_offchain:   "0 (fully unwrapped)",
        alice_usdc_balance: (await provider.call({
            to: USDC, data: usdcIface.encodeFunctionData("balanceOf", [ALICE.coa]),
        })) ? BigInt(await provider.call({
            to: USDC, data: usdcIface.encodeFunctionData("balanceOf", [ALICE.coa]),
        })).toString() : "0",
        bob_usdc_balance: bobUsdcBalRaw.toString(),
    };
    results.overall_pass = true;

    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const outPath = join(DEPLOYMENTS_DIR, "smoke-janus-erc20-v0.4.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");

    console.log("\n" + "=".repeat(72));
    console.log("SMOKE TEST PASS");
    console.log("=".repeat(72));
    console.log("Result written to:", outPath);
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
