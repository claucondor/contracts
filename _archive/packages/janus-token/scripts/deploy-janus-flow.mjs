/**
 * deploy-janus-flow.mjs — v0.3 Phase 1 deployment.
 *
 * Deploys, in order, to Flow EVM testnet (chainId 545) via the openjanus-flow
 * Cadence Owned Account (COA — operator-owned, Pattern A per memory
 * `flow-evm-coa-as-owner`):
 *
 *   1. AmountDiscloseVerifier (production v0.3 ceremony output)
 *   2. JanusFlow implementation (uninitialised, _disableInitializers)
 *   3. ERC1967Proxy(impl, encodeCall(initialize)) → atomic initialize() call
 *
 * The ConfidentialTransferVerifier is REUSED from the lab deployment
 * (0x70FA331534619DBd4051b22b7fb19e647be141b0) — it is stateless and ungated.
 * The BabyJub library is REUSED from the existing deployment.
 *
 * Output:
 *   packages/janus-token/deployments/janus-flow-v0.3.json
 *
 * Run from package root:
 *   node scripts/deploy-janus-flow.mjs
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

const JANUSFLOW_ART      = join(ARTIFACTS, "JanusFlow.sol/JanusFlow.json");
const PROXY_ART          = join(ARTIFACTS, "JanusFlowProxy.sol/JanusFlowProxy.json");
const AMOUNT_VERIFIER_ART = join(ARTIFACTS, "AmountDiscloseVerifier.sol/AmountDiscloseVerifier.json");
const TRANSFER_VERIFIER_ART = join(ARTIFACTS, "ConfidentialTransferVerifier.sol/ConfidentialTransferVerifier.json");

// --- Existing primitive addresses (REUSED) ---------------------------------
const BABYJUB_ADDRESS = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";

// NOTE: the lab ConfidentialTransferVerifier at 0x70FA331534619DBd4051b22b7fb19e647be141b0
// no longer matches the current zkey artifacts in cadence-crypto-lab (zkey was
// regenerated after the .sol/.bytecode were exported). We deploy a fresh
// verifier from the *current* zkey so on-chain verification succeeds.

// --- Deployer Flow / COA -----------------------------------------------------
const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_ADDR    = "0xbef3c77681c15397";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";

// --- RPC --------------------------------------------------------------------
const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const CEREMONY_ZKEY_SHA256 =
    "bb50c5aadcd435c27bfca83b46c216d21162281220bc77ea2d554fa135fe439c";

// --- Cadence deploy tx (one-arg: bytecodeHex) -------------------------------
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

    // fallback: pick first non-known 0x40-hex address
    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        OPENJANUS_FLOW_COA_EVM.toLowerCase(),
        BABYJUB_ADDRESS.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    return fallback[0] ?? null;
}

async function main() {
    console.log("=== JanusFlow v0.3 deploy — production ceremony ===\n");

    for (const p of [JANUSFLOW_ART, PROXY_ART, AMOUNT_VERIFIER_ART, TRANSFER_VERIFIER_ART]) {
        if (!existsSync(p)) throw new Error(`Missing artifact: ${p} — run hardhat compile`);
    }

    const jfArt = JSON.parse(readFileSync(JANUSFLOW_ART, "utf8"));
    const proxyArt = JSON.parse(readFileSync(PROXY_ART, "utf8"));
    const verifierArt = JSON.parse(readFileSync(AMOUNT_VERIFIER_ART, "utf8"));
    const xferVerifierArt = JSON.parse(readFileSync(TRANSFER_VERIFIER_ART, "utf8"));

    // ───────────── 1a. Deploy AmountDiscloseVerifier ─────────────
    console.log("[1a/4] Deploying AmountDiscloseVerifier (production v0.3 ceremony)...");
    const verifierBytecode = verifierArt.bytecode.startsWith("0x")
        ? verifierArt.bytecode.slice(2)
        : verifierArt.bytecode;
    console.log("  bytecode size:", verifierBytecode.length / 2, "bytes");
    const verifierResult = runFlowDeploy(verifierBytecode, "deploy_amount_verifier");
    const verifierTxHash = verifierResult?.id ?? "unknown";
    const verifierAddress = extractDeployedAddress(verifierResult);
    console.log("  tx:", verifierTxHash);
    console.log("  address:", verifierAddress);
    if (!verifierAddress) {
        writeFileSync("/tmp/verifier-deploy-raw.json", JSON.stringify(verifierResult, null, 2));
        throw new Error("Failed to parse AmountDiscloseVerifier address — see /tmp/verifier-deploy-raw.json");
    }

    // ───────────── 1b. Deploy ConfidentialTransferVerifier ─────────────
    console.log("\n[1b/4] Deploying ConfidentialTransferVerifier (matched to cadence-crypto-lab current zkey)...");
    const xferVerifierBytecode = xferVerifierArt.bytecode.startsWith("0x")
        ? xferVerifierArt.bytecode.slice(2)
        : xferVerifierArt.bytecode;
    console.log("  bytecode size:", xferVerifierBytecode.length / 2, "bytes");
    const xferVerifierResult = runFlowDeploy(xferVerifierBytecode, "deploy_xfer_verifier");
    const xferVerifierTxHash = xferVerifierResult?.id ?? "unknown";
    const xferVerifierAddress = extractDeployedAddress(xferVerifierResult);
    console.log("  tx:", xferVerifierTxHash);
    console.log("  address:", xferVerifierAddress);
    if (!xferVerifierAddress) {
        writeFileSync("/tmp/xfer-verifier-deploy-raw.json", JSON.stringify(xferVerifierResult, null, 2));
        throw new Error("Failed to parse ConfidentialTransferVerifier address");
    }
    const CONFIDENTIAL_TRANSFER_VERIFIER = xferVerifierAddress;

    // ───────────── 2. Deploy JanusFlow impl ─────────────
    console.log("\n[2/4] Deploying JanusFlow implementation (uninitialised)...");
    const implBytecode = jfArt.bytecode.startsWith("0x")
        ? jfArt.bytecode.slice(2)
        : jfArt.bytecode;
    console.log("  bytecode size:", implBytecode.length / 2, "bytes");
    const implResult = runFlowDeploy(implBytecode, "deploy_janus_flow_impl");
    const implTxHash = implResult?.id ?? "unknown";
    const implAddress = extractDeployedAddress(implResult);
    console.log("  tx:", implTxHash);
    console.log("  address:", implAddress);
    if (!implAddress) {
        writeFileSync("/tmp/impl-deploy-raw.json", JSON.stringify(implResult, null, 2));
        throw new Error("Failed to parse JanusFlow impl address — see /tmp/impl-deploy-raw.json");
    }

    // ───────────── 3. Deploy ERC1967Proxy → atomic initialize ─────────────
    console.log("\n[3/4] Deploying JanusFlowProxy(impl, initData) → atomic initialize() ...");
    const iface = new Interface(jfArt.abi);
    const initData = iface.encodeFunctionData("initialize", [
        BABYJUB_ADDRESS,
        CONFIDENTIAL_TRANSFER_VERIFIER,
        verifierAddress,
        OPENJANUS_FLOW_COA_EVM,   // owner = our deployer COA
    ]);
    console.log("  initialize calldata length:", initData.length / 2 - 1, "bytes");

    const abiCoder = new AbiCoder();
    const proxyCtorArgs = abiCoder.encode(["address", "bytes"], [implAddress, initData]);
    const proxyBytecode = (proxyArt.bytecode.startsWith("0x")
        ? proxyArt.bytecode.slice(2)
        : proxyArt.bytecode) + proxyCtorArgs.slice(2);
    console.log("  proxy deploy payload:", proxyBytecode.length / 2, "bytes");

    const proxyResult = runFlowDeploy(proxyBytecode, "deploy_janus_flow_proxy");
    const proxyTxHash = proxyResult?.id ?? "unknown";
    const proxyAddress = extractDeployedAddress(proxyResult);
    console.log("  tx (initialize bundled):", proxyTxHash);
    console.log("  proxy address:", proxyAddress);
    if (!proxyAddress) {
        writeFileSync("/tmp/proxy-deploy-raw.json", JSON.stringify(proxyResult, null, 2));
        throw new Error("Failed to parse JanusFlowProxy address — see /tmp/proxy-deploy-raw.json");
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

    // Impl should NOT be initialised — owner() reverts (or returns 0). We use
    // a low-level call so a revert doesn't kill the script.
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
        version: "0.3.0",
        date: new Date().toISOString().slice(0, 10),
        network: "flow-evm-testnet",
        chainId: 545,
        contracts: {
            JanusFlow_proxy: proxyAddress,
            JanusFlow_impl: implAddress,
            AmountDiscloseVerifier: verifierAddress,
            ConfidentialTransferVerifier: CONFIDENTIAL_TRANSFER_VERIFIER,
            BabyJub: BABYJUB_ADDRESS,
        },
        contract_status: {
            JanusFlow_proxy: "NEW",
            JanusFlow_impl: "NEW",
            AmountDiscloseVerifier: "NEW (production v0.3 ceremony)",
            ConfidentialTransferVerifier: "NEW (rebuilt from lab current zkey; the previous lab-deployed verifier 0x70FA...141b0 no longer matches the current cadence-crypto-lab zkey artifacts)",
            BabyJub: "REUSED (existing — stateless library)",
        },
        deprecated_references: {
            JanusToken_proxy_v02: {
                address: "0x025efe7e89acdb8F315C804BE7245F348AA9c538",
                status: "DEPRECATED — leaky ElGamal-accumulator design, do not use for new flows",
                note: "Stays deployed for archival purposes; v0.3 is fully independent.",
            },
        },
        tx_hashes: {
            amount_disclose_verifier_deploy: verifierTxHash,
            confidential_transfer_verifier_deploy: xferVerifierTxHash,
            janus_flow_impl_deploy: implTxHash,
            janus_flow_proxy_deploy_with_init: proxyTxHash,
        },
        owner: owner,
        deployer_flow_account: OPENJANUS_FLOW_ADDR,
        deployer_coa_evm: OPENJANUS_FLOW_COA_EVM,
        deploy_method: "coa.deploy() via Cadence transaction (P-256 Flow signing)",
        upgradability: "UUPS (proxy.upgradeToAndCall, gated by _authorizeUpgrade onlyOwner)",
        ceremony_zkey_sha256: CEREMONY_ZKEY_SHA256,
        ceremony_path: "circuits/v0.3-ceremony/",
        ceremony_grade: "pre-mainnet (Hermez pot14 + 2 named contributors + Flow VRF beacon)",
        post_deploy_checks: {
            owner_is_admin_coa: ownerMatches,
            babyJub_address: babyJubAddr,
            transferVerifier_address: xferAddr,
            amountDiscloseVerifier_address: adAddr,
            impl_owner_direct: implOwnerStatus,
        },
        explorer: {
            proxy: `https://evm-testnet.flowscan.io/address/${proxyAddress}`,
            impl: `https://evm-testnet.flowscan.io/address/${implAddress}`,
            amount_verifier: `https://evm-testnet.flowscan.io/address/${verifierAddress}`,
        },
    };

    const outPath = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log("\nDeployment record written:", outPath);
    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
