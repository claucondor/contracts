/**
 * deploy-janus-erc20.mjs — v0.4.0 JanusERC20 deployment.
 *
 * Deploys, in order, to Flow EVM testnet (chainId 545) via the openjanus-flow
 * Cadence Owned Account (COA — operator-owned, Pattern A per memory
 * `flow-evm-coa-as-owner`):
 *
 *   1. MockUSDC (6-decimal ERC20 underlying — Flow EVM testnet lacks a
 *      canonical USDC).
 *   2. JanusERC20 implementation (uninitialised, _disableInitializers).
 *   3. JanusERC20Proxy(impl, encodeCall(initialize)) → atomic initialize call.
 *
 * REUSES (does NOT redeploy):
 *   - BabyJub                      0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   - ConfidentialTransferVerifier 0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B
 *   - AmountDiscloseVerifier       0xD0ED3936530258C278f5357C1dB709ad34768352
 *
 * Owner of the JanusERC20Proxy is the openjanus-flow admin COA, same as the
 * v0.3 JanusFlow proxy.
 *
 * Output:
 *   packages/janus-erc20/deployments/janus-erc20-v0.4.json
 *
 * Run from package root:
 *   node scripts/deploy-janus-erc20.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AbiCoder, Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const ARTIFACTS = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

const JANUSERC20_ART = join(ARTIFACTS, "JanusERC20.sol/JanusERC20.json");
const PROXY_ART      = join(ARTIFACTS, "JanusERC20Proxy.sol/JanusERC20Proxy.json");
const USDC_ART       = join(ARTIFACTS, "MockUSDC.sol/MockUSDC.json");

// --- Existing primitive addresses (REUSED from v0.3) ------------------------
const BABYJUB_ADDRESS                = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const CONFIDENTIAL_TRANSFER_VERIFIER = "0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B";
const AMOUNT_DISCLOSE_VERIFIER       = "0xD0ED3936530258C278f5357C1dB709ad34768352";

// --- Deployer Flow / COA ----------------------------------------------------
const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_ADDR    = "0xbef3c77681c15397";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";

const RPC_URL = "https://testnet.evm.nodes.onflow.org";

// --- Cadence deploy tx ------------------------------------------------------
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

// ---------------------------------------------------------------------------

function runFlowDeploy(bytecodeHex, label) {
    const txPath = `/tmp/.${label}.cdc`;
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
        const stdout = execSync(cmd, { cwd: MODULE_ROOT, timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); }
            catch {
                throw new Error(`[${label}] flow CLI non-JSON output:\n${err.stdout?.slice(0, 800)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
        }
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
        BABYJUB_ADDRESS.toLowerCase(),
        AMOUNT_DISCLOSE_VERIFIER.toLowerCase(),
        CONFIDENTIAL_TRANSFER_VERIFIER.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    return fallback[0] ?? null;
}

async function main() {
    console.log("=== JanusERC20 v0.4 deploy — production ===\n");

    for (const p of [JANUSERC20_ART, PROXY_ART, USDC_ART]) {
        if (!existsSync(p)) throw new Error(`Missing artifact: ${p} — run hardhat compile`);
    }

    const jeArt    = JSON.parse(readFileSync(JANUSERC20_ART, "utf8"));
    const proxyArt = JSON.parse(readFileSync(PROXY_ART, "utf8"));
    const usdcArt  = JSON.parse(readFileSync(USDC_ART, "utf8"));

    // ───────────── 1. Deploy MockUSDC ─────────────
    console.log("[1/3] Deploying MockUSDC (mUSDC, 6 decimals)...");
    const usdcBytecode = usdcArt.bytecode.startsWith("0x")
        ? usdcArt.bytecode.slice(2)
        : usdcArt.bytecode;
    console.log("  bytecode size:", usdcBytecode.length / 2, "bytes");
    const usdcResult = runFlowDeploy(usdcBytecode, "deploy_mock_usdc");
    const usdcTxHash = usdcResult?.id ?? "unknown";
    const usdcAddress = extractDeployedAddress(usdcResult);
    console.log("  tx:", usdcTxHash);
    console.log("  address:", usdcAddress);
    if (!usdcAddress) {
        writeFileSync("/tmp/usdc-deploy-raw.json", JSON.stringify(usdcResult, null, 2));
        throw new Error("Failed to parse MockUSDC address");
    }

    // ───────────── 2. Deploy JanusERC20 impl ─────────────
    console.log("\n[2/3] Deploying JanusERC20 implementation (uninitialised)...");
    const implBytecode = jeArt.bytecode.startsWith("0x")
        ? jeArt.bytecode.slice(2)
        : jeArt.bytecode;
    console.log("  bytecode size:", implBytecode.length / 2, "bytes");
    const implResult = runFlowDeploy(implBytecode, "deploy_janus_erc20_impl");
    const implTxHash = implResult?.id ?? "unknown";
    const implAddress = extractDeployedAddress(implResult);
    console.log("  tx:", implTxHash);
    console.log("  address:", implAddress);
    if (!implAddress) {
        writeFileSync("/tmp/erc20-impl-deploy-raw.json", JSON.stringify(implResult, null, 2));
        throw new Error("Failed to parse JanusERC20 impl address");
    }

    // ───────────── 3. Deploy ERC1967Proxy → atomic initialize ─────────────
    console.log("\n[3/3] Deploying JanusERC20Proxy(impl, initData) → atomic initialize() ...");
    const iface = new Interface(jeArt.abi);
    const initData = iface.encodeFunctionData("initialize", [
        BABYJUB_ADDRESS,
        CONFIDENTIAL_TRANSFER_VERIFIER,
        AMOUNT_DISCLOSE_VERIFIER,
        usdcAddress,
        OPENJANUS_FLOW_COA_EVM,   // owner = our deployer COA
    ]);
    console.log("  initialize calldata length:", initData.length / 2 - 1, "bytes");

    const abiCoder = new AbiCoder();
    const proxyCtorArgs = abiCoder.encode(["address", "bytes"], [implAddress, initData]);
    const proxyBytecode = (proxyArt.bytecode.startsWith("0x")
        ? proxyArt.bytecode.slice(2)
        : proxyArt.bytecode) + proxyCtorArgs.slice(2);
    console.log("  proxy deploy payload:", proxyBytecode.length / 2, "bytes");

    const proxyResult = runFlowDeploy(proxyBytecode, "deploy_janus_erc20_proxy");
    const proxyTxHash = proxyResult?.id ?? "unknown";
    const proxyAddress = extractDeployedAddress(proxyResult);
    console.log("  tx (initialize bundled):", proxyTxHash);
    console.log("  proxy address:", proxyAddress);
    if (!proxyAddress) {
        writeFileSync("/tmp/erc20-proxy-deploy-raw.json", JSON.stringify(proxyResult, null, 2));
        throw new Error("Failed to parse JanusERC20Proxy address");
    }

    // ───────────── Verify ─────────────
    console.log("\n=== Verifying proxy state via eth_call ===");
    const provider = new JsonRpcProvider(RPC_URL);

    const ownerData = iface.encodeFunctionData("owner", []);
    const ownerHex = await provider.call({ to: proxyAddress, data: ownerData });
    const owner = "0x" + ownerHex.slice(-40);
    console.log("  proxy.owner()                   =", owner);
    const ownerMatches = owner.toLowerCase() === OPENJANUS_FLOW_COA_EVM.toLowerCase();
    console.log("  matches admin COA               =", ownerMatches ? "YES" : "NO");

    const underlyingData = iface.encodeFunctionData("underlying", []);
    const underlyingHex = await provider.call({ to: proxyAddress, data: underlyingData });
    const underlyingAddr = "0x" + underlyingHex.slice(-40);
    console.log("  proxy.underlying()              =", underlyingAddr);
    const underlyingMatches = underlyingAddr.toLowerCase() === usdcAddress.toLowerCase();
    console.log("  underlying matches MockUSDC     =", underlyingMatches ? "YES" : "NO");

    const babyJubData = iface.encodeFunctionData("babyJub", []);
    const babyJubHex = await provider.call({ to: proxyAddress, data: babyJubData });
    const babyJubAddr = "0x" + babyJubHex.slice(-40);
    console.log("  proxy.babyJub()                 =", babyJubAddr);

    const xferData = iface.encodeFunctionData("transferVerifier", []);
    const xferHex = await provider.call({ to: proxyAddress, data: xferData });
    const xferAddr = "0x" + xferHex.slice(-40);
    console.log("  proxy.transferVerifier()        =", xferAddr);

    const adData = iface.encodeFunctionData("amountDiscloseVerifier", []);
    const adHex = await provider.call({ to: proxyAddress, data: adData });
    const adAddr = "0x" + adHex.slice(-40);
    console.log("  proxy.amountDiscloseVerifier()  =", adAddr);

    const lockedData = iface.encodeFunctionData("totalLocked", []);
    const lockedHex = await provider.call({ to: proxyAddress, data: lockedData });
    console.log("  proxy.totalLocked()             =", BigInt(lockedHex).toString());

    let implOwnerStatus = "n/a";
    try {
        const implOwnerHex = await provider.call({ to: implAddress, data: ownerData });
        const implOwner = "0x" + implOwnerHex.slice(-40);
        implOwnerStatus = implOwner === "0x0000000000000000000000000000000000000000"
            ? "0x0 (locked)"
            : implOwner;
    } catch (e) {
        implOwnerStatus = "reverted (expected — initializers disabled)";
    }
    console.log("  impl.owner() direct             =", implOwnerStatus);

    // ───────────── Record ─────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const record = {
        version: "0.4.0",
        date: new Date().toISOString().slice(0, 10),
        network: "flow-evm-testnet",
        chainId: 545,
        contracts: {
            JanusERC20_proxy: proxyAddress,
            JanusERC20_impl: implAddress,
            MockUSDC: usdcAddress,
            AmountDiscloseVerifier: AMOUNT_DISCLOSE_VERIFIER,
            ConfidentialTransferVerifier: CONFIDENTIAL_TRANSFER_VERIFIER,
            BabyJub: BABYJUB_ADDRESS,
        },
        contract_status: {
            JanusERC20_proxy: "NEW",
            JanusERC20_impl: "NEW",
            MockUSDC: "NEW (test underlying — 6 decimals)",
            AmountDiscloseVerifier: "REUSED (v0.3 production ceremony)",
            ConfidentialTransferVerifier: "REUSED (v0.3 production)",
            BabyJub: "REUSED (existing — stateless library)",
        },
        tx_hashes: {
            mock_usdc_deploy: usdcTxHash,
            janus_erc20_impl_deploy: implTxHash,
            janus_erc20_proxy_deploy_with_init: proxyTxHash,
        },
        owner: owner,
        deployer_flow_account: OPENJANUS_FLOW_ADDR,
        deployer_coa_evm: OPENJANUS_FLOW_COA_EVM,
        deploy_method: "coa.deploy() via Cadence transaction (P-256 Flow signing)",
        upgradability: "UUPS (proxy.upgradeToAndCall, gated by _authorizeUpgrade onlyOwner)",
        underlying: {
            address: usdcAddress,
            symbol: "mUSDC",
            decimals: 6,
            note: "Flow EVM testnet lacks a canonical USDC — this is a permissionlessly-mintable test token. Replace with a real ERC20 address for mainnet.",
        },
        post_deploy_checks: {
            owner_is_admin_coa: ownerMatches,
            underlying_pinned_correctly: underlyingMatches,
            babyJub_address: babyJubAddr,
            transferVerifier_address: xferAddr,
            amountDiscloseVerifier_address: adAddr,
            impl_owner_direct: implOwnerStatus,
        },
        explorer: {
            proxy: `https://evm-testnet.flowscan.io/address/${proxyAddress}`,
            impl: `https://evm-testnet.flowscan.io/address/${implAddress}`,
            mock_usdc: `https://evm-testnet.flowscan.io/address/${usdcAddress}`,
        },
    };

    const outPath = join(DEPLOYMENTS_DIR, "janus-erc20-v0.4.json");
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log("\nDeployment record written:", outPath);
    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
