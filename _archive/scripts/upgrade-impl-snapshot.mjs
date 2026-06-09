/**
 * upgrade-impl-snapshot.mjs — Phase A close: redeploy JanusFlow + JanusERC20
 * impls with snapshot-aware wrapWithProof (emits real encryptedSnapshot /
 * ephPubkeyX / ephPubkeyY), then upgrade the existing UUPS proxies.
 *
 * What this script does:
 *   1. Deploy new JanusFlow impl  (from current artifacts, commit d25fcb2)
 *   2. Deploy new JanusERC20 impl
 *   3. upgradeToAndCall(newJFImpl,  "0x") on JanusFlow  proxy
 *   4. upgradeToAndCall(newERC20Impl,"0x") on JanusERC20 proxy
 *   5. Post-upgrade view checks (owner / verifiers / pedersen)
 *   6. Update deployments/aggregate-testnet.json
 *
 * All existing proxy state (commitments, totalLocked, verifier addresses,
 * usedNonces, etc.) is preserved — UUPS upgrade only swaps the logic contract.
 *
 * AmountDiscloseAggregateVerifier is already configured on both proxies and
 * does NOT need to be redeployed.
 *
 * Run from repo root:
 *   node scripts/upgrade-impl-snapshot.mjs
 *
 * Prerequisites:
 *   cd packages/janus-token  && npx hardhat compile
 *   cd packages/janus-erc20  && npx hardhat compile
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AbiCoder, Interface, JsonRpcProvider } from "ethers";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, "..");

const JANUS_TOKEN_PKG  = join(REPO_ROOT, "packages", "janus-token");
const JANUS_ERC20_PKG  = join(REPO_ROOT, "packages", "janus-erc20");
const JF_ARTIFACTS     = join(JANUS_TOKEN_PKG, "artifacts/contracts/solidity");
const ERC20_ARTIFACTS  = join(JANUS_ERC20_PKG, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR  = join(REPO_ROOT, "deployments");
const FLOW_JSON        = "/tmp/upgrade_snapshot_flow.json";

// ── Artifact paths ─────────────────────────────────────────────────────────────
const JF_ART    = join(JF_ARTIFACTS,   "JanusFlow.sol/JanusFlow.json");
const ERC20_ART = join(ERC20_ARTIFACTS,"JanusERC20.sol/JanusERC20.json");

// ── Known on-chain addresses ──────────────────────────────────────────────────
const JANUSFLOW_PROXY  = "0x9A83732417947Ef9b7AEa64bF807a345267c2FdA";
const JANUSERC20_PROXY = "0xD5E6a52635599E6B2296B5BfEeC617E333561ea0";
const PEDERSEN2GEN     = "0xb8Af0091A010E082b05d0c55E1019c3833E15760";
const BABYJUB          = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const AGG_TRANSFER_VER = "0x5702A545d2853b03B808aEA331f892c121b67243";
const AMT_DISCLOSE_AGG = "0xa80283baB7fcEFC2c75De43DB5a1cBF00E96B984";

// ── Admin ──────────────────────────────────────────────────────────────────────
const ADMIN_CADENCE = "c4e8f99915893a2f";
const ADMIN_COA_EVM = "0x000000000000000000000002656f9205e386ed78";
const FLOW_SIGNER   = "v066-admin";
const PKEY_PATH     = "/home/oydual3/.flow/v066-admin.pkey";
const RPC_URL       = "https://testnet.evm.nodes.onflow.org";

// ── Cadence deploy transaction ─────────────────────────────────────────────────
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

// ── Cadence call transaction ───────────────────────────────────────────────────
const CALL_TX = `import "EVM"

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
        networks:     base.networks,
        dependencies: base.dependencies,
        accounts: {
            [FLOW_SIGNER]: {
                address: ADMIN_CADENCE,
                key: { type: "file", location: PKEY_PATH },
            },
        },
        contracts:   {},
        deployments: {},
    };
    writeFileSync(FLOW_JSON, JSON.stringify(cleaned, null, 2));
}

function runFlow(txBody, args, label, timeout = 300_000) {
    const txPath = `/tmp/.upgrade_snap_${label}.cdc`;
    writeFileSync(txPath, txBody);
    const argStrs = args.map(a => (typeof a === "number" ? String(a) : `"${a}"`)).join(" ");
    const cmd = [
        "flow transactions send",
        txPath,
        argStrs,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");

    let result;
    try {
        const stdout = execSync(cmd, { timeout, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); } catch {
                throw new Error(`[${label}] non-JSON stdout:\n${err.stdout?.slice(0, 1000)}`);
            }
        } else {
            throw new Error(`[${label}] exec error: ${err.message}`);
        }
    }
    if (result.error)        throw new Error(`[${label}] flow CLI error: ${result.error.slice(0, 500)}`);
    if (result.errorMessage) throw new Error(`[${label}] tx errorMessage: ${result.errorMessage.slice(0, 500)}`);
    if (result.status && result.status !== "SEALED")
        throw new Error(`[${label}] tx status not SEALED: ${result.status}`);
    return result;
}

function extractDeployedAddress(result, label) {
    const blob = JSON.stringify(result?.events ?? []);

    // Primary: contractAddress field in events
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    // Fallback: any EVM address that is NOT a known address
    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        ADMIN_COA_EVM.toLowerCase(),
        JANUSFLOW_PROXY.toLowerCase(),
        JANUSERC20_PROXY.toLowerCase(),
        PEDERSEN2GEN.toLowerCase(),
        BABYJUB.toLowerCase(),
        AGG_TRANSFER_VER.toLowerCase(),
        AMT_DISCLOSE_AGG.toLowerCase(),
    ]);
    const all = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    if (all.length > 0) return all[0];

    writeFileSync(`/tmp/.upgrade_snap_${label}_raw.json`, JSON.stringify(result, null, 2));
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
    const hex  = await provider.call({ to, data });
    return "0x" + hex.slice(-40);
}

async function main() {
    console.log("=".repeat(72));
    console.log("Phase A close: upgrade JanusFlow + JanusERC20 impls (snapshot-aware)");
    console.log("Network: Flow EVM Testnet (chainId 545)");
    console.log("=".repeat(72));
    console.log(`JanusFlow proxy:    ${JANUSFLOW_PROXY}`);
    console.log(`JanusERC20 proxy:   ${JANUSERC20_PROXY}`);
    console.log(`Admin Cadence:      0x${ADMIN_CADENCE}`);
    console.log(`Admin COA EVM:      ${ADMIN_COA_EVM}\n`);

    for (const p of [JF_ART, ERC20_ART]) {
        if (!existsSync(p)) throw new Error(`Missing artifact: ${p}\nRun: npx hardhat compile in each package first`);
    }

    const jfArt    = JSON.parse(readFileSync(JF_ART,    "utf8"));
    const erc20Art = JSON.parse(readFileSync(ERC20_ART, "utf8"));

    const provider   = new JsonRpcProvider(RPC_URL);
    const jfIface    = new Interface(jfArt.abi);
    const erc20Iface = new Interface(erc20Art.abi);

    ensureFlowJson();

    const txHashes = {};

    // ── 1. Deploy new JanusFlow impl ──────────────────────────────────────────
    console.log("[1/4] Deploying new JanusFlow impl (snapshot-aware wrapWithProof)...");
    const jfBytecode = jfArt.bytecode.replace(/^0x/, "");
    const jfResult   = runFlow(DEPLOY_TX, [jfBytecode], "jf_impl");
    const jfImplAddr = extractDeployedAddress(jfResult, "jf_impl");
    txHashes.janusflow_impl_snapshot_deploy = jfResult.id ?? "unknown";
    const jfImplEvmTx = extractEvmTxHash(jfResult) ?? "n/a";
    console.log(`  Flow tx:  ${txHashes.janusflow_impl_snapshot_deploy}`);
    console.log(`  EVM tx:   ${jfImplEvmTx}`);
    console.log(`  address:  ${jfImplAddr}`);
    if (!jfImplAddr) throw new Error("Could not parse new JanusFlow impl address from deploy result");

    // ── 2. Deploy new JanusERC20 impl ─────────────────────────────────────────
    console.log("\n[2/4] Deploying new JanusERC20 impl (snapshot-aware wrapWithProof)...");
    const erc20Bytecode = erc20Art.bytecode.replace(/^0x/, "");
    const erc20Result   = runFlow(DEPLOY_TX, [erc20Bytecode], "erc20_impl");
    const erc20ImplAddr = extractDeployedAddress(erc20Result, "erc20_impl");
    txHashes.januserc20_impl_snapshot_deploy = erc20Result.id ?? "unknown";
    const erc20ImplEvmTx = extractEvmTxHash(erc20Result) ?? "n/a";
    console.log(`  Flow tx:  ${txHashes.januserc20_impl_snapshot_deploy}`);
    console.log(`  EVM tx:   ${erc20ImplEvmTx}`);
    console.log(`  address:  ${erc20ImplAddr}`);
    if (!erc20ImplAddr) throw new Error("Could not parse new JanusERC20 impl address from deploy result");

    // ── 3. Upgrade JanusFlow proxy ────────────────────────────────────────────
    console.log("\n[3/4] Upgrading JanusFlow proxy to new impl...");
    const upgradeJfCalldata = jfIface.encodeFunctionData("upgradeToAndCall", [jfImplAddr, "0x"]);
    const upgradeJfResult   = runFlow(CALL_TX, [JANUSFLOW_PROXY, upgradeJfCalldata.slice(2), 3000000], "upgrade_jf");
    txHashes.janusflow_upgrade_snapshot = upgradeJfResult.id ?? "unknown";
    const upgradeJfEvmTx = extractEvmTxHash(upgradeJfResult) ?? "n/a";
    console.log(`  Flow tx:  ${txHashes.janusflow_upgrade_snapshot}`);
    console.log(`  EVM tx:   ${upgradeJfEvmTx}`);

    // ── 4. Upgrade JanusERC20 proxy ───────────────────────────────────────────
    console.log("\n[4/4] Upgrading JanusERC20 proxy to new impl...");
    const upgradeErc20Calldata = erc20Iface.encodeFunctionData("upgradeToAndCall", [erc20ImplAddr, "0x"]);
    const upgradeErc20Result   = runFlow(CALL_TX, [JANUSERC20_PROXY, upgradeErc20Calldata.slice(2), 3000000], "upgrade_erc20");
    txHashes.januserc20_upgrade_snapshot = upgradeErc20Result.id ?? "unknown";
    const upgradeErc20EvmTx = extractEvmTxHash(upgradeErc20Result) ?? "n/a";
    console.log(`  Flow tx:  ${txHashes.januserc20_upgrade_snapshot}`);
    console.log(`  EVM tx:   ${upgradeErc20EvmTx}`);

    // ── Post-upgrade verification ─────────────────────────────────────────────
    console.log("\n=== Post-upgrade view checks ===");
    const checkResults = {};

    for (const [name, proxy, iface] of [
        ["janusflow",  JANUSFLOW_PROXY,  jfIface],
        ["januserc20", JANUSERC20_PROXY, erc20Iface],
    ]) {
        const owner  = await callView(provider, proxy, iface, "owner");
        const babyjub= await callView(provider, proxy, iface, "babyJub");
        const xfer   = await callView(provider, proxy, iface, "transferVerifier");
        const ad     = await callView(provider, proxy, iface, "amountDiscloseVerifier");
        const p2g    = await callView(provider, proxy, iface, "pedersen2Gen");

        console.log(`\n  ${name}:`);
        console.log(`    owner()                  = ${owner}`);
        console.log(`    babyJub()                = ${babyjub}`);
        console.log(`    transferVerifier()        = ${xfer}`);
        console.log(`    amountDiscloseVerifier()  = ${ad}`);
        console.log(`    pedersen2Gen()            = ${p2g}`);

        checkResults[name] = {
            owner_is_admin_coa:              owner.toLowerCase()  === ADMIN_COA_EVM.toLowerCase(),
            babyjub_correct:                 babyjub.toLowerCase() === BABYJUB.toLowerCase(),
            transfer_verifier_is_agg:        xfer.toLowerCase()   === AGG_TRANSFER_VER.toLowerCase(),
            amount_disclose_is_new_verifier: ad.toLowerCase()     === AMT_DISCLOSE_AGG.toLowerCase(),
            pedersen2gen_correct:            p2g.toLowerCase()    === PEDERSEN2GEN.toLowerCase(),
        };
    }

    const allOk = Object.values(checkResults).every(r => Object.values(r).every(Boolean));
    console.log(`\n  All checks: ${allOk ? "PASS" : "FAIL"}`);
    if (!allOk) {
        console.error("WARN: Some view checks failed — review the output above.");
    }

    // ── Update deployments/aggregate-testnet.json ─────────────────────────────
    const record = JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, "aggregate-testnet.json"), "utf8"));

    record.date = new Date().toISOString().slice(0, 10);

    // Replace impl addresses with new snapshot-aware deploys
    record.contracts.JanusFlow_impl_aggregate  = jfImplAddr;
    record.contracts.JanusERC20_impl_aggregate = erc20ImplAddr;

    // Add upgrade tx hashes
    Object.assign(record.tx_hashes, txHashes);

    // Update status labels
    record.contract_status.JanusFlow_impl_aggregate  =
        "UPGRADED — snapshot-aware wrapWithProof (emits encryptedSnapshot + ephPubkey)";
    record.contract_status.JanusERC20_impl_aggregate =
        "UPGRADED — snapshot-aware wrapWithProof (emits encryptedSnapshot + ephPubkey)";

    record.post_deploy_checks_aggregate = checkResults;

    writeFileSync(
        join(DEPLOYMENTS_DIR, "aggregate-testnet.json"),
        JSON.stringify(record, null, 2) + "\n"
    );
    console.log("\nWrote deployments/aggregate-testnet.json");

    console.log("\n=== SUMMARY ===");
    console.log(`New JanusFlow impl:   ${jfImplAddr}`);
    console.log(`New JanusERC20 impl:  ${erc20ImplAddr}`);
    console.log(`JanusFlow upgrade tx (Flow):    ${txHashes.janusflow_upgrade_snapshot}`);
    console.log(`JanusERC20 upgrade tx (Flow):   ${txHashes.januserc20_upgrade_snapshot}`);
    console.log(`All post-upgrade checks:        ${allOk ? "PASS" : "FAIL"}`);

    if (!allOk) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
