/**
 * deploy-janus-erc20.mjs
 *
 * Deployment script for JanusERC20 v0.8.0 on Flow EVM testnet.
 *
 * Deployment is orchestrated via a Flow COA (Cadence-Owned Account) — the
 * Flow native key is P-256 and cannot derive an EVM EOA, so the COA is the
 * only valid UUPS owner for upgradeable contracts.
 *
 * Usage (from packages/janus-erc20/):
 *
 *   node --experimental-vm-modules scripts/deploy-janus-erc20.mjs \
 *     --babyJub      <address>       \
 *     --transferVer  <address>       \
 *     --amtDisclose  <address>       \
 *     --underlying   <address>       \
 *     --owner        <COA-address>   \
 *     --memoRegistry <address>       \
 *     --pedersen     <address>       \
 *     --inbox        <address>       \   # optional; pass 0x0...0 to deploy without inbox
 *     --rpc          <rpc-url>
 *
 * Outputs:
 *   - JanusERC20 implementation address
 *   - JanusERC20_Proxy address (the canonical token address)
 *   - Full initialize calldata for COA execution
 *
 * Note: DO NOT embed a private key here — deployment is submitted via the
 * COA/Cadence layer, not by a raw EOA. The script prints the encoded calldata
 * so the operator can pass it through Cadence transactions.
 */

import { createRequire } from "module";
import { parseArgs }     from "util";
import path              from "path";
import { fileURLToPath } from "url";

const require   = createRequire(import.meta.url);
const { ethers } = require("ethers");

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Artifact loader — reads Hardhat artifacts from the package output directory
// ---------------------------------------------------------------------------

function loadArtifact(contractName) {
  const artifactPath = path.join(
    __dirname, "..", "artifacts", "contracts", "solidity",
    `${contractName}.sol`, `${contractName}.json`
  );
  return require(artifactPath);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: opts } = parseArgs({
  options: {
    babyJub:      { type: "string", default: "" },
    transferVer:  { type: "string", default: "" },
    amtDisclose:  { type: "string", default: "" },
    underlying:   { type: "string", default: "" },
    owner:        { type: "string", default: "" },
    memoRegistry: { type: "string", default: "" },
    pedersen:     { type: "string", default: "" },
    inbox:        { type: "string", default: ethers.ZeroAddress },
    rpc:          { type: "string", default: "https://testnet.evm.nodes.onflow.org" },
    dryRun:       { type: "boolean", default: false },
  },
  strict: false,
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const requiredArgs = ["babyJub", "transferVer", "amtDisclose", "underlying", "owner", "memoRegistry", "pedersen"];
  const missing = requiredArgs.filter(k => !opts[k]);
  if (missing.length > 0 && !opts.dryRun) {
    console.error(`Missing required arguments: ${missing.join(", ")}`);
    console.error("Use --dryRun to print encoded calldata without a live network.");
    process.exit(1);
  }

  // For dryRun mode, fill missing addresses with zero address
  const babyJub      = opts.babyJub      || ethers.ZeroAddress;
  const transferVer  = opts.transferVer  || ethers.ZeroAddress;
  const amtDisclose  = opts.amtDisclose  || ethers.ZeroAddress;
  const underlying   = opts.underlying   || ethers.ZeroAddress;
  const owner        = opts.owner        || ethers.ZeroAddress;
  const memoRegistry = opts.memoRegistry || ethers.ZeroAddress;
  const pedersen     = opts.pedersen     || ethers.ZeroAddress;
  const inbox        = opts.inbox        || ethers.ZeroAddress;

  console.log("\n=== JanusERC20 v0.8.0 Deploy ===");
  console.log("  babyJub:      ", babyJub);
  console.log("  transferVer:  ", transferVer);
  console.log("  amtDisclose:  ", amtDisclose);
  console.log("  underlying:   ", underlying);
  console.log("  owner (COA):  ", owner);
  console.log("  memoRegistry: ", memoRegistry);
  console.log("  pedersen:     ", pedersen);
  console.log("  inbox:        ", inbox, inbox === ethers.ZeroAddress ? "(no inbox)" : "");
  console.log("  rpc:          ", opts.rpc);

  // Load artifacts
  const implArtifact  = loadArtifact("JanusERC20");
  const proxyArtifact = loadArtifact("JanusERC20_Proxy");

  // Encode initialize calldata (8-arg v0.8.0 signature)
  const iface = new ethers.Interface(implArtifact.abi);
  const initData = iface.encodeFunctionData("initialize", [
    babyJub,
    transferVer,
    amtDisclose,
    underlying,
    owner,
    memoRegistry,
    pedersen,
    inbox,
  ]);

  console.log("\n--- Encoded initialize calldata (for COA Cadence tx) ---");
  console.log(initData);

  if (opts.dryRun) {
    console.log("\n[dry-run] Skipping live deployment.");
    return;
  }

  // Live deployment — requires a funded signer accessible via the RPC
  // (for testing only; production uses COA orchestration via Cadence).
  const provider = new ethers.JsonRpcProvider(opts.rpc);
  const signer   = await provider.getSigner(); // uses default account if available

  console.log("\n[1/2] Deploying JanusERC20 implementation...");
  const implFactory = new ethers.ContractFactory(implArtifact.abi, implArtifact.bytecode, signer);
  const impl        = await implFactory.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log("      JanusERC20 impl:", implAddress);

  console.log("\n[2/2] Deploying JanusERC20_Proxy (ERC1967)...");
  const proxyFactory = new ethers.ContractFactory(proxyArtifact.abi, proxyArtifact.bytecode, signer);
  const proxy        = await proxyFactory.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log("      JanusERC20_Proxy:", proxyAddress);

  console.log("\n=== Deployment complete ===");
  console.log("  Implementation:  ", implAddress);
  console.log("  Proxy (token):   ", proxyAddress);
  console.log("\nNext steps:");
  console.log("  1. Verify implementation: hardhat verify --network flow-evm-testnet", implAddress);
  console.log("  2. Set owner to COA via transferOwnership() if not set during init.");
  console.log("  3. Record tx hashes for deployment manifest.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
