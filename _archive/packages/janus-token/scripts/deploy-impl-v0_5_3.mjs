/**
 * deploy-impl-v0_5_3.mjs — Deploy JanusFlow_v0_5_3 implementation contract.
 *
 * Deploys ONLY the implementation — does NOT upgrade the proxy.
 * Run upgrade-proxy-to-v0_5_3.mjs next.
 *
 * Run from package root:
 *   node scripts/deploy-impl-v0_5_3.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT    = join(__dirname, "..");
const ARTIFACTS      = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON      = join(MODULE_ROOT, "flow.json");

const ART_JANUSFLOW = join(ARTIFACTS, "JanusFlow_v0_5_3.sol/JanusFlow_v0_5_3.json");

const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";

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
    console.log("JanusFlow v0.5.3 — Deploy implementation contract");
    console.log("=".repeat(72));

    if (!existsSync(ART_JANUSFLOW)) {
        throw new Error(`Missing artifact: ${ART_JANUSFLOW} — run: npx hardhat compile`);
    }

    console.log("\n[1/1] Deploying JanusFlow_v0_5_3 impl...");
    const implBc = loadBytecode(ART_JANUSFLOW);
    console.log(`  bytecode: ${implBc.length / 2} bytes`);

    const implRes  = runFlowTx(DEPLOY_TX, [implBc], "v053_deploy_impl");
    const implAddr = extractDeployedAddress(implRes);
    const flowTxId = implRes?.id ?? "unknown";
    const evmTxHash = extractEvmTxHash(implRes);

    console.log(`  Flow tx:    ${flowTxId}`);
    console.log(`  EVM tx:     ${evmTxHash}`);
    console.log(`  address:    ${implAddr}`);

    if (!implAddr) {
        writeFileSync("/tmp/v053-impl-deploy-raw.json", JSON.stringify(implRes, null, 2));
        throw new Error("Failed to parse JanusFlow_v0_5_3 impl address — raw result in /tmp/v053-impl-deploy-raw.json");
    }

    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const record = {
        version: "0.5.3",
        date: new Date().toISOString(),
        network: "flow-evm-testnet",
        chainId: 545,
        impl_address: implAddr,
        deploy_tx_flow: flowTxId,
        deploy_tx_evm: evmTxHash,
        status: "impl_deployed — upgrade pending",
    };
    const OUT = join(DEPLOYMENTS_DIR, "janusflow-v0_5_3.json");
    writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
    console.log(`\nDeployment record: ${OUT}`);

    console.log("\n" + "=".repeat(72));
    console.log(`NEXT: node scripts/upgrade-proxy-to-v0_5_3.mjs`);
    console.log("=".repeat(72));
    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
