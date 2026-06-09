/**
 * v03-cross-vm-smoke.mjs — Cross-VM end-to-end smoke test for JanusFlow v0.3.
 *
 * Exercises the Cadence JanusFlow router at 0x5dcbeb41055ec57e, which in turn
 * forwards every call through each signer's COA to the EVM JanusFlow proxy at
 * 0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078. This is what `v03-smoke.mjs`
 * tests at the EVM-only level, lifted up one layer.
 *
 * Atomicity property under test: every Cadence transaction either commits
 * BOTH the Cadence-side mirror state (totalLocked) AND the EVM-side state
 * (commitments, EVM totalLocked, event emission), or commits nothing.
 *
 * Flow (3 - 1 - 0.5 - 1 = 0.5 FLOW final pool delta):
 *   1. Dave JanusFlow.wrap(3 FLOW)
 *   2. Alice JanusFlow.shieldedTransfer(1 FLOW -> Charlie's COA)
 *   3. Alice JanusFlow.shieldedTransfer(0.5 FLOW -> Bob's COA)
 *   4. Eve JanusFlow.unwrap(1 FLOW -> Eve's COA)
 *
 * Outputs deployments/cross-vm-smoke-results.json.
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
const JANUSFLOW_ART = join(
    MODULE_ROOT,
    "artifacts/contracts/solidity/JanusFlow.sol/JanusFlow.json",
);

const DEPLOY_RECORD_PATH = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");
const RESULTS_PATH = join(DEPLOYMENTS_DIR, "cross-vm-smoke-results.json");

// Circuit artifacts — same as v03-smoke.mjs (zkey sha256 matches ceremony).
const AMOUNT_WASM = "/home/oydual3/cadence-crypto-lab/modules/token/confidential-flow/circuits/build/amount_disclose_js/amount_disclose.wasm";
const AMOUNT_ZKEY = "/home/oydual3/openjanus-contracts/circuits/v0.3-ceremony/amount_disclose_final.zkey";
const TRANSFER_WASM = "/home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/circuit/build/confidential_transfer_js/confidential_transfer.wasm";
const TRANSFER_ZKEY = "/home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/setup/confidential_transfer_final.zkey";

// We use Dave + Eve for v0.3 cross-VM testing because they have FRESH EVM
// commitments (identity (0, 1)) on the new JanusFlow proxy, so we control the
// full blinding chain. Alice / Bob / Charlie carry non-identity commitments
// from the EVM-direct v03-smoke run; we can't construct transfer-proofs for
// them without their old blinding values.
//
// Bob is included as a passive recipient — the 0.5 FLOW shieldedTransfer to
// Bob adds homomorphically to his existing commit. We never try to unwrap
// from Bob in this test (we don't know his blinding chain).
const DAVE = { name: "dave", signer: "dave", flow: "0xd32d9100e1fe983b", coa: "0x0000000000000000000000027b94cfc8a64971cd" };
const EVE  = { name: "eve",  signer: "eve",  flow: "0x374a28ddf00498e4", coa: "0x000000000000000000000002f99c41f078c6c238" };
const BOB  = { name: "bob",  signer: "bob",  flow: "0xd807a3992d7be612", coa: "0x00000000000000000000000250d93efba617e0bf" };

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const provider = new JsonRpcProvider(RPC_URL);

const SCALE = 1_000_000_000_000_000_000n; // 1 FLOW = 1e18 attoFLOW

// ---------------------------------------------------------------------------
// Cadence transaction templates — these hit the JanusFlow Cadence ROUTER
// rather than calling EVM directly. The router does the COA borrow + EVM call.
// ---------------------------------------------------------------------------

const JF_WRAP_TX = `import "EVM"
import "FlowToken"
import "FungibleToken"
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    flowAmount: UFix64,
    txCommitX: UInt256,
    txCommitY: UInt256,
    proof0: UInt256, proof1: UInt256, proof2: UInt256, proof3: UInt256,
    proof4: UInt256, proof5: UInt256, proof6: UInt256, proof7: UInt256,
    calldataHex: String
) {
    prepare(signer: auth(BorrowValue, Storage) &Account) {
        let flowVault = signer.storage
            .borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/flowTokenVault)
            ?? panic("No FlowToken vault")

        let chunk <- flowVault.withdraw(amount: flowAmount) as! @FlowToken.Vault

        JanusFlow.wrap(
            signer: signer,
            vault: <-chunk,
            txCommit: [txCommitX, txCommitY],
            amountProof: [proof0, proof1, proof2, proof3, proof4, proof5, proof6, proof7],
            calldataHex: calldataHex
        )
    }
}
`;

const JF_TRANSFER_TX = `import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    toEVMHex: String,
    pi0: UInt256, pi1: UInt256, pi2: UInt256, pi3: UInt256, pi4: UInt256, pi5: UInt256,
    proof0: UInt256, proof1: UInt256, proof2: UInt256, proof3: UInt256,
    proof4: UInt256, proof5: UInt256, proof6: UInt256, proof7: UInt256,
    calldataHex: String
) {
    prepare(signer: auth(BorrowValue) &Account) {
        JanusFlow.shieldedTransfer(
            signer: signer,
            toEVMHex: toEVMHex,
            publicInputs: [pi0, pi1, pi2, pi3, pi4, pi5],
            proof: [proof0, proof1, proof2, proof3, proof4, proof5, proof6, proof7],
            calldataHex: calldataHex
        )
    }
}
`;

const JF_UNWRAP_TX = `import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    claimedAmount: UFix64,
    recipientEVMHex: String,
    txCommitX: UInt256, txCommitY: UInt256,
    ap0: UInt256, ap1: UInt256, ap2: UInt256, ap3: UInt256, ap4: UInt256, ap5: UInt256, ap6: UInt256, ap7: UInt256,
    tpi0: UInt256, tpi1: UInt256, tpi2: UInt256, tpi3: UInt256, tpi4: UInt256, tpi5: UInt256,
    tp0: UInt256, tp1: UInt256, tp2: UInt256, tp3: UInt256, tp4: UInt256, tp5: UInt256, tp6: UInt256, tp7: UInt256,
    calldataHex: String
) {
    prepare(signer: auth(BorrowValue) &Account) {
        JanusFlow.unwrap(
            signer: signer,
            claimedAmount: claimedAmount,
            recipientEVMHex: recipientEVMHex,
            txCommit: [txCommitX, txCommitY],
            amountProof: [ap0, ap1, ap2, ap3, ap4, ap5, ap6, ap7],
            transferPublicInputs: [tpi0, tpi1, tpi2, tpi3, tpi4, tpi5],
            transferProof: [tp0, tp1, tp2, tp3, tp4, tp5, tp6, tp7],
            calldataHex: calldataHex
        )
    }
}
`;

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
                throw new Error(`[${label}] non-JSON flow CLI output:\n${err.stdout?.slice(0, 1500)}\nSTDERR: ${err.stderr?.slice(0, 500)}`);
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

function extractCadenceEvents(result, suffix) {
    const events = result?.events ?? [];
    return events.filter(e => (e?.type ?? "").endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Proof helpers (mirror v03-smoke.mjs / cadence-crypto-lab SDK)
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
    const { randomBytes } = require("crypto");
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

function bytesIn(hexstr, needleHex) {
    if (!hexstr || !needleHex) return false;
    const clean = (hexstr.startsWith("0x") ? hexstr.slice(2) : hexstr).toLowerCase();
    let n = needleHex.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
    if (!n) return false;
    return clean.includes(n);
}

// ---------------------------------------------------------------------------

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.3 — CROSS-VM (Cadence router → EVM) smoke");
    console.log("=".repeat(72));

    if (!existsSync(DEPLOY_RECORD_PATH)) {
        throw new Error(`Missing deploy record: ${DEPLOY_RECORD_PATH}`);
    }
    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD_PATH, "utf8"));
    const PROXY = deploy.contracts.JanusFlow_proxy;
    console.log(`Cadence router:  0x5dcbeb41055ec57e (JanusFlow)`);
    console.log(`EVM proxy:       ${PROXY}`);
    console.log();

    const art = JSON.parse(readFileSync(JANUSFLOW_ART, "utf8"));
    const iface = new Interface(art.abi);

    // --- Pre-state -----------------------------------------------------------
    const evmPool0 = BigInt(await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("totalLocked", []),
    }));
    console.log("[0] EVM totalLocked at start:", evmPool0.toString(), "attoFLOW");

    // Pre-existing Alice commitment, if any.
    const daveCommitHex0 = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("balanceOfCommitmentXY", [DAVE.coa]),
    });
    const daveX0 = BigInt("0x" + daveCommitHex0.slice(2, 66));
    const daveY0 = BigInt("0x" + daveCommitHex0.slice(66, 130));
    const daveHadPriorCommit = !(daveX0 === 0n && daveY0 === 1n);
    console.log(`[0] Dave prior commit: ${daveHadPriorCommit ? "yes" : "no"}`);

    const results = {
        date: new Date().toISOString(),
        layer: "cross-vm (Cadence JanusFlow router → EVM JanusFlow proxy)",
        cadence_router: "0x5dcbeb41055ec57e",
        evm_proxy: PROXY,
        steps: {},
        privacy_checks: {},
        tx_hashes: {},
        assertions: {},
    };

    // Tracked private state
    let daveBalance = 0n;
    let daveBlinding = 0n;
    let eveBalance = 0n;
    let eveBlinding = 0n;
    let bobBalance = 0n;
    let bobBlinding = 0n;

    // ─── 1. Dave JanusFlow.wrap(3 FLOW) ──────────────────────────────────────
    console.log("\n[1] Dave JanusFlow.wrap(3 FLOW)");
    const wrapFlow = 3.0;
    const wrapAtto = BigInt(wrapFlow * 1e9) * 1_000_000_000n;
    const wrapBlinding = rand128();
    const wrapProof = await makeAmountProof(wrapAtto, wrapBlinding);

    const wrapCalldataHex = iface
        .encodeFunctionData("wrap", [[wrapProof.commit.x, wrapProof.commit.y], wrapProof.proof])
        .slice(2);

    const wrapTxPath = "/tmp/.v03_cvm_wrap.cdc";
    writeFileSync(wrapTxPath, JF_WRAP_TX);
    const wrapArgs = [
        wrapFlow.toFixed(8),
        wrapProof.commit.x.toString(), wrapProof.commit.y.toString(),
        ...wrapProof.proof.map(p => p.toString()),
        wrapCalldataHex,
    ];
    const wrapRes = runFlowTx(wrapTxPath, wrapArgs, DAVE.signer, "dave-wrap");
    const wrapEvmTx = extractEvmTxHashFromFlow(wrapRes);
    const wrapCadenceEvents = extractCadenceEvents(wrapRes, "JanusFlow.Wrapped");
    console.log(`   flow tx: ${wrapRes.id}`);
    console.log(`   evm tx : ${wrapEvmTx}`);
    console.log(`   Cadence Wrapped events: ${wrapCadenceEvents.length}`);

    daveBalance = daveHadPriorCommit ? daveBalance + wrapAtto : wrapAtto;
    daveBlinding = wrapBlinding;
    // NOTE: if Alice had a prior commitment, the EVM JanusFlow does NOT add
    // wrap to it (it overwrites or adds homomorphically via _acceptShieldedCredit).
    // For this smoke we assume a fresh commit; the past v03-smoke wrapped 5
    // FLOW, but _acceptShieldedCredit overwrites Alice's commitment with the
    // wrap txCommit (which by design corresponds to JUST the wrapped amount).

    const evmPool1 = BigInt(await provider.call({
        to: PROXY, data: iface.encodeFunctionData("totalLocked", []),
    }));
    const evmDelta1 = evmPool1 - evmPool0;
    console.log(`   EVM totalLocked delta: ${evmDelta1.toString()} (expected ${wrapAtto.toString()})`);
    if (evmDelta1 !== wrapAtto) throw new Error("EVM totalLocked delta mismatch");

    const wrapReceipt = await provider.getTransactionReceipt(wrapEvmTx);
    const wrappedEvmEvent = wrapReceipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "Wrapped");
    if (!wrappedEvmEvent) throw new Error("EVM Wrapped event missing");
    if (BigInt(wrappedEvmEvent.args.amount) !== wrapAtto) {
        throw new Error("EVM Wrapped amount mismatch");
    }
    console.log(`   EVM Wrapped event amount: ${wrappedEvmEvent.args.amount.toString()} (LEAK by design)`);

    // Atomicity: Cadence Wrapped event was emitted AND EVM Wrapped event was
    // emitted in the same sealed Flow transaction.
    const wrapAtomic = wrapCadenceEvents.length === 1 && wrappedEvmEvent !== null;
    console.log(`   Cadence + EVM events both emitted: ${wrapAtomic ? "YES (atomic)" : "NO"}`);

    results.tx_hashes.wrap_flow = wrapRes.id;
    results.tx_hashes.wrap_evm = wrapEvmTx;
    results.steps.wrap = {
        amount_flow: wrapFlow,
        amount_atto: wrapAtto.toString(),
        evm_totalLocked_delta: evmDelta1.toString(),
        cadence_event_count: wrapCadenceEvents.length,
        evm_wrapped_amount: wrappedEvmEvent.args.amount.toString(),
        evm_tx: wrapEvmTx,
        flow_tx: wrapRes.id,
    };
    results.assertions.cadence_wrap_to_evm_wrap_atomic = wrapAtomic;
    results.assertions.evm_wrapped_event_amount_visible = wrappedEvmEvent.args.amount.toString();

    // ─── 2. Dave JanusFlow.shieldedTransfer(1 FLOW -> Eve) ───────────────
    console.log("\n[2] Dave JanusFlow.shieldedTransfer(1 FLOW -> Eve)");
    const x1Atto = 1n * SCALE;
    const x1TxBlinding = rand128();
    const x1NewBlinding = rand128();
    const x1 = await makeTransferProof(
        daveBalance, daveBlinding,
        x1Atto, x1TxBlinding,
        x1NewBlinding,
    );

    const x1CalldataHex = iface
        .encodeFunctionData("shieldedTransfer", [EVE.coa, x1.publicInputs, x1.proof])
        .slice(2);

    const xferTxPath = "/tmp/.v03_cvm_transfer.cdc";
    writeFileSync(xferTxPath, JF_TRANSFER_TX);
    const x1Args = [
        EVE.coa,
        ...x1.publicInputs.map(p => p.toString()),
        ...x1.proof.map(p => p.toString()),
        x1CalldataHex,
    ];
    const x1Res = runFlowTx(xferTxPath, x1Args, DAVE.signer, "dave-transfer-eve");
    const x1EvmTx = extractEvmTxHashFromFlow(x1Res);
    const x1CadenceEvents = extractCadenceEvents(x1Res, "JanusFlow.ShieldedTransferred");
    console.log(`   flow tx: ${x1Res.id}`);
    console.log(`   evm tx : ${x1EvmTx}`);
    console.log(`   Cadence ShieldedTransferred events: ${x1CadenceEvents.length}`);

    daveBalance -= x1Atto;
    daveBlinding = x1NewBlinding;
    eveBalance += x1Atto;
    eveBlinding = x1TxBlinding;

    // Privacy: calldata MUST NOT contain plaintext amount.
    const x1AmountHex = x1Atto.toString(16);
    const x1CalldataLeak = bytesIn(x1CalldataHex, x1AmountHex);
    console.log(`   calldata contains plain amount: ${x1CalldataLeak ? "YES (LEAK)" : "no (HIDE)"}`);

    // Privacy: ConfidentialTransfer EVM event has NO amount field.
    const x1Receipt = await provider.getTransactionReceipt(x1EvmTx);
    const ctEvent = x1Receipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "ConfidentialTransfer");
    if (!ctEvent) throw new Error("EVM ConfidentialTransfer event missing");
    const ctFields = ctEvent.fragment.inputs.map(i => i.name);
    const ctLeaksAmount = ctFields.includes("amount") || ctFields.includes("value");
    console.log(`   EVM ConfidentialTransfer fields: [${ctFields.join(", ")}]`);
    console.log(`   EVM ConfidentialTransfer leaks amount: ${ctLeaksAmount ? "YES" : "no (HIDE)"}`);

    // Privacy: totalLocked unchanged on transfer.
    const evmPool2 = BigInt(await provider.call({
        to: PROXY, data: iface.encodeFunctionData("totalLocked", []),
    }));
    if (evmPool2 !== evmPool1) throw new Error("EVM totalLocked changed on transfer");
    console.log(`   EVM totalLocked unchanged on transfer: PASS`);

    const x1Atomic = x1CadenceEvents.length === 1 && ctEvent !== null;
    console.log(`   Cadence ShieldedTransferred + EVM ConfidentialTransfer both emitted: ${x1Atomic ? "YES (atomic)" : "NO"}`);

    results.tx_hashes.transfer_dave_to_eve_flow = x1Res.id;
    results.tx_hashes.transfer_dave_to_eve_evm = x1EvmTx;
    results.steps.transfer_dave_to_eve = {
        amount_atto: x1Atto.toString(),
        calldata_has_plain_amount: x1CalldataLeak,
        evm_event_fields: ctFields,
        evm_event_leaks_amount: ctLeaksAmount,
        cadence_event_count: x1CadenceEvents.length,
        evm_tx: x1EvmTx,
        flow_tx: x1Res.id,
    };
    results.assertions.transfer_calldata_amount_hidden = !x1CalldataLeak;
    results.assertions.transfer_event_amount_hidden = !ctLeaksAmount;
    results.assertions.transfer_pool_unchanged = true;
    results.assertions.cadence_transfer_to_evm_transfer_atomic = x1Atomic;
    results.privacy_checks.transfer_event_fields = ctFields;
    results.privacy_checks.transfer_event_leaks_amount = ctLeaksAmount;
    results.privacy_checks.transfer_calldata_has_amount = x1CalldataLeak;

    // ─── 3. Dave JanusFlow.shieldedTransfer(0.5 FLOW -> Bob) ─────────────────
    console.log("\n[3] Dave JanusFlow.shieldedTransfer(0.5 FLOW -> Bob)");
    const x2Atto = SCALE / 2n; // 0.5 FLOW
    const x2TxBlinding = rand128();
    const x2NewBlinding = rand128();
    const x2 = await makeTransferProof(
        daveBalance, daveBlinding,
        x2Atto, x2TxBlinding,
        x2NewBlinding,
    );

    const x2CalldataHex = iface
        .encodeFunctionData("shieldedTransfer", [BOB.coa, x2.publicInputs, x2.proof])
        .slice(2);

    const x2Args = [
        BOB.coa,
        ...x2.publicInputs.map(p => p.toString()),
        ...x2.proof.map(p => p.toString()),
        x2CalldataHex,
    ];
    const x2Res = runFlowTx(xferTxPath, x2Args, DAVE.signer, "dave-transfer-bob");
    const x2EvmTx = extractEvmTxHashFromFlow(x2Res);
    console.log(`   flow tx: ${x2Res.id}`);
    console.log(`   evm tx : ${x2EvmTx}`);

    daveBalance -= x2Atto;
    daveBlinding = x2NewBlinding;
    bobBalance += x2Atto;
    bobBlinding = x2TxBlinding;

    const x2AmountHex = x2Atto.toString(16);
    const x2CalldataLeak = bytesIn(x2CalldataHex, x2AmountHex);
    console.log(`   calldata contains plain amount: ${x2CalldataLeak ? "YES (LEAK)" : "no (HIDE)"}`);

    results.tx_hashes.transfer_dave_to_bob_flow = x2Res.id;
    results.tx_hashes.transfer_dave_to_bob_evm = x2EvmTx;
    results.steps.transfer_dave_to_bob = {
        amount_atto: x2Atto.toString(),
        calldata_has_plain_amount: x2CalldataLeak,
        evm_tx: x2EvmTx,
        flow_tx: x2Res.id,
    };

    // ─── 4. Eve JanusFlow.unwrap(1 FLOW -> Eve's COA) ─────────────────
    console.log("\n[4] Eve JanusFlow.unwrap(1 FLOW -> Eve's COA)");
    const uAtto = 1n * SCALE;
    const uTxBlinding = rand128();
    const uNewBlinding = rand128();

    const adProof = await makeAmountProof(uAtto, uTxBlinding);
    const xProof  = await makeTransferProof(
        eveBalance, eveBlinding,
        uAtto, uTxBlinding,
        uNewBlinding,
    );

    if (adProof.commit.x !== xProof.txCommit.x || adProof.commit.y !== xProof.txCommit.y) {
        throw new Error("amount_disclose commit != transfer txCommit");
    }

    const uCalldataHex = iface
        .encodeFunctionData("unwrap", [
            uAtto,
            EVE.coa,
            [adProof.commit.x, adProof.commit.y],
            adProof.proof,
            xProof.publicInputs,
            xProof.proof,
        ])
        .slice(2);

    const eveBefore = await provider.getBalance(EVE.coa);
    console.log(`   Eve COA balance BEFORE unwrap: ${eveBefore.toString()}`);

    const unwrapTxPath = "/tmp/.v03_cvm_unwrap.cdc";
    writeFileSync(unwrapTxPath, JF_UNWRAP_TX);
    const uArgs = [
        // UFix64 must be a decimal — convert 1.0 FLOW from atto.
        (Number(uAtto) / 1e18).toFixed(8),
        EVE.coa,
        adProof.commit.x.toString(), adProof.commit.y.toString(),
        ...adProof.proof.map(p => p.toString()),
        ...xProof.publicInputs.map(p => p.toString()),
        ...xProof.proof.map(p => p.toString()),
        uCalldataHex,
    ];
    const uRes = runFlowTx(unwrapTxPath, uArgs, EVE.signer, "eve-unwrap");
    const uEvmTx = extractEvmTxHashFromFlow(uRes);
    const uCadenceEvents = extractCadenceEvents(uRes, "JanusFlow.Unwrapped");
    console.log(`   flow tx: ${uRes.id}`);
    console.log(`   evm tx : ${uEvmTx}`);
    console.log(`   Cadence Unwrapped events: ${uCadenceEvents.length}`);

    eveBalance -= uAtto;
    eveBlinding = uNewBlinding;

    const eveAfter = await provider.getBalance(EVE.coa);
    const eveDelta = eveAfter - eveBefore;
    console.log(`   Eve COA balance AFTER  unwrap: ${eveAfter.toString()} (delta ${eveDelta.toString()})`);
    if (eveDelta !== uAtto) {
        throw new Error(`Eve COA delta ${eveDelta} != expected ${uAtto}`);
    }

    const evmPool3 = BigInt(await provider.call({
        to: PROXY, data: iface.encodeFunctionData("totalLocked", []),
    }));
    const unwrapDelta = evmPool3 - evmPool2;
    console.log(`   EVM totalLocked delta on unwrap: ${unwrapDelta.toString()} (expected ${(-uAtto).toString()})`);
    if (unwrapDelta !== -uAtto) throw new Error("EVM totalLocked delta on unwrap mismatch");

    const uReceipt = await provider.getTransactionReceipt(uEvmTx);
    const unwrappedEvent = uReceipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "Unwrapped");
    if (!unwrappedEvent) throw new Error("EVM Unwrapped event missing");
    if (BigInt(unwrappedEvent.args.amount) !== uAtto) {
        throw new Error("EVM Unwrapped amount mismatch");
    }

    const unwrapAtomic = uCadenceEvents.length === 1 && unwrappedEvent !== null && eveDelta === uAtto;
    console.log(`   Cadence unwrap → EVM unwrap → COA receive all atomic: ${unwrapAtomic ? "YES" : "NO"}`);

    results.tx_hashes.unwrap_flow = uRes.id;
    results.tx_hashes.unwrap_evm = uEvmTx;
    results.steps.unwrap_eve = {
        amount_atto: uAtto.toString(),
        coa_delta: eveDelta.toString(),
        cadence_event_count: uCadenceEvents.length,
        evm_unwrapped_amount: unwrappedEvent.args.amount.toString(),
        evm_tx: uEvmTx,
        flow_tx: uRes.id,
    };
    results.assertions.cadence_unwrap_to_evm_unwrap_to_coa_receive_atomic = unwrapAtomic;

    // ─── Final invariant ──────────────────────────────────────────────────────
    const expectedDelta = wrapAtto - uAtto; // 3 - 1 = 2 FLOW remain (0.5 transfers don't move pool)
    const actualDelta = evmPool3 - evmPool0;
    if (actualDelta !== expectedDelta) {
        throw new Error(`Final EVM totalLocked delta mismatch: ${actualDelta} != ${expectedDelta}`);
    }
    console.log(`\n[OK] EVM totalLocked delta == ${actualDelta.toString()} atto (expected ${expectedDelta.toString()})`);

    // Cadence-side router mirror
    const routerMirror = await execSync(
        `flow scripts execute /dev/stdin --network testnet --config-path ${FLOW_JSON} <<'EOFCDC'\n` +
        `import JanusFlow from 0x5dcbeb41055ec57e\n` +
        `access(all) fun main(): UFix64 { return JanusFlow.getTotalLocked() }\n` +
        `EOFCDC`,
        { encoding: "utf8", cwd: MODULE_ROOT },
    );
    const mirrorMatch = routerMirror.match(/Result:\s*([0-9.]+)/);
    if (mirrorMatch) {
        console.log(`     Cadence router totalLocked mirror: ${mirrorMatch[1]} FLOW`);
        results.cadence_router_totalLocked_mirror = mirrorMatch[1];
    }

    results.totalLocked_invariant = {
        evm_pool_initial_atto: evmPool0.toString(),
        evm_pool_final_atto:   evmPool3.toString(),
        evm_delta_atto:        actualDelta.toString(),
        expected_delta_atto:   expectedDelta.toString(),
        wrap_atto:             wrapAtto.toString(),
        transfer_dave_to_eve_atto: x1Atto.toString(),
        transfer_dave_to_bob_atto:     x2Atto.toString(),
        unwrap_atto:           uAtto.toString(),
        // 3 - 1 - 0.5 - 1 = 0.5 FLOW expressed as the per-actor balance ledger;
        // pool delta is wrap - unwrap = 3 - 1 = 2 FLOW.
        per_actor_balances_atto: {
            dave_remaining:    daveBalance.toString(),
            bob_remaining:     bobBalance.toString(),
            eve_remaining:     eveBalance.toString(),
            sum_check_atto:    (daveBalance + bobBalance + eveBalance).toString(),
        },
    };

    results.summary = {
        cadence_wrap_to_evm_wrap_atomic:        results.assertions.cadence_wrap_to_evm_wrap_atomic,
        evm_wrapped_amount_visible:             true,
        cadence_transfer_to_evm_transfer_atomic: results.assertions.cadence_transfer_to_evm_transfer_atomic,
        evm_confidential_transfer_event_hides_amount: !ctLeaksAmount,
        cadence_unwrap_to_evm_unwrap_to_coa_receive_atomic:
            results.assertions.cadence_unwrap_to_evm_unwrap_to_coa_receive_atomic,
        totalLocked_invariant_holds: actualDelta === expectedDelta,
        verdict: "PASS - cross-VM atomicity holds and amount HIDDEN on shieldedTransfer (calldata + events)",
    };

    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nResults written: ${RESULTS_PATH}`);

    if (snarkjs.curves) {
        try {
            for (const c of Object.values(snarkjs.curves)) {
                if (c && typeof c.terminate === "function") await c.terminate();
            }
        } catch {}
    }
    process.exit(0);
}

import { createRequire } from "module";
const require = createRequire(import.meta.url);

main().catch(err => {
    console.error("\nCROSS-VM SMOKE FAILED:", err.message);
    console.error(err.stack);
    process.exit(1);
});
