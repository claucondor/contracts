/**
 * deploy-proxy.mjs — Deploy UUPS JanusToken (impl + ERC1967Proxy) to Flow EVM testnet
 *
 * Fixes vulnerability 014 (unwrap unit mismatch) and introduces UUPS upgradeability.
 *
 * Deploys via openjanus-flow COA (P-256 Flow signing, no EVM EOA derivation needed).
 * Each step is a separate Cadence tx so all 3 tx hashes are first-class.
 *
 * Steps:
 *   1. coa.deploy(JanusToken impl bytecode) → impl address
 *   2. coa.deploy(ERC1967Proxy ctor(impl, initData)) → proxy address
 *   3. coa.call(proxy, owner()) → verify owner
 *
 * Note: ERC1967Proxy constructor calls initialize() during deployment, so a
 * separate initialize tx is not needed. We capture it as part of step 2.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AbiCoder, Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const IMPL_ARTIFACT = join(MODULE_ROOT, "artifacts/contracts/solidity/JanusToken.sol/JanusToken.json");
const PROXY_ARTIFACT = join(MODULE_ROOT, "artifacts/contracts/solidity/JanusTokenProxy.sol/JanusTokenProxy.json");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

// Existing ZK verifier addresses (KEEP)
const BABYJUB_ADDRESS          = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const ENCRYPT_VERIFIER_ADDRESS = "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e";
const DECRYPT_VERIFIER_ADDRESS = "0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc";

// Deployer / owner Flow account
const FLOW_SIGNER = "openjanus-flow";
const OPENJANUS_FLOW_ADDR = "0xbef3c77681c15397";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";

const RPC_URL = "https://testnet.evm.nodes.onflow.org";

// Cadence: deploy raw bytecode via COA
const DEPLOY_TX = `import "EVM"

transaction(bytecodeHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Deploy) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        // EVM gas (NOT Cadence CU): 6M is plenty for ~12KB bytecode.
        let result = coa.deploy(
            code: bytecodeHex.decodeHex(),
            gasLimit: 6_000_000,
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

// Cadence: arbitrary read-only call via COA
const CALL_TX = `import "EVM"

transaction(toHex: String, dataHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let to = EVM.addressFromString(toHex)
        let result = coa.call(
            to: to,
            data: dataHex.decodeHex(),
            gasLimit: 200_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "call failed: ".concat(result.errorMessage)
        )
        log("call ok, returned hex bytes")
    }
}
`;

function runFlowTx(txPath, argHex, label) {
    const cmd = [
        "flow transactions send",
        txPath,
        `"${argHex}"`,
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
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] ${err.stdout?.slice(0, 800)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
        }
    }
    return result;
}

function runFlowTxTwoArgs(txPath, arg1, arg2, label) {
    const cmd = [
        "flow transactions send",
        txPath,
        `"${arg1}"`,
        `"${arg2}"`,
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
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] ${err.stdout?.slice(0, 800)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
        }
    }
    return result;
}

function extractDeployedAddress(result) {
    const blob = JSON.stringify(result?.events ?? []);
    // first match for an EVM contract address from event payload
    const matches = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (matches.length > 0) return matches[0][1];

    // some Flow CLI builds return RLP-encoded addresses inside the event payload
    // fall back: look for first 0x40-hex address in the event blob
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => a !== "0x0000000000000000000000000000000000000000"
                  && a.toLowerCase() !== OPENJANUS_FLOW_COA_EVM.toLowerCase()
                  && a !== BABYJUB_ADDRESS
                  && a !== ENCRYPT_VERIFIER_ADDRESS
                  && a !== DECRYPT_VERIFIER_ADDRESS);
    return fallback[0] ?? null;
}

async function main() {
    console.log("=== UUPS JanusToken deploy (impl + ERC1967 proxy) ===\n");

    if (!existsSync(IMPL_ARTIFACT)) throw new Error("impl artifact missing — run hardhat compile");
    if (!existsSync(PROXY_ARTIFACT)) throw new Error("proxy artifact missing — run hardhat compile");

    const implArt = JSON.parse(readFileSync(IMPL_ARTIFACT, "utf8"));
    const proxyArt = JSON.parse(readFileSync(PROXY_ARTIFACT, "utf8"));

    // ───────────────────── Step 1: deploy impl ─────────────────────
    console.log("[1/3] Deploying JanusToken implementation...");
    const implTxFile = "/tmp/.deploy_impl.cdc";
    writeFileSync(implTxFile, DEPLOY_TX);

    // Impl deploys WITHOUT constructor args (constructor only calls _disableInitializers)
    const implDeployHex = implArt.bytecode.slice(2);
    console.log("  impl bytecode size:", implDeployHex.length / 2, "bytes");

    const implResult = runFlowTx(implTxFile, implDeployHex, "deploy-impl");
    const implTxHash = implResult?.id ?? "unknown";
    const implAddress = extractDeployedAddress(implResult);
    console.log("  impl tx:", implTxHash);
    console.log("  impl address:", implAddress);
    if (!implAddress) {
        writeFileSync("/tmp/impl-raw.json", JSON.stringify(implResult, null, 2));
        throw new Error("Could not parse impl address — see /tmp/impl-raw.json");
    }

    // ─────────────────── Step 2: deploy ERC1967 proxy ───────────────────
    console.log("\n[2/3] Deploying ERC1967Proxy → calls impl.initialize() atomically...");
    const iface = new Interface(implArt.abi);
    const initData = iface.encodeFunctionData("initialize", [
        BABYJUB_ADDRESS,
        ENCRYPT_VERIFIER_ADDRESS,
        DECRYPT_VERIFIER_ADDRESS,
        OPENJANUS_FLOW_COA_EVM,  // owner = our COA so we can authorize upgrades
    ]);
    console.log("  initialize calldata length:", initData.length / 2 - 1, "bytes");

    const proxyAbiCoder = new AbiCoder();
    const proxyCtorArgs = proxyAbiCoder.encode(
        ["address", "bytes"],
        [implAddress, initData]
    );
    const proxyDeployHex = proxyArt.bytecode.slice(2) + proxyCtorArgs.slice(2);
    console.log("  proxy deploy payload:", proxyDeployHex.length / 2, "bytes");

    const proxyTxFile = "/tmp/.deploy_proxy.cdc";
    writeFileSync(proxyTxFile, DEPLOY_TX);
    const proxyResult = runFlowTx(proxyTxFile, proxyDeployHex, "deploy-proxy");
    const proxyTxHash = proxyResult?.id ?? "unknown";
    const proxyAddress = extractDeployedAddress(proxyResult);
    console.log("  proxy tx (initialize included):", proxyTxHash);
    console.log("  proxy address:", proxyAddress);
    if (!proxyAddress) {
        writeFileSync("/tmp/proxy-raw.json", JSON.stringify(proxyResult, null, 2));
        throw new Error("Could not parse proxy address — see /tmp/proxy-raw.json");
    }

    // ─────────────────── Step 3: verify owner() via proxy ───────────────────
    console.log("\n[3/3] Verifying proxy.owner() == admin COA...");
    const provider = new JsonRpcProvider(RPC_URL);
    const ownerSlotData = iface.encodeFunctionData("owner", []);
    const ownerHex = await provider.call({ to: proxyAddress, data: ownerSlotData });
    const owner = "0x" + ownerHex.slice(-40);
    console.log("  proxy.owner() =", owner);
    const ownerMatches = owner.toLowerCase() === OPENJANUS_FLOW_COA_EVM.toLowerCase();
    console.log("  matches admin COA:", ownerMatches ? "YES" : "NO");

    // Also verify SCALE constant
    const scaleData = iface.encodeFunctionData("SCALE", []);
    const scaleHex = await provider.call({ to: proxyAddress, data: scaleData });
    const scale = BigInt(scaleHex);
    console.log("  proxy.SCALE() =", scale.toString(), "(expected: 1000000000000000000)");

    // Direct read of impl (should not be initialized)
    const implOwnerHex = await provider.call({ to: implAddress, data: ownerSlotData });
    const implOwner = "0x" + implOwnerHex.slice(-40);
    console.log("  impl.owner() direct =", implOwner, "(expected: 0x0 — impl is locked)");

    // ─────────────────── Record ───────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const deployment = {
        network: "flow-evm-testnet",
        chain_id: 545,
        deployed_at: new Date().toISOString(),
        contract: "JanusToken (UUPS)",
        scheme: "ERC1967Proxy → JanusToken implementation",
        proxy_address: proxyAddress,
        impl_address: implAddress,
        owner: owner,
        scale: scale.toString(),
        scale_expected: "1000000000000000000",
        impl_owner_direct: implOwner,
        impl_locked: implOwner === "0x0000000000000000000000000000000000000000",
        tx_hashes: {
            impl_deploy: implTxHash,
            proxy_deploy_with_init: proxyTxHash,
            // initialize call is bundled into proxy deploy (ERC1967Proxy ctor calls it)
        },
        dependencies: {
            BabyJub: BABYJUB_ADDRESS,
            EncryptConsistencyVerifier: ENCRYPT_VERIFIER_ADDRESS,
            DecryptOpenVerifier: DECRYPT_VERIFIER_ADDRESS,
        },
        deployer_flow_account: OPENJANUS_FLOW_ADDR,
        deployer_coa_evm: OPENJANUS_FLOW_COA_EVM,
        deploy_method: "coa.deploy() via Cadence transaction (P-256 Flow signing)",
        fixes: ["vulnerability-catalog/014 (unwrap unit mismatch via SCALE=1e18)"],
        upgradability: "UUPS (proxy.upgradeToAndCall, gated by _authorizeUpgrade onlyOwner)",
    };
    writeFileSync(join(DEPLOYMENTS_DIR, "janus-token-uups.json"), JSON.stringify(deployment, null, 2));
    console.log("\nDeployment record written.");
    return deployment;
}

main().catch(err => {
    console.error("FATAL:", err.message);
    process.exit(1);
});
