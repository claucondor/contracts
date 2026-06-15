/**
 * upgrade-v0.8.1-claimBatch.mjs
 *
 * UUPS upgrade script for JanusFlow and JanusERC20 to v0.8.1 (claimBatch wired).
 *
 * What this script does:
 *   1. Deploy a new JanusFlow implementation (v0.8.1) via EOA.
 *   2. Build upgradeToAndCall calldata for the JanusFlow proxy (sets batchClaimVerifier
 *      atomically via setBatchClaimVerifier).
 *   3. Deploy a new JanusERC20 implementation (v0.8.1) via EOA.
 *   4. Build upgradeToAndCall calldata for the JanusERC20 proxy.
 *   5. Print Cadence transaction templates for the operator to submit.
 *      (The proxy owner is the COA EVM address — upgrades MUST go via Cadence.)
 *
 * Usage (from packages/janus-token):
 *
 *   node scripts/upgrade-v0.8.1-claimBatch.mjs
 *
 * Env vars (optional — defaults to testnet-v0.8.json):
 *   DEPLOY_RECORD  path to a deployments JSON file with proxy addresses
 *
 * Deployer EOA: 0xFc47B35f79d26A060B652E112c53d7c6057d05FF
 * EOA key: set DEPLOYER_KEY env var (or falls back to hardcoded testnet key)
 * RPC: https://testnet.evm.nodes.onflow.org (chainId 545)
 *
 * NOTE: Implementation deploy goes via EOA (has FLOW for gas).
 *       Proxy upgrade calls (upgradeToAndCall) must originate from the COA owner,
 *       so they go via a Cadence transaction.  This script outputs the calldata
 *       ready for the operator to paste into the Cadence tx template.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { JsonRpcProvider, Wallet, Interface, ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT     = join(__dirname, "..");
const REPO_ROOT       = join(MODULE_ROOT, "../..");
const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL      = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID     = 545;
const DEPLOYER_KEY = process.env.DEPLOYER_KEY
    || "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
const DEPLOYER_EOA = "0xFc47B35f79d26A060B652E112c53d7c6057d05FF";

// Deployed verifier (pot22 ceremony, never changes):
const BATCH_CLAIM_VERIFIER = "0x2FBf6baef1D70f5A9aFF2602c934Bd62dcf6Df80";

// Existing deployment record
const DEPLOY_RECORD = process.env.DEPLOY_RECORD
    || join(DEPLOYMENTS_DIR, "testnet-v0.8.json");

// ---------------------------------------------------------------------------
// Load existing deployment
// ---------------------------------------------------------------------------

const existing = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));
const JANUSFLOW_PROXY  = existing.evm.janusFlow.proxy;
const JANUSFLOW_IMPL   = existing.evm.janusFlow.impl;
const JANUSERC20_PROXY = existing.evm.janusErc20.proxy;
const JANUSERC20_IMPL  = existing.evm.janusErc20.impl;

console.log("=".repeat(72));
console.log("JanusFlow + JanusERC20 v0.8.1 upgrade (claimBatch wiring)");
console.log("=".repeat(72));
console.log(`  JanusFlow proxy:   ${JANUSFLOW_PROXY}`);
console.log(`  JanusFlow impl:    ${JANUSFLOW_IMPL}  (current — will be replaced)`);
console.log(`  JanusERC20 proxy:  ${JANUSERC20_PROXY}`);
console.log(`  JanusERC20 impl:   ${JANUSERC20_IMPL}  (current — will be replaced)`);
console.log(`  Batch verifier:    ${BATCH_CLAIM_VERIFIER}`);
console.log(`  Deployer EOA:      ${DEPLOYER_EOA}`);
console.log();

// ---------------------------------------------------------------------------
// Connect to testnet
// ---------------------------------------------------------------------------

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet   = new Wallet(DEPLOYER_KEY, provider);

const deployerBalance = await provider.getBalance(DEPLOYER_EOA);
console.log(`Deployer balance: ${ethers.formatEther(deployerBalance)} FLOW`);

if (deployerBalance === 0n) {
    console.error("ERROR: Deployer has 0 FLOW balance. Fund it before running.");
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Load ABIs / bytecodes from artifacts
// ---------------------------------------------------------------------------

const jfArt  = JSON.parse(readFileSync(join(MODULE_ROOT, "artifacts/contracts/solidity/JanusFlow.sol/JanusFlow.json"), "utf8"));
const jfIface = new Interface(jfArt.abi);

// JanusERC20 lives in the janus-erc20 package
const erc20ArtPath = join(REPO_ROOT, "packages/janus-erc20/artifacts/contracts/solidity/JanusERC20.sol/JanusERC20.json");
const erc20Art   = JSON.parse(readFileSync(erc20ArtPath, "utf8"));
const erc20Iface = new Interface(erc20Art.abi);

// ---------------------------------------------------------------------------
// Step 1: Deploy new JanusFlow implementation
// ---------------------------------------------------------------------------

console.log("\n── Step 1: Deploy JanusFlow v0.8.1 implementation ──");
const JanusFlowFactory = new ethers.ContractFactory(jfArt.abi, jfArt.bytecode, wallet);
const jfImpl = await JanusFlowFactory.deploy();
await jfImpl.waitForDeployment();
const jfImplAddr = await jfImpl.getAddress();
const jfDeployTx = jfImpl.deploymentTransaction().hash;

console.log(`  JanusFlow impl deployed: ${jfImplAddr}`);
console.log(`  Deploy tx:               ${jfDeployTx}`);

// ---------------------------------------------------------------------------
// Step 2: Build upgradeToAndCall calldata for JanusFlow proxy
// ---------------------------------------------------------------------------

// upgradeToAndCall(address newImpl, bytes calldata data)
// The "data" is the call to setBatchClaimVerifier(batchClaimVerifier)
const jfSetVerifierCalldata = jfIface.encodeFunctionData("setBatchClaimVerifier", [BATCH_CLAIM_VERIFIER]);
const jfUpgradeCalldata     = jfIface.encodeFunctionData("upgradeToAndCall", [jfImplAddr, jfSetVerifierCalldata]);

console.log("\n── Step 2: JanusFlow upgradeToAndCall calldata ──");
console.log(`  Calldata: ${jfUpgradeCalldata}`);

// ---------------------------------------------------------------------------
// Step 3: Deploy new JanusERC20 implementation
// ---------------------------------------------------------------------------

console.log("\n── Step 3: Deploy JanusERC20 v0.8.1 implementation ──");
const JanusERC20Factory = new ethers.ContractFactory(erc20Art.abi, erc20Art.bytecode, wallet);
const erc20Impl = await JanusERC20Factory.deploy();
await erc20Impl.waitForDeployment();
const erc20ImplAddr = await erc20Impl.getAddress();
const erc20DeployTx = erc20Impl.deploymentTransaction().hash;

console.log(`  JanusERC20 impl deployed: ${erc20ImplAddr}`);
console.log(`  Deploy tx:                ${erc20DeployTx}`);

// ---------------------------------------------------------------------------
// Step 4: Build upgradeToAndCall calldata for JanusERC20 proxy
// ---------------------------------------------------------------------------

const erc20SetVerifierCalldata = erc20Iface.encodeFunctionData("setBatchClaimVerifier", [BATCH_CLAIM_VERIFIER]);
const erc20UpgradeCalldata     = erc20Iface.encodeFunctionData("upgradeToAndCall", [erc20ImplAddr, erc20SetVerifierCalldata]);

console.log("\n── Step 4: JanusERC20 upgradeToAndCall calldata ──");
console.log(`  Calldata: ${erc20UpgradeCalldata}`);

// ---------------------------------------------------------------------------
// Step 5: Print Cadence transaction template
// ---------------------------------------------------------------------------

console.log("\n");
console.log("=".repeat(72));
console.log("OPERATOR INSTRUCTIONS — Run these Cadence transactions:");
console.log("=".repeat(72));
console.log(`
// Cadence Tx A: Upgrade JanusFlow proxy to v0.8.1
// Account: openjanus-v08 (0x4b6bc58bc8bf5dcc)
// Key: /home/oydual3/.flow/openjanus-v08.pkey

import "EVM"

transaction {
    prepare(signer: auth(Storage) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("no COA")

        let calldata: [UInt8] = ${JSON.stringify(Array.from(Buffer.from(jfUpgradeCalldata.slice(2), "hex")))}

        let result = coa.call(
            to: EVM.addressFromString("${JANUSFLOW_PROXY}"),
            data: calldata,
            gasLimit: 500_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(result.status == EVM.Status.successful,
            message: "JanusFlow upgrade failed: ".concat(result.errorMessage))
    }
}

---

// Cadence Tx B: Upgrade JanusERC20 proxy to v0.8.1
// Same signer as above.

import "EVM"

transaction {
    prepare(signer: auth(Storage) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("no COA")

        let calldata: [UInt8] = ${JSON.stringify(Array.from(Buffer.from(erc20UpgradeCalldata.slice(2), "hex")))}

        let result = coa.call(
            to: EVM.addressFromString("${JANUSERC20_PROXY}"),
            data: calldata,
            gasLimit: 500_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(result.status == EVM.Status.successful,
            message: "JanusERC20 upgrade failed: ".concat(result.errorMessage))
    }
}
`);

// ---------------------------------------------------------------------------
// Save output to deployments JSON
// ---------------------------------------------------------------------------

const output = {
    version: "0.8.1",
    date:    new Date().toISOString().slice(0, 10),
    network: "flow-evm-testnet",
    chainId: CHAIN_ID,
    status:  "CALLDATA_READY — run Cadence transactions above to complete upgrade",
    batchClaimVerifier: BATCH_CLAIM_VERIFIER,
    janusFlow: {
        proxy:           JANUSFLOW_PROXY,
        newImpl:         jfImplAddr,
        oldImpl:         JANUSFLOW_IMPL,
        implDeployTx:    jfDeployTx,
        upgradeCalldata: jfUpgradeCalldata,
    },
    janusErc20: {
        proxy:           JANUSERC20_PROXY,
        newImpl:         erc20ImplAddr,
        oldImpl:         JANUSERC20_IMPL,
        implDeployTx:    erc20DeployTx,
        upgradeCalldata: erc20UpgradeCalldata,
    },
};

const outPath = join(DEPLOYMENTS_DIR, "upgrade-v0.8.1-claimBatch.json");
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

console.log(`\nOutput saved to: ${outPath}`);
console.log("=".repeat(72));
console.log("After running both Cadence transactions, smoke-check with:");
console.log("  cast call <proxy> 'VERSION()(string)' --rpc-url https://testnet.evm.nodes.onflow.org");
console.log("  cast call <proxy> 'batchClaimVerifier()(address)' --rpc-url https://testnet.evm.nodes.onflow.org");
console.log("=".repeat(72));
