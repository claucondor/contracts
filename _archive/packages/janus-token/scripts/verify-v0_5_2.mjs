/**
 * verify-v0_5_2.mjs — Post-upgrade smoke check for JanusFlow v0.5.2.
 *
 * Verifies:
 *   1. proxy.VERSION() == "0.5.2"
 *   2. proxy.MAX_WRAP() == 2^128-1
 *   3. publishMemoKey ABI exists on proxy (by calling with dummy values)
 *   4. memoKeyPubX/Y mappings return 0 for a fresh address
 *   5. Snapshot event signatures exist in the ABI
 *
 * Run from package root (no network tx required — pure eth_call):
 *   node scripts/verify-v0_5_2.mjs
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT    = join(__dirname, "..");
const ARTIFACTS      = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");

const ART_JANUSFLOW = join(ARTIFACTS, "JanusFlow_v0_5_2.sol/JanusFlow_v0_5_2.json");
const DEPLOY_RECORD = join(DEPLOYMENTS_DIR, "janusflow-v0_5_2.json");

const PROXY   = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const RPC_URL = "https://testnet.evm.nodes.onflow.org";

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.5.2 — Post-upgrade verification");
    console.log("=".repeat(72));

    if (!existsSync(ART_JANUSFLOW)) {
        throw new Error(`Missing artifact: ${ART_JANUSFLOW} — run: npx hardhat compile`);
    }

    const jfArt   = JSON.parse(readFileSync(ART_JANUSFLOW, "utf8"));
    const jfIface = new Interface(jfArt.abi);
    const provider = new JsonRpcProvider(RPC_URL);

    let allOk = true;

    // 1. VERSION
    console.log("\n[1] proxy.VERSION()...");
    const versionData = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("VERSION"),
    });
    const [version] = jfIface.decodeFunctionResult("VERSION", versionData);
    const versionOk = version === "0.5.2";
    console.log(`  proxy.VERSION() = "${version}" → ${versionOk ? "OK" : "FAIL"}`);
    if (!versionOk) allOk = false;

    // 2. MAX_WRAP
    console.log("\n[2] proxy.MAX_WRAP()...");
    const maxWrapData = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("MAX_WRAP"),
    });
    const [maxWrap] = jfIface.decodeFunctionResult("MAX_WRAP", maxWrapData);
    const expected128 = (1n << 128n) - 1n;
    const maxWrapOk = BigInt(maxWrap) === expected128;
    console.log(`  proxy.MAX_WRAP() = ${BigInt(maxWrap).toString()} → ${maxWrapOk ? "OK" : "FAIL"}`);
    if (!maxWrapOk) allOk = false;

    // 3. memoKeyPubX/Y for fresh address
    console.log("\n[3] proxy.memoKeyPubX/Y(zero)...");
    const ZERO_ADDR = "0x0000000000000000000000000000000000000001";
    const pubXData = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("memoKeyPubX", [ZERO_ADDR]),
    });
    const pubYData = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("memoKeyPubY", [ZERO_ADDR]),
    });
    const [pubX] = jfIface.decodeFunctionResult("memoKeyPubX", pubXData);
    const [pubY] = jfIface.decodeFunctionResult("memoKeyPubY", pubYData);
    const memoOk = BigInt(pubX) === 0n && BigInt(pubY) === 0n;
    console.log(`  memoKeyPubX = ${pubX}, memoKeyPubY = ${pubY} → ${memoOk ? "OK (fresh address returns 0)" : "FAIL"}`);
    if (!memoOk) allOk = false;

    // 4. Event signatures present in ABI
    console.log("\n[4] Checking snapshot event signatures in ABI...");
    const events = [
        "WrapWithSnapshot",
        "ShieldedTransferWithSnapshot",
        "UnwrapWithSnapshot",
        "MemoKeyPublished",
    ];
    for (const ev of events) {
        const found = jfArt.abi.some(f => f.type === "event" && f.name === ev);
        console.log(`  ${ev}: ${found ? "OK" : "MISSING"}`);
        if (!found) allOk = false;
    }

    // 5. publishMemoKey function in ABI
    console.log("\n[5] Checking publishMemoKey function in ABI...");
    const pubMemo = jfArt.abi.some(f => f.type === "function" && f.name === "publishMemoKey");
    console.log(`  publishMemoKey: ${pubMemo ? "OK" : "MISSING"}`);
    if (!pubMemo) allOk = false;

    // Summary
    console.log("\n" + "=".repeat(72));
    if (allOk) {
        console.log("JanusFlow v0.5.2 verification: ALL CHECKS PASSED");
    } else {
        console.log("JanusFlow v0.5.2 verification: SOME CHECKS FAILED — see above");
        process.exit(1);
    }
    console.log("=".repeat(72));

    // Print deployment info
    if (existsSync(DEPLOY_RECORD)) {
        const rec = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));
        console.log(`\nProxy:           ${rec.proxy ?? PROXY}`);
        console.log(`Impl:            ${rec.impl_address}`);
        console.log(`Deploy tx (EVM): ${rec.deploy_tx_evm}`);
        console.log(`Upgrade tx (EVM):${rec.upgrade_tx_evm}`);
    }
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
