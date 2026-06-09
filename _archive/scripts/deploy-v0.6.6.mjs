/**
 * deploy-v0.6.6.mjs — v0.6.6 full clean testnet deployment.
 *
 * Deploys fresh JanusFlow + JanusERC20 proxies using the new v0.6.6 admin
 * Cadence account + COA as owner. Reuses stateless on-chain primitives.
 *
 * Admin:
 *   Cadence:  0xc4e8f99915893a2f  (new, created 2026-06-03)
 *   COA EVM:  0x000000000000000000000002656f9205e386ed78
 *
 * REUSED (stateless — no state to corrupt):
 *   BabyJub                  0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   AmountDiscloseVerifier   0xD0ED3936530258C278f5357C1dB709ad34768352
 *   ConfidentialTransferVerifier 0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B
 *   MemoKeyRegistry          0x05D104962ff087441f26BA11A1E1C3b9E091D663
 *
 * REDEPLOYED (fresh state, corrupted in previous deploy):
 *   MockUSDC     — fresh ERC20 underlying
 *   JanusERC20   — fresh impl + proxy, owner = new admin COA
 *   JanusFlow    — fresh impl + proxy, owner = new admin COA
 *
 * Output: /home/oydual3/openjanus-contracts/deployments/v0.6.6-testnet.json
 *
 * Run from repo root:
 *   node scripts/deploy-v0.6.6.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AbiCoder, Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const JANUS_TOKEN_PKG   = join(REPO_ROOT, "packages", "janus-token");
const JANUS_ERC20_PKG   = join(REPO_ROOT, "packages", "janus-erc20");
const JF_ARTIFACTS      = join(JANUS_TOKEN_PKG, "artifacts/contracts/solidity");
const ERC20_ARTIFACTS   = join(JANUS_ERC20_PKG, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR   = join(REPO_ROOT, "deployments");
const FLOW_JSON         = "/tmp/v066_flow.json";

// ── Artifact paths ────────────────────────────────────────────────────────────
const JF_ART      = join(JF_ARTIFACTS,    "JanusFlow.sol/JanusFlow.json");
const JF_PROXY_ART = join(JF_ARTIFACTS,   "JanusFlowProxy.sol/JanusFlowProxy.json");
const ERC20_ART   = join(ERC20_ARTIFACTS, "JanusERC20.sol/JanusERC20.json");
const ERC20_PROXY_ART = join(ERC20_ARTIFACTS, "JanusERC20Proxy.sol/JanusERC20Proxy.json");
const USDC_ART    = join(ERC20_ARTIFACTS, "MockUSDC.sol/MockUSDC.json");

// ── Reused addresses ──────────────────────────────────────────────────────────
const BABYJUB_ADDRESS                = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const CONFIDENTIAL_TRANSFER_VERIFIER = "0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B";
const AMOUNT_DISCLOSE_VERIFIER       = "0xD0ED3936530258C278f5357C1dB709ad34768352";
const MEMO_REGISTRY                  = "0x05D104962ff087441f26BA11A1E1C3b9E091D663";

// ── New admin ─────────────────────────────────────────────────────────────────
const ADMIN_CADENCE    = "c4e8f99915893a2f";
const ADMIN_COA_EVM    = "0x000000000000000000000002656f9205e386ed78";
const FLOW_SIGNER      = "v066-admin";

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID = 545;

// ── Cadence deploy transaction ────────────────────────────────────────────────
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

function runFlowDeploy(bytecodeHex, label) {
    const txPath = `/tmp/.v066_${label}.cdc`;
    writeFileSync(txPath, DEPLOY_TX);
    const cmd = [
        "flow transactions send",
        txPath,
        `"${bytecodeHex}"`,
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
                throw new Error(`[${label}] flow CLI non-JSON output:\n${err.stdout?.slice(0, 1000)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
        }
    }
    if (result.error) {
        throw new Error(`[${label}] transaction failed: ${result.error.slice(0, 500)}`);
    }
    return result;
}

function extractDeployedAddress(result) {
    const blob = JSON.stringify(result?.events ?? []);
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        ADMIN_COA_EVM.toLowerCase(),
        BABYJUB_ADDRESS.toLowerCase(),
        AMOUNT_DISCLOSE_VERIFIER.toLowerCase(),
        CONFIDENTIAL_TRANSFER_VERIFIER.toLowerCase(),
        MEMO_REGISTRY.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    return fallback[0] ?? null;
}

async function callView(provider, to, iface, fn) {
    const data = iface.encodeFunctionData(fn, []);
    const hex = await provider.call({ to, data });
    return "0x" + hex.slice(-40);
}

async function main() {
    console.log("=== JanusFlow + JanusERC20 v0.6.6 clean deploy ===\n");
    console.log("Admin Cadence:", ADMIN_CADENCE);
    console.log("Admin COA EVM:", ADMIN_COA_EVM);
    console.log("");

    // Verify artifact files
    for (const p of [JF_ART, JF_PROXY_ART, ERC20_ART, ERC20_PROXY_ART, USDC_ART]) {
        if (!existsSync(p)) throw new Error(`Missing artifact: ${p} — run hardhat compile first`);
    }

    const jfArt       = JSON.parse(readFileSync(JF_ART, "utf8"));
    const jfProxyArt  = JSON.parse(readFileSync(JF_PROXY_ART, "utf8"));
    const erc20Art    = JSON.parse(readFileSync(ERC20_ART, "utf8"));
    const erc20ProxyArt = JSON.parse(readFileSync(ERC20_PROXY_ART, "utf8"));
    const usdcArt     = JSON.parse(readFileSync(USDC_ART, "utf8"));

    const abiCoder = new AbiCoder();
    const provider = new JsonRpcProvider(RPC_URL);

    const txHashes = {};
    const contracts = {};

    // ── 1. Deploy MockUSDC ────────────────────────────────────────────────────
    console.log("[1/6] Deploying MockUSDC (6-decimal testnet underlying)...");
    const usdcBytecode = usdcArt.bytecode.replace(/^0x/, "");
    const usdcResult = runFlowDeploy(usdcBytecode, "mockusdc");
    txHashes.mockusdc_deploy = usdcResult.id ?? "unknown";
    const usdcAddress = extractDeployedAddress(usdcResult);
    console.log("  tx:", txHashes.mockusdc_deploy);
    console.log("  address:", usdcAddress);
    if (!usdcAddress) {
        writeFileSync("/tmp/v066-mockusdc-deploy-raw.json", JSON.stringify(usdcResult, null, 2));
        throw new Error("Failed to parse MockUSDC address — see /tmp/v066-mockusdc-deploy-raw.json");
    }
    contracts.MockUSDC = usdcAddress;

    // ── 2. Deploy JanusERC20 impl ─────────────────────────────────────────────
    console.log("\n[2/6] Deploying JanusERC20 implementation...");
    const erc20ImplBytecode = erc20Art.bytecode.replace(/^0x/, "");
    const erc20ImplResult = runFlowDeploy(erc20ImplBytecode, "januserc20_impl");
    txHashes.januserc20_impl_deploy = erc20ImplResult.id ?? "unknown";
    const erc20ImplAddress = extractDeployedAddress(erc20ImplResult);
    console.log("  tx:", txHashes.januserc20_impl_deploy);
    console.log("  address:", erc20ImplAddress);
    if (!erc20ImplAddress) {
        writeFileSync("/tmp/v066-erc20impl-raw.json", JSON.stringify(erc20ImplResult, null, 2));
        throw new Error("Failed to parse JanusERC20 impl address");
    }
    contracts.JanusERC20_impl = erc20ImplAddress;

    // ── 3. Deploy JanusERC20 proxy (with atomic initialize) ──────────────────
    console.log("\n[3/6] Deploying JanusERC20 proxy (with initialize)...");
    const erc20Iface = new Interface(erc20Art.abi);
    const erc20InitData = erc20Iface.encodeFunctionData("initialize", [
        BABYJUB_ADDRESS,
        CONFIDENTIAL_TRANSFER_VERIFIER,
        AMOUNT_DISCLOSE_VERIFIER,
        usdcAddress,
        ADMIN_COA_EVM,
        MEMO_REGISTRY,
    ]);
    const erc20ProxyCtorArgs = abiCoder.encode(["address", "bytes"], [erc20ImplAddress, erc20InitData]);
    const erc20ProxyBytecode = erc20ProxyArt.bytecode.replace(/^0x/, "") + erc20ProxyCtorArgs.slice(2);
    const erc20ProxyResult = runFlowDeploy(erc20ProxyBytecode, "januserc20_proxy");
    txHashes.januserc20_proxy_deploy = erc20ProxyResult.id ?? "unknown";
    const erc20ProxyAddress = extractDeployedAddress(erc20ProxyResult);
    console.log("  tx:", txHashes.januserc20_proxy_deploy);
    console.log("  address:", erc20ProxyAddress);
    if (!erc20ProxyAddress) {
        writeFileSync("/tmp/v066-erc20proxy-raw.json", JSON.stringify(erc20ProxyResult, null, 2));
        throw new Error("Failed to parse JanusERC20 proxy address");
    }
    contracts.JanusERC20_proxy = erc20ProxyAddress;

    // ── 4. Deploy JanusFlow impl ──────────────────────────────────────────────
    console.log("\n[4/6] Deploying JanusFlow implementation...");
    const jfImplBytecode = jfArt.bytecode.replace(/^0x/, "");
    const jfImplResult = runFlowDeploy(jfImplBytecode, "janusflow_impl");
    txHashes.janusflow_impl_deploy = jfImplResult.id ?? "unknown";
    const jfImplAddress = extractDeployedAddress(jfImplResult);
    console.log("  tx:", txHashes.janusflow_impl_deploy);
    console.log("  address:", jfImplAddress);
    if (!jfImplAddress) {
        writeFileSync("/tmp/v066-jfimpl-raw.json", JSON.stringify(jfImplResult, null, 2));
        throw new Error("Failed to parse JanusFlow impl address");
    }
    contracts.JanusFlow_impl = jfImplAddress;

    // ── 5. Deploy JanusFlow proxy (with atomic initialize) ────────────────────
    console.log("\n[5/6] Deploying JanusFlow proxy (with initialize)...");
    const jfIface = new Interface(jfArt.abi);
    const jfInitData = jfIface.encodeFunctionData("initialize", [
        BABYJUB_ADDRESS,
        CONFIDENTIAL_TRANSFER_VERIFIER,
        AMOUNT_DISCLOSE_VERIFIER,
        ADMIN_COA_EVM,
        MEMO_REGISTRY,
    ]);
    const jfProxyCtorArgs = abiCoder.encode(["address", "bytes"], [jfImplAddress, jfInitData]);
    const jfProxyBytecode = jfProxyArt.bytecode.replace(/^0x/, "") + jfProxyCtorArgs.slice(2);
    const jfProxyResult = runFlowDeploy(jfProxyBytecode, "janusflow_proxy");
    txHashes.janusflow_proxy_deploy = jfProxyResult.id ?? "unknown";
    const jfProxyAddress = extractDeployedAddress(jfProxyResult);
    console.log("  tx:", txHashes.janusflow_proxy_deploy);
    console.log("  address:", jfProxyAddress);
    if (!jfProxyAddress) {
        writeFileSync("/tmp/v066-jfproxy-raw.json", JSON.stringify(jfProxyResult, null, 2));
        throw new Error("Failed to parse JanusFlow proxy address");
    }
    contracts.JanusFlow_proxy = jfProxyAddress;

    // ── 6. Set fee recipients ─────────────────────────────────────────────────
    // Fee init is done separately via a call tx after proxy deploy.
    // The fee recipient is the admin COA (receives fees for operator).
    console.log("\n[6/6] Skipped — initFees called separately after proxy verify (see init-fees script)");
    console.log("      Fee recipient will be set to:", ADMIN_COA_EVM, "(admin COA)");

    // ── Post-deploy verification ──────────────────────────────────────────────
    console.log("\n=== Verifying deployed proxies via eth_call ===");

    const checks = {
        janusflow: { proxy: jfProxyAddress, iface: jfIface },
        januserc20: { proxy: erc20ProxyAddress, iface: erc20Iface },
    };

    const results = {};
    for (const [name, { proxy, iface }] of Object.entries(checks)) {
        const owner  = await callView(provider, proxy, iface, "owner");
        const babyjub = await callView(provider, proxy, iface, "babyJub");
        const xfer   = await callView(provider, proxy, iface, "transferVerifier");
        const ad     = await callView(provider, proxy, iface, "amountDiscloseVerifier");
        const memreg = await callView(provider, proxy, iface, "memoRegistry");

        const totalLockedData = iface.encodeFunctionData("totalLocked", []);
        const totalLockedHex = await provider.call({ to: proxy, data: totalLockedData });
        const totalLocked = BigInt(totalLockedHex).toString();

        console.log(`\n  ${name} proxy: ${proxy}`);
        console.log(`    owner()                   = ${owner} (expected: ${ADMIN_COA_EVM.toLowerCase()})`);
        console.log(`    babyJub()                 = ${babyjub}`);
        console.log(`    transferVerifier()         = ${xfer}`);
        console.log(`    amountDiscloseVerifier()   = ${ad}`);
        console.log(`    memoRegistry()             = ${memreg}`);
        console.log(`    totalLocked()             = ${totalLocked} (expected: 0)`);

        results[name] = {
            owner_is_admin_coa: owner.toLowerCase() === ADMIN_COA_EVM.toLowerCase(),
            babyjub_correct: babyjub.toLowerCase() === BABYJUB_ADDRESS.toLowerCase(),
            transfer_verifier_correct: xfer.toLowerCase() === CONFIDENTIAL_TRANSFER_VERIFIER.toLowerCase(),
            amount_disclose_correct: ad.toLowerCase() === AMOUNT_DISCLOSE_VERIFIER.toLowerCase(),
            memo_registry_correct: memreg.toLowerCase() === MEMO_REGISTRY.toLowerCase(),
            total_locked_zero: totalLocked === "0",
        };
    }

    // JanusERC20 extra check: underlying
    const underlyingData = erc20Iface.encodeFunctionData("underlying", []);
    const underlyingHex = await provider.call({ to: erc20ProxyAddress, data: underlyingData });
    const underlyingAddr = "0x" + underlyingHex.slice(-40);
    console.log(`\n  JanusERC20.underlying() = ${underlyingAddr} (expected: ${usdcAddress.toLowerCase()})`);
    results.januserc20.underlying_correct = underlyingAddr.toLowerCase() === usdcAddress.toLowerCase();

    // ── Save deployment record ────────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

    const record = {
        version: "0.6.6",
        date: new Date().toISOString().slice(0, 10),
        network: "flow-evm-testnet",
        chainId: CHAIN_ID,
        admin: {
            cadence_address: `0x${ADMIN_CADENCE}`,
            coa_evm_address: ADMIN_COA_EVM,
            pkey_path: "/home/oydual3/.flow/v066-admin.pkey",
            note: "New account created 2026-06-03 for clean v0.6.6 deploy",
        },
        contracts: {
            ...contracts,
            BabyJub: BABYJUB_ADDRESS,
            AmountDiscloseVerifier: AMOUNT_DISCLOSE_VERIFIER,
            ConfidentialTransferVerifier: CONFIDENTIAL_TRANSFER_VERIFIER,
            MemoKeyRegistry: MEMO_REGISTRY,
        },
        contract_status: {
            MockUSDC: "NEW (fresh 6-decimal testnet underlying)",
            JanusERC20_impl: "NEW (v0.5.0, 9-arg shieldedTransfer, fresh storage)",
            JanusERC20_proxy: "NEW (UUPS, initialized with fresh admin COA as owner)",
            JanusFlow_impl: "NEW (v0.6.3, 9-arg shieldedTransfer, fresh storage)",
            JanusFlow_proxy: "NEW (UUPS, initialized with fresh admin COA as owner)",
            BabyJub: "REUSED (stateless — no corruption risk)",
            AmountDiscloseVerifier: "REUSED (stateless — no corruption risk)",
            ConfidentialTransferVerifier: "REUSED (stateless — no corruption risk)",
            MemoKeyRegistry: "REUSED (shared registry — unaffected by old proxy state)",
        },
        tx_hashes: txHashes,
        post_deploy_checks: results,
        fee_status: "NOT_INITIALIZED — run init-fees transaction to set fee recipient = admin COA, feeBps = 10",
        cadence_contracts: {
            MockFT: { address: "0x7599043aea001283", note: "REUSED from testnet-claucondor account" },
            JanusFT: { address: "0x7599043aea001283", note: "REUSED from testnet-claucondor account (contractName: JanusFT)" },
        },
        explorer: {
            JanusFlow_proxy: `https://evm-testnet.flowscan.io/address/${jfProxyAddress}`,
            JanusERC20_proxy: `https://evm-testnet.flowscan.io/address/${erc20ProxyAddress}`,
            MockUSDC: `https://evm-testnet.flowscan.io/address/${usdcAddress}`,
        },
    };

    const outPath = join(DEPLOYMENTS_DIR, "v0.6.6-testnet.json");
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log("\n=== Deployment record written:", outPath, "===");

    // Summary
    const allChecksPass = Object.values(results).every(r =>
        typeof r === "object" ? Object.values(r).every(Boolean) : r
    );
    console.log("\n=== SUMMARY ===");
    console.log("JanusFlow proxy:   ", jfProxyAddress);
    console.log("JanusERC20 proxy:  ", erc20ProxyAddress);
    console.log("MockUSDC:          ", usdcAddress);
    console.log("All post-deploy checks passed:", allChecksPass ? "YES" : "NO — check above");

    if (!allChecksPass) {
        console.error("\nWARNING: Some post-deploy checks failed. Review the deployment record.");
        process.exit(1);
    }

    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
