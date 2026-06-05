/**
 * deploy-aggregate.mjs — v0.7.0 aggregate commitment deployment.
 *
 * Deploys the full aggregate commitment stack to Flow EVM testnet:
 *   1. Pedersen2Gen library (new — stateless commitment primitives)
 *   2. ConfidentialTransferAggregateVerifier (new — test zkey, 18,620 constraints)
 *   3. JanusFlow impl + proxy (new — wired to aggregate verifier + Pedersen2Gen)
 *   4. JanusERC20 impl + proxy (new — wired to aggregate verifier + Pedersen2Gen)
 *
 * REUSED (stateless — no state to corrupt):
 *   BabyJub                  0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   AmountDiscloseVerifier   0xD0ED3936530258C278f5357C1dB709ad34768352
 *   MemoKeyRegistry          0x05D104962ff087441f26BA11A1E1C3b9E091D663
 *   MockUSDC                 0x686E8d90A7B608540cAF46E527fD8a5631A1b658
 *
 * Admin:
 *   Cadence:  0xc4e8f99915893a2f
 *   COA EVM:  0x000000000000000000000002656f9205e386ed78
 *
 * WARN: Verifier is test zkey only (single-contributor).
 * Multi-party ceremony required before mainnet.
 *
 * Output: deployments/aggregate-testnet.json
 *
 * Run from repo root:
 *   node scripts/deploy-aggregate.mjs
 *
 * Prerequisites:
 *   cd packages/janus-token && npx hardhat compile --config hardhat.config.cjs
 *   cd packages/janus-erc20 && npx hardhat compile --config hardhat.config.cjs
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
const FLOW_JSON         = "/tmp/aggregate_flow.json";

// ── Artifact paths ────────────────────────────────────────────────────────────
const PEDERSEN_ART   = join(JF_ARTIFACTS, "Pedersen2Gen.sol/Pedersen2Gen.json");
const AGG_VER_ART    = join(JF_ARTIFACTS, "ConfidentialTransferAggregateVerifier.sol/ConfidentialTransferAggregateVerifier.json");
const JF_ART         = join(JF_ARTIFACTS, "JanusFlow.sol/JanusFlow.json");
const JF_PROXY_ART   = join(JF_ARTIFACTS, "JanusFlow.sol/JanusFlow_Proxy.json");
const ERC20_ART      = join(ERC20_ARTIFACTS, "JanusERC20.sol/JanusERC20.json");
const ERC20_PROXY_ART = join(ERC20_ARTIFACTS, "JanusERC20.sol/JanusERC20_Proxy.json");

// ── Reused addresses ──────────────────────────────────────────────────────────
const BABYJUB_ADDRESS          = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const AMOUNT_DISCLOSE_VERIFIER = "0xD0ED3936530258C278f5357C1dB709ad34768352";
const MEMO_REGISTRY            = "0x05D104962ff087441f26BA11A1E1C3b9E091D663";
const MOCK_USDC                = "0x686E8d90A7B608540cAF46E527fD8a5631A1b658";

// ── Admin ──────────────────────────────────────────────────────────────────────
const ADMIN_CADENCE    = "c4e8f99915893a2f";
const ADMIN_COA_EVM    = "0x000000000000000000000002656f9205e386ed78";
const FLOW_SIGNER      = "v066-admin";
const PKEY_PATH        = "/home/oydual3/.flow/v066-admin.pkey";

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID = 545;

// ── Flow JSON config ──────────────────────────────────────────────────────────
const flowJsonConfig = {
    networks: { testnet: "access.devnet.nodes.onflow.org:9000" },
    accounts: {
        [FLOW_SIGNER]: {
            address: ADMIN_CADENCE,
            key: { type: "file", location: PKEY_PATH },
        },
    },
    contracts: {},
    deployments: {},
};

// ── Cadence deploy transaction ────────────────────────────────────────────────
const DEPLOY_TX_TEMPLATE = `import "EVM"

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

function ensureFlowJson() {
    writeFileSync(FLOW_JSON, JSON.stringify(flowJsonConfig, null, 2));
}

function runFlowDeploy(bytecodeHex, label) {
    const txPath = `/tmp/.agg_${label}.cdc`;
    writeFileSync(txPath, DEPLOY_TX_TEMPLATE);
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
            try {
                result = JSON.parse(err.stdout);
            } catch {
                throw new Error(
                    `[${label}] flow CLI non-JSON output:\n${err.stdout?.slice(0, 1000)}\nSTDERR: ${err.stderr?.slice(0, 400)}`
                );
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

function extractDeployedAddress(result, label) {
    const blob = JSON.stringify(result?.events ?? []);
    // Primary: explicit contractAddress field
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    // Fallback: any 40-char hex address not in the known-set
    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        ADMIN_COA_EVM.toLowerCase(),
        BABYJUB_ADDRESS.toLowerCase(),
        AMOUNT_DISCLOSE_VERIFIER.toLowerCase(),
        MEMO_REGISTRY.toLowerCase(),
        MOCK_USDC.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    if (fallback.length > 0) return fallback[0];

    // Last resort: dump result for debugging
    writeFileSync(`/tmp/.agg_${label}_raw.json`, JSON.stringify(result, null, 2));
    return null;
}

async function callView(provider, to, iface, fn) {
    const data = iface.encodeFunctionData(fn, []);
    const hex = await provider.call({ to, data });
    return "0x" + hex.slice(-40);
}

async function main() {
    console.log("=== JanusFlow + JanusERC20 aggregate commitment (v0.7.0) deploy ===\n");
    console.log("Admin Cadence:", `0x${ADMIN_CADENCE}`);
    console.log("Admin COA EVM:", ADMIN_COA_EVM);
    console.log("WARN: Test zkey only — single-contributor ceremony. Mainnet requires ≥3 contributors.\n");

    // Verify artifacts exist
    const artifacts = [PEDERSEN_ART, AGG_VER_ART, JF_ART, JF_PROXY_ART, ERC20_ART, ERC20_PROXY_ART];
    for (const p of artifacts) {
        if (!existsSync(p)) {
            throw new Error(
                `Missing artifact: ${p}\n` +
                `Run:\n` +
                `  cd packages/janus-token && npx hardhat compile --config hardhat.config.cjs\n` +
                `  cd packages/janus-erc20 && npx hardhat compile --config hardhat.config.cjs`
            );
        }
    }

    const pedersenArt  = JSON.parse(readFileSync(PEDERSEN_ART, "utf8"));
    const aggVerArt    = JSON.parse(readFileSync(AGG_VER_ART, "utf8"));
    const jfArt        = JSON.parse(readFileSync(JF_ART, "utf8"));
    const jfProxyArt   = JSON.parse(readFileSync(JF_PROXY_ART, "utf8"));
    const erc20Art     = JSON.parse(readFileSync(ERC20_ART, "utf8"));
    const erc20ProxyArt = JSON.parse(readFileSync(ERC20_PROXY_ART, "utf8"));

    const abiCoder = new AbiCoder();
    const provider = new JsonRpcProvider(RPC_URL);
    ensureFlowJson();

    const txHashes = {};
    const contracts = {};

    // ── 1. Deploy Pedersen2Gen library ────────────────────────────────────────
    console.log("[1/5] Deploying Pedersen2Gen (stateless commitment library)...");
    const pedersenBytecode = pedersenArt.bytecode.replace(/^0x/, "");
    const pedersenResult = runFlowDeploy(pedersenBytecode, "pedersen2gen");
    txHashes.pedersen2gen_deploy = pedersenResult.id ?? "unknown";
    const pedersenAddress = extractDeployedAddress(pedersenResult, "pedersen2gen");
    console.log("  tx:", txHashes.pedersen2gen_deploy);
    console.log("  address:", pedersenAddress);
    if (!pedersenAddress) {
        throw new Error("Failed to parse Pedersen2Gen address — see /tmp/.agg_pedersen2gen_raw.json");
    }
    contracts.Pedersen2Gen_library = pedersenAddress;

    // ── 2. Deploy ConfidentialTransferAggregateVerifier ───────────────────────
    console.log("\n[2/5] Deploying ConfidentialTransferAggregateVerifier (test zkey)...");
    const aggVerBytecode = aggVerArt.bytecode.replace(/^0x/, "");
    const aggVerResult = runFlowDeploy(aggVerBytecode, "agg_verifier");
    txHashes.agg_verifier_deploy = aggVerResult.id ?? "unknown";
    const aggVerAddress = extractDeployedAddress(aggVerResult, "agg_verifier");
    console.log("  tx:", txHashes.agg_verifier_deploy);
    console.log("  address:", aggVerAddress);
    if (!aggVerAddress) {
        throw new Error("Failed to parse ConfidentialTransferAggregateVerifier address");
    }
    contracts.ConfidentialTransferAggregateVerifier = aggVerAddress;

    // ── 3. Deploy JanusFlow impl ──────────────────────────────────────────────
    console.log("\n[3/5] Deploying JanusFlow implementation (v0.7.0)...");
    const jfImplBytecode = jfArt.bytecode.replace(/^0x/, "");
    const jfImplResult = runFlowDeploy(jfImplBytecode, "janusflow_impl");
    txHashes.janusflow_impl_deploy = jfImplResult.id ?? "unknown";
    const jfImplAddress = extractDeployedAddress(jfImplResult, "janusflow_impl");
    console.log("  tx:", txHashes.janusflow_impl_deploy);
    console.log("  address:", jfImplAddress);
    if (!jfImplAddress) {
        throw new Error("Failed to parse JanusFlow impl address");
    }
    contracts.JanusFlow_impl = jfImplAddress;

    // ── 4. Deploy JanusFlow proxy (with atomic initialize) ────────────────────
    console.log("\n[4/5] Deploying JanusFlow proxy (with initialize, v0.7.0)...");
    const jfIface = new Interface(jfArt.abi);
    const jfInitData = jfIface.encodeFunctionData("initialize", [
        BABYJUB_ADDRESS,
        aggVerAddress,          // new aggregate verifier
        AMOUNT_DISCLOSE_VERIFIER,
        ADMIN_COA_EVM,
        MEMO_REGISTRY,
        pedersenAddress,        // new Pedersen2Gen library
    ]);
    const jfProxyCtorArgs = abiCoder.encode(["address", "bytes"], [jfImplAddress, jfInitData]);
    const jfProxyBytecode = jfProxyArt.bytecode.replace(/^0x/, "") + jfProxyCtorArgs.slice(2);
    const jfProxyResult = runFlowDeploy(jfProxyBytecode, "janusflow_proxy");
    txHashes.janusflow_proxy_deploy = jfProxyResult.id ?? "unknown";
    const jfProxyAddress = extractDeployedAddress(jfProxyResult, "janusflow_proxy");
    console.log("  tx:", txHashes.janusflow_proxy_deploy);
    console.log("  address:", jfProxyAddress);
    if (!jfProxyAddress) {
        throw new Error("Failed to parse JanusFlow proxy address");
    }
    contracts.JanusFlow_proxy = jfProxyAddress;

    // ── 5. Deploy JanusERC20 impl + proxy ─────────────────────────────────────
    console.log("\n[5/5] Deploying JanusERC20 impl + proxy (v0.7.0)...");

    const erc20ImplBytecode = erc20Art.bytecode.replace(/^0x/, "");
    const erc20ImplResult = runFlowDeploy(erc20ImplBytecode, "januserc20_impl");
    txHashes.januserc20_impl_deploy = erc20ImplResult.id ?? "unknown";
    const erc20ImplAddress = extractDeployedAddress(erc20ImplResult, "januserc20_impl");
    console.log("  JanusERC20 impl tx:", txHashes.januserc20_impl_deploy);
    console.log("  JanusERC20 impl address:", erc20ImplAddress);
    if (!erc20ImplAddress) {
        throw new Error("Failed to parse JanusERC20 impl address");
    }
    contracts.JanusERC20_impl = erc20ImplAddress;

    const erc20Iface = new Interface(erc20Art.abi);
    const erc20InitData = erc20Iface.encodeFunctionData("initialize", [
        BABYJUB_ADDRESS,
        aggVerAddress,           // new aggregate verifier
        AMOUNT_DISCLOSE_VERIFIER,
        MOCK_USDC,               // reused underlying
        ADMIN_COA_EVM,
        MEMO_REGISTRY,
        pedersenAddress,         // new Pedersen2Gen library
    ]);
    const erc20ProxyCtorArgs = abiCoder.encode(["address", "bytes"], [erc20ImplAddress, erc20InitData]);
    const erc20ProxyBytecode = erc20ProxyArt.bytecode.replace(/^0x/, "") + erc20ProxyCtorArgs.slice(2);
    const erc20ProxyResult = runFlowDeploy(erc20ProxyBytecode, "januserc20_proxy");
    txHashes.januserc20_proxy_deploy = erc20ProxyResult.id ?? "unknown";
    const erc20ProxyAddress = extractDeployedAddress(erc20ProxyResult, "januserc20_proxy");
    console.log("  JanusERC20 proxy tx:", txHashes.januserc20_proxy_deploy);
    console.log("  JanusERC20 proxy address:", erc20ProxyAddress);
    if (!erc20ProxyAddress) {
        throw new Error("Failed to parse JanusERC20 proxy address");
    }
    contracts.JanusERC20_proxy = erc20ProxyAddress;

    // ── Post-deploy verification ──────────────────────────────────────────────
    console.log("\n=== Verifying deployed proxies via eth_call ===");

    const checkResults = {};

    for (const [name, { proxy, iface }] of [
        ["janusflow", { proxy: jfProxyAddress, iface: jfIface }],
        ["januserc20", { proxy: erc20ProxyAddress, iface: erc20Iface }],
    ]) {
        const owner   = await callView(provider, proxy, iface, "owner");
        const babyjub = await callView(provider, proxy, iface, "babyJub");
        const xfer    = await callView(provider, proxy, iface, "transferVerifier");
        const ad      = await callView(provider, proxy, iface, "amountDiscloseVerifier");
        const memreg  = await callView(provider, proxy, iface, "memoRegistry");
        const p2g     = await callView(provider, proxy, iface, "pedersen2Gen");

        const totalLockedData = iface.encodeFunctionData("totalLocked", []);
        const totalLockedHex = await provider.call({ to: proxy, data: totalLockedData });
        const totalLocked = BigInt(totalLockedHex).toString();

        console.log(`\n  ${name} proxy: ${proxy}`);
        console.log(`    owner()                     = ${owner}`);
        console.log(`    babyJub()                   = ${babyjub}`);
        console.log(`    transferVerifier()           = ${xfer} (aggregate verifier)`);
        console.log(`    amountDiscloseVerifier()     = ${ad}`);
        console.log(`    memoRegistry()               = ${memreg}`);
        console.log(`    pedersen2Gen()               = ${p2g}`);
        console.log(`    totalLocked()               = ${totalLocked}`);

        checkResults[name] = {
            owner_is_admin_coa:          owner.toLowerCase() === ADMIN_COA_EVM.toLowerCase(),
            babyjub_correct:             babyjub.toLowerCase() === BABYJUB_ADDRESS.toLowerCase(),
            transfer_verifier_is_agg:    xfer.toLowerCase() === aggVerAddress.toLowerCase(),
            amount_disclose_correct:     ad.toLowerCase() === AMOUNT_DISCLOSE_VERIFIER.toLowerCase(),
            memo_registry_correct:       memreg.toLowerCase() === MEMO_REGISTRY.toLowerCase(),
            pedersen2gen_correct:        p2g.toLowerCase() === pedersenAddress.toLowerCase(),
            total_locked_zero:           totalLocked === "0",
        };
    }

    // JanusERC20: check underlying
    const underlyingData = erc20Iface.encodeFunctionData("underlying", []);
    const underlyingHex = await provider.call({ to: erc20ProxyAddress, data: underlyingData });
    const underlyingAddr = "0x" + underlyingHex.slice(-40);
    console.log(`\n  JanusERC20.underlying() = ${underlyingAddr} (expected: ${MOCK_USDC.toLowerCase()})`);
    checkResults.januserc20.underlying_correct = underlyingAddr.toLowerCase() === MOCK_USDC.toLowerCase();

    // ── Save deployment record ────────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

    const record = {
        version: "0.7.0",
        date: new Date().toISOString().slice(0, 10),
        network: "flow-evm-testnet",
        chainId: CHAIN_ID,
        admin: {
            cadence_address: `0x${ADMIN_CADENCE}`,
            coa_evm_address: ADMIN_COA_EVM,
            pkey_path: PKEY_PATH,
            note: "Reused from v0.6.6 stack",
        },
        contracts: {
            Pedersen2Gen_library:                contracts.Pedersen2Gen_library,
            ConfidentialTransferAggregateVerifier: contracts.ConfidentialTransferAggregateVerifier,
            JanusFlow_impl:                       contracts.JanusFlow_impl,
            JanusFlow_proxy:                      contracts.JanusFlow_proxy,
            JanusERC20_impl:                      contracts.JanusERC20_impl,
            JanusERC20_proxy:                     contracts.JanusERC20_proxy,
            BabyJub:                              BABYJUB_ADDRESS,
            AmountDiscloseVerifier:               AMOUNT_DISCLOSE_VERIFIER,
            MemoKeyRegistry:                      MEMO_REGISTRY,
            MockUSDC:                             MOCK_USDC,
        },
        contract_status: {
            Pedersen2Gen_library:                "NEW (stateless, reusable, homomorphic point operations)",
            ConfidentialTransferAggregateVerifier: "NEW (test zkey — single-contributor, testnet only)",
            JanusFlow_impl:                       "NEW (v0.7.0 — 2-gen Pedersen aggregate commitment)",
            JanusFlow_proxy:                      "NEW (UUPS, initialized with aggregate verifier + Pedersen2Gen)",
            JanusERC20_impl:                      "NEW (v0.7.0 — 2-gen Pedersen aggregate commitment)",
            JanusERC20_proxy:                     "NEW (UUPS, initialized with aggregate verifier + Pedersen2Gen)",
            BabyJub:                              "REUSED (stateless — no corruption risk)",
            AmountDiscloseVerifier:               "REUSED (stateless — no corruption risk)",
            MemoKeyRegistry:                      "REUSED (shared registry — unaffected by stack change)",
            MockUSDC:                             "REUSED (testnet underlying token)",
        },
        tx_hashes: txHashes,
        post_deploy_checks: checkResults,
        fee_status: "NOT_INITIALIZED — run initFees(ADMIN_COA_EVM, 10) from owner",
        ceremony: {
            type: "single-contributor-test",
            pot: "pot18 from Hermez (powersOfTau28_hez_final_18.ptau)",
            constraints: 18620,
            zkey_path: "circuits/aggregate-ceremony/setup/confidential_transfer_aggregate_test.zkey",
            production_required: "multi-party Phase 2 with ≥3 contributors before mainnet",
        },
        explorer: {
            JanusFlow_proxy:  `https://evm-testnet.flowscan.io/address/${jfProxyAddress}`,
            JanusERC20_proxy: `https://evm-testnet.flowscan.io/address/${erc20ProxyAddress}`,
        },
        cadence_contracts: {
            JanusFT: {
                address: "0x7599043aea001283",
                note: "REUSED from testnet-claucondor account — JanusFT Cadence side unchanged",
            },
        },
    };

    const outPath = join(DEPLOYMENTS_DIR, "aggregate-testnet.json");
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log("\n=== Deployment record written:", outPath, "===");

    // Summary
    const allChecksPass = Object.values(checkResults).every(r =>
        typeof r === "object" ? Object.values(r).every(Boolean) : r
    );

    console.log("\n=== SUMMARY ===");
    console.log("Pedersen2Gen:          ", pedersenAddress);
    console.log("AggregateVerifier:     ", aggVerAddress);
    console.log("JanusFlow proxy:       ", jfProxyAddress);
    console.log("JanusERC20 proxy:      ", erc20ProxyAddress);
    console.log("All post-deploy checks:", allChecksPass ? "PASS" : "FAIL — review above");

    if (!allChecksPass) {
        console.error("\nWARN: Some post-deploy checks failed. Review the deployment record before proceeding.");
        process.exit(1);
    }

    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
