/**
 * deploy-v0.8.2-batchN10.mjs
 *
 * Deploys the new ConfidentialClaimBatchVerifier (N=10 ceremony) and
 * wires it into JanusFlow + JanusERC20 via the standalone
 * setBatchClaimVerifier() setter (no UUPS upgrade needed).
 *
 * Also updates JanusFT.cdc (Cadence) via flow accounts update-contract
 * so BATCH_CLAIM_VERIFIER_ADDR() returns the new address.
 *
 * Deployment path: COA of openjanus-v08 (0x4b6bc58bc8bf5dcc)
 *   COA EVM: 0x0000000000000000000000020885d7ad3582356a
 *   Pkey:    /home/oydual3/.flow/openjanus-v08.pkey
 *
 * Proxies updated (Path 1 — setter only, no impl redeploy):
 *   JanusFlow:   0xA64340C1d356835A2450306Ffd290Ed52c001Ad3
 *   JanusERC20:  0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d
 *
 * JanusFT Cadence: contract upgrade to change hardcoded BATCH_CLAIM_VERIFIER_ADDR()
 *
 * Run from repo root:
 *   node scripts/deploy-v0.8.2-batchN10.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { JsonRpcProvider, AbiCoder, Interface } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const JANUS_TOKEN_PKG = join(REPO_ROOT, "packages", "janus-token");
const JANUS_ERC20_PKG = join(REPO_ROOT, "packages", "janus-erc20");
const JANUS_FT_PKG    = join(REPO_ROOT, "packages", "janus-ft");
const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");
const DEPLOY_RECORD   = join(DEPLOYMENTS_DIR, "testnet-v0.8.json");

// ── Artifact paths ──────────────────────────────────────────────────────────
const CCB_VERIFIER_ART = join(
    JANUS_TOKEN_PKG,
    "artifacts/contracts/solidity/ConfidentialClaimBatchVerifier.sol/Groth16Verifier.json"
);
const JF_ART  = join(JANUS_TOKEN_PKG, "artifacts/contracts/solidity/JanusFlow.sol/JanusFlow.json");
const ERC20_ART = join(JANUS_ERC20_PKG, "artifacts/contracts/solidity/JanusERC20.sol/JanusERC20.json");

// ── Admin ───────────────────────────────────────────────────────────────────
const ADMIN_CADENCE  = "4b6bc58bc8bf5dcc";
const ADMIN_COA_EVM  = "0x0000000000000000000000020885d7ad3582356a";
const FLOW_SIGNER    = "openjanus-v08";
const PKEY_PATH      = "/home/oydual3/.flow/openjanus-v08.pkey";
const FLOW_JSON_PATH = "/tmp/.v082_batchN10_flow.json";

// ── Existing proxies ─────────────────────────────────────────────────────────
const JANUSFLOW_PROXY  = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";
const JANUSERC20_PROXY = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d";

// ── Network ─────────────────────────────────────────────────────────────────
const RPC_URL  = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID = 545;

// ── JanusFT Cadence source path ──────────────────────────────────────────────
const JANUS_FT_CDC = join(JANUS_FT_PKG, "contracts/cadence/JanusFT.cdc");

// ── setBatchClaimVerifier(address) selector — same across JanusToken/JanusERC20 ──
// keccak256("setBatchClaimVerifier(address)") = cc41bced…
const SET_BCK_SELECTOR = "cc41bced";

// ── Cadence tx templates ─────────────────────────────────────────────────────

const DEPLOY_TX_TEMPLATE = `import "EVM"

transaction(bytecodeHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Deploy) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.deploy(
            code: bytecodeHex.decodeHex(),
            gasLimit: 8_000_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "deploy failed: ".concat(result.errorMessage)
        )
        log("deployed at:")
        log(result.deployedContract?.toString() ?? "unknown")
    }
}
`;

const CALL_TX_TEMPLATE = `import "EVM"

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
            message: "call failed: ".concat(result.errorMessage)
        )
    }
}
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureFlowJson() {
    // Build a minimal flow.json for the openjanus-v08 signer, reusing
    // the janus-ft dependency set (which includes EVM, FungibleToken, etc.)
    const base = JSON.parse(readFileSync(join(JANUS_FT_PKG, "flow.json"), "utf8"));
    const cfg = {
        networks: base.networks,
        dependencies: base.dependencies,
        accounts: {
            [FLOW_SIGNER]: {
                address: ADMIN_CADENCE,
                key: {
                    type: "file",
                    location: PKEY_PATH,
                    signatureAlgorithm: "ECDSA_secp256k1",
                    hashAlgorithm: "SHA2_256",
                },
            },
        },
        contracts: {
            JanusFT: {
                source: JANUS_FT_CDC,
                aliases: { testnet: ADMIN_CADENCE },
            },
        },
        deployments: {},
    };
    writeFileSync(FLOW_JSON_PATH, JSON.stringify(cfg, null, 2));
}

function runFlowDeploy(bytecodeHex, label) {
    const txPath = `/tmp/.v082_deploy_${label}.cdc`;
    writeFileSync(txPath, DEPLOY_TX_TEMPLATE);
    const cmd = [
        "flow transactions send",
        txPath,
        `"${bytecodeHex}"`,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON_PATH}`,
    ].join(" ");

    console.log(`  Sending deploy tx for ${label}...`);
    let result;
    try {
        const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] non-JSON output:\n${err.stdout?.slice(0, 1000)}`);
            }
        } else throw new Error(`[${label}] ${err.message}`);
    }
    if (result.error) throw new Error(`[${label}] tx failed: ${result.error.slice(0, 500)}`);
    return result;
}

function runFlowCall(contractAddress, calldataHex, label, gasLimit = 3_000_000) {
    const txPath = `/tmp/.v082_call_${label}.cdc`;
    writeFileSync(txPath, CALL_TX_TEMPLATE);
    const cmd = [
        "flow transactions send",
        txPath,
        `"${contractAddress}"`,
        `"${calldataHex}"`,
        `${gasLimit}`,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON_PATH}`,
    ].join(" ");

    console.log(`  Calling ${label} on ${contractAddress}...`);
    let result;
    try {
        const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] non-JSON output:\n${err.stdout?.slice(0, 1000)}`);
            }
        } else throw new Error(`[${label}] ${err.message}`);
    }
    if (result.error) throw new Error(`[${label}] call failed: ${result.error.slice(0, 500)}`);
    return result;
}

function extractDeployedAddress(result, label) {
    const blob = JSON.stringify(result?.events ?? []);

    // Primary: look for contractAddress field in EVM.DeployedContract event
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    // Fallback: any 40-hex address that isn't a known constant
    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        ADMIN_COA_EVM.toLowerCase(),
        JANUSFLOW_PROXY.toLowerCase(),
        JANUSERC20_PROXY.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    if (fallback.length > 0) return fallback[0];

    writeFileSync(`/tmp/.v082_${label}_raw.json`, JSON.stringify(result, null, 2));
    return null;
}

function extractCadenceTxId(result) {
    return result?.id ?? result?.txID ?? result?.transactionId ?? "unknown";
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

/** Encode setBatchClaimVerifier(address) calldata. */
function encodeSetBatchClaimVerifier(newVerifierAddr) {
    // selector cc41bced + abi-encoded address (32 bytes)
    const addrPadded = newVerifierAddr.toLowerCase().replace("0x", "").padStart(64, "0");
    return SET_BCK_SELECTOR + addrPadded;
}

