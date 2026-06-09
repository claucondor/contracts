/**
 * v051-smoke.mjs — Smoke test for JanusFlow v0.5.1 (pot18 ceremony) on Flow EVM testnet.
 *
 * Tests a simple wrap using the new v0.5.1 circuit artifacts (pot18 ceremony).
 * If the wrap succeeds on-chain, the new verifier is accepting pot18 proofs correctly.
 *
 * Wrap: 5 FLOW from alice (openjanus-flow COA)
 * Circuit: v0.5.1 ceremony (128-bit Pedersen, pot18 setup)
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

// v0.5.1 circuit artifacts (pot18 ceremony)
const AMOUNT_WASM = join(MODULE_ROOT, "../../circuits/v0.5.1-ceremony/build/amount_disclose_js/amount_disclose.wasm");
const AMOUNT_ZKEY = join(MODULE_ROOT, "../../circuits/v0.5.1-ceremony/amount_disclose_final.zkey");

const DEPLOY_RECORD_PATH = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");

const ALICE = { name: "alice", signer: "openjanus-flow", coa: "0x0000000000000000000000022f6b30af48a94787" };

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const provider = new JsonRpcProvider(RPC_URL);

// 0.5 FLOW in attoFLOW (alice COA has 1 FLOW, keep some for gas)
const WRAP_AMOUNT = 500_000_000_000_000_000n;

// ---------------------------------------------------------------------------
// Cadence transaction for wrap
// ---------------------------------------------------------------------------

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
            message: "wrap call failed: ".concat(result.errorMessage)
        )
    }
}
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runFlowTx(txBody, args, label, signer, gasLimit = 9999) {
    const txPath = `/tmp/.v051smoke_${label}.cdc`;
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
                throw new Error(`[${label}] non-JSON: ${err.stdout?.slice(0,1000)}`);
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

// v0.5.1 Pedersen commitment (same function as v0.5 — 256-bit buffer)
// Matches SDK computeCommitmentV05: unpackPoint on the hash output
async function computeCommitmentV051(value, blinding) {
    const { buildPedersenHash, buildBabyjub } = await import("circomlibjs");
    const pedersenHash = await buildPedersenHash();
    const babyJub = await buildBabyjub();
    const F = babyJub.F;

    // 32-byte buffer: 16 bytes value (LE) + 16 bytes blinding (LE)
    const buf = Buffer.alloc(32, 0);
    let v = value;
    for (let i = 0; i < 16; i++) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    let b = blinding;
    for (let i = 16; i < 32; i++) {
        buf[i] = Number(b & 0xffn);
        b >>= 8n;
    }
    const hash = pedersenHash.hash(buf);
    const point = babyJub.unpackPoint(hash);
    return {
        x: F.toObject(point[0]),
        y: F.toObject(point[1]),
    };
}

// Apply pi_b FP2 swap for EVM verifier
function applyPiBSwap(proof) {
    return {
        pi_a: proof.pi_a.slice(0, 2).map(BigInt),
        pi_b: [
            [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
            [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
        ],
        pi_c: proof.pi_c.slice(0, 2).map(BigInt),
    };
}

function proofToUint256Array(p) {
    return [
        p.pi_a[0], p.pi_a[1],
        p.pi_b[0][0], p.pi_b[0][1],
        p.pi_b[1][0], p.pi_b[1][1],
        p.pi_c[0], p.pi_c[1],
    ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.5.1 smoke test — wrap 0.5 FLOW with pot18 proof");
    console.log("=".repeat(72));

    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD_PATH, "utf8"));
    const PROXY = deploy.contracts.JanusFlow_proxy;
    const NEW_AMOUNT_VERIFIER = "0x9c83b2b1EFFD3bd375b9Bee93Cb618005D6A2Dc4";

    console.log(`Proxy:                  ${PROXY}`);
    console.log(`AmountDiscloseVerifier: ${NEW_AMOUNT_VERIFIER} (v0.5.1 / pot18)`);

    // Read ABI for encoding
    const jfArt = JSON.parse(readFileSync(
        join(MODULE_ROOT, "artifacts/contracts/solidity/JanusFlow_v0_5.sol/JanusFlow_v0_5.json"),
        "utf8"
    ));
    const jfIface = new Interface(jfArt.abi);

    // Confirm verifier is the new pot18 one
    const amtVerRaw = await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("amountDiscloseVerifier") });
    const amtVerOnChain = "0x" + amtVerRaw.slice(-40);
    console.log(`\nOn-chain amountDiscloseVerifier: ${amtVerOnChain}`);
    if (amtVerOnChain.toLowerCase() !== NEW_AMOUNT_VERIFIER.toLowerCase()) {
        throw new Error(`FATAL: verifier mismatch — expected ${NEW_AMOUNT_VERIFIER}, got ${amtVerOnChain}`);
    }
    console.log("Verifier address confirmed: pot18");

    // totalLocked before
    const lockedBefore = BigInt(await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("totalLocked") }));
    console.log(`\ntotalLocked before: ${lockedBefore} attoFLOW (${Number(lockedBefore / 10n**18n)} FLOW)`);

    // Generate wrap proof using v0.5.1 zkey
    console.log(`\nGenerating AmountDisclose proof for ${WRAP_AMOUNT} attoFLOW (5 FLOW)...`);
    const blinding = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join(""));
    const commitment = await computeCommitmentV051(WRAP_AMOUNT, blinding);
    console.log(`  commitment: Cx=${commitment.x}, Cy=${commitment.y}`);

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        {
            blinding: blinding.toString(),
            claimed_amount: WRAP_AMOUNT.toString(),
            commit: [commitment.x.toString(), commitment.y.toString()],
        },
        AMOUNT_WASM,
        AMOUNT_ZKEY
    );
    console.log("  proof generated");

    // Off-chain verify against the new vkey
    const AMOUNT_VKEY_PATH = join(MODULE_ROOT, "../../circuits/v0.5.1-ceremony/amount_disclose_vkey.json");
    const vk = JSON.parse(readFileSync(AMOUNT_VKEY_PATH, "utf8"));
    const offChainOk = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log(`  off-chain verify: ${offChainOk ? "PASS" : "FAIL"}`);
    if (!offChainOk) throw new Error("Off-chain proof verification failed — bad ceremony artifacts");

    // Encode wrap calldata
    const evmProof = applyPiBSwap(proof);
    const proofArr = proofToUint256Array(evmProof);
    const txCommit = [commitment.x, commitment.y];
    const wrapCalldata = jfIface.encodeFunctionData("wrap", [txCommit, proofArr]);

    // Send wrap tx via alice COA
    console.log(`\nSending wrap tx (alice signer)...`);
    const wrapTx = makeWrapTx(WRAP_AMOUNT);
    const wrapRes = runFlowTx(
        wrapTx,
        [PROXY, wrapCalldata.slice(2), "3000000"],
        "wrap",
        ALICE.signer,
        9999
    );
    const wrapFlowTx = wrapRes?.id ?? "unknown";
    const wrapEvmTx = extractEvmTxHash(wrapRes);
    console.log(`  Flow tx:  ${wrapFlowTx}`);
    console.log(`  EVM tx:   ${wrapEvmTx}`);

    // totalLocked after
    const lockedAfter = BigInt(await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("totalLocked") }));
    const delta = lockedAfter - lockedBefore;
    const deltaOk = delta === WRAP_AMOUNT;
    console.log(`\ntotalLocked after:  ${lockedAfter} attoFLOW (${Number(lockedAfter / 10n**18n)} FLOW)`);
    console.log(`delta:              ${delta} attoFLOW`);
    console.log(`expected delta:     ${WRAP_AMOUNT} attoFLOW`);
    console.log(`delta OK:           ${deltaOk ? "YES" : "NO"}`);

    const verdict = offChainOk && deltaOk ? "PASS" : "FAIL";
    console.log(`\n${"=".repeat(72)}`);
    console.log(`v0.5.1 smoke test: ${verdict}`);
    console.log("=".repeat(72));

    // Write results
    const results = {
        date: new Date().toISOString(),
        verdict,
        ceremony: "v0.5.1 (pot18)",
        proxy: PROXY,
        amount_disclose_verifier: NEW_AMOUNT_VERIFIER,
        wrap_amount_attoflow: WRAP_AMOUNT.toString(),
        wrap_amount_flow: "0.5",
        total_locked_before: lockedBefore.toString(),
        total_locked_after: lockedAfter.toString(),
        delta: delta.toString(),
        delta_matches_wrap: deltaOk,
        off_chain_proof_verified: offChainOk,
        tx_hashes: {
            wrap_flow: wrapFlowTx,
            wrap_evm: wrapEvmTx,
        },
    };
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    writeFileSync(join(DEPLOYMENTS_DIR, "v051-smoke-results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log("Results written: deployments/v051-smoke-results.json");
    return results;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
