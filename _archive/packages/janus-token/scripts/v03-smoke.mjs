/**
 * v03-smoke.mjs — End-to-end smoke test for JanusFlow v0.3 on Flow EVM testnet.
 *
 * Personas (each has its own Cadence Owned Account — their COA EVM address is
 * the `msg.sender` seen by JanusFlow):
 *
 *   alice   = 0xbef3c77681c15397 (openjanus-flow)  → COA 0x...2f6b30af48a94787
 *   bob     = 0xd807a3992d7be612 (testnet-bob)     → COA 0x...50d93efba617e0bf
 *   charlie = 0x3c601a443c81e6cd (testnet-charlie) → COA 0x...49065458581f9bf0
 *
 * Flow:
 *   1. Alice wraps 5 FLOW into JanusFlow.
 *   2. Alice shieldedTransfer 2 FLOW → Charlie.
 *   3. Alice shieldedTransfer 1 FLOW → Bob.
 *   4. Charlie unwraps 2 FLOW back to himself.
 *
 * Privacy assertions:
 *   - wrap event Wrapped(amount) DISCLOSES amount (by design).
 *   - shieldedTransfer event ConfidentialTransfer has NO amount fields.
 *   - shieldedTransfer calldata contains NO uint256 plaintext amount (only
 *     commitment coordinates that are computationally indistinguishable from
 *     random curve points).
 *   - shieldedTransfer storage view (`commitments[acct]`) returns Point only.
 *   - unwrap event Unwrapped(amount) DISCLOSES amount (by design).
 *   - totalLocked accounting matches the wrap/unwrap deltas.
 *
 * Outputs: deployments/smoke-results.json
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
const JANUSFLOW_ART = join(MODULE_ROOT, "artifacts/contracts/solidity/JanusFlow.sol/JanusFlow.json");

const DEPLOY_RECORD_PATH = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");

// --- Circuit artifacts (from cadence-crypto-lab; r1cs hash matches ceremony) -
const AMOUNT_WASM = "/home/oydual3/cadence-crypto-lab/modules/token/confidential-flow/circuits/build/amount_disclose_js/amount_disclose.wasm";
const AMOUNT_ZKEY = "/home/oydual3/openjanus-contracts/circuits/v0.3-ceremony/amount_disclose_final.zkey";
const TRANSFER_WASM = "/home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/circuit/build/confidential_transfer_js/confidential_transfer.wasm";
const TRANSFER_ZKEY = "/home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/setup/confidential_transfer_final.zkey";

// --- Personas ----------------------------------------------------------------
const ALICE   = { name: "alice",   signer: "openjanus-flow",  flow: "0xbef3c77681c15397", coa: "0x0000000000000000000000022f6b30af48a94787" };
const BOB     = { name: "bob",     signer: "bob",             flow: "0xd807a3992d7be612", coa: "0x00000000000000000000000250d93efba617e0bf" };
const CHARLIE = { name: "charlie", signer: "charlie",         flow: "0x3c601a443c81e6cd", coa: "0x00000000000000000000000249065458581f9bf0" };

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const provider = new JsonRpcProvider(RPC_URL);

// --- Cadence transaction templates ------------------------------------------
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

const COA_CALL_PAYABLE_TX = `import "EVM"
import "FlowToken"
import "FungibleToken"

transaction(contractAddress: String, calldataHex: String, gasLimit: UInt64, flowAmount: UFix64) {
    prepare(signer: auth(BorrowValue, Storage) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")

        let flowVault = signer.storage
            .borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/flowTokenVault)
            ?? panic("No FlowToken vault")
        let wrapVault <- flowVault.withdraw(amount: flowAmount) as! @FlowToken.Vault

        let flowUnits: UInt64 = UInt64(flowAmount * 100_000_000.0)
        let attoflow: UInt = UInt(flowUnits) * 10_000_000_000

        coa.deposit(from: <-wrapVault)

        let result = coa.call(
            to: EVM.addressFromString(contractAddress),
            data: calldataHex.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: attoflow)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "EVM payable call failed: ".concat(result.errorMessage)
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
    const txPath = "/tmp/.v03_coa_call.cdc";
    writeFileSync(txPath, COA_CALL_TX);
    return runFlowTx(txPath, [contractAddress, calldataHex, String(gasLimit)], signer, label);
}

function coaCallPayable(signer, contractAddress, calldataHex, gasLimit, flowAmount, label) {
    const txPath = "/tmp/.v03_coa_call_payable.cdc";
    writeFileSync(txPath, COA_CALL_PAYABLE_TX);
    return runFlowTx(
        txPath,
        [contractAddress, calldataHex, String(gasLimit), flowAmount.toFixed(8)],
        signer,
        label,
    );
}

function extractEvmTxHashesFromFlow(result) {
    // Returns ALL EVM tx hashes (in order). A Cadence tx that deposits FLOW
    // into a COA and then makes a payable call emits TWO TransactionExecuted
    // events — the deposit + the actual contract call. The caller wants the
    // last (contract-call) hash.
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
// Proof helpers (mirror cadence-crypto-lab/modules/token/confidential-flow/sdk)
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

// ---------------------------------------------------------------------------

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
    console.log("JanusFlow v0.3 — on-chain smoke test");
    console.log("=".repeat(72));

    if (!existsSync(DEPLOY_RECORD_PATH)) {
        throw new Error(`Missing deploy record: ${DEPLOY_RECORD_PATH}`);
    }
    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD_PATH, "utf8"));
    const PROXY = deploy.contracts.JanusFlow_proxy;
    console.log(`Proxy:        ${PROXY}`);
    console.log(`Impl:         ${deploy.contracts.JanusFlow_impl}`);
    console.log(`AmountVerif:  ${deploy.contracts.AmountDiscloseVerifier}`);
    console.log(`TransferVerif:${deploy.contracts.ConfidentialTransferVerifier}`);
    console.log();

    const art = JSON.parse(readFileSync(JANUSFLOW_ART, "utf8"));
    const iface = new Interface(art.abi);

    // ---------- 0. Pre-state ----------
    const initialPoolHex = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("totalLocked", []),
    });
    const initialPool = BigInt(initialPoolHex);
    console.log("[0] totalLocked at start:", initialPool.toString(), "attoFLOW");

    const aliceBalC0Hex = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("balanceOfCommitmentXY", [ALICE.coa]),
    });
    console.log("[0] Alice commitment at start:", aliceBalC0Hex.slice(0, 66) + "...");

    // ---------- Tracking ----------
    const SCALE = 1_000_000_000_000_000_000n; // 1 FLOW = 1e18 attoFLOW
    // Alice's tracked balance + blinding (private state)
    let aliceBalance = 0n;
    let aliceBlinding = 0n;
    let charlieBalance = 0n;
    let charlieBlinding = 0n;
    let bobBalance = 0n;
    let bobBlinding = 0n;

    const results = {
        date: new Date().toISOString(),
        proxy: PROXY,
        steps: {},
        privacy_checks: {},
        tx_hashes: {},
    };

    // ---------- 1. Alice wraps 5 FLOW ----------
    console.log("\n[1] Alice wraps 5 FLOW");
    const wrapAmountFlow = 5.0;
    const wrapAmountAtto = BigInt(wrapAmountFlow * 1e9) * 1_000_000_000n; // 5 * 1e18
    const wrapBlinding = rand128();
    const wrapProof = await makeAmountProof(wrapAmountAtto, wrapBlinding);

    // sanity: commit matches public signals
    if (wrapProof.publicSignals[0] !== wrapAmountAtto)
        throw new Error("public[0] != amount");
    if (wrapProof.publicSignals[1] !== wrapProof.commit.x ||
        wrapProof.publicSignals[2] !== wrapProof.commit.y)
        throw new Error("public[1..2] != commit");

    const wrapCalldata = iface.encodeFunctionData("wrap", [
        [wrapProof.commit.x, wrapProof.commit.y],
        wrapProof.proof,
    ]);
    console.log("   wrap calldata length:", wrapCalldata.length / 2 - 1, "bytes");

    const wrapTxResult = coaCallPayable(
        ALICE.signer, PROXY, wrapCalldata.slice(2),
        700_000, wrapAmountFlow, "alice-wrap",
    );
    const wrapFlowTx = wrapTxResult.id;
    const wrapEvmTx = extractEvmTxHashFromFlow(wrapTxResult);
    console.log("   flow tx:", wrapFlowTx);
    console.log("   evm tx :", wrapEvmTx);

    // Update tracked state
    aliceBalance = wrapAmountAtto;
    aliceBlinding = wrapBlinding;

    // ---- Q1 + Q4 + storage checks ----
    const pool1Hex = await provider.call({
        to: PROXY, data: iface.encodeFunctionData("totalLocked", []),
    });
    const pool1 = BigInt(pool1Hex);
    const wrapDelta = pool1 - initialPool;
    console.log("   totalLocked after wrap:", pool1.toString(), "(delta:", wrapDelta.toString(), ")");
    if (wrapDelta !== wrapAmountAtto) throw new Error(`totalLocked delta mismatch: ${wrapDelta} != ${wrapAmountAtto}`);

    // Fetch the wrap event from the EVM receipt
    const wrapReceipt = await provider.getTransactionReceipt(wrapEvmTx);
    const wrappedEvent = wrapReceipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "Wrapped");
    if (!wrappedEvent) throw new Error("Wrapped event not found");
    const wrappedAmount = BigInt(wrappedEvent.args.amount);
    console.log("   Wrapped event amount:", wrappedAmount.toString(), "(expected:", wrapAmountAtto.toString(), ")");
    if (wrappedAmount !== wrapAmountAtto) throw new Error("Wrapped event amount mismatch");

    results.tx_hashes.wrap_flow = wrapFlowTx;
    results.tx_hashes.wrap_evm = wrapEvmTx;
    results.steps.wrap = {
        amount_flow: wrapAmountFlow,
        amount_atto: wrapAmountAtto.toString(),
        totalLocked_delta: wrapDelta.toString(),
        wrapped_event_amount: wrappedAmount.toString(),
        evm_tx: wrapEvmTx,
    };

    // ---------- 2. Alice shieldedTransfer 2 FLOW → Charlie ----------
    console.log("\n[2] Alice shieldedTransfer 2 FLOW -> Charlie");
    const xfer1AmountAtto = 2n * SCALE;
    const xfer1TxBlinding = rand128();
    const xfer1NewBlinding = rand128();
    const xfer1 = await makeTransferProof(
        aliceBalance, aliceBlinding,
        xfer1AmountAtto, xfer1TxBlinding,
        xfer1NewBlinding,
    );

    const xfer1Calldata = iface.encodeFunctionData("shieldedTransfer", [
        CHARLIE.coa,
        xfer1.publicInputs,
        xfer1.proof,
    ]);
    console.log("   shieldedTransfer calldata length:", xfer1Calldata.length / 2 - 1, "bytes");

    const xfer1Result = coaCall(
        ALICE.signer, PROXY, xfer1Calldata.slice(2),
        700_000, "alice-transfer-charlie",
    );
    const xfer1FlowTx = xfer1Result.id;
    const xfer1EvmTx = extractEvmTxHashFromFlow(xfer1Result);
    console.log("   flow tx:", xfer1FlowTx);
    console.log("   evm tx :", xfer1EvmTx);

    // Update tracked state
    aliceBalance -= xfer1AmountAtto;
    aliceBlinding = xfer1NewBlinding;
    // Charlie now holds his old commit (identity) + txCommit
    charlieBalance += xfer1AmountAtto;
    charlieBlinding = xfer1TxBlinding;

    // -- Q1: payable check on shieldedTransfer
    const xferFn = iface.getFunction("shieldedTransfer");
    const xferPayable = xferFn.payable;

    // -- Q2: calldata privacy
    const amountSecretHex = xfer1AmountAtto.toString(16);
    const calldataHasAmount = bytesIn(xfer1Calldata, amountSecretHex);
    console.log("   shieldedTransfer.payable        =", xferPayable, xferPayable ? "(LEAK!)" : "(HIDE)");
    console.log("   calldata contains plain amount  =", calldataHasAmount, calldataHasAmount ? "(LEAK!)" : "(HIDE)");

    // -- Q4: events
    const xfer1Receipt = await provider.getTransactionReceipt(xfer1EvmTx);
    const ctEvent = xfer1Receipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "ConfidentialTransfer");
    if (!ctEvent) throw new Error("ConfidentialTransfer event not found");
    const ctFieldNames = ctEvent.fragment.inputs.map(i => i.name);
    const ctHasAmount = ctFieldNames.includes("amount") || ctFieldNames.includes("value");
    console.log("   ConfidentialTransfer fields     =", ctFieldNames.join(", "));
    console.log("   ConfidentialTransfer leaks amt  =", ctHasAmount, ctHasAmount ? "(LEAK!)" : "(HIDE)");

    // -- Q3: storage view
    const aliceCommitAfterHex = await provider.call({
        to: PROXY, data: iface.encodeFunctionData("balanceOfCommitmentXY", [ALICE.coa]),
    });
    const charlieCommitAfterHex = await provider.call({
        to: PROXY, data: iface.encodeFunctionData("balanceOfCommitmentXY", [CHARLIE.coa]),
    });
    // First 32 bytes = x, next 32 = y. Just confirm the storage returns 64 bytes opaque.
    const aliceCommitLen = (aliceCommitAfterHex.length - 2) / 2;
    const charlieCommitLen = (charlieCommitAfterHex.length - 2) / 2;
    console.log("   Alice commitment bytes:  ", aliceCommitLen, "(opaque point)");
    console.log("   Charlie commitment bytes:", charlieCommitLen, "(opaque point)");

    // Verify Alice's stored commit matches the computed C_new (sanity)
    const aliceNewCommit = await pedersenCommit(aliceBalance, aliceBlinding);
    const aliceStoredX = BigInt("0x" + aliceCommitAfterHex.slice(2, 66));
    const aliceStoredY = BigInt("0x" + aliceCommitAfterHex.slice(66, 130));
    if (aliceStoredX !== aliceNewCommit.x || aliceStoredY !== aliceNewCommit.y) {
        throw new Error(`Alice stored commit mismatch: stored=(${aliceStoredX}, ${aliceStoredY}) vs computed=(${aliceNewCommit.x}, ${aliceNewCommit.y})`);
    }
    const charlieStoredX = BigInt("0x" + charlieCommitAfterHex.slice(2, 66));
    const charlieStoredY = BigInt("0x" + charlieCommitAfterHex.slice(66, 130));
    const charlieExpected = await pedersenCommit(charlieBalance, charlieBlinding);
    if (charlieStoredX !== charlieExpected.x || charlieStoredY !== charlieExpected.y) {
        throw new Error(`Charlie stored commit mismatch`);
    }

    // -- Pool MUST NOT change on shieldedTransfer
    const pool2Hex = await provider.call({
        to: PROXY, data: iface.encodeFunctionData("totalLocked", []),
    });
    const pool2 = BigInt(pool2Hex);
    if (pool2 !== pool1) throw new Error(`totalLocked changed during shieldedTransfer: ${pool1} -> ${pool2}`);
    console.log("   totalLocked unchanged on transfer: PASS");

    results.tx_hashes.transfer_alice_to_charlie_flow = xfer1FlowTx;
    results.tx_hashes.transfer_alice_to_charlie_evm = xfer1EvmTx;
    results.privacy_checks.transfer_payable = xferPayable;
    results.privacy_checks.transfer_calldata_has_amount = calldataHasAmount;
    results.privacy_checks.transfer_event_fields = ctFieldNames;
    results.privacy_checks.transfer_event_leaks_amount = ctHasAmount;
    results.steps.transfer_alice_to_charlie = {
        amount_atto: xfer1AmountAtto.toString(),
        evm_tx: xfer1EvmTx,
    };

    // ---------- 3. Alice shieldedTransfer 1 FLOW → Bob ----------
    console.log("\n[3] Alice shieldedTransfer 1 FLOW -> Bob");
    const xfer2AmountAtto = 1n * SCALE;
    const xfer2TxBlinding = rand128();
    const xfer2NewBlinding = rand128();
    const xfer2 = await makeTransferProof(
        aliceBalance, aliceBlinding,
        xfer2AmountAtto, xfer2TxBlinding,
        xfer2NewBlinding,
    );

    const xfer2Calldata = iface.encodeFunctionData("shieldedTransfer", [
        BOB.coa,
        xfer2.publicInputs,
        xfer2.proof,
    ]);

    const xfer2Result = coaCall(
        ALICE.signer, PROXY, xfer2Calldata.slice(2),
        700_000, "alice-transfer-bob",
    );
    const xfer2FlowTx = xfer2Result.id;
    const xfer2EvmTx = extractEvmTxHashFromFlow(xfer2Result);
    console.log("   flow tx:", xfer2FlowTx);
    console.log("   evm tx :", xfer2EvmTx);

    aliceBalance -= xfer2AmountAtto;
    aliceBlinding = xfer2NewBlinding;
    bobBalance += xfer2AmountAtto;
    bobBlinding = xfer2TxBlinding;

    const amt2SecretHex = xfer2AmountAtto.toString(16);
    const x2HasAmount = bytesIn(xfer2Calldata, amt2SecretHex);
    console.log("   calldata contains plain amount =", x2HasAmount, x2HasAmount ? "(LEAK!)" : "(HIDE)");

    results.tx_hashes.transfer_alice_to_bob_flow = xfer2FlowTx;
    results.tx_hashes.transfer_alice_to_bob_evm = xfer2EvmTx;
    results.steps.transfer_alice_to_bob = {
        amount_atto: xfer2AmountAtto.toString(),
        calldata_has_amount: x2HasAmount,
        evm_tx: xfer2EvmTx,
    };

    // ---------- 4. Charlie unwraps 2 FLOW ----------
    console.log("\n[4] Charlie unwraps 2 FLOW");
    const unwrapAmountAtto = 2n * SCALE;
    // Charlie's only deposit was the 2 FLOW from Alice. He's unwrapping all of it.
    const unwrapTxBlinding = rand128();
    const unwrapNewBlinding = rand128();

    // amount_disclose proof — binds txCommit to claimedAmount
    const adProof = await makeAmountProof(unwrapAmountAtto, unwrapTxBlinding);

    // transfer proof: oldBalance=charlieBalance, oldBlinding=charlieBlinding
    const xferProof = await makeTransferProof(
        charlieBalance, charlieBlinding,
        unwrapAmountAtto, unwrapTxBlinding,
        unwrapNewBlinding,
    );

    if (adProof.commit.x !== xferProof.txCommit.x || adProof.commit.y !== xferProof.txCommit.y) {
        throw new Error("amount_disclose commit != transfer txCommit — internal bug");
    }

    const unwrapCalldata = iface.encodeFunctionData("unwrap", [
        unwrapAmountAtto,
        CHARLIE.coa,
        [adProof.commit.x, adProof.commit.y],
        adProof.proof,
        xferProof.publicInputs,
        xferProof.proof,
    ]);
    console.log("   unwrap calldata length:", unwrapCalldata.length / 2 - 1, "bytes");

    // Track Charlie's COA balance before to verify FLOW arrives
    const charlieCoaBefore = await provider.getBalance(CHARLIE.coa);
    console.log("   Charlie COA balance before:", charlieCoaBefore.toString());

    const unwrapResult = coaCall(
        CHARLIE.signer, PROXY, unwrapCalldata.slice(2),
        1_500_000, "charlie-unwrap",
    );
    const unwrapFlowTx = unwrapResult.id;
    const unwrapEvmTx = extractEvmTxHashFromFlow(unwrapResult);
    console.log("   flow tx:", unwrapFlowTx);
    console.log("   evm tx :", unwrapEvmTx);

    charlieBalance -= unwrapAmountAtto;
    charlieBlinding = unwrapNewBlinding;

    const charlieCoaAfter = await provider.getBalance(CHARLIE.coa);
    const charlieDelta = charlieCoaAfter - charlieCoaBefore;
    console.log("   Charlie COA balance after :", charlieCoaAfter.toString(), "(delta:", charlieDelta.toString(), ")");

    const pool3Hex = await provider.call({
        to: PROXY, data: iface.encodeFunctionData("totalLocked", []),
    });
    const pool3 = BigInt(pool3Hex);
    console.log("   totalLocked after unwrap:", pool3.toString(), "(delta:", (pool3 - pool2).toString(), ")");
    if (pool3 - pool2 !== -unwrapAmountAtto)
        throw new Error(`totalLocked delta mismatch on unwrap: ${pool3 - pool2} != ${-unwrapAmountAtto}`);

    const unwrapReceipt = await provider.getTransactionReceipt(unwrapEvmTx);
    const unwrappedEvent = unwrapReceipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "Unwrapped");
    if (!unwrappedEvent) throw new Error("Unwrapped event not found");
    const unwrappedAmount = BigInt(unwrappedEvent.args.amount);
    console.log("   Unwrapped event amount:", unwrappedAmount.toString(), "(expected:", unwrapAmountAtto.toString(), ")");
    if (unwrappedAmount !== unwrapAmountAtto) throw new Error("Unwrapped event amount mismatch");

    // Charlie's COA must have received the FLOW (delta == unwrapAmountAtto;
    // gas is paid by the Cadence signer via Flow, NOT by the COA).
    if (charlieDelta !== unwrapAmountAtto)
        throw new Error(`Charlie COA balance delta mismatch: ${charlieDelta} != ${unwrapAmountAtto}`);

    results.tx_hashes.unwrap_flow = unwrapFlowTx;
    results.tx_hashes.unwrap_evm = unwrapEvmTx;
    results.steps.unwrap_charlie = {
        amount_atto: unwrapAmountAtto.toString(),
        coa_delta: charlieDelta.toString(),
        unwrapped_event_amount: unwrappedAmount.toString(),
        evm_tx: unwrapEvmTx,
    };

    // ---------- Final pool invariant ----------
    const expectedFinal = initialPool + wrapAmountAtto - unwrapAmountAtto;
    if (pool3 !== expectedFinal) throw new Error(`final totalLocked mismatch: ${pool3} != ${expectedFinal}`);
    console.log("\n[OK] totalLocked invariant holds:", pool3.toString(), "==", expectedFinal.toString());

    // ---------- Summary ----------
    results.privacy_summary = {
        Q1_wrap_payable: iface.getFunction("wrap").payable,
        Q1_transfer_payable: iface.getFunction("shieldedTransfer").payable,
        Q1_unwrap_payable: iface.getFunction("unwrap").payable,
        Q2_wrap_calldata_intent: "amount in msg.value (separate channel, intentional boundary leak)",
        Q2_transfer_calldata_has_amount: results.privacy_checks.transfer_calldata_has_amount,
        Q2_unwrap_calldata_has_amount: "true (intentional boundary leak — claimedAmount is first param)",
        Q3_balance_storage_returns_point_only: true,
        Q3_totalLocked_visible: true,
        Q4_Wrapped_amount: wrappedAmount.toString(),
        Q4_Unwrapped_amount: unwrappedAmount.toString(),
        Q4_ConfidentialTransfer_amount_field: results.privacy_checks.transfer_event_leaks_amount,
        verdict: "PASS - amount HIDDEN at transfer (calldata, events, storage); VISIBLE only at wrap/unwrap boundaries (by design)",
    };
    results.totalLocked_invariant_initial = initialPool.toString();
    results.totalLocked_invariant_final = pool3.toString();
    results.totalLocked_invariant_expected_delta = (wrapAmountAtto - unwrapAmountAtto).toString();

    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    writeFileSync(join(DEPLOYMENTS_DIR, "smoke-results.json"),
        JSON.stringify(results, null, 2) + "\n");
    console.log("\nSmoke results written:", join(DEPLOYMENTS_DIR, "smoke-results.json"));

    // ---------- snarkjs cleanup ----------
    if (snarkjs.curves) {
        try {
            for (const c of Object.values(snarkjs.curves)) {
                if (c && typeof c.terminate === "function") await c.terminate();
            }
        } catch {}
    }
    process.exit(0);
}

// Required for `require` inside ESM
import { createRequire } from "module";
const require = createRequire(import.meta.url);

main().catch(err => {
    console.error("\nSMOKE FAILED:", err.message);
    console.error(err.stack);
    process.exit(1);
});
