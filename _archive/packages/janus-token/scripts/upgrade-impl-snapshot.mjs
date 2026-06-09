/**
 * upgrade-impl-snapshot.mjs — Deploy snapshot-aware JanusFlow + JanusERC20 impls,
 * then UUPS-upgrade both proxies from the v066-admin COA.
 *
 * What this does:
 *   1. Deploy new JanusFlow impl (with encryptedSnapshot + ephPubkey in wrapWithProof)
 *   2. Deploy new JanusERC20 impl (same change)
 *   3. Call proxy.upgradeToAndCall(newImpl, 0x) on JanusFlow proxy
 *   4. Call proxy.upgradeToAndCall(newImpl, 0x) on JanusERC20 proxy
 *   5. Verify both upgrades via ERC1967 Upgraded event
 *   6. Persist new impl addresses to ../../deployments/aggregate-testnet.json
 *      (overwrites JanusFlow_impl_aggregate + JanusERC20_impl_aggregate — no vN suffixes)
 *
 * Run from packages/janus-token:
 *   node scripts/upgrade-impl-snapshot.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT     = join(__dirname, "..");
const REPO_ROOT       = join(MODULE_ROOT, "../..");
const JF_ARTIFACTS    = join(MODULE_ROOT, "artifacts/contracts/solidity");
const ERC20_ARTIFACTS = join(REPO_ROOT, "packages/janus-erc20/artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");
const DEPLOY_RECORD_PATH = join(DEPLOYMENTS_DIR, "aggregate-testnet.json");

const JF_ART_PATH   = join(JF_ARTIFACTS,    "JanusFlow.sol/JanusFlow.json");
const ERC20_ART_PATH = join(ERC20_ARTIFACTS, "JanusERC20.sol/JanusERC20.json");

// ── Admin account ─────────────────────────────────────────────────────────────
const ADMIN_CADENCE = "c4e8f99915893a2f";
const ADMIN_COA_EVM = "0x000000000000000000000002656f9205e386ed78";
const FLOW_SIGNER   = "v066-admin";
const PKEY_PATH     = "/home/oydual3/.flow/v066-admin.pkey";
const FLOW_JSON_TMP = "/tmp/upgrade_snapshot_flow.json";

const RPC_URL = "https://testnet.evm.nodes.onflow.org";

// ── Cadence transaction templates ─────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureFlowJson() {
    const base = JSON.parse(readFileSync(join(MODULE_ROOT, "flow.json"), "utf8"));
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
    writeFileSync(FLOW_JSON_TMP, JSON.stringify(cleaned, null, 2));
}

function runFlowTx(txBody, args, label, gasLimit = 9999) {
    const txPath = `/tmp/.upgrade_snap_${label}.cdc`;
    writeFileSync(txPath, txBody);
    const argStrs = args.map(a => `"${a}"`).join(" ");
    const cmd = [
        "flow transactions send", txPath, argStrs,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        `--gas-limit ${gasLimit}`,
        "--output json",
        `--config-path ${FLOW_JSON_TMP}`,
    ].join(" ");
    let result;
    try {
        const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
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

function extractDeployedAddress(result, coaEvm) {
    const blob = JSON.stringify(result?.events ?? []);
    // Try contractAddress field first
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    // Fallback: any 20-byte hex address that isn't the zero address or COA
    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        coaEvm.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    return fallback[0] ?? null;
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

async function deployAndUpgrade(name, artifactPath, proxyAddress, ifaceName, provider) {
    console.log(`\n── ${name} ──────────────────────────────────────────────────`);

    const art = JSON.parse(readFileSync(artifactPath, "utf8"));
    const iface = new Interface(art.abi);
    const bytecode = art.bytecode.startsWith("0x") ? art.bytecode.slice(2) : art.bytecode;

    console.log(`  Artifact:       ${artifactPath}`);
    console.log(`  Bytecode size:  ${bytecode.length / 2} bytes`);
    console.log(`  Proxy:          ${proxyAddress}`);

    // Sanity: wrapWithProof selector must be in bytecode
    const wrapSig = iface.getFunction("wrapWithProof").selector.slice(2);
    const hasWrap = bytecode.toLowerCase().includes(wrapSig.toLowerCase());
    console.log(`  wrapWithProof selector (${wrapSig}) in bytecode: ${hasWrap ? "YES" : "NO — ABORT"}`);
    if (!hasWrap) throw new Error(`${name}: wrapWithProof selector not found in bytecode`);

    // 1. Deploy new impl
    console.log(`\n  [1/3] Deploying new ${name} impl...`);
    const deployRes = runFlowTx(DEPLOY_TX, [bytecode], `deploy_${name.replace(/\s/g, "_")}`);
    const implAddress = extractDeployedAddress(deployRes, ADMIN_COA_EVM);
    const deployFlowTx = deployRes?.id ?? "unknown";
    const deployEvmTx  = extractEvmTxHash(deployRes);
    console.log(`  Flow tx:        ${deployFlowTx}`);
    console.log(`  EVM tx:         ${deployEvmTx}`);
    console.log(`  New impl:       ${implAddress}`);

    if (!implAddress) {
        writeFileSync(`/tmp/upgrade-snap-deploy-raw-${name}.json`, JSON.stringify(deployRes, null, 2));
        throw new Error(`${name}: failed to parse deployed impl address — raw saved to /tmp`);
    }

    // 2. upgradeToAndCall(newImpl, 0x)
    console.log(`\n  [2/3] Calling proxy.upgradeToAndCall(${implAddress}, 0x)...`);
    const upgradeCalldata = iface.encodeFunctionData("upgradeToAndCall", [implAddress, "0x"]);
    const upgradeRes = runFlowTx(
        CALL_TX,
        [proxyAddress, upgradeCalldata.slice(2)],
        `upgrade_${name.replace(/\s/g, "_")}`
    );
    const upgradeFlowTx = upgradeRes?.id ?? "unknown";
    const upgradeEvmTx  = extractEvmTxHash(upgradeRes);
    console.log(`  Flow tx:        ${upgradeFlowTx}`);
    console.log(`  EVM tx:         ${upgradeEvmTx}`);

    // 3. Verify via ERC1967 Upgraded event
    console.log(`\n  [3/3] Verifying upgrade via ERC1967 Upgraded event...`);
    const UPGRADED_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
    const rcpt = upgradeEvmTx ? await provider.getTransactionReceipt(upgradeEvmTx) : null;
    const upgEvt = rcpt?.logs?.find(l =>
        l.address.toLowerCase() === proxyAddress.toLowerCase() &&
        l.topics[0] === UPGRADED_TOPIC
    );
    const evtImpl = upgEvt ? "0x" + upgEvt.topics[1].slice(-40) : null;
    const upgraded = evtImpl ? evtImpl.toLowerCase() === implAddress.toLowerCase() : false;
    console.log(`  ERC1967 Upgraded impl = ${evtImpl ?? "(not found)"}`);
    console.log(`  Matches new impl:       ${upgraded ? "YES" : "NO — FAIL"}`);
    if (!upgraded) {
        throw new Error(`${name}: upgrade verification failed — Upgraded event missing or impl mismatch`);
    }

    // Quick spot-check: VERSION
    try {
        const versionHex = await provider.call({
            to: proxyAddress,
            data: iface.encodeFunctionData("VERSION"),
        });
        const version = iface.decodeFunctionResult("VERSION", versionHex)[0];
        console.log(`  proxy.VERSION():        ${version}`);
    } catch (e) {
        console.log(`  proxy.VERSION() probe: ${e.message}`);
    }

    return {
        impl_address: implAddress,
        tx_hashes: {
            impl_deploy_flow: deployFlowTx,
            impl_deploy_evm:  deployEvmTx,
            upgrade_flow:     upgradeFlowTx,
            upgrade_evm:      upgradeEvmTx,
        },
    };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log("=".repeat(72));
    console.log("Upgrade JanusFlow + JanusERC20 — snapshot-aware wrapWithProof");
    console.log("Network: Flow EVM Testnet (chainId 545)");
    console.log("Admin COA:", ADMIN_COA_EVM);
    console.log("=".repeat(72));

    ensureFlowJson();

    const provider = new JsonRpcProvider(RPC_URL);
    const deployRecord = JSON.parse(readFileSync(DEPLOY_RECORD_PATH, "utf8"));
    const CONTRACTS = deployRecord.contracts;

    const JF_PROXY   = CONTRACTS.JanusFlow_proxy;
    const ERC20_PROXY = CONTRACTS.JanusERC20_proxy;
    console.log(`JanusFlow proxy:  ${JF_PROXY}`);
    console.log(`JanusERC20 proxy: ${ERC20_PROXY}`);

    // Deploy + upgrade JanusFlow
    const jfResult = await deployAndUpgrade(
        "JanusFlow",
        JF_ART_PATH,
        JF_PROXY,
        "JanusFlow",
        provider
    );

    // Deploy + upgrade JanusERC20
    const erc20Result = await deployAndUpgrade(
        "JanusERC20",
        ERC20_ART_PATH,
        ERC20_PROXY,
        "JanusERC20",
        provider
    );

    // ── Persist to aggregate-testnet.json ─────────────────────────────────────
    console.log("\n── Updating deployments/aggregate-testnet.json ─────────────────────────");

    deployRecord.contracts.JanusFlow_impl_aggregate  = jfResult.impl_address;
    deployRecord.contracts.JanusERC20_impl_aggregate = erc20Result.impl_address;

    deployRecord.contract_status.JanusFlow_impl_aggregate  =
        "UPGRADED — snapshot-aware wrapWithProof (emits encryptedSnapshot + ephPubkey)";
    deployRecord.contract_status.JanusERC20_impl_aggregate =
        "UPGRADED — snapshot-aware wrapWithProof (emits encryptedSnapshot + ephPubkey)";

    const newTxHashes = {
        janusflow_impl_snapshot_deploy:  jfResult.tx_hashes.impl_deploy_flow,
        janusflow_upgrade_snapshot:      jfResult.tx_hashes.upgrade_flow,
        januserc20_impl_snapshot_deploy: erc20Result.tx_hashes.impl_deploy_flow,
        januserc20_upgrade_snapshot:     erc20Result.tx_hashes.upgrade_flow,
        // EVM tx hashes (from COA calls)
        janusflow_impl_snapshot_deploy_evm:  jfResult.tx_hashes.impl_deploy_evm,
        janusflow_upgrade_snapshot_evm:      jfResult.tx_hashes.upgrade_evm,
        januserc20_impl_snapshot_deploy_evm: erc20Result.tx_hashes.impl_deploy_evm,
        januserc20_upgrade_snapshot_evm:     erc20Result.tx_hashes.upgrade_evm,
    };
    Object.assign(deployRecord.tx_hashes, newTxHashes);

    // Update date
    deployRecord.date = new Date().toISOString().split("T")[0];

    writeFileSync(DEPLOY_RECORD_PATH, JSON.stringify(deployRecord, null, 2) + "\n");
    console.log(`  Written: ${DEPLOY_RECORD_PATH}`);

    // ── Final summary ─────────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(72));
    console.log("UPGRADE COMPLETE");
    console.log("=".repeat(72));
    console.log(`JanusFlow  new impl: ${jfResult.impl_address}`);
    console.log(`  deploy flow tx:    ${jfResult.tx_hashes.impl_deploy_flow}`);
    console.log(`  deploy evm  tx:    ${jfResult.tx_hashes.impl_deploy_evm}`);
    console.log(`  upgrade flow tx:   ${jfResult.tx_hashes.upgrade_flow}`);
    console.log(`  upgrade evm  tx:   ${jfResult.tx_hashes.upgrade_evm}`);
    console.log(`JanusERC20 new impl: ${erc20Result.impl_address}`);
    console.log(`  deploy flow tx:    ${erc20Result.tx_hashes.impl_deploy_flow}`);
    console.log(`  deploy evm  tx:    ${erc20Result.tx_hashes.impl_deploy_evm}`);
    console.log(`  upgrade flow tx:   ${erc20Result.tx_hashes.upgrade_flow}`);
    console.log(`  upgrade evm  tx:   ${erc20Result.tx_hashes.upgrade_evm}`);
    console.log("=".repeat(72));
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
