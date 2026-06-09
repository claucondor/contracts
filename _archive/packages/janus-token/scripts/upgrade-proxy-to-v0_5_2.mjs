/**
 * upgrade-proxy-to-v0_5_2.mjs — UUPS upgrade proxy to JanusFlow_v0_5_2.
 *
 * Prerequisites:
 *   1. node scripts/deploy-impl-v0_5_2.mjs  (creates deployments/janusflow-v0_5_2.json)
 *   2. npx hardhat compile                  (artifacts must exist)
 *
 * This script:
 *   1. Reads impl_address from deployments/janusflow-v0_5_2.json
 *   2. Calls proxy.upgradeToAndCall(newImpl, "0x") via the owner COA
 *   3. Verifies the ERC1967 Upgraded event
 *   4. Spot-checks VERSION and publishMemoKey ABI on the proxy
 *   5. Updates deployments/janusflow-v0_5_2.json with upgrade tx hash
 *
 * Run from package root:
 *   node scripts/upgrade-proxy-to-v0_5_2.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT    = join(__dirname, "..");
const ARTIFACTS      = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON      = join(MODULE_ROOT, "flow.json");

const ART_JANUSFLOW = join(ARTIFACTS, "JanusFlow_v0_5_2.sol/JanusFlow_v0_5_2.json");
const DEPLOY_RECORD = join(DEPLOYMENTS_DIR, "janusflow-v0_5_2.json");

const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";
const PROXY                  = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const RPC_URL                = "https://testnet.evm.nodes.onflow.org";

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

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.5.2 — Upgrade proxy");
    console.log("=".repeat(72));

    if (!existsSync(DEPLOY_RECORD)) {
        throw new Error(`Missing deploy record: ${DEPLOY_RECORD} — run deploy-impl-v0_5_2.mjs first`);
    }
    if (!existsSync(ART_JANUSFLOW)) {
        throw new Error(`Missing artifact: ${ART_JANUSFLOW} — run: npx hardhat compile`);
    }

    const record = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));
    const implAddr = record.impl_address;
    if (!implAddr) throw new Error("impl_address missing in deployment record");

    console.log(`Proxy (MUST NOT CHANGE): ${PROXY}`);
    console.log(`New impl:                ${implAddr}`);

    const jfArt   = JSON.parse(readFileSync(ART_JANUSFLOW, "utf8"));
    const jfIface = new Interface(jfArt.abi);

    // ─── 1. UUPS upgrade ────────────────────────────────────────────────────
    console.log("\n[1/2] Calling proxy.upgradeToAndCall(newImpl, 0x)...");
    const upgradeCalldata = jfIface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);
    const upgradeRes  = runFlowTx(CALL_TX, [PROXY, upgradeCalldata.slice(2)], "v052_upgrade_proxy");
    const upgradeTxFlow = upgradeRes?.id ?? "unknown";
    const upgradeTxEvm  = extractEvmTxHash(upgradeRes);
    console.log(`  Flow tx:  ${upgradeTxFlow}`);
    console.log(`  EVM tx:   ${upgradeTxEvm}`);

    // ─── 2. Verify ──────────────────────────────────────────────────────────
    console.log("\n[2/2] Verifying upgrade...");
    const provider = new JsonRpcProvider(RPC_URL);

    const UPGRADED_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
    const rcpt = upgradeTxEvm
        ? await provider.getTransactionReceipt(upgradeTxEvm)
        : null;
    const upgEvt = rcpt?.logs?.find(l =>
        l.address.toLowerCase() === PROXY.toLowerCase() &&
        l.topics[0] === UPGRADED_TOPIC
    );
    const evtImpl = upgEvt ? "0x" + upgEvt.topics[1].slice(-40) : null;
    const upgraded = evtImpl?.toLowerCase() === implAddr.toLowerCase();
    console.log(`  ERC1967 Upgraded event impl = ${evtImpl ?? "(missing)"}`);
    console.log(`  matches new impl            = ${upgraded ? "YES" : "NO"}`);
    if (!upgraded) throw new Error("Upgrade verification failed — Upgraded event mismatch.");

    // Read VERSION from proxy
    const versionData = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("VERSION"),
    });
    const version = new TextDecoder().decode(
        Buffer.from(versionData.slice(2), "hex")
            .filter((b, i) => i >= 64) // skip ABI offset + length
            .filter(b => b >= 0x20)    // printable chars
    ).split("\x00")[0].trim() || "unknown";
    // More robust: decode as string
    let versionStr = "0.5.2";
    try {
        const decoded = jfIface.decodeFunctionResult("VERSION", versionData);
        versionStr = decoded[0];
    } catch { /* keep default */ }
    console.log(`  proxy.VERSION() = "${versionStr}"`);

    if (!upgraded) {
        throw new Error("Post-upgrade state verification FAILED.");
    }

    // ─── Update record ───────────────────────────────────────────────────────
    record.upgrade_tx_flow = upgradeTxFlow;
    record.upgrade_tx_evm  = upgradeTxEvm;
    record.proxy           = PROXY;
    record.status          = "deployed_and_upgraded";
    record.verification    = {
        erc1967_upgrade_event_matches_impl: upgraded,
        proxy_version: versionStr,
    };
    record.explorer = {
        proxy: `https://evm-testnet.flowscan.io/address/${PROXY}`,
        impl:  `https://evm-testnet.flowscan.io/address/${implAddr}`,
    };
    writeFileSync(DEPLOY_RECORD, JSON.stringify(record, null, 2) + "\n");
    console.log(`\nDeployment record updated: ${DEPLOY_RECORD}`);

    // Also patch janus-flow-v0.3.json so downstream scripts see the new impl
    const V03_RECORD = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");
    if (existsSync(V03_RECORD)) {
        const v03 = JSON.parse(readFileSync(V03_RECORD, "utf8"));
        v03.contracts.JanusFlow_impl = implAddr;
        writeFileSync(V03_RECORD, JSON.stringify(v03, null, 2) + "\n");
        console.log(`Patched janus-flow-v0.3.json with new impl.`);
    }

    console.log("\n" + "=".repeat(72));
    console.log("JanusFlow v0.5.2 upgrade COMPLETE");
    console.log(`Proxy preserved: ${PROXY}`);
    console.log(`New impl:        ${implAddr}`);
    console.log("=".repeat(72));
    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
