/**
 * verify-admin-reset.mjs — Verify that adminResetSlot zeroed a target's
 * commitment slot on the JanusFlow EVM proxy.
 *
 * Usage:
 *   node scripts/verify-admin-reset.mjs <evmAddress | flowAddress>
 *
 *   If a Flow Cadence address is passed (starts with 0x and is 16 hex digits),
 *   the script resolves the COA EVM address via the /public/evm capability on
 *   that account; otherwise it treats the arg as a 20-byte EVM address.
 */

import { JsonRpcProvider, Interface } from "ethers";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const ART = join(MODULE_ROOT, "artifacts/contracts/solidity/JanusFlow.sol/JanusFlow.json");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

const PROXY = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const RPC = "https://testnet.evm.nodes.onflow.org";

function resolveFlowCOA(flowAddr) {
    const script = `
import "EVM"
access(all) fun main(target: Address): String? {
    let acct = getAccount(target)
    let coaRef = acct.capabilities.borrow<&EVM.CadenceOwnedAccount>(/public/evm)
    if coaRef == nil { return nil }
    return coaRef!.address().toString()
}
`;
    const path = "/tmp/.verify_admin_reset_coa.cdc";
    writeFileSync(path, script);
    const stdout = execSync(
        `flow scripts execute ${path} ${flowAddr} --network testnet --output json --config-path ${FLOW_JSON}`,
        { encoding: "utf8", cwd: MODULE_ROOT },
    );
    const parsed = JSON.parse(stdout);
    const hex = parsed?.value?.value;
    if (!hex) return null;
    return "0x" + hex.toLowerCase().padStart(40, "0");
}

async function main() {
    const arg = process.argv[2];
    if (!arg) {
        console.error("usage: node verify-admin-reset.mjs <evmAddress | flowAddress>");
        process.exit(1);
    }
    let evmAddr;
    const cleaned = arg.toLowerCase().replace(/^0x/, "");
    if (cleaned.length === 16) {
        console.log(`Treating ${arg} as Flow Cadence address; resolving COA...`);
        evmAddr = resolveFlowCOA(arg);
        if (!evmAddr) {
            console.error("Could not resolve COA at /public/evm");
            process.exit(2);
        }
        console.log(`COA EVM address: ${evmAddr}`);
    } else if (cleaned.length === 40 || cleaned.length === 64) {
        evmAddr = "0x" + cleaned.padStart(64, "0").slice(-40);
    } else {
        console.error(`unrecognised address length: ${cleaned.length}`);
        process.exit(3);
    }

    const provider = new JsonRpcProvider(RPC);
    const iface = new Interface(JSON.parse(readFileSync(ART, "utf8")).abi);

    const r = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("balanceOfCommitmentXY", [evmAddr]),
    });
    const x = BigInt("0x" + r.slice(2, 66));
    const y = BigInt("0x" + r.slice(66, 130));
    const isIdentity = x === 0n && y === 1n;
    console.log(`commitment[${evmAddr}]:`);
    console.log(`  x = ${x.toString()}`);
    console.log(`  y = ${y.toString()}`);
    console.log(`  identity (0, 1)? ${isIdentity ? "YES — slot is fresh" : "no — slot still carries a commitment"}`);
    process.exit(isIdentity ? 0 : 1);
}

main().catch(err => {
    console.error("FATAL:", err.message);
    process.exit(99);
});
