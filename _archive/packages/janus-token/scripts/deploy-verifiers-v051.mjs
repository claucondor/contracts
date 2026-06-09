/**
 * deploy-verifiers-v051.mjs — ceremony-only bump from pot14 to pot18.
 *
 * Steps:
 *   1. Deploy AmountDiscloseVerifier (v0.5.1 / pot18 ceremony) via COA.
 *   2. Deploy ConfidentialTransferVerifier (v0.5.1 / pot18 ceremony) via COA.
 *   3. Call setVerifiers(newAmtVerifier, newXfrVerifier) on the existing proxy.
 *      (NO new impl deploy — proxy is already at v0.5.0 which has setVerifiers)
 *   4. Verify on-chain state.
 *   5. Write deployments/janus-flow-v0.5.1.json.
 *
 * Run from package root:
 *   node scripts/deploy-verifiers-v051.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT     = join(__dirname, "..");
const ARTIFACTS       = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON       = join(MODULE_ROOT, "flow.json");

// Artifact paths
const ART_AMOUNT   = join(ARTIFACTS, "AmountDiscloseVerifier.sol/AmountDiscloseVerifier.json");
const ART_TRANSFER = join(ARTIFACTS, "ConfidentialTransferVerifier.sol/ConfidentialTransferVerifier.json");
// Use existing JanusFlow_v0_5 ABI to encode setVerifiers / read verifier addresses
const ART_JANUSFLOW = join(ARTIFACTS, "JanusFlow_v0_5.sol/JanusFlow_v0_5.json");

const DEPLOY_RECORD = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");
const V05_RECORD    = join(DEPLOYMENTS_DIR, "janus-flow-v0.5.json");
const OUT_RECORD    = join(DEPLOYMENTS_DIR, "janus-flow-v0.5.1.json");

// The proxy that MUST NOT CHANGE
const PROXY = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";
const RPC_URL                = "https://testnet.evm.nodes.onflow.org";

// ---------------------------------------------------------------------------
// Cadence transaction templates
// ---------------------------------------------------------------------------

const DEPLOY_TX = `import "EVM"

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

const CALL_TX = `import "EVM"

transaction(toHex: String, calldataHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(toHex),
            data: calldataHex.decodeHex(),
            gasLimit: 800_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "call failed: ".concat(result.errorMessage)
        )
    }
}
`;

// ---------------------------------------------------------------------------

function runFlowTx(txBody, args, label, gasLimit = 9999) {
    const txPath = `/tmp/.${label}.cdc`;
    writeFileSync(txPath, txBody);
    const argStrs = args.map(a => `"${a}"`).join(" ");
    const cmd = [
        "flow transactions send",
        txPath,
        argStrs,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
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

function extractDeployedAddress(result) {
    const blob = JSON.stringify(result?.events ?? []);
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        OPENJANUS_FLOW_COA_EVM.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    return fallback[0] ?? null;
}

function extractEvmTxHash(result) {
    const events = result?.events ?? [];
    for (const ev of events) {
        const t = ev?.type ?? "";
        if (!t.endsWith(".EVM.TransactionExecuted")) continue;
        const fields = ev?.values?.value?.fields ?? [];
        for (const f of fields) {
            const arr = f?.value?.value;
            if (Array.isArray(arr) && arr.length === 32 &&
                arr.every(b => b?.type === "UInt8")) {
                const hex = arr.map(b => Number(b.value).toString(16).padStart(2, "0")).join("");
                return "0x" + hex;
            }
        }
    }
    return null;
}

function loadBytecode(artPath) {
    const art = JSON.parse(readFileSync(artPath, "utf8"));
    return art.bytecode.startsWith("0x") ? art.bytecode.slice(2) : art.bytecode;
}

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.5.1 — ceremony-only pot18 verifier rotation");
    console.log("=".repeat(72));

    // Sanity: check artifacts exist
    for (const [label, path] of [
        ["AmountDiscloseVerifier", ART_AMOUNT],
        ["ConfidentialTransferVerifier", ART_TRANSFER],
        ["JanusFlow_v0_5 (ABI only)", ART_JANUSFLOW],
    ]) {
        if (!existsSync(path)) throw new Error(`Missing artifact: ${path} — run hardhat compile`);
        console.log(`  artifact ok: ${label}`);
    }

    // Sanity: confirm proxy VERSION == "0.5.0"
    const provider = new JsonRpcProvider(RPC_URL);
    const jfArt    = JSON.parse(readFileSync(ART_JANUSFLOW, "utf8"));
    const jfIface  = new Interface(jfArt.abi);

    const versionHex = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("VERSION"),
    });
    // ABI-decode string
    const version = jfIface.decodeFunctionResult("VERSION", versionHex)[0];
    console.log(`\nProxy VERSION(): "${version}"`);
    if (version !== "0.5.0") {
        throw new Error(`Proxy VERSION() is "${version}", expected "0.5.0" — wrong impl?`);
    }

    const txHashes = {};

    // ─── 1. Deploy AmountDiscloseVerifier (v0.5.1 / pot18) ──────────────────
    console.log("\n[1/3] Deploying AmountDiscloseVerifier (v0.5.1 / pot18 ceremony)...");
    const amtBc  = loadBytecode(ART_AMOUNT);
    console.log(`  bytecode: ${amtBc.length / 2} bytes`);
    const amtRes  = runFlowTx(DEPLOY_TX, [amtBc], "v051_deploy_amount_verifier");
    const amtAddr = extractDeployedAddress(amtRes);
    txHashes.amount_verifier_deploy_flow = amtRes?.id ?? "unknown";
    txHashes.amount_verifier_deploy_evm  = extractEvmTxHash(amtRes);
    console.log(`  Flow tx:    ${txHashes.amount_verifier_deploy_flow}`);
    console.log(`  EVM tx:     ${txHashes.amount_verifier_deploy_evm}`);
    console.log(`  address:    ${amtAddr}`);
    if (!amtAddr) {
        writeFileSync("/tmp/v051-amount-deploy-raw.json", JSON.stringify(amtRes, null, 2));
        throw new Error("Failed to parse AmountDiscloseVerifier address — see /tmp/v051-amount-deploy-raw.json");
    }

    // ─── 2. Deploy ConfidentialTransferVerifier (v0.5.1 / pot18) ─────────────
    console.log("\n[2/3] Deploying ConfidentialTransferVerifier (v0.5.1 / pot18 ceremony)...");
    const xfrBc  = loadBytecode(ART_TRANSFER);
    console.log(`  bytecode: ${xfrBc.length / 2} bytes`);
    const xfrRes  = runFlowTx(DEPLOY_TX, [xfrBc], "v051_deploy_transfer_verifier");
    const xfrAddr = extractDeployedAddress(xfrRes);
    txHashes.transfer_verifier_deploy_flow = xfrRes?.id ?? "unknown";
    txHashes.transfer_verifier_deploy_evm  = extractEvmTxHash(xfrRes);
    console.log(`  Flow tx:    ${txHashes.transfer_verifier_deploy_flow}`);
    console.log(`  EVM tx:     ${txHashes.transfer_verifier_deploy_evm}`);
    console.log(`  address:    ${xfrAddr}`);
    if (!xfrAddr) {
        writeFileSync("/tmp/v051-transfer-deploy-raw.json", JSON.stringify(xfrRes, null, 2));
        throw new Error("Failed to parse ConfidentialTransferVerifier address — see /tmp/v051-transfer-deploy-raw.json");
    }

    // ─── 3. setVerifiers on the existing proxy ───────────────────────────────
    console.log("\n[3/3] Calling proxy.setVerifiers(newAmt, newXfr)...");
    const setVCalldata = jfIface.encodeFunctionData("setVerifiers", [amtAddr, xfrAddr]);
    const setVRes  = runFlowTx(CALL_TX, [PROXY, setVCalldata.slice(2)], "v051_set_verifiers");
    txHashes.set_verifiers_flow = setVRes?.id ?? "unknown";
    txHashes.set_verifiers_evm  = extractEvmTxHash(setVRes);
    console.log(`  Cadence tx: ${txHashes.set_verifiers_flow}`);
    console.log(`  EVM tx:     ${txHashes.set_verifiers_evm}`);

    // ─── 4. Verify on-chain state ─────────────────────────────────────────────
    console.log("\nVerifying on-chain state...");

    // Read amountDiscloseVerifier() from proxy
    const amtVerRaw  = await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("amountDiscloseVerifier") });
    const amtVerAddr = "0x" + amtVerRaw.slice(-40);
    const amtVerMatch = amtVerAddr.toLowerCase() === amtAddr.toLowerCase();
    console.log(`  proxy.amountDiscloseVerifier() = ${amtVerAddr}`);
    console.log(`  matches new verifier           = ${amtVerMatch ? "YES" : "NO"}`);

    // Read transferVerifier() from proxy
    const xfrVerRaw  = await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("transferVerifier") });
    const xfrVerAddr = "0x" + xfrVerRaw.slice(-40);
    const xfrVerMatch = xfrVerAddr.toLowerCase() === xfrAddr.toLowerCase();
    console.log(`  proxy.transferVerifier()       = ${xfrVerAddr}`);
    console.log(`  matches new verifier           = ${xfrVerMatch ? "YES" : "NO"}`);

    // VERSION still 0.5.0
    const versionHex2 = await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("VERSION") });
    const version2    = jfIface.decodeFunctionResult("VERSION", versionHex2)[0];
    const versionOk   = version2 === "0.5.0";
    console.log(`  proxy.VERSION()                = "${version2}"`);
    console.log(`  still 0.5.0                    = ${versionOk ? "YES" : "NO"}`);

    // totalLocked unchanged
    const lockedHex = await provider.call({ to: PROXY, data: jfIface.encodeFunctionData("totalLocked") });
    console.log(`  proxy.totalLocked()            = ${BigInt(lockedHex).toString()} attoFLOW`);

    if (!amtVerMatch || !xfrVerMatch || !versionOk) {
        throw new Error("Post-setVerifiers state verification FAILED — check logs above.");
    }

    // ─── 5. Write record ──────────────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const record = {
        version: "0.5.1",
        date: new Date().toISOString(),
        network: "flow-evm-testnet",
        chainId: 545,
        proxy: PROXY,
        impl: "0x05.0 (unchanged — no impl deploy in this ceremony bump)",
        new_amount_disclose_verifier: amtAddr,
        new_transfer_verifier: xfrAddr,
        prior_amount_disclose_verifier: "0xee5Dc464e7e9782c7b04FC0bEAd0EBC2F366945b",
        prior_transfer_verifier: "0x93cb6f84B30455CCF2154C671F96201333756D9e",
        ceremony: {
            path: "circuits/v0.5.1-ceremony/",
            ptau_file: "powersOfTau28_hez_final_18.ptau",
            ptau_source: "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_18.ptau",
            ptau_size_bytes: 302072984,
            ptau_blake2b: "7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e",
            ptau_sha256: "e970efa7774da80101e0ac336d083ef3339855c98112539338d706b2b89ac694",
            beacon_block_height: 324226714,
            beacon_hex: "6e470bc1fc410b1a12b72991da0a8b4d7cfc5c8872eff0a3d57ae0c8ecffdc7a",
            beacon_type: "Flow VRF testnet block ID",
            contributors: 1,
        },
        tx_hashes: txHashes,
        verification: {
            proxy_amount_disclose_verifier_matches: amtVerMatch,
            proxy_transfer_verifier_matches: xfrVerMatch,
            proxy_version_still_0_5_0: versionOk,
        },
        explorer: {
            proxy: `https://evm-testnet.flowscan.io/address/${PROXY}`,
            new_amount_verifier: `https://evm-testnet.flowscan.io/address/${amtAddr}`,
            new_transfer_verifier: `https://evm-testnet.flowscan.io/address/${xfrAddr}`,
            set_verifiers_evm_tx: txHashes.set_verifiers_evm
                ? `https://evm-testnet.flowscan.io/tx/${txHashes.set_verifiers_evm}`
                : null,
        },
    };

    writeFileSync(OUT_RECORD, JSON.stringify(record, null, 2) + "\n");
    console.log(`\nDeploy record written: ${OUT_RECORD}`);

    // Patch janus-flow-v0.3.json so downstream scripts see the new verifiers
    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));
    deploy.contracts.AmountDiscloseVerifier = amtAddr;
    deploy.contracts.ConfidentialTransferVerifier = xfrAddr;
    writeFileSync(DEPLOY_RECORD, JSON.stringify(deploy, null, 2) + "\n");
    console.log(`Patched deploy record:   ${DEPLOY_RECORD}`);

    // Also patch v0.5 record if it exists
    if (existsSync(V05_RECORD)) {
        const v05 = JSON.parse(readFileSync(V05_RECORD, "utf8"));
        v05.new_amount_disclose_verifier = amtAddr;
        v05.new_transfer_verifier = xfrAddr;
        writeFileSync(V05_RECORD, JSON.stringify(v05, null, 2) + "\n");
        console.log(`Patched v0.5 record:     ${V05_RECORD}`);
    }

    console.log("\n" + "=".repeat(72));
    console.log("JanusFlow v0.5.1 verifier rotation COMPLETE");
    console.log(`  AmountDiscloseVerifier:       ${amtAddr}`);
    console.log(`  ConfidentialTransferVerifier: ${xfrAddr}`);
    console.log(`  setVerifiers Cadence tx:      ${txHashes.set_verifiers_flow}`);
    console.log(`  setVerifiers EVM tx:          ${txHashes.set_verifiers_evm}`);
    console.log("=".repeat(72));
    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
