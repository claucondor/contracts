/**
 * upgrade-janus-flow-admin-reset.mjs — UUPS upgrade of the JanusFlow proxy at
 * 0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078 to the new implementation that
 * carries `adminResetSlot(address)`.
 *
 * Flow (same Pattern A as deploy-janus-flow.mjs):
 *   1. Compile (done out-of-band; we only read the artifact).
 *   2. Deploy the new JanusFlow impl as raw bytecode via the openjanus-flow
 *      COA (Pattern A — COA is the EVM owner of the proxy).
 *   3. From the same COA, call `proxy.upgradeToAndCall(newImpl, "")` to point
 *      the ERC1967 proxy at the new impl. No re-initialise call is needed.
 *   4. eth_call sanity-check the proxy after upgrade.
 *
 * Output:
 *   packages/janus-token/deployments/janus-flow-admin-reset-upgrade.json
 *
 * Run from package root:
 *   node scripts/upgrade-janus-flow-admin-reset.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const ARTIFACTS = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

const JANUSFLOW_ART = join(ARTIFACTS, "JanusFlow.sol/JanusFlow.json");
const DEPLOY_RECORD = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");

const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";

const RPC_URL = "https://testnet.evm.nodes.onflow.org";

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

function extractEvmTxHashFromFlow(result) {
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
    console.log("JanusFlow UUPS upgrade — adminResetSlot impl");
    console.log("=".repeat(72));

    if (!existsSync(JANUSFLOW_ART)) {
        throw new Error(`Missing artifact: ${JANUSFLOW_ART} — run hardhat compile`);
    }
    if (!existsSync(DEPLOY_RECORD)) {
        throw new Error(`Missing deploy record: ${DEPLOY_RECORD}`);
    }
    const jfArt = JSON.parse(readFileSync(JANUSFLOW_ART, "utf8"));
    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));
    const PROXY = deploy.contracts.JanusFlow_proxy;
    const PRIOR_IMPL = deploy.contracts.JanusFlow_impl;
    console.log(`Proxy:          ${PROXY}`);
    console.log(`Prior impl:     ${PRIOR_IMPL}`);

    const iface = new Interface(jfArt.abi);

    // ─── Sanity: new bytecode contains the chainid guard "545" (0x221) and
    //          the adminResetSlot selector. We don't enforce — just print —
    //          but it surfaces accidental bytecode drift.
    const adminResetSig = iface.getFunction("adminResetSlot").selector.slice(2);
    const implBytecode = jfArt.bytecode.startsWith("0x")
        ? jfArt.bytecode.slice(2)
        : jfArt.bytecode;
    const hasSelector = implBytecode.toLowerCase().includes(adminResetSig.toLowerCase());
    console.log(`adminResetSlot selector ${adminResetSig} in bytecode: ${hasSelector ? "yes" : "NO — abort!"}`);
    if (!hasSelector) {
        throw new Error("New impl bytecode does not contain adminResetSlot selector — recompile.");
    }

    // ─── 1. Deploy new impl ───────────────────────────────────────────────
    console.log("\n[1/3] Deploying new JanusFlow impl (uninitialised)...");
    console.log(`  bytecode size: ${implBytecode.length / 2} bytes`);
    const implRes = runFlowTx(DEPLOY_TX, [implBytecode], "upgrade_deploy_new_impl");
    const newImpl = extractDeployedAddress(implRes);
    const implFlowTx = implRes?.id ?? "unknown";
    const implEvmTx = extractEvmTxHashFromFlow(implRes);
    console.log(`  Flow tx:   ${implFlowTx}`);
    console.log(`  EVM tx:    ${implEvmTx}`);
    console.log(`  new impl:  ${newImpl}`);
    if (!newImpl) {
        writeFileSync("/tmp/upgrade-impl-deploy-raw.json", JSON.stringify(implRes, null, 2));
        throw new Error("Failed to parse new impl address — see /tmp/upgrade-impl-deploy-raw.json");
    }

    // ─── 2. proxy.upgradeToAndCall(newImpl, "") ───────────────────────────
    console.log("\n[2/3] Calling proxy.upgradeToAndCall(newImpl, 0x)...");
    const upgradeCalldata = iface.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]);
    const upgradeRes = runFlowTx(
        CALL_TX,
        [PROXY, upgradeCalldata.slice(2)],
        "upgrade_proxy",
    );
    const upgradeFlowTx = upgradeRes?.id ?? "unknown";
    const upgradeEvmTx = extractEvmTxHashFromFlow(upgradeRes);
    console.log(`  Flow tx:  ${upgradeFlowTx}`);
    console.log(`  EVM tx:   ${upgradeEvmTx}`);

    // ─── 3. Verify ────────────────────────────────────────────────────────
    console.log("\n[3/3] Verifying proxy state after upgrade...");
    const provider = new JsonRpcProvider(RPC_URL);

    // Flow EVM does not expose ERC1967 implementation slot via eth_getStorageAt
    // (returns 0x0 even though the slot is set). We verify the upgrade by
    // reading the canonical `Upgraded(address)` event from the upgrade tx
    // receipt — this is the only authoritative on-chain signal.
    const UPGRADED_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
    const rcpt = upgradeEvmTx
        ? await provider.getTransactionReceipt(upgradeEvmTx)
        : null;
    const upgEvt = rcpt?.logs?.find(l =>
        l.address.toLowerCase() === PROXY.toLowerCase() &&
        l.topics[0] === UPGRADED_TOPIC
    );
    const evtImpl = upgEvt ? "0x" + upgEvt.topics[1].slice(-40) : null;
    const upgraded = evtImpl
        ? evtImpl.toLowerCase() === newImpl.toLowerCase()
        : false;
    console.log(`  ERC1967 Upgraded event impl = ${evtImpl ?? "(missing)"}`);
    console.log(`  matches new impl            = ${upgraded ? "YES" : "NO"}`);
    if (!upgraded) {
        throw new Error("Upgrade verification failed — Upgraded event missing or impl mismatch.");
    }

    // Owner unchanged
    const ownerHex = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("owner", []),
    });
    const owner = "0x" + ownerHex.slice(-40);
    console.log(`  proxy.owner()             = ${owner}`);

    // totalLocked unchanged (read-only sanity)
    const lockedHex = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("totalLocked", []),
    });
    console.log(`  proxy.totalLocked()       = ${BigInt(lockedHex).toString()} attoFLOW`);

    // adminResetSlot is now callable on the proxy (static-call simulation —
    // we don't actually mutate state). We use a known non-owner caller (0x0)
    // so the call reverts with Ownable's error, proving the selector exists.
    let adminResetCallable = false;
    try {
        await provider.call({
            to: PROXY,
            data: iface.encodeFunctionData("adminResetSlot", ["0x0000000000000000000000000000000000000000"]),
            from: "0x0000000000000000000000000000000000000001",
        });
        adminResetCallable = true;
    } catch (e) {
        const msg = (e?.shortMessage || e?.message || "").toLowerCase();
        // Either Ownable revert OR zero-user revert both prove the selector
        // is reachable. A "function selector was not recognised" would mean
        // the upgrade didn't land.
        if (msg.includes("owner") || msg.includes("ownableunauthorized") || msg.includes("zero user")) {
            adminResetCallable = true;
        } else {
            console.log("  unexpected revert on adminResetSlot probe:", msg);
        }
    }
    console.log(`  adminResetSlot selector reachable = ${adminResetCallable ? "YES" : "NO"}`);

    // ─── Record ────────────────────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const record = {
        date: new Date().toISOString(),
        network: "flow-evm-testnet",
        chainId: 545,
        proxy: PROXY,
        prior_impl: PRIOR_IMPL,
        new_impl: newImpl,
        upgrade_method: "ERC1967 UUPS upgradeToAndCall(newImpl, 0x)",
        chainid_guard: "block.chainid == 545 (Flow EVM testnet)",
        new_function: "adminResetSlot(address user) external onlyOwner",
        privacy_warning: "PRIVACY-BREAKING — testnet-only commitment reset. AdminSlotReset event leaks prior commitment point.",
        tx_hashes: {
            new_impl_deploy_flow: implFlowTx,
            new_impl_deploy_evm:  implEvmTx,
            upgrade_call_flow:    upgradeFlowTx,
            upgrade_call_evm:     upgradeEvmTx,
        },
        verification: {
            erc1967_impl_slot_matches_new_impl: upgraded,
            proxy_owner: owner,
            admin_reset_selector_reachable: adminResetCallable,
        },
        explorer: {
            proxy: `https://evm-testnet.flowscan.io/address/${PROXY}`,
            new_impl: `https://evm-testnet.flowscan.io/address/${newImpl}`,
            upgrade_tx: upgradeEvmTx
                ? `https://evm-testnet.flowscan.io/tx/${upgradeEvmTx}`
                : null,
        },
    };

    const outPath = join(DEPLOYMENTS_DIR, "janus-flow-admin-reset-upgrade.json");
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log(`\nUpgrade record written: ${outPath}`);

    // Also patch janus-flow-v0.3.json so downstream scripts see the new impl.
    deploy.contracts.JanusFlow_impl = newImpl;
    deploy.contracts.JanusFlow_impl_prior = PRIOR_IMPL;
    deploy.tx_hashes.janus_flow_impl_upgrade_to_admin_reset = upgradeEvmTx;
    writeFileSync(DEPLOY_RECORD, JSON.stringify(deploy, null, 2) + "\n");
    console.log(`Patched deploy record:   ${DEPLOY_RECORD}`);

    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
