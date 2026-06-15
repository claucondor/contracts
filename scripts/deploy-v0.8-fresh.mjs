/**
 * deploy-v0.8-fresh.mjs — Deploy full Janus v0.8 stack on Flow EVM testnet.
 *
 * Uses a funded EVM EOA deployer. All UUPS proxies are initialized with
 * COA EVM address as owner (COA is the only valid UUPS upgrader for Flow-native keys).
 *
 * Usage:
 *   DEPLOYER_KEY=0x... COA_ADDR=0x... node scripts/deploy-v0.8-fresh.mjs
 *
 * Deploy order (dependency-safe):
 *   1.  BabyJub library
 *   2.  Pedersen2Gen library (stateless)
 *   3.  MockUSDC
 *   4.  ConfidentialTransferAggregateVerifier
 *   5.  AmountDiscloseAggregateVerifier
 *   6.  ConfidentialClaimBatchVerifier (NEW — Fase 7)
 *   7.  MemoKeyRegistry
 *   8.  ShieldedInbox
 *   9.  ShieldedCheckpoint
 *  10.  JanusFlow impl
 *  11.  JanusFlow proxy (initialize with all deps)
 *  12.  JanusERC20 impl
 *  13.  JanusERC20 proxy (initialize with MockUSDC + all deps)
 *
 * Output: ../../deployments/testnet-v0.8.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Artifact loaders
function loadArtifact(packageDir, contractName) {
  const p = join(REPO_ROOT, "packages", packageDir, "artifacts", "contracts", "solidity",
    `${contractName}.sol`, `${contractName}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

const RPC = "https://testnet.evm.nodes.onflow.org";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const COA_ADDR     = process.env.COA_ADDR; // new account's COA

if (!DEPLOYER_KEY) { console.error("DEPLOYER_KEY env var required"); process.exit(1); }
if (!COA_ADDR)     { console.error("COA_ADDR env var required"); process.exit(1); }

// Dynamic import of ethers (ESM)
const { ethers } = await import("../packages/janus-erc20/node_modules/ethers/lib.esm/index.js").catch(async () => {
  // Fallback: use require-style import
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  return req("../packages/janus-erc20/node_modules/ethers");
});

const provider = new ethers.JsonRpcProvider(RPC);
const signer   = new ethers.Wallet(DEPLOYER_KEY, provider);
console.log("Deployer:", await signer.getAddress());
console.log("COA owner:", COA_ADDR);

const balance = await provider.getBalance(await signer.getAddress());
console.log("Deployer balance:", ethers.formatEther(balance), "FLOW\n");

if (balance < ethers.parseEther("1")) {
  throw new Error("Insufficient deployer balance");
}

// Tx hashes for manifest
const txHashes = {};
const addresses = {};

async function deployContract(label, artifact, constructorArgs = [], linkMap = {}) {
  let bytecode = artifact.bytecode;

  // Apply library links
  for (const [placeholder, addr] of Object.entries(linkMap)) {
    // Placeholder: __$<keccak256 of fully qualified name, first 34 hex chars>$__
    const re = new RegExp(placeholder, "g");
    bytecode = bytecode.replace(re, addr.slice(2).toLowerCase());
  }

  const factory = new ethers.ContractFactory(artifact.abi, bytecode, signer);
  console.log(`[deploying] ${label}...`);
  const contract = await factory.deploy(...constructorArgs);
  const receipt  = await contract.deploymentTransaction().wait(1);
  const addr     = await contract.getAddress();
  const txHash   = receipt.hash;
  console.log(`  ${label}: ${addr}  (tx: ${txHash})`);
  addresses[label] = addr;
  txHashes[label]  = txHash;
  return { contract, addr, txHash };
}

// ---------------------------------------------------------------------------
// 1. BabyJub library
// ---------------------------------------------------------------------------
const babyJubArt = loadArtifact("janus-token", "BabyJub");
const { addr: babyJub } = await deployContract("babyJub", babyJubArt);

// ---------------------------------------------------------------------------
// 2. Pedersen2Gen library (no dependencies)
// ---------------------------------------------------------------------------
const pedersenArt = loadArtifact("janus-token", "Pedersen2Gen");
const { addr: pedersen } = await deployContract("pedersen2Gen", pedersenArt);

// ---------------------------------------------------------------------------
// 3. MockUSDC
// ---------------------------------------------------------------------------
const mockUsdcArt = loadArtifact("janus-erc20", "MockUSDC");
const { addr: mockUsdc } = await deployContract("mockUsdc", mockUsdcArt);

// ---------------------------------------------------------------------------
// 4. ConfidentialTransferAggregateVerifier
// ---------------------------------------------------------------------------
const ctVerArt = loadArtifact("janus-token", "ConfidentialTransferAggregateVerifier");
const { addr: ctVerifier } = await deployContract("confidentialTransferVerifier", ctVerArt);

// ---------------------------------------------------------------------------
// 5. AmountDiscloseAggregateVerifier
// ---------------------------------------------------------------------------
const adVerArt = loadArtifact("janus-token", "AmountDiscloseAggregateVerifier");
const { addr: adVerifier } = await deployContract("amountDiscloseVerifier", adVerArt);

// ---------------------------------------------------------------------------
// 6. ConfidentialClaimBatchVerifier (NEW — Fase 7)
// ---------------------------------------------------------------------------
const ccbVerArt = loadArtifact("janus-token", "ConfidentialClaimBatchVerifier");
const { addr: ccbVerifier } = await deployContract("confidentialClaimBatchVerifier", ccbVerArt);

// ---------------------------------------------------------------------------
// 7. MemoKeyRegistry
// ---------------------------------------------------------------------------
const memoArt = loadArtifact("janus-token", "MemoKeyRegistry");
const { addr: memoRegistry } = await deployContract("memoKeyRegistry", memoArt);

// ---------------------------------------------------------------------------
// 8. ShieldedInbox
// ---------------------------------------------------------------------------
const inboxArt = loadArtifact("janus-token", "ShieldedInbox");
const { addr: shieldedInbox } = await deployContract("shieldedInbox", inboxArt);

// ---------------------------------------------------------------------------
// 9. ShieldedCheckpoint
// ---------------------------------------------------------------------------
const checkpointArt = loadArtifact("janus-token", "ShieldedCheckpoint");
const { addr: shieldedCheckpoint } = await deployContract("shieldedCheckpoint", checkpointArt);

// ---------------------------------------------------------------------------
// 10. JanusFlow implementation
// ---------------------------------------------------------------------------
const jfArt = loadArtifact("janus-token", "JanusFlow");
const { addr: janusFlowImpl } = await deployContract("janusFlowImpl", jfArt);

// ---------------------------------------------------------------------------
// 11. JanusFlow proxy — initialize(babyJub, ctVerifier, adVerifier, owner, memo, pedersen, inbox)
// ---------------------------------------------------------------------------
const jfIface = new ethers.Interface(jfArt.abi);
const jfInitData = jfIface.encodeFunctionData("initialize", [
  babyJub,
  ctVerifier,
  adVerifier,
  COA_ADDR,        // owner = new account's COA
  memoRegistry,
  pedersen,
  shieldedInbox,
]);

const jfProxyArt = loadArtifact("janus-token", "JanusFlowProxy");
const { addr: janusFlowProxy } = await deployContract("janusFlowProxy", jfProxyArt, [janusFlowImpl, jfInitData]);

// Verify JanusFlow VERSION
const jfProxy = new ethers.Contract(janusFlowProxy, jfArt.abi, provider);
const jfVersion = await jfProxy.VERSION();
console.log(`  JanusFlow VERSION: ${jfVersion}`);
if (jfVersion !== "0.8.0") throw new Error(`Expected JanusFlow VERSION 0.8.0, got ${jfVersion}`);

// ---------------------------------------------------------------------------
// 12. JanusERC20 implementation
// ---------------------------------------------------------------------------
const je20Art = loadArtifact("janus-erc20", "JanusERC20");
const { addr: janusErc20Impl } = await deployContract("janusErc20Impl", je20Art);

// ---------------------------------------------------------------------------
// 13. JanusERC20 proxy — initialize(babyJub, ctVer, adVer, underlying, owner, memo, pedersen, inbox)
// ---------------------------------------------------------------------------
const je20Iface = new ethers.Interface(je20Art.abi);
const je20InitData = je20Iface.encodeFunctionData("initialize", [
  babyJub,
  ctVerifier,
  adVerifier,
  mockUsdc,        // underlying ERC20
  COA_ADDR,        // owner = new account's COA
  memoRegistry,
  pedersen,
  shieldedInbox,
]);

const je20ProxyArt = loadArtifact("janus-erc20", "JanusERC20Proxy");
const { addr: janusErc20Proxy } = await deployContract("janusErc20Proxy", je20ProxyArt, [janusErc20Impl, je20InitData]);

// Verify JanusERC20 VERSION
const je20Proxy = new ethers.Contract(janusErc20Proxy, je20Art.abi, provider);
const je20Version = await je20Proxy.VERSION();
console.log(`  JanusERC20 VERSION: ${je20Version}`);
if (je20Version !== "0.8.0") throw new Error(`Expected JanusERC20 VERSION 0.8.0, got ${je20Version}`);

// ---------------------------------------------------------------------------
// Verify MockUSDC name
// ---------------------------------------------------------------------------
const mockUsdcContract = new ethers.Contract(mockUsdc, mockUsdcArt.abi, provider);
const usdcName = await mockUsdcContract.name();
console.log(`  MockUSDC.name(): ${usdcName}`);

// ---------------------------------------------------------------------------
// Write deployment manifest
// ---------------------------------------------------------------------------
const manifest = {
  version: "0.8.0",
  date: new Date().toISOString().slice(0, 10),
  chainId: 545,
  network: "flow-evm-testnet",
  account: {
    cadenceAddress: "0x4b6bc58bc8bf5dcc",
    coaEvmAddress: COA_ADDR,
  },
  evm: {
    babyJubLibrary:         babyJub,
    pedersen2GenLibrary:    pedersen,
    mockUsdc:               mockUsdc,
    memoKeyRegistry:        memoRegistry,
    shieldedInbox:          shieldedInbox,
    shieldedCheckpoint:     shieldedCheckpoint,
    verifiers: {
      confidentialTransferAggregate: ctVerifier,
      amountDiscloseAggregate:       adVerifier,
      confidentialClaimBatch:        ccbVerifier,
    },
    janusFlow: {
      impl:  janusFlowImpl,
      proxy: janusFlowProxy,
    },
    janusErc20: {
      impl:  janusErc20Impl,
      proxy: janusErc20Proxy,
    },
  },
  cadence: {
    shieldedInbox:    "0x4b6bc58bc8bf5dcc",
    shieldedCheckpoint: "0x4b6bc58bc8bf5dcc",
    mockFT:           "0x4b6bc58bc8bf5dcc",
    janusFT:          "0x4b6bc58bc8bf5dcc",
  },
  txHashes: {
    accountCreation: "455276f56324e7c834110cf2e6253a0804d24415e36f17b594a7958687205845",
    coaSetup:        "644ead55681b68373866fb08659a602a2e386b993c87cc8bf6d075744ee4b4a9",
    fundCoa:         "8fa1dc652ecca173224ecbf641ab3779a5433ef89679665612133876ce22801a",
    fundDeployer:    "581c04e199a0f2c96ce7e03e14a9a27ee86cfbebecac97425670e3304359a9c3",
    evmDeploys:      txHashes,
  },
  smokeCheck: {
    mockUsdcName:    usdcName,
    janusFlowVersion: jfVersion,
    janusErc20Version: je20Version,
  },
};

const outDir = join(REPO_ROOT, "deployments");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "testnet-v0.8.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

console.log("\n" + "=".repeat(60));
console.log("EVM deploy complete — manifest:", outPath);
console.log("=".repeat(60));
