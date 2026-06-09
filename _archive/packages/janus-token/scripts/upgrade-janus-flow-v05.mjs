/**
 * upgrade-janus-flow-v05.mjs — v0.5 ceremony upgrade of JanusFlow.
 *
 * Steps:
 *   1. Deploy AmountDiscloseVerifier (v0.5 ceremony) via COA.
 *   2. Deploy ConfidentialTransferVerifier (v0.5 ceremony) via COA.
 *   3. Deploy JanusFlow_v0_5 impl (with setVerifiers + 2^128 MAX_WRAP) via COA.
 *   4. UUPS upgrade proxy → new impl (upgradeToAndCall).
 *   5. Call setVerifiers(newAmountVerifier, newTransferVerifier) on proxy.
 *   6. eth_call sanity checks on proxy.
 *   7. Write deployments/janus-flow-v0.5.json.
 *
 * Run from package root:
 *   node scripts/upgrade-janus-flow-v05.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT    = join(__dirname, "..");
const ARTIFACTS      = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON      = join(MODULE_ROOT, "flow.json");

// Artifact paths
const ART_AMOUNT    = join(ARTIFACTS, "AmountDiscloseVerifier.sol/AmountDiscloseVerifier.json");
const ART_TRANSFER  = join(ARTIFACTS, "ConfidentialTransferVerifier.sol/ConfidentialTransferVerifier.json");
const ART_JANUSFLOW = join(ARTIFACTS, "JanusFlow_v0_5.sol/JanusFlow_v0_5.json");

const DEPLOY_RECORD = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");
const OUT_RECORD    = join(DEPLOYMENTS_DIR, "janus-flow-v0.5.json");

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
    console.log("JanusFlow v0.5 upgrade — 2^128 cap + setVerifiers + v0.5 ceremony");
    console.log("=".repeat(72));

    for (const [label, path] of [
        ["AmountDiscloseVerifier", ART_AMOUNT],
        ["ConfidentialTransferVerifier", ART_TRANSFER],
        ["JanusFlow_v0_5", ART_JANUSFLOW],
    ]) {
        if (!existsSync(path)) throw new Error(`Missing artifact: ${path} — run hardhat compile`);
    }
    if (!existsSync(DEPLOY_RECORD)) throw new Error(`Missing deploy record: ${DEPLOY_RECORD}`);

    const deploy = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));
    const PROXY  = deploy.contracts.JanusFlow_proxy;
    console.log(`Proxy (MUST NOT CHANGE): ${PROXY}`);

    const jfArt   = JSON.parse(readFileSync(ART_JANUSFLOW, "utf8"));
    const jfIface = new Interface(jfArt.abi);

    const txHashes = {};

    // ─── 1. Deploy AmountDiscloseVerifier ───────────────────────────────────
    console.log("\n[1/5] Deploying AmountDiscloseVerifier (v0.5 ceremony)...");
    const amtBc = loadBytecode(ART_AMOUNT);
    console.log(`  bytecode: ${amtBc.length / 2} bytes`);
    const amtRes   = runFlowTx(DEPLOY_TX, [amtBc], "v05_deploy_amount_verifier");
    const amtAddr  = extractDeployedAddress(amtRes);
    txHashes.amount_verifier_deploy_flow = amtRes?.id ?? "unknown";
    txHashes.amount_verifier_deploy_evm  = extractEvmTxHash(amtRes);
    console.log(`  Flow tx:    ${txHashes.amount_verifier_deploy_flow}`);
    console.log(`  EVM tx:     ${txHashes.amount_verifier_deploy_evm}`);
    console.log(`  address:    ${amtAddr}`);
    if (!amtAddr) {
        writeFileSync("/tmp/v05-amount-deploy-raw.json", JSON.stringify(amtRes, null, 2));
        throw new Error("Failed to parse AmountDiscloseVerifier address");
    }

    // ─── 2. Deploy ConfidentialTransferVerifier ──────────────────────────────
    console.log("\n[2/5] Deploying ConfidentialTransferVerifier (v0.5 ceremony)...");
    const xfrBc  = loadBytecode(ART_TRANSFER);
    console.log(`  bytecode: ${xfrBc.length / 2} bytes`);
    const xfrRes  = runFlowTx(DEPLOY_TX, [xfrBc], "v05_deploy_transfer_verifier");
    const xfrAddr = extractDeployedAddress(xfrRes);
    txHashes.transfer_verifier_deploy_flow = xfrRes?.id ?? "unknown";
    txHashes.transfer_verifier_deploy_evm  = extractEvmTxHash(xfrRes);
    console.log(`  Flow tx:    ${txHashes.transfer_verifier_deploy_flow}`);
    console.log(`  EVM tx:     ${txHashes.transfer_verifier_deploy_evm}`);
    console.log(`  address:    ${xfrAddr}`);
    if (!xfrAddr) {
        writeFileSync("/tmp/v05-transfer-deploy-raw.json", JSON.stringify(xfrRes, null, 2));
        throw new Error("Failed to parse ConfidentialTransferVerifier address");
    }

    // ─── 3. Deploy JanusFlow_v0_5 impl ──────────────────────────────────────
    console.log("\n[3/5] Deploying JanusFlow_v0_5 impl...");
    const implBc   = loadBytecode(ART_JANUSFLOW);
    console.log(`  bytecode: ${implBc.length / 2} bytes`);
    const implRes  = runFlowTx(DEPLOY_TX, [implBc], "v05_deploy_impl");
    const implAddr = extractDeployedAddress(implRes);
    txHashes.impl_deploy_flow = implRes?.id ?? "unknown";
    txHashes.impl_deploy_evm  = extractEvmTxHash(implRes);
    console.log(`  Flow tx:    ${txHashes.impl_deploy_flow}`);
    console.log(`  EVM tx:     ${txHashes.impl_deploy_evm}`);
    console.log(`  address:    ${implAddr}`);
    if (!implAddr) {
        writeFileSync("/tmp/v05-impl-deploy-raw.json", JSON.stringify(implRes, null, 2));
        throw new Error("Failed to parse JanusFlow_v0_5 impl address");
    }

    // ─── 4. UUPS upgrade: proxy → new impl ──────────────────────────────────
    console.log("\n[4/5] Calling proxy.upgradeToAndCall(newImpl, 0x)...");
    const upgradeCalldata = jfIface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);
    const upgradeRes  = runFlowTx(CALL_TX, [PROXY, upgradeCalldata.slice(2)], "v05_upgrade_proxy");
    txHashes.upgrade_flow = upgradeRes?.id ?? "unknown";
    txHashes.upgrade_evm  = extractEvmTxHash(upgradeRes);
    console.log(`  Flow tx:  ${txHashes.upgrade_flow}`);
    console.log(`  EVM tx:   ${txHashes.upgrade_evm}`);

    // ─── 5. setVerifiers ─────────────────────────────────────────────────────
    console.log("\n[5/5] Calling proxy.setVerifiers(newAmtVerifier, newXfrVerifier)...");
    const setVCalldata = jfIface.encodeFunctionData("setVerifiers", [amtAddr, xfrAddr]);
    const setVRes  = runFlowTx(CALL_TX, [PROXY, setVCalldata.slice(2)], "v05_set_verifiers");
    txHashes.set_verifiers_flow = setVRes?.id ?? "unknown";
    txHashes.set_verifiers_evm  = extractEvmTxHash(setVRes);
    console.log(`  Flow tx:  ${txHashes.set_verifiers_flow}`);
    console.log(`  EVM tx:   ${txHashes.set_verifiers_evm}`);

    // ─── 6. Verify on-chain state ─────────────────────────────────────────────
    console.log("\nVerifying on-chain state...");
    const provider = new JsonRpcProvider(RPC_URL);

    // Verify upgrade via Upgraded event
    const UPGRADED_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
    const rcpt = txHashes.upgrade_evm
        ? await provider.getTransactionReceipt(txHashes.upgrade_evm)
        : null;
    const upgEvt  = rcpt?.logs?.find(l =>
        l.address.toLowerCase() === PROXY.toLowerCase() &&
        l.topics[0] === UPGRADED_TOPIC
    );
    const evtImpl = upgEvt ? "0x" + upgEvt.topics[1].slice(-40) : null;
    const upgraded = evtImpl?.toLowerCase() === implAddr.toLowerCase();
    console.log(`  ERC1967 Upgraded event impl = ${evtImpl ?? "(missing)"}`);
    console.log(`  matches new impl            = ${upgraded ? "YES" : "NO"}`);
    if (!upgraded) throw new Error("Upgrade verification failed — Upgraded event mismatch.");

    // Read amountDiscloseVerifier() from proxy
    const amtVerOnChain = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("amountDiscloseVerifier"),
    });
    const amtVerAddr = "0x" + amtVerOnChain.slice(-40);
    const amtVerMatch = amtVerAddr.toLowerCase() === amtAddr.toLowerCase();
    console.log(`  proxy.amountDiscloseVerifier() = ${amtVerAddr}`);
    console.log(`  matches new verifier           = ${amtVerMatch ? "YES" : "NO"}`);

    // Read transferVerifier() from proxy
    const xfrVerOnChain = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("transferVerifier"),
    });
    const xfrVerAddr = "0x" + xfrVerOnChain.slice(-40);
    const xfrVerMatch = xfrVerAddr.toLowerCase() === xfrAddr.toLowerCase();
    console.log(`  proxy.transferVerifier()       = ${xfrVerAddr}`);
    console.log(`  matches new verifier           = ${xfrVerMatch ? "YES" : "NO"}`);

    // Read MAX_WRAP
    const maxWrapHex = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("MAX_WRAP"),
    });
    const maxWrap = BigInt(maxWrapHex);
    const expected128 = (1n << 128n) - 1n;
    const maxWrapOk = maxWrap === expected128;
    console.log(`  proxy.MAX_WRAP()               = ${maxWrap.toString()}`);
    console.log(`  equals 2^128-1                 = ${maxWrapOk ? "YES" : "NO"}`);

    // totalLocked unchanged
    const lockedHex = await provider.call({
        to: PROXY,
        data: jfIface.encodeFunctionData("totalLocked"),
    });
    console.log(`  proxy.totalLocked()            = ${BigInt(lockedHex).toString()} attoFLOW`);

    if (!amtVerMatch || !xfrVerMatch || !maxWrapOk) {
        throw new Error("Post-upgrade state verification FAILED — check logs above.");
    }

    // ─── Record ───────────────────────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const record = {
        version: "0.5.0",
        date: new Date().toISOString(),
        network: "flow-evm-testnet",
        chainId: 545,
        proxy: PROXY,
        prior_impl: deploy.contracts.JanusFlow_impl,
        new_impl: implAddr,
        new_amount_disclose_verifier: amtAddr,
        new_transfer_verifier: xfrAddr,
        ceremony: {
            path: "circuits/v0.5-ceremony/",
            ptau: "pot14_hez.ptau",
            ptau_sha256: "758514f13dc3ca4be14084398750d415a12f2a6eb8f76e53e120f10f7ddd5ef1",
            beacon_block: 324191000,
            beacon_hex: "02264a91de389ab416785958f4e15705579d0747b770f27b77a512df3ea8a905",
        },
        tx_hashes: txHashes,
        verification: {
            erc1967_upgrade_event_matches_impl: upgraded,
            proxy_amount_disclose_verifier_matches: amtVerMatch,
            proxy_transfer_verifier_matches: xfrVerMatch,
            proxy_max_wrap_is_2_128_minus_1: maxWrapOk,
        },
        explorer: {
            proxy: `https://evm-testnet.flowscan.io/address/${PROXY}`,
            new_impl: `https://evm-testnet.flowscan.io/address/${implAddr}`,
            new_amount_verifier: `https://evm-testnet.flowscan.io/address/${amtAddr}`,
            new_transfer_verifier: `https://evm-testnet.flowscan.io/address/${xfrAddr}`,
        },
    };

    writeFileSync(OUT_RECORD, JSON.stringify(record, null, 2) + "\n");
    console.log(`\nUpgrade record written: ${OUT_RECORD}`);

    // Patch janus-flow-v0.3.json so downstream scripts see the new impl + verifiers
    deploy.contracts.JanusFlow_impl = implAddr;
    deploy.contracts.AmountDiscloseVerifier = amtAddr;
    deploy.contracts.ConfidentialTransferVerifier = xfrAddr;
    writeFileSync(DEPLOY_RECORD, JSON.stringify(deploy, null, 2) + "\n");
    console.log(`Patched deploy record:   ${DEPLOY_RECORD}`);

    console.log("\n" + "=".repeat(72));
    console.log("JanusFlow v0.5 upgrade COMPLETE");
    console.log("=".repeat(72));
    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
