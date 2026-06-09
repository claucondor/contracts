/**
 * init-fees-v0.6.6.mjs — Initialize fee parameters on JanusFlow + JanusERC20 proxies.
 *
 * Sets feeRecipient = admin COA, feeBps = 10 (0.1%).
 * Must be called after deploy-v0.6.6.mjs.
 *
 * Run from repo root:
 *   node scripts/init-fees-v0.6.6.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");
const FLOW_JSON = "/tmp/v066_flow.json";

const ADMIN_COA_EVM = "0x000000000000000000000002656f9205e386ed78";
const FLOW_SIGNER   = "v066-admin";
const FEE_BPS       = 10;  // 0.1%

// Read deployed addresses
const record = JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, "v0.6.6-testnet.json"), "utf8"));
const JF_PROXY    = record.contracts.JanusFlow_proxy;
const ERC20_PROXY = record.contracts.JanusERC20_proxy;

const INIT_FEES_ABI = [
  "function initFees(address recipient, uint16 bps) external",
  "function feeRecipient() view returns (address)",
  "function feeBps() view returns (uint16)",
];

const CALL_TX = (calldataHex, proxyHex) => `import "EVM"

transaction(calldataHex: String, proxyHex: String) {
  prepare(signer: auth(BorrowValue) &Account) {
    let coa = signer.storage
      .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("No COA at /storage/evm")

    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 200_000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      result.status == EVM.Status.successful,
      message: "initFees failed: ".concat(result.errorMessage)
    )
  }
}`;

function runCallTx(calldataHex, proxyHex, label) {
    const tx = CALL_TX(calldataHex, proxyHex);
    const txPath = `/tmp/.v066_${label}.cdc`;
    writeFileSync(txPath, tx);
    const cmd = [
        "flow transactions send",
        txPath,
        `"${calldataHex}"`,
        `"${proxyHex}"`,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");
    let result;
    try {
        const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); }
            catch {
                throw new Error(`[${label}] ${err.stdout?.slice(0, 600)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}`);
        }
    }
    if (result.error) {
        throw new Error(`[${label}] tx failed: ${result.error.slice(0, 400)}`);
    }
    return result;
}

async function main() {
    console.log("=== init-fees v0.6.6 ===\n");
    console.log("JanusFlow proxy:   ", JF_PROXY);
    console.log("JanusERC20 proxy:  ", ERC20_PROXY);
    console.log("Fee recipient:     ", ADMIN_COA_EVM);
    console.log("feeBps:            ", FEE_BPS, "(0.1%)");
    console.log("");

    const iface = new Interface(INIT_FEES_ABI);

    // JanusFlow initFees
    console.log("[1/2] initFees on JanusFlow proxy...");
    const jfCalldata = iface.encodeFunctionData("initFees", [ADMIN_COA_EVM, FEE_BPS]).slice(2);
    const jfResult = runCallTx(jfCalldata, JF_PROXY, "jf_initfees");
    console.log("  tx:", jfResult.id);

    // JanusERC20 initFees
    console.log("\n[2/2] initFees on JanusERC20 proxy...");
    const erc20Calldata = iface.encodeFunctionData("initFees", [ADMIN_COA_EVM, FEE_BPS]).slice(2);
    const erc20Result = runCallTx(erc20Calldata, ERC20_PROXY, "erc20_initfees");
    console.log("  tx:", erc20Result.id);

    // Update deployment record
    record.fee_status = "INITIALIZED";
    record.fee_config = {
        recipient: ADMIN_COA_EVM,
        feeBps: FEE_BPS,
        description: "0.1% fee to admin COA",
    };
    record.tx_hashes.janusflow_initfees = jfResult.id;
    record.tx_hashes.januserc20_initfees = erc20Result.id;
    writeFileSync(join(DEPLOYMENTS_DIR, "v0.6.6-testnet.json"), JSON.stringify(record, null, 2) + "\n");

    console.log("\n=== Fee initialization complete ===");
    console.log("Deployment record updated.");
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
