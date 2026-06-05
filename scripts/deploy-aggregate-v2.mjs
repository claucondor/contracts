/**
 * deploy-aggregate-v2.mjs — amount-disclose aggregate integration deployment.
 *
 * This script completes the aggregate-Pedersen stack by:
 *   1. Deploying AmountDiscloseAggregateVerifier (new — test zkey, 6,163 constraints)
 *   2. Deploying new JanusFlow impl (wrapWithProof + usedNonces)
 *   3. Upgrading JanusFlow proxy to new impl (UUPS upgradeToAndCall)
 *   4. Deploying new JanusERC20 impl (wrapWithProof + usedNonces)
 *   5. Upgrading JanusERC20 proxy to new impl (UUPS upgradeToAndCall)
 *   6. Configuring AmountDiscloseAggregateVerifier on both proxies via setAmountDiscloseVerifier
 *
 * Existing proxy addresses (from deploy-aggregate.mjs run):
 *   JanusFlow proxy:    0x9A83732417947Ef9b7AEa64bF807a345267c2FdA
 *   JanusERC20 proxy:   0xD5E6a52635599E6B2296B5BfEeC617E333561ea0
 *
 * Admin:
 *   Cadence:  0xc4e8f99915893a2f
 *   COA EVM:  0x000000000000000000000002656f9205e386ed78
 *
 * WARN: Verifier is test zkey only (single-contributor).
 * Multi-party ceremony required before mainnet.
 *
 * Output: updates deployments/aggregate-testnet.json
 *
 * Run from repo root:
 *   node scripts/deploy-aggregate-v2.mjs
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
const AMT_DISCLOSE_ART  = join(JF_ARTIFACTS, "AmountDiscloseAggregateVerifier.sol/AmountDiscloseAggregateVerifier.json");
const JF_ART            = join(JF_ARTIFACTS, "JanusFlow.sol/JanusFlow.json");
const ERC20_ART         = join(ERC20_ARTIFACTS, "JanusERC20.sol/JanusERC20.json");

// ── Existing deployed addresses ──────────────────────────────────────────────
// These are the proxies from the prior deploy — we upgrade them in place.
const JANUSFLOW_PROXY    = "0x9A83732417947Ef9b7AEa64bF807a345267c2FdA";
const JANUSERC20_PROXY   = "0xD5E6a52635599E6B2296B5BfEeC617E333561ea0";
const PEDERSEN2GEN       = "0xb8Af0091A010E082b05d0c55E1019c3833E15760";
const BABYJUB_ADDRESS    = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const MEMO_REGISTRY      = "0x05D104962ff087441f26BA11A1E1C3b9E091D663";
const MOCK_USDC          = "0x686E8d90A7B608540cAF46E527fD8a5631A1b658";
const AGG_TRANSFER_VER   = "0x5702A545d2853b03B808aEA331f892c121b67243";

// ── Admin ──────────────────────────────────────────────────────────────────────
const ADMIN_CADENCE    = "c4e8f99915893a2f";
const ADMIN_COA_EVM    = "0x000000000000000000000002656f9205e386ed78";
const FLOW_SIGNER      = "v066-admin";
const PKEY_PATH        = "/home/oydual3/.flow/v066-admin.pkey";

const RPC_URL  = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID = 545;

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

// ── Cadence call transaction ────────────────────────────────────────────────
const CALL_TX_TEMPLATE = `import "EVM"

transaction(contractAddress: String, calldataHex: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(contractAddress),
            data: calldataHex.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "call failed: ".concat(result.errorMessage)
        )
    }
}
`;

function ensureFlowJson() {
    const base = JSON.parse(readFileSync(join(JANUS_TOKEN_PKG, "flow.json"), "utf8"));
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
    writeFileSync(FLOW_JSON, JSON.stringify(cleaned, null, 2));
}

function runFlowDeploy(bytecodeHex, label) {
    const txPath = `/tmp/.agg2_${label}.cdc`;
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
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] flow CLI non-JSON:\n${err.stdout?.slice(0, 1000)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}`);
        }
    }
    if (result.error) throw new Error(`[${label}] tx failed: ${result.error.slice(0, 500)}`);
    return result;
}

function runFlowCall(contractAddress, calldataHex, label, gasLimit = 3000000) {
    const txPath = `/tmp/.agg2_call_${label}.cdc`;
    writeFileSync(txPath, CALL_TX_TEMPLATE);
    const cmd = [
        "flow transactions send",
        txPath,
        `"${contractAddress}"`,
        `"${calldataHex}"`,
        `${gasLimit}`,
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
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] flow CLI non-JSON:\n${err.stdout?.slice(0, 1000)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}`);
        }
    }
    if (result.error) throw new Error(`[${label}] call failed: ${result.error.slice(0, 500)}`);
    return result;
}

function extractDeployedAddress(result, label) {
    const blob = JSON.stringify(result?.events ?? []);
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        ADMIN_COA_EVM.toLowerCase(),
        JANUSFLOW_PROXY.toLowerCase(),
        JANUSERC20_PROXY.toLowerCase(),
        PEDERSEN2GEN.toLowerCase(),
        BABYJUB_ADDRESS.toLowerCase(),
        MEMO_REGISTRY.toLowerCase(),
        MOCK_USDC.toLowerCase(),
        AGG_TRANSFER_VER.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    if (fallback.length > 0) return fallback[0];

    writeFileSync(`/tmp/.agg2_${label}_raw.json`, JSON.stringify(result, null, 2));
    return null;
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

async function callView(provider, to, iface, fn) {
    const data = iface.encodeFunctionData(fn, []);
    const hex = await provider.call({ to, data });
    return "0x" + hex.slice(-40);
}

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow + JanusERC20 amount-disclose aggregate integration (v0.7.1)");
    console.log("Network: Flow EVM Testnet (chainId 545)");
    console.log("=".repeat(72));
    console.log("Admin Cadence:", `0x${ADMIN_CADENCE}`);
    console.log("Admin COA EVM:", ADMIN_COA_EVM);
    console.log("JanusFlow proxy (existing):", JANUSFLOW_PROXY);
    console.log("JanusERC20 proxy (existing):", JANUSERC20_PROXY);
    console.log("WARN: Test zkey only — single-contributor. Mainnet requires ≥3 contributors.\n");

    // Verify artifacts exist
    for (const p of [AMT_DISCLOSE_ART, JF_ART, ERC20_ART]) {
        if (!existsSync(p)) {
            throw new Error(
                `Missing artifact: ${p}\n` +
                `Run: cd packages/janus-token && npx hardhat compile --config hardhat.config.cjs\n` +
                `     cd packages/janus-erc20 && npx hardhat compile --config hardhat.config.cjs`
            );
        }
    }

    const amtDiscloseArt = JSON.parse(readFileSync(AMT_DISCLOSE_ART, "utf8"));
    const jfArt          = JSON.parse(readFileSync(JF_ART, "utf8"));
    const erc20Art       = JSON.parse(readFileSync(ERC20_ART, "utf8"));

    const provider  = new JsonRpcProvider(RPC_URL);
    const abiCoder  = new AbiCoder();
    const jfIface   = new Interface(jfArt.abi);
    const erc20Iface = new Interface(erc20Art.abi);

    ensureFlowJson();

    const txHashes  = {};
    const contracts = {};

    // ── 1. Deploy AmountDiscloseAggregateVerifier ─────────────────────────────
    console.log("[1/5] Deploying AmountDiscloseAggregateVerifier (test zkey, 6,163 constraints)...");
    const amtBytecode = amtDiscloseArt.bytecode.replace(/^0x/, "");
    const amtResult = runFlowDeploy(amtBytecode, "amt_disclose_verifier");
    txHashes.amt_disclose_verifier_deploy = amtResult.id ?? "unknown";
    const amtVerifierAddress = extractDeployedAddress(amtResult, "amt_disclose_verifier");
    console.log("  Flow tx:", txHashes.amt_disclose_verifier_deploy);
    console.log("  address:", amtVerifierAddress);
    if (!amtVerifierAddress) {
        throw new Error("Failed to parse AmountDiscloseAggregateVerifier address");
    }
    contracts.AmountDiscloseAggregateVerifier = amtVerifierAddress;

    // ── 2. Deploy new JanusFlow impl (aggregate-paired) ──────────────────────
    console.log("\n[2/5] Deploying new JanusFlow impl (wrapWithProof — aggregate-paired)...");
    const jfImplBytecode = jfArt.bytecode.replace(/^0x/, "");
    const jfImplResult = runFlowDeploy(jfImplBytecode, "janusflow_impl_aggregate");
    txHashes.janusflow_impl_aggregate_deploy = jfImplResult.id ?? "unknown";
    const jfImplAddress = extractDeployedAddress(jfImplResult, "janusflow_impl_aggregate");
    console.log("  Flow tx:", txHashes.janusflow_impl_aggregate_deploy);
    console.log("  address:", jfImplAddress);
    if (!jfImplAddress) throw new Error("Failed to parse new JanusFlow impl address");
    contracts.JanusFlow_impl_aggregate = jfImplAddress;

    // ── 3. Upgrade JanusFlow proxy to new impl (UUPS upgradeToAndCall) ────────
    // Since we don't need to reinitialize (storage is preserved), use upgradeToAndCall with empty data.
    console.log("\n[3/5] Upgrading JanusFlow proxy to new impl...");
    const upgradeJfCalldata = jfIface.encodeFunctionData("upgradeToAndCall", [
        jfImplAddress,
        "0x",  // no re-init needed; state preserved, new slot 92 starts empty
    ]);
    const upgradeJfResult = runFlowCall(JANUSFLOW_PROXY, upgradeJfCalldata.slice(2), "upgrade_janusflow");
    txHashes.janusflow_upgrade = upgradeJfResult.id ?? "unknown";
    console.log("  Flow tx:", txHashes.janusflow_upgrade);
    console.log("  EVM tx: ", extractEvmTxHash(upgradeJfResult));

    // ── 4. Deploy new JanusERC20 impl (aggregate-paired) ─────────────────────
    console.log("\n[4/5] Deploying new JanusERC20 impl (wrapWithProof — aggregate-paired)...");
    const erc20ImplBytecode = erc20Art.bytecode.replace(/^0x/, "");
    const erc20ImplResult = runFlowDeploy(erc20ImplBytecode, "januserc20_impl_aggregate");
    txHashes.januserc20_impl_aggregate_deploy = erc20ImplResult.id ?? "unknown";
    const erc20ImplAddress = extractDeployedAddress(erc20ImplResult, "januserc20_impl_aggregate");
    console.log("  Flow tx:", txHashes.januserc20_impl_aggregate_deploy);
    console.log("  address:", erc20ImplAddress);
    if (!erc20ImplAddress) throw new Error("Failed to parse new JanusERC20 impl address");
    contracts.JanusERC20_impl_aggregate = erc20ImplAddress;

    // ── 5. Upgrade JanusERC20 proxy to new impl ───────────────────────────────
    console.log("\n[5/5] Upgrading JanusERC20 proxy to new impl...");
    const upgradeErc20Calldata = erc20Iface.encodeFunctionData("upgradeToAndCall", [
        erc20ImplAddress,
        "0x",
    ]);
    const upgradeErc20Result = runFlowCall(JANUSERC20_PROXY, upgradeErc20Calldata.slice(2), "upgrade_januserc20");
    txHashes.januserc20_upgrade = upgradeErc20Result.id ?? "unknown";
    console.log("  Flow tx:", txHashes.januserc20_upgrade);
    console.log("  EVM tx: ", extractEvmTxHash(upgradeErc20Result));

    // ── 6. Set AmountDiscloseAggregateVerifier on both proxies ─────────────────
    console.log("\n[6/6] Configuring AmountDiscloseAggregateVerifier on both proxies...");

    const setAdVJf = jfIface.encodeFunctionData("setAmountDiscloseVerifier", [amtVerifierAddress]);
    const setAdVJfResult = runFlowCall(JANUSFLOW_PROXY, setAdVJf.slice(2), "set_adv_janusflow");
    txHashes.janusflow_set_adv = setAdVJfResult.id ?? "unknown";
    console.log("  JanusFlow setAmountDiscloseVerifier tx:", txHashes.janusflow_set_adv);

    const setAdVErc20 = erc20Iface.encodeFunctionData("setAmountDiscloseVerifier", [amtVerifierAddress]);
    const setAdVErc20Result = runFlowCall(JANUSERC20_PROXY, setAdVErc20.slice(2), "set_adv_januserc20");
    txHashes.januserc20_set_adv = setAdVErc20Result.id ?? "unknown";
    console.log("  JanusERC20 setAmountDiscloseVerifier tx:", txHashes.januserc20_set_adv);

    // ── Post-upgrade verification ─────────────────────────────────────────────
    console.log("\n=== Verifying upgraded proxies ===");

    const checkResults = {};

    for (const [name, proxy, iface] of [
        ["janusflow",  JANUSFLOW_PROXY,  jfIface],
        ["januserc20", JANUSERC20_PROXY, erc20Iface],
    ]) {
        const owner   = await callView(provider, proxy, iface, "owner");
        const babyjub = await callView(provider, proxy, iface, "babyJub");
        const xfer    = await callView(provider, proxy, iface, "transferVerifier");
        const ad      = await callView(provider, proxy, iface, "amountDiscloseVerifier");
        const p2g     = await callView(provider, proxy, iface, "pedersen2Gen");

        console.log(`\n  ${name} proxy: ${proxy}`);
        console.log(`    owner()                    = ${owner}`);
        console.log(`    babyJub()                  = ${babyjub}`);
        console.log(`    transferVerifier()          = ${xfer}`);
        console.log(`    amountDiscloseVerifier()    = ${ad}`);
        console.log(`    pedersen2Gen()              = ${p2g}`);

        checkResults[name] = {
            owner_is_admin_coa:              owner.toLowerCase() === ADMIN_COA_EVM.toLowerCase(),
            babyjub_correct:                 babyjub.toLowerCase() === BABYJUB_ADDRESS.toLowerCase(),
            transfer_verifier_is_agg:        xfer.toLowerCase() === AGG_TRANSFER_VER.toLowerCase(),
            amount_disclose_is_new_verifier: ad.toLowerCase() === amtVerifierAddress.toLowerCase(),
            pedersen2gen_correct:            p2g.toLowerCase() === PEDERSEN2GEN.toLowerCase(),
        };
    }

    // ── Update deployment record ───────────────────────────────────────────────
    const prevRecord = JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, "aggregate-testnet.json"), "utf8"));

    // Merge new data into existing record
    prevRecord.version = "0.7.1";
    prevRecord.date    = new Date().toISOString().slice(0, 10);

    prevRecord.contracts.AmountDiscloseAggregateVerifier = amtVerifierAddress;
    prevRecord.contracts.JanusFlow_impl_aggregate = jfImplAddress;
    prevRecord.contracts.JanusERC20_impl_aggregate = erc20ImplAddress;

    // Mark the old incompatible AmountDiscloseVerifier as retired
    prevRecord.contract_status.AmountDiscloseVerifier =
        "RETIRED — replaced by AmountDiscloseAggregateVerifier";
    prevRecord.contract_status.AmountDiscloseAggregateVerifier =
        "NEW (test zkey — single-contributor, testnet only; 6,163 constraints)";
    prevRecord.contract_status.JanusFlow_impl_aggregate =
        "NEW (wrapWithProof + anti-replay usedNonces, paired with AmountDiscloseAggregateVerifier)";
    prevRecord.contract_status.JanusERC20_impl_aggregate =
        "NEW (wrapWithProof + anti-replay usedNonces, paired with AmountDiscloseAggregateVerifier)";

    // Add new tx hashes
    Object.assign(prevRecord.tx_hashes, txHashes);

    prevRecord.post_deploy_checks_aggregate = checkResults;

    prevRecord.ceremony.circuits = {
        confidential_transfer_aggregate: {
            constraints: 18620,
            zkey: "circuits/aggregate-ceremony/setup/confidential_transfer_aggregate_test.zkey",
        },
        amount_disclose_aggregate: {
            constraints: 6163,
            zkey: "circuits/aggregate-ceremony/setup/amount_disclose_aggregate_test.zkey",
        },
    };

    writeFileSync(join(DEPLOYMENTS_DIR, "aggregate-testnet.json"), JSON.stringify(prevRecord, null, 2) + "\n");

    const allOk = Object.values(checkResults).every(r =>
        Object.values(r).every(Boolean)
    );

    console.log("\n=== SUMMARY ===");
    console.log("AmountDiscloseAggregateVerifier:", amtVerifierAddress);
    console.log("JanusFlow impl (aggregate):     ", jfImplAddress);
    console.log("JanusERC20 impl (aggregate):    ", erc20ImplAddress);
    console.log("All post-upgrade checks:        ", allOk ? "PASS" : "FAIL — review above");

    if (!allOk) {
        console.error("\nWARN: Some checks failed. Review deployment record.");
        process.exit(1);
    }
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