async function callView(provider, to, abi, fn) {
    const iface = new Interface(abi);
    const data  = iface.encodeFunctionData(fn, []);
    const hex   = await provider.call({ to, data });
    return "0x" + hex.slice(-40);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("=".repeat(72));
    console.log("BatchClaim N=10 — v0.8.2 deployment sprint");
    console.log("Network: Flow EVM Testnet (chainId 545)");
    console.log("=".repeat(72));
    console.log("Admin Cadence:", `0x${ADMIN_CADENCE}`);
    console.log("Admin COA EVM:", ADMIN_COA_EVM);
    console.log("JanusFlow proxy:", JANUSFLOW_PROXY);
    console.log("JanusERC20 proxy:", JANUSERC20_PROXY);
    console.log();

    // Verify artifacts
    for (const p of [CCB_VERIFIER_ART, JF_ART, ERC20_ART]) {
        if (!existsSync(p)) throw new Error(`Missing artifact: ${p}\nRun hardhat compile first.`);
    }
    if (!existsSync(JANUS_FT_CDC)) throw new Error(`Missing JanusFT.cdc: ${JANUS_FT_CDC}`);

    const ccbArt    = JSON.parse(readFileSync(CCB_VERIFIER_ART, "utf8"));
    const jfArt     = JSON.parse(readFileSync(JF_ART, "utf8"));
    const erc20Art  = JSON.parse(readFileSync(ERC20_ART, "utf8"));
    const provider  = new JsonRpcProvider(RPC_URL, CHAIN_ID);

    ensureFlowJson();
    console.log("Flow config written to", FLOW_JSON_PATH);

    const txHashes = {};

    // ── Phase A: Deploy ConfidentialClaimBatchVerifier (N=10) via COA ──────────
    console.log("\n[1/4] Deploying ConfidentialClaimBatchVerifier (N=10)...");
    const ccbBytecode = ccbArt.bytecode.replace(/^0x/, "");
    console.log(`  Bytecode size: ${ccbBytecode.length / 2} bytes`);

    const deployResult = runFlowDeploy(ccbBytecode, "ccb_n10");
    const cadenceDeployTxId = extractCadenceTxId(deployResult);
    const newVerifierAddr   = extractDeployedAddress(deployResult, "ccb_n10");

    txHashes.ccb_n10_deploy_cadence = cadenceDeployTxId;

    if (!newVerifierAddr) {
        throw new Error(
            `Could not parse deployed address from tx events.\n` +
            `Raw tx output: /tmp/.v082_ccb_n10_raw.json\n` +
            `Cadence tx: ${cadenceDeployTxId}`
        );
    }

    console.log(`  Cadence tx:    ${cadenceDeployTxId}`);
    console.log(`  New verifier:  ${newVerifierAddr}`);

    // ── Phase B: setBatchClaimVerifier on JanusFlow proxy ──────────────────────
    console.log("\n[2/4] Calling setBatchClaimVerifier on JanusFlow proxy...");
    const setJfCalldata = encodeSetBatchClaimVerifier(newVerifierAddr);
    const setJfResult   = runFlowCall(JANUSFLOW_PROXY, setJfCalldata, "set_bcv_janusflow");
    txHashes.janusflow_setBatchClaimVerifier_cadence = extractCadenceTxId(setJfResult);
    txHashes.janusflow_setBatchClaimVerifier_evm     = extractEvmTxHash(setJfResult);
    console.log("  Cadence tx:", txHashes.janusflow_setBatchClaimVerifier_cadence);
    console.log("  EVM tx:    ", txHashes.janusflow_setBatchClaimVerifier_evm);

    // ── Phase C: setBatchClaimVerifier on JanusERC20 proxy ────────────────────
    console.log("\n[3/4] Calling setBatchClaimVerifier on JanusERC20 proxy...");
    const setErcCalldata = encodeSetBatchClaimVerifier(newVerifierAddr);
    const setErcResult   = runFlowCall(JANUSERC20_PROXY, setErcCalldata, "set_bcv_januserc20");
    txHashes.januserc20_setBatchClaimVerifier_cadence = extractCadenceTxId(setErcResult);
    txHashes.januserc20_setBatchClaimVerifier_evm     = extractEvmTxHash(setErcResult);
    console.log("  Cadence tx:", txHashes.januserc20_setBatchClaimVerifier_cadence);
    console.log("  EVM tx:    ", txHashes.januserc20_setBatchClaimVerifier_evm);

    // ── Phase D: Verify on-chain that both proxies reflect the new address ────
    console.log("\n=== EVM on-chain verification ===");
    const jfBcvAddr   = await callView(provider, JANUSFLOW_PROXY,  jfArt.abi,    "batchClaimVerifier");
    const ercBcvAddr  = await callView(provider, JANUSERC20_PROXY, erc20Art.abi, "batchClaimVerifier");

    const jfOk  = jfBcvAddr.toLowerCase()  === newVerifierAddr.toLowerCase();
    const ercOk = ercBcvAddr.toLowerCase() === newVerifierAddr.toLowerCase();

    console.log(`  JanusFlow  batchClaimVerifier() = ${jfBcvAddr}  ${jfOk  ? "OK" : "MISMATCH"}`);
    console.log(`  JanusERC20 batchClaimVerifier() = ${ercBcvAddr} ${ercOk ? "OK" : "MISMATCH"}`);

    if (!jfOk || !ercOk) {
        throw new Error("EVM proxy batchClaimVerifier mismatch — aborting before Cadence update.");
    }

    // ── Phase E: Update JanusFT.cdc with the new verifier address ─────────────
    console.log("\n[4/4] Updating JanusFT.cdc BATCH_CLAIM_VERIFIER_ADDR()...");

    const janusFtSrc = readFileSync(JANUS_FT_CDC, "utf8");

    // Replace specifically the address inside BATCH_CLAIM_VERIFIER_ADDR() function body.
    // Anchored to the function name to avoid hitting BABYJUB_ADDR() or other view fns.
    const oldBcvPattern = /(BATCH_CLAIM_VERIFIER_ADDR\(\)[^}]*return\s+")0x[0-9a-fA-F]{40}(")/s;
    const matchBcv = janusFtSrc.match(oldBcvPattern);
    if (!matchBcv) throw new Error("Could not locate BATCH_CLAIM_VERIFIER_ADDR() return in JanusFT.cdc");

    // Extract the currently returned address for logging
    const currentAddrMatch = janusFtSrc.match(/BATCH_CLAIM_VERIFIER_ADDR\(\)[^}]*return\s+"(0x[0-9a-fA-F]{40})"/s);
    const currentAddr = currentAddrMatch ? currentAddrMatch[1] : "(unknown)";

    if (currentAddr.toLowerCase() === newVerifierAddr.toLowerCase()) {
        console.log("  JanusFT.cdc already points to new address — no edit needed.");
    } else {
        const updatedSrc = janusFtSrc.replace(oldBcvPattern, `$1${newVerifierAddr}$2`);
        writeFileSync(JANUS_FT_CDC, updatedSrc);
        console.log(`  JanusFT.cdc updated: ${currentAddr} → ${newVerifierAddr}`);
    }

    // ── Phase F: Deploy updated JanusFT to testnet ──────────────────────────
    console.log("  Sending flow accounts update-contract JanusFT...");
    const updateCmd = [
        "flow accounts update-contract",
        "JanusFT",
        JANUS_FT_CDC,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        "--output json",
        `--config-path ${FLOW_JSON_PATH}`,
    ].join(" ");

    let updateResult;
    try {
        const stdout = execSync(updateCmd, { timeout: 300_000, encoding: "utf8" });
        updateResult = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { updateResult = JSON.parse(err.stdout); } catch {
                throw new Error(`JanusFT update non-JSON:\n${err.stdout?.slice(0, 1000)}`);
            }
        } else throw new Error(`JanusFT update failed: ${err.message}`);
    }
    if (updateResult.error) throw new Error(`JanusFT update error: ${updateResult.error.slice(0, 500)}`);

    txHashes.janusFT_v082_batchN10_cadence = extractCadenceTxId(updateResult);
    console.log("  JanusFT update Cadence tx:", txHashes.janusFT_v082_batchN10_cadence);

    // ── Phase G: Update deployments/testnet-v0.8.json ─────────────────────────
    console.log("\n=== Updating deployment record ===");
    const record = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));

    record.version = "0.8.2";
    record.date    = new Date().toISOString().slice(0, 10);

    // Archive old N=50 verifier
    if (!record.evm.verifiers_archive) record.evm.verifiers_archive = {};
    record.evm.verifiers_archive.confidentialClaimBatch_n50 =
        record.evm.verifiers.confidentialClaimBatch;

    // Record new N=10 verifier
    record.evm.verifiers.confidentialClaimBatch = newVerifierAddr;
    record.evm.janusFlow.batchClaimVerifier      = newVerifierAddr;
    record.evm.janusErc20.batchClaimVerifier     = newVerifierAddr;

    // Append tx hashes
    if (!record.txHashes.v082Upgrades) record.txHashes.v082Upgrades = {};
    Object.assign(record.txHashes.v082Upgrades, txHashes);

    writeFileSync(DEPLOY_RECORD, JSON.stringify(record, null, 2) + "\n");
    console.log("  Deployment record updated:", DEPLOY_RECORD);

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(72));
    console.log("SUMMARY — BatchClaim N=10 deployment complete");
    console.log("=".repeat(72));
    console.log(`New ConfidentialClaimBatchVerifier (N=10): ${newVerifierAddr}`);
    console.log(`JanusFlow  setBatchClaimVerifier EVM tx:  ${txHashes.janusflow_setBatchClaimVerifier_evm}`);
    console.log(`JanusERC20 setBatchClaimVerifier EVM tx:  ${txHashes.januserc20_setBatchClaimVerifier_evm}`);
    console.log(`JanusFT Cadence update tx:                 ${txHashes.janusFT_v082_batchN10_cadence}`);
    console.log("\nFlowscan links:");
    const cadenceTxBase = "https://testnet.flowscan.io/tx/";
    const evmTxBase     = "https://evm-testnet.flowscan.io/tx/";
    console.log(`  Verifier deploy: ${cadenceTxBase}${txHashes.ccb_n10_deploy_cadence}`);
    console.log(`  JanusFlow set:   ${evmTxBase}${txHashes.janusflow_setBatchClaimVerifier_evm}`);
    console.log(`  JanusERC20 set:  ${evmTxBase}${txHashes.januserc20_setBatchClaimVerifier_evm}`);
    console.log(`  JanusFT update:  ${cadenceTxBase}${txHashes.janusFT_v082_batchN10_cadence}`);
    console.log("\nStatus: EVM proxies + Cadence JanusFT point to N=10 verifier.");
    console.log("Next: Step 3 — SDK rebundle (@openjanus/sdk)");
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
