/**
 * smoke-aggregate.mjs — v0.7.0 aggregate commitment smoke test
 *
 * Flow EVM Testnet (chainId 545)
 *
 * Tests the deployed v0.7.0 JanusFlow stack on Flow EVM testnet:
 *
 *   Step 1 — Wrap probe:
 *     Wrap 1 FLOW into JanusFlow proxy (v0.7.0) using a real v0.5.1 amount-disclose proof.
 *     Confirms: wrap path functional, totalLocked increases, commitment stored.
 *
 *   Step 2 — ConfidentialTransferAggregateVerifier probe:
 *     Generate a real Groth16 proof (test zkey) for a 2-gen Pedersen transfer.
 *     Call verifyProof() on the deployed ConfidentialTransferAggregateVerifier via eth_call.
 *     Confirms: new verifier contract accepts valid aggregate proofs.
 *
 *   Step 3 — Pedersen2Gen library probe:
 *     Call addCommits() on the deployed Pedersen2Gen library via eth_call.
 *     Confirms: on-chain homomorphic addition works.
 *
 *   Step 4 — adminResetSlot:
 *     Reset admin COA slot back to identity (0,1).
 *     Cleans up testnet state.
 *
 * Architecture note: The deployed v0.7.0 JanusFlow retains the v0.5.1
 * AmountDiscloseVerifier for wrap. That verifier uses windowed-Pedersen
 * commitments, while shieldedTransfer uses 2-gen Pedersen. These schemes
 * are incompatible for a single-signer round-trip — a unified AmountDisclose
 * v2 circuit (proving 2-gen commitment) is required for the full production
 * wrap→transfer path. The full round-trip is covered by unit tests (mock
 * AmountDiscloseVerifier) in janus-flow-aggregate.test.cjs (27 tests pass).
 *
 * WARN: test zkey only (single-contributor). Production requires multi-party ceremony.
 *
 * Output: deployments/aggregate-testnet-smoke.json
 *
 * Run from packages/janus-token:
 *   node scripts/smoke-aggregate.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";
import * as snarkjs from "snarkjs";
import { buildPedersenHash, buildBabyjub } from "circomlibjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const REPO_ROOT   = join(MODULE_ROOT, "../..");
const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");

// ── Deployment record ─────────────────────────────────────────────────────────
const DEPLOY_RECORD = JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, "aggregate-testnet.json"), "utf8"));
const CONTRACTS = DEPLOY_RECORD.contracts;

const JANUSFLOW_PROXY   = CONTRACTS.JanusFlow_proxy;
const AGG_VERIFIER      = CONTRACTS.ConfidentialTransferAggregateVerifier;
const PEDERSEN2GEN      = CONTRACTS.Pedersen2Gen_library;
const AMT_VERIFIER      = CONTRACTS.AmountDiscloseVerifier;

// ── Admin account ─────────────────────────────────────────────────────────────
const ADMIN_CADENCE = "c4e8f99915893a2f";
const ADMIN_COA_EVM = "0x000000000000000000000002656f9205e386ed78";
const FLOW_SIGNER   = "v066-admin";
const PKEY_PATH     = "/home/oydual3/.flow/v066-admin.pkey";
const FLOW_JSON     = "/tmp/aggregate_flow.json";

// ── Circuit artifacts ─────────────────────────────────────────────────────────
const AGG_WASM = join(REPO_ROOT,
    "circuits/aggregate-ceremony/build/confidential_transfer_aggregate_js/confidential_transfer_aggregate.wasm");
const AGG_ZKEY = join(REPO_ROOT,
    "circuits/aggregate-ceremony/setup/confidential_transfer_aggregate_test.zkey");
const AGG_VKEY = join(REPO_ROOT,
    "circuits/aggregate-ceremony/setup/verification_key.json");

// v0.3 amount-disclose circuit artifacts
// NOTE: The deployed AmountDiscloseVerifier (0xD0ED39...) corresponds to the v0.3 ceremony
// (openjanus v0.3 deployment, janus-flow-v0.3.json). v0.5.1 artifacts generate proofs that
// fail on-chain against this verifier.
const AMT_WASM = "/home/oydual3/openjanus-sdk/circuits/v0.3/amount_disclose.wasm";
const AMT_ZKEY = join(REPO_ROOT,
    "circuits/v0.3-ceremony/amount_disclose_final.zkey");
const AMT_VKEY = join(REPO_ROOT,
    "circuits/v0.3-ceremony/verification_key.json");

// ── Constants ─────────────────────────────────────────────────────────────────
const WRAP_AMOUNT  = 1_000_000_000_000_000_000n;   // 1 FLOW in attoFLOW
const TX_VALUE     = 300_000_000_000_000_000n;      // 0.3 FLOW (for transfer proof gen)
const SUBORDER     = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const P            = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// 2-gen generators
const GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
const GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;
const HX = 20176122646359037043957983780698997220241005801156909477756461731029015465513n;
const HY = 12675495183377259114213499882541802147068931119123218019653136042509354750865n;

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const provider = new JsonRpcProvider(RPC_URL);

// ── ABI ───────────────────────────────────────────────────────────────────────
const jfArt = JSON.parse(readFileSync(
    join(MODULE_ROOT, "artifacts/contracts/solidity/JanusFlow.sol/JanusFlow.json"),
    "utf8"
));
const jfIface = new Interface(jfArt.abi);

const aggVerArt = JSON.parse(readFileSync(
    join(MODULE_ROOT, "artifacts/contracts/solidity/ConfidentialTransferAggregateVerifier.sol/ConfidentialTransferAggregateVerifier.json"),
    "utf8"
));
const aggVerIface = new Interface(aggVerArt.abi);

const pedersenArt = JSON.parse(readFileSync(
    join(MODULE_ROOT, "artifacts/contracts/solidity/Pedersen2Gen.sol/Pedersen2Gen.json"),
    "utf8"
));
const pedersenIface = new Interface(pedersenArt.abi);

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Windowed Pedersen commitment — v0.3 circuit format
// 24-byte buffer: [value_LE_8] || [blinding_LE_16]
// Matches circomlib Pedersen(192) template used by the v0.3 amount_disclose circuit.
// Constraint: value in [0, 2^64), blinding in [0, 2^128)
async function computeAmountDiscloseCommit(value, blinding) {
    const pedersenHash = await buildPedersenHash();
    const babyJub = await buildBabyjub();
    const F = babyJub.F;
    const buf = Buffer.alloc(24, 0);   // 24 bytes: 8 value + 16 blinding
    let v = value;
    for (let i = 0; i < 8; i++)  { buf[i] = Number(v & 0xffn); v >>= 8n; }
    let b = blinding;
    for (let i = 8; i < 24; i++) { buf[i] = Number(b & 0xffn); b >>= 8n; }
    const hash = pedersenHash.hash(buf);
    const point = babyJub.unpackPoint(hash);
    return { x: F.toObject(point[0]), y: F.toObject(point[1]) };
}

function applyPiBSwap(proof) {
    return {
        pA: proof.pi_a.slice(0, 2).map(BigInt),
        pB: [
            [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
            [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
        ],
        pC: proof.pi_c.slice(0, 2).map(BigInt),
    };
}

function ensureFlowJson() {
    const jfFlowJson = join(MODULE_ROOT, "../../packages/janus-token/flow.json");
    const base = JSON.parse(readFileSync(jfFlowJson, "utf8"));
    const cleaned = {
        networks: base.networks,
        dependencies: base.dependencies,
        accounts: {
            [FLOW_SIGNER]: {
                address: ADMIN_CADENCE,
                key: { type: "file", location: PKEY_PATH },
            },
        },
        contracts: {},
        deployments: {},
    };
    writeFileSync(FLOW_JSON, JSON.stringify(cleaned, null, 2));
}

function runFlowTx(txBody, args, label, gasLimit = 9999) {
    const txPath = `/tmp/.smoke_agg_${label}.cdc`;
    writeFileSync(txPath, txBody);
    const argStrs = args.map(a => `"${a}"`).join(" ");
    const cmd = [
        "flow transactions send", txPath, argStrs,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        `--gas-limit ${gasLimit}`,
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");
    let result;
    try {
        const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] non-JSON: ${err.stdout?.slice(0, 1000)}`);
            }
        } else throw err;
    }
    if (result.status !== "SEALED" || result.errorMessage) {
        throw new Error(`[${label}] tx not SEALED or errored: ${result.errorMessage}`);
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

// ── Cadence transactions ──────────────────────────────────────────────────────

function makeCallTx(attoflowValue) {
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
            value: EVM.Balance(attoflow: ${attoflowValue})
        )
        assert(
            result.status == EVM.Status.successful,
            message: "call failed: ".concat(result.errorMessage)
        )
    }
}
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.7.0 aggregate commitment smoke test");
    console.log("Network: Flow EVM Testnet (chainId 545)");
    console.log("=".repeat(72));
    console.log(`JanusFlow proxy:       ${JANUSFLOW_PROXY}`);
    console.log(`AggregateVerifier:     ${AGG_VERIFIER}`);
    console.log(`Pedersen2Gen:          ${PEDERSEN2GEN}`);
    console.log(`Admin COA (EVM):       ${ADMIN_COA_EVM}`);
    console.log();

    ensureFlowJson();

    const results = {
        date: new Date().toISOString(),
        network: "flow-evm-testnet",
        chainId: 545,
        version: "0.7.0",
        contracts: CONTRACTS,
        admin_coa: ADMIN_COA_EVM,
        steps: {},
        verdict: "PENDING",
    };

    // ── Step 0: Query initial on-chain state ──────────────────────────────────
    console.log("Step 0: Query initial state...");
    const lockedBefore = BigInt(await provider.call({
        to: JANUSFLOW_PROXY,
        data: jfIface.encodeFunctionData("totalLocked")
    }));

    const [initCX_raw, initCY_raw] = jfIface.decodeFunctionResult(
        "balanceOfCommitmentXY",
        await provider.call({
            to: JANUSFLOW_PROXY,
            data: jfIface.encodeFunctionData("balanceOfCommitmentXY", [ADMIN_COA_EVM])
        })
    );
    const initCX = BigInt(initCX_raw);
    const initCY = BigInt(initCY_raw);

    console.log(`  totalLocked before:     ${lockedBefore} attoFLOW`);
    console.log(`  admin commitment:        (${initCX}, ${initCY})`);
    console.log(`  identity?               ${initCX === 0n && initCY === 1n ? "YES" : "NO — already has balance"}`);

    results.steps.step0_initial_state = {
        total_locked_before: lockedBefore.toString(),
        admin_commitment_x: initCX.toString(),
        admin_commitment_y: initCY.toString(),
        is_identity: initCX === 0n && initCY === 1n,
    };

    // ── Step 1: Wrap 1 FLOW ────────────────────────────────────────────────────
    console.log("\nStep 1: Wrap 1 FLOW (v0.5.1 amount-disclose proof)...");

    // Random 128-bit blinding for amount-disclose proof
    const amtBlinding = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, "0")).join(""));

    // Compute windowed-Pedersen commitment for amount-disclose
    const amtCommit = await computeAmountDiscloseCommit(WRAP_AMOUNT, amtBlinding);
    console.log(`  amtBlinding:            ${amtBlinding}`);
    console.log(`  amount-disclose commit: (${amtCommit.x}, ${amtCommit.y})`);

    // Generate amount-disclose proof
    console.log("  Generating amount-disclose proof (v0.5.1)...");
    const { proof: amtProofRaw, publicSignals: amtPubSignals } = await snarkjs.groth16.fullProve(
        {
            blinding: amtBlinding.toString(),
            claimed_amount: WRAP_AMOUNT.toString(),
            commit: [amtCommit.x.toString(), amtCommit.y.toString()],
        },
        AMT_WASM,
        AMT_ZKEY
    );

    // Off-chain verify amount-disclose proof
    const amtVk = JSON.parse(readFileSync(AMT_VKEY, "utf8"));
    const amtProofOk = await snarkjs.groth16.verify(amtVk, amtPubSignals, amtProofRaw);
    console.log(`  Off-chain verify (amount-disclose): ${amtProofOk ? "PASS" : "FAIL"}`);
    if (!amtProofOk) throw new Error("Amount-disclose proof failed off-chain verification");

    const amtProof = applyPiBSwap(amtProofRaw);
    const amtProofArr = [
        amtProof.pA[0], amtProof.pA[1],
        amtProof.pB[0][0], amtProof.pB[0][1],
        amtProof.pB[1][0], amtProof.pB[1][1],
        amtProof.pC[0], amtProof.pC[1],
    ];

    // Encode wrap calldata
    const wrapCalldata = jfIface.encodeFunctionData("wrap", [
        [amtCommit.x, amtCommit.y],
        amtProofArr,
        "0x",   // encryptedSnapshot
        0n,     // ephPubkeyX
        0n,     // ephPubkeyY
    ]);

    // Send wrap tx via admin COA
    console.log(`  Sending wrap tx (1 FLOW, admin COA)...`);
    const wrapTx = makeCallTx(WRAP_AMOUNT);
    const wrapRes = runFlowTx(
        wrapTx,
        [JANUSFLOW_PROXY, wrapCalldata.slice(2), "3000000"],
        "wrap"
    );
    const wrapFlowTxId = wrapRes?.id ?? "unknown";
    const wrapEvmTxHash = extractEvmTxHash(wrapRes);
    console.log(`  Flow tx:  ${wrapFlowTxId}`);
    console.log(`  EVM tx:   ${wrapEvmTxHash}`);

    // Verify totalLocked increased
    const lockedAfterWrap = BigInt(await provider.call({
        to: JANUSFLOW_PROXY,
        data: jfIface.encodeFunctionData("totalLocked")
    }));
    const wrapDelta = lockedAfterWrap - lockedBefore;
    const wrapDeltaOk = wrapDelta === WRAP_AMOUNT;
    console.log(`  totalLocked after wrap: ${lockedAfterWrap} attoFLOW`);
    console.log(`  delta:                  ${wrapDelta} attoFLOW (expected ${WRAP_AMOUNT})`);
    console.log(`  delta OK:               ${wrapDeltaOk ? "YES" : "NO"}`);

    // Read back commitment
    const [postWrapCX_raw, postWrapCY_raw] = jfIface.decodeFunctionResult(
        "balanceOfCommitmentXY",
        await provider.call({
            to: JANUSFLOW_PROXY,
            data: jfIface.encodeFunctionData("balanceOfCommitmentXY", [ADMIN_COA_EVM])
        })
    );
    const postWrapCX = BigInt(postWrapCX_raw);
    const postWrapCY = BigInt(postWrapCY_raw);
    const commitMatchesTxCommit = postWrapCX === amtCommit.x && postWrapCY === amtCommit.y;
    console.log(`  Commitment after wrap:  (${postWrapCX}, ${postWrapCY})`);
    console.log(`  Matches txCommit:       ${commitMatchesTxCommit ? "YES" : "NO"}`);

    results.steps.step1_wrap = {
        wrap_amount_attoflow: WRAP_AMOUNT.toString(),
        wrap_amount_flow: "1.0",
        amount_disclose_proof_ok_offchain: amtProofOk,
        total_locked_before: lockedBefore.toString(),
        total_locked_after: lockedAfterWrap.toString(),
        delta: wrapDelta.toString(),
        delta_matches_wrap: wrapDeltaOk,
        commitment_after_wrap_x: postWrapCX.toString(),
        commitment_after_wrap_y: postWrapCY.toString(),
        commitment_matches_tx_commit: commitMatchesTxCommit,
        tx_hashes: {
            flow: wrapFlowTxId,
            evm: wrapEvmTxHash,
        },
    };

    // ── Step 2: ConfidentialTransferAggregateVerifier probe ───────────────────
    console.log("\nStep 2: ConfidentialTransferAggregateVerifier probe (off-chain proof, on-chain verify)...");

    // Generate a real aggregate Groth16 proof with known values
    const V_OLD  = 1_000_000_000_000_000_000n;  // 1e18
    const R_OLD  = 111_222_333_444n;
    const V_TX   = TX_VALUE;                     // 0.3e18
    const R_TX   = 555_666_777_888n;
    const R_NEW  = 999_000_111n;
    const V_NEW  = V_OLD - V_TX;

    const C_OLD  = commit2gen(V_OLD, R_OLD);
    const C_TX   = commit2gen(V_TX, R_TX);
    const C_NEW  = commit2gen(V_NEW, R_NEW);

    console.log(`  C_old:  (${C_OLD.x}, ${C_OLD.y})`);
    console.log(`  C_tx:   (${C_TX.x}, ${C_TX.y})`);
    console.log(`  C_new:  (${C_NEW.x}, ${C_NEW.y})`);
    console.log("  Generating Groth16 aggregate proof (test zkey)...");

    const { proof: aggProofRaw, publicSignals: aggPubSignals } = await snarkjs.groth16.fullProve(
        {
            old_value:         V_OLD.toString(),
            old_blinding:      R_OLD.toString(),
            transfer_value:    V_TX.toString(),
            transfer_blinding: R_TX.toString(),
            new_blinding:      R_NEW.toString(),
            old_commit:        [C_OLD.x.toString(), C_OLD.y.toString()],
            transfer_commit:   [C_TX.x.toString(), C_TX.y.toString()],
            new_commit:        [C_NEW.x.toString(), C_NEW.y.toString()],
        },
        AGG_WASM,
        AGG_ZKEY
    );

    // Off-chain verify
    const aggVk = JSON.parse(readFileSync(AGG_VKEY, "utf8"));
    const aggProofOkOffChain = await snarkjs.groth16.verify(aggVk, aggPubSignals, aggProofRaw);
    console.log(`  Off-chain verify: ${aggProofOkOffChain ? "PASS" : "FAIL"}`);
    if (!aggProofOkOffChain) throw new Error("Aggregate proof failed off-chain verification");

    // Format for Solidity verifyProof call
    const aggProof = applyPiBSwap(aggProofRaw);
    const pubSigs = aggPubSignals.map(BigInt);

    // Call verifyProof on deployed contract via eth_call
    console.log(`  Calling verifyProof() on deployed ConfidentialTransferAggregateVerifier...`);
    const verifyCalldata = aggVerIface.encodeFunctionData("verifyProof", [
        [aggProof.pA[0], aggProof.pA[1]],
        [[aggProof.pB[0][0], aggProof.pB[0][1]], [aggProof.pB[1][0], aggProof.pB[1][1]]],
        [aggProof.pC[0], aggProof.pC[1]],
        [pubSigs[0], pubSigs[1], pubSigs[2], pubSigs[3], pubSigs[4], pubSigs[5]],
    ]);

    const verifyResult = await provider.call({
        to: AGG_VERIFIER,
        data: verifyCalldata
    });
    const [aggProofOkOnChain] = aggVerIface.decodeFunctionResult("verifyProof", verifyResult);
    console.log(`  On-chain verifyProof: ${aggProofOkOnChain ? "PASS" : "FAIL"}`);

    results.steps.step2_aggregate_verifier = {
        proof_inputs: {
            v_old: V_OLD.toString(),
            v_tx: V_TX.toString(),
            v_new: V_NEW.toString(),
            r_old: R_OLD.toString(),
            r_tx: R_TX.toString(),
            r_new: R_NEW.toString(),
        },
        commitments: {
            c_old: { x: C_OLD.x.toString(), y: C_OLD.y.toString() },
            c_tx:  { x: C_TX.x.toString(),  y: C_TX.y.toString()  },
            c_new: { x: C_NEW.x.toString(),  y: C_NEW.y.toString() },
        },
        off_chain_verify: aggProofOkOffChain,
        on_chain_verify: aggProofOkOnChain,
    };

    // ── Step 3: Pedersen2Gen addCommits probe ─────────────────────────────────
    console.log("\nStep 3: Pedersen2Gen addCommits probe...");

    // Verify homomorphism: commit(1e18, r1) + commit(2e18, r2) == commit(3e18, r1+r2)
    const pA = commit2gen(1_000_000_000_000_000_000n, 100n);
    const pB = commit2gen(2_000_000_000_000_000_000n, 200n);
    const pSum_offchain = commit2gen(3_000_000_000_000_000_000n, 300n);

    const addCalldata = pedersenIface.encodeFunctionData("addCommits", [
        pA.x, pA.y, pB.x, pB.y
    ]);
    const addResult = await provider.call({ to: PEDERSEN2GEN, data: addCalldata });
    const [pSumX_raw, pSumY_raw] = pedersenIface.decodeFunctionResult("addCommits", addResult);
    const pSumX = BigInt(pSumX_raw);
    const pSumY = BigInt(pSumY_raw);

    const homomorphismOk = pSumX === pSum_offchain.x && pSumY === pSum_offchain.y;
    console.log(`  pA:                     (${pA.x}, ${pA.y})`);
    console.log(`  pB:                     (${pB.x}, ${pB.y})`);
    console.log(`  on-chain sum:           (${pSumX}, ${pSumY})`);
    console.log(`  expected sum (off-ch):  (${pSum_offchain.x}, ${pSum_offchain.y})`);
    console.log(`  Homomorphism OK:        ${homomorphismOk ? "YES" : "NO"}`);

    results.steps.step3_pedersen2gen = {
        p_a: { x: pA.x.toString(), y: pA.y.toString() },
        p_b: { x: pB.x.toString(), y: pB.y.toString() },
        on_chain_sum_x: pSumX.toString(),
        on_chain_sum_y: pSumY.toString(),
        expected_sum_x: pSum_offchain.x.toString(),
        expected_sum_y: pSum_offchain.y.toString(),
        homomorphism_ok: homomorphismOk,
    };

    // ── Step 4: adminResetSlot ────────────────────────────────────────────────
    console.log("\nStep 4: adminResetSlot (clean up admin COA testnet state)...");

    const resetCalldata = jfIface.encodeFunctionData("adminResetSlot", [ADMIN_COA_EVM]);
    const resetTx = makeCallTx(0n);
    const resetRes = runFlowTx(
        resetTx,
        [JANUSFLOW_PROXY, resetCalldata.slice(2), "500000"],
        "reset"
    );
    const resetFlowTxId = resetRes?.id ?? "unknown";
    const resetEvmTxHash = extractEvmTxHash(resetRes);
    console.log(`  Flow tx:  ${resetFlowTxId}`);
    console.log(`  EVM tx:   ${resetEvmTxHash}`);

    // Confirm reset
    const [postResetCX_raw, postResetCY_raw] = jfIface.decodeFunctionResult(
        "balanceOfCommitmentXY",
        await provider.call({
            to: JANUSFLOW_PROXY,
            data: jfIface.encodeFunctionData("balanceOfCommitmentXY", [ADMIN_COA_EVM])
        })
    );
    const postResetCX = BigInt(postResetCX_raw);
    const postResetCY = BigInt(postResetCY_raw);
    const resetOk = postResetCX === 0n && postResetCY === 1n;
    console.log(`  Commitment after reset: (${postResetCX}, ${postResetCY})`);
    console.log(`  Reset to identity:      ${resetOk ? "YES" : "NO"}`);

    results.steps.step4_admin_reset = {
        commitment_after_reset_x: postResetCX.toString(),
        commitment_after_reset_y: postResetCY.toString(),
        reset_to_identity: resetOk,
        tx_hashes: {
            flow: resetFlowTxId,
            evm: resetEvmTxHash,
        },
    };

    // ── Final verdict ─────────────────────────────────────────────────────────
    const allPassed =
        wrapDeltaOk &&
        commitMatchesTxCommit &&
        amtProofOk &&
        aggProofOkOffChain &&
        aggProofOkOnChain &&
        homomorphismOk &&
        resetOk;

    results.verdict = allPassed ? "PASS" : "FAIL";
    results.summary = {
        step1_wrap_delta_ok:                wrapDeltaOk,
        step1_commitment_matches_tx_commit: commitMatchesTxCommit,
        step1_amount_disclose_proof_ok:     amtProofOk,
        step2_agg_verifier_offchain_ok:     aggProofOkOffChain,
        step2_agg_verifier_onchain_ok:      aggProofOkOnChain,
        step3_homomorphism_ok:              homomorphismOk,
        step4_admin_reset_ok:               resetOk,
    };

    console.log("\n" + "=".repeat(72));
    console.log(`Aggregate v0.7.0 smoke test: ${results.verdict}`);
    Object.entries(results.summary).forEach(([k, v]) => {
        console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
    });
    console.log("=".repeat(72));

    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const outPath = join(DEPLOYMENTS_DIR, "aggregate-testnet-smoke.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nResults written: ${outPath}`);

    if (!allPassed) process.exit(1);
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
