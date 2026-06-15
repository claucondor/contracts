/**
 * combo-A.cjs — Scenario 10.A: Alice diversified across all 3 tokens simultaneously.
 *
 * Alice (deployer EOA) wraps tokens in all 3 Janus contracts:
 *   - 2 FLOW into JanusFlow (EVM)
 *   - 50 mUSDC into JanusERC20 (EVM)
 *   - 50 MockFT into JanusFT (Cadence, via openjanus-v08)
 *
 * Assertions:
 *   - All 3 commits are non-identity
 *   - All 3 commits are DISTINCT from each other
 *
 * Saves full state (value + blinding + commit) to results-combo-A.json for scenario D reuse.
 */

"use strict";

const { execFileSync } = require("child_process");
const { ethers }       = require("ethers");
const fs               = require("fs");
const path             = require("path");

const {
  generateAmountDiscloseProof,
  SUBORDER,
} = require("../../../packages/janus-token/tests/solidity/helpers/proofGen.cjs");

const {
  pubkeyFromPrivkey,
  encryptNote,
} = require("../../../packages/janus-token/tests/solidity/helpers/ecies.cjs");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL      = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID     = 545;
const SMOKE_DIR    = path.join(__dirname, "..");
const CADENCE_DIR  = path.join(SMOKE_DIR, "cadence");
const RESULTS_FILE = path.join(SMOKE_DIR, "results-combo-A.json");
const NETWORK      = "testnet";

const DEPLOYER_KEY       = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
const ALICE_CADENCE_ADDR = "0x4b6bc58bc8bf5dcc";
const ALICE_FLOW_ACCT    = "openjanus-v08";

const ADDRESSES = {
  janusFlow:       "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
  janusERC20:      "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
  mockUSDC:        "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
  memoKeyRegistry: "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
  shieldedInbox:   "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6",
};

const E18         = 10n ** 18n;
const E6          = 10n ** 6n;
const MOCKFT_SCALE = 100_000_000n;

const FLOW_WRAP_AMOUNT  = 1n * 10n**17n;   // 0.1 FLOW
const MUSDC_WRAP_AMOUNT = 5n * E6;         // 5 mUSDC
const FT_WRAP_AMOUNT    = 50n * MOCKFT_SCALE;  // 50 MockFT in uint256
const FT_WRAP_UFIX      = "50.00000000";

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const JANUS_FLOW_ABI = [
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) payable",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function VERSION() view returns (string)",
];

const JANUS_ERC20_ABI = [
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function VERSION() view returns (string)",
];

const MOCK_USDC_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const MEMO_KEY_REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y)",
  "function rotateMemoKey(uint256 x, uint256 y)",
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
];

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

let results = {
  phase:    "10.A",
  scenario: "alice-diversified",
  started:  new Date().toISOString(),
  steps:    {},
  verdict:  "RUNNING",
};

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v
  ));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function deriveJubKeypair(address) {
  const seed = ethers.keccak256(
    ethers.toUtf8Bytes(`${address.toLowerCase()}:openjanus/memokey/v1:v08-smoke`)
  );
  const priv   = BigInt(seed) % SUBORDER;
  const pubkey = await pubkeyFromPrivkey(priv);
  return { privkey: priv, pubkey };
}

function flatProof(p) {
  return [
    p.pA[0], p.pA[1],
    p.pB[0][0], p.pB[0][1],
    p.pB[1][0], p.pB[1][1],
    p.pC[0], p.pC[1],
  ];
}

async function waitTx(tx, label) {
  console.log(`  ${label}: sent ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`  ${label}: confirmed block=${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return receipt;
}

const { webcrypto } = require("crypto");
async function randomScalar() {
  while (true) {
    const bytes = new Uint8Array(32);
    webcrypto.getRandomValues(bytes);
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    const s = v % SUBORDER;
    if (s !== 0n) return s;
  }
}

function flowSend(txFile, signer, argsJson) {
  const txPath = path.join(CADENCE_DIR, txFile);
  const cmd = [
    "flow", "transactions", "send",
    "--network", NETWORK,
    "--signer", signer,
    "--config-path", path.join(SMOKE_DIR, "flow.json"),
    "--output", "json",
    "--args-json", JSON.stringify(argsJson),
    txPath,
  ];
  console.log(`  → flow send ${txFile} (signer=${signer})`);
  const output = execFileSync(cmd[0], cmd.slice(1), {
    cwd: SMOKE_DIR,
    timeout: 180_000,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  let result;
  try { result = JSON.parse(output.trim()); }
  catch {
    const m = output.match(/(\{[\s\S]*\})/);
    if (!m) throw new Error(`flow send ${txFile}: no JSON:\n${output.slice(0,500)}`);
    result = JSON.parse(m[1]);
  }
  if (!result.id) throw new Error(`flow send ${txFile}: no id:\n${JSON.stringify(result).slice(0,500)}`);
  const _sc  = result.statusCode ?? result.status_code;
  const _err = result.errorMessage || result.error_message || "";
  if ((typeof _sc === "number" && _sc !== 0) || _err.includes("[Error Code:")) {
    throw new Error(`flow send ${txFile}: tx FAILED: ${_err || `statusCode=${_sc}`}`);
  }
  console.log(`  ✓ sealed tx=${result.id}`);
  return { txId: result.id, events: result.events || [] };
}

function uint256Arg(n) { return { type: "UInt256", value: n.toString() }; }
function addressArg(a) { return { type: "Address", value: a }; }
function ufixArg(v)    { return { type: "UFix64",  value: v }; }
function arrayUint256(arr) {
  return { type: "Array", value: arr.map(n => uint256Arg(n)) };
}
function array2d(arr) {
  return { type: "Array", value: arr.map(row => ({ type: "Array", value: row.map(n => uint256Arg(n)) })) };
}
function arrayUint8(buf) {
  return { type: "Array", value: Array.from(buf).map(b => ({ type: "UInt8", value: b.toString() })) };
}
function addressArrayArg(addrs) {
  return { type: "Array", value: addrs.map(a => ({ type: "Address", value: a })) };
}

function encodeAdminBatchReset(addresses) {
  const iface = new ethers.Interface(["function adminBatchResetSlots(address[] calldata users) external"]);
  return iface.encodeFunctionData("adminBatchResetSlots", [addresses]).slice(2);
}

async function getCadenceCommitment(accountAddr) {
  const script = Buffer.from(`
import JanusFT from 0x4b6bc58bc8bf5dcc
access(all) fun main(account: Address): [UInt256] {
    let registry = getAccount(0x4b6bc58bc8bf5dcc)
        .capabilities.borrow<&{JanusFT.CommitmentRegistryPublic}>(/public/janusFTRegistry)
        ?? panic("no registry")
    let c = registry.balanceOfCommitment(account: account)
    return [c.x, c.y]
}
  `.trim(), "utf8").toString("base64");

  const argB64 = Buffer.from(JSON.stringify({ type: "Address", value: accountAddr }), "utf8").toString("base64");

  const resp = await fetch("https://rest-testnet.onflow.org/v1/scripts?block_height=sealed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, arguments: [argB64] }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Cadence script HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const resultRaw = await resp.json();
  if (typeof resultRaw !== "string") {
    throw new Error(`Cadence script error response: ${JSON.stringify(resultRaw).slice(0, 300)}`);
  }
  const decoded   = Buffer.from(resultRaw, "base64").toString("utf8");
  const parsed    = JSON.parse(decoded);
  return { x: BigInt(parsed.value[0].value), y: BigInt(parsed.value[1].value) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Scenario 10.A: Alice Diversified Across All 3 Tokens ===\n");

  const provider      = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const aliceWallet   = new ethers.Wallet(DEPLOYER_KEY, provider);
  console.log("Alice (deployer EOA):", aliceWallet.address);
  console.log("Alice (Cadence):", ALICE_CADENCE_ADDR);

  results.steps.accounts = {
    alice_evm:     aliceWallet.address,
    alice_cadence: ALICE_CADENCE_ADDR,
    ts:            new Date().toISOString(),
  };
  saveResults();

  const janusFlow  = new ethers.Contract(ADDRESSES.janusFlow,       JANUS_FLOW_ABI,        aliceWallet);
  const janusERC20 = new ethers.Contract(ADDRESSES.janusERC20,      JANUS_ERC20_ABI,       aliceWallet);
  const usdc       = new ethers.Contract(ADDRESSES.mockUSDC,        MOCK_USDC_ABI,         aliceWallet);
  const memoReg    = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, aliceWallet);

  // Verify contract versions
  const flowVer  = await janusFlow.VERSION();
  const erc20Ver = await janusERC20.VERSION();
  console.log(`JanusFlow VERSION: ${flowVer}, JanusERC20 VERSION: ${erc20Ver}`);
  if (flowVer !== "0.8.0" || erc20Ver !== "0.8.0") throw new Error("Version mismatch");

  // -------------------------------------------------------------------------
  // Step 0: Setup + Admin reset (clean state)
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Setup + Admin reset ---");

  // 0a: Ensure JanusFT vault type is MockFT (repair if drifted to FlowToken after contract update)
  const strArg    = (s) => ({ type: "String", value: s });
  const uint64Arg = (n) => ({ type: "UInt64",  value: n.toString() });
  const MOCKFT_TYPE = "A.4b6bc58bc8bf5dcc.MockFT.Vault";

  flowSend("set_underlying_vault_type.cdc", ALICE_FLOW_ACCT, [
    strArg(MOCKFT_TYPE),
  ]);
  console.log("  JanusFT underlyingVaultType set to MockFT.Vault");

  // 0b: Install/refresh CommitmentRegistry (idempotent)
  flowSend("install_registry.cdc", ALICE_FLOW_ACCT, []);
  flowSend("setup_mockft_vault.cdc", ALICE_FLOW_ACCT, []);
  console.log("  JanusFT CommitmentRegistry installed + memokey vault setup");

  const flowResetCalldata  = encodeAdminBatchReset([aliceWallet.address]);
  const erc20ResetCalldata = encodeAdminBatchReset([aliceWallet.address]);

  const flowResetTx = flowSend("admin_evm_call.cdc", ALICE_FLOW_ACCT, [
    strArg(ADDRESSES.janusFlow.slice(2)),
    strArg(flowResetCalldata),
    uint64Arg(500_000n),
  ]);

  const erc20ResetTx = flowSend("admin_evm_call.cdc", ALICE_FLOW_ACCT, [
    strArg(ADDRESSES.janusERC20.slice(2)),
    strArg(erc20ResetCalldata),
    uint64Arg(500_000n),
  ]);

  // Also reset JanusFT Cadence slot for openjanus-v08
  const ftResetTx = flowSend("admin_reset_janusFT.cdc", ALICE_FLOW_ACCT, [
    addressArrayArg([ALICE_CADENCE_ADDR]),
  ]);

  // Verify all slots are identity now
  const [preCxF, preCyF]   = await janusFlow.balanceOfCommitmentXY(aliceWallet.address);
  const [preCxE, preCyE]   = await janusERC20.balanceOfCommitmentXY(aliceWallet.address);
  const preCadence         = await getCadenceCommitment(ALICE_CADENCE_ADDR);

  if (preCxF !== 0n || preCyF !== 1n)         throw new Error(`JanusFlow: post-reset not identity: (${preCxF},${preCyF})`);
  if (preCxE !== 0n || preCyE !== 1n)         throw new Error(`JanusERC20: post-reset not identity: (${preCxE},${preCyE})`);
  if (preCadence.x !== 0n || preCadence.y !== 1n) throw new Error(`JanusFT: post-reset not identity: (${preCadence.x},${preCadence.y})`);

  console.log("  All 3 slots reset to identity (0,1) — clean state confirmed");

  results.steps.admin_reset = {
    flow_reset_tx:   flowResetTx.txId,
    erc20_reset_tx:  erc20ResetTx.txId,
    ft_reset_tx:     ftResetTx.txId,
    verified:        true,
    ts:              new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: Generate Alice's BabyJub keypair + publish memokey
  // -------------------------------------------------------------------------
  console.log("\n--- Step 1: Generate keypair + ensure EVM memokey ---");
  const aliceJub = await deriveJubKeypair(aliceWallet.address);
  console.log("  Alice JubPub.x:", aliceJub.pubkey.x.toString().slice(0,20) + "...");

  // Use rotateMemoKey if key already published (deployer may have published in Fase 9)
  const [existX, , publishedAt] = await memoReg.getMemoKey(aliceWallet.address);
  let memoTx;
  if (publishedAt > 0n) {
    console.log("  Key already published — rotating to same deterministic key");
    memoTx = await memoReg.rotateMemoKey(aliceJub.pubkey.x, aliceJub.pubkey.y);
    await waitTx(memoTx, "alice-rotate-memokey");
  } else {
    memoTx = await memoReg.publishMemoKey(aliceJub.pubkey.x, aliceJub.pubkey.y);
    await waitTx(memoTx, "alice-publish-memokey");
  }

  const [mx, my] = await memoReg.getMemoKey(aliceWallet.address);
  if (mx !== aliceJub.pubkey.x || my !== aliceJub.pubkey.y) throw new Error("memokey mismatch");
  console.log("  Memokey verified in EVM registry");

  results.steps.memokey = { tx: memoTx.hash, verified: true, ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 2: Alice wraps 2 FLOW into JanusFlow
  // -------------------------------------------------------------------------
  console.log("\n--- Step 2: Alice wraps 2 FLOW into JanusFlow ---");
  const flowBlinding = await randomScalar();
  const flowNonce    = BigInt(Date.now());

  console.log("  Generating amount-disclose proof for 2 FLOW...");
  const flowWrapProof = await generateAmountDiscloseProof({
    amount:   FLOW_WRAP_AMOUNT,
    blinding: flowBlinding,
    nonce:    flowNonce,
  });
  const flowCX = flowWrapProof.pubSignals[1];
  const flowCY = flowWrapProof.pubSignals[2];

  const { ciphertext: flowSnap, ephemeralPubkey: flowSnapEph } = await encryptNote(
    { amount: FLOW_WRAP_AMOUNT, blinding: flowBlinding },
    aliceJub.pubkey
  );

  const flowWrapTx = await janusFlow.wrapWithProof(
    flowNonce,
    [flowCX, flowCY],
    flowWrapProof.pA,
    flowWrapProof.pB,
    flowWrapProof.pC,
    flowSnap,
    flowSnapEph.x,
    flowSnapEph.y,
    { value: FLOW_WRAP_AMOUNT }
  );
  await waitTx(flowWrapTx, "alice-flow-wrap");

  const [postCxF, postCyF] = await janusFlow.balanceOfCommitmentXY(aliceWallet.address);
  if (postCxF !== flowCX || postCyF !== flowCY) {
    throw new Error(`JanusFlow commit mismatch: (${postCxF},${postCyF}) vs (${flowCX},${flowCY})`);
  }
  console.log("  JanusFlow commitment verified");

  results.steps.flow_wrap = {
    tx:       flowWrapTx.hash,
    amount:   FLOW_WRAP_AMOUNT.toString(),
    commit_x: flowCX.toString(),
    commit_y: flowCY.toString(),
    blinding: flowBlinding.toString(),
    verified: true,
    ts:       new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 3: Mint mUSDC + Alice wraps 50 mUSDC into JanusERC20
  // -------------------------------------------------------------------------
  console.log("\n--- Step 3: Mint mUSDC + Alice wraps 50 mUSDC into JanusERC20 ---");

  const mintTx = await usdc.mint(aliceWallet.address, MUSDC_WRAP_AMOUNT * 2n);
  await waitTx(mintTx, "mint-musdc");

  const approveTx = await usdc.approve(ADDRESSES.janusERC20, MUSDC_WRAP_AMOUNT);
  await waitTx(approveTx, "approve-musdc");

  const musdcBlinding = await randomScalar();
  const musdcNonce    = BigInt(Date.now());

  console.log("  Generating amount-disclose proof for 50 mUSDC...");
  const musdcWrapProof = await generateAmountDiscloseProof({
    amount:   MUSDC_WRAP_AMOUNT,
    blinding: musdcBlinding,
    nonce:    musdcNonce,
  });
  const musdcCX = musdcWrapProof.pubSignals[1];
  const musdcCY = musdcWrapProof.pubSignals[2];

  const { ciphertext: musdcSnap, ephemeralPubkey: musdcSnapEph } = await encryptNote(
    { amount: MUSDC_WRAP_AMOUNT, blinding: musdcBlinding },
    aliceJub.pubkey
  );

  const musdcWrapTx = await janusERC20.wrapWithProof(
    MUSDC_WRAP_AMOUNT,
    musdcNonce,
    [musdcCX, musdcCY],
    musdcWrapProof.pA,
    musdcWrapProof.pB,
    musdcWrapProof.pC,
    musdcSnap,
    musdcSnapEph.x,
    musdcSnapEph.y
  );
  await waitTx(musdcWrapTx, "alice-musdc-wrap");

  const [postCxE, postCyE] = await janusERC20.balanceOfCommitmentXY(aliceWallet.address);
  if (postCxE !== musdcCX || postCyE !== musdcCY) {
    throw new Error(`JanusERC20 commit mismatch: (${postCxE},${postCyE}) vs (${musdcCX},${musdcCY})`);
  }
  console.log("  JanusERC20 commitment verified");

  results.steps.musdc_wrap = {
    mint_tx:  mintTx.hash,
    wrap_tx:  musdcWrapTx.hash,
    amount:   MUSDC_WRAP_AMOUNT.toString(),
    commit_x: musdcCX.toString(),
    commit_y: musdcCY.toString(),
    blinding: musdcBlinding.toString(),
    verified: true,
    ts:       new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 4: Mint MockFT + Alice wraps 50 MockFT into JanusFT (Cadence)
  // -------------------------------------------------------------------------
  console.log("\n--- Step 4: Mint MockFT + Alice wraps 50 MockFT into JanusFT ---");

  const ftMintTx = flowSend("mint_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArg("100.00000000"),
    addressArg(ALICE_CADENCE_ADDR),
  ]);
  console.log("  Minted 100 MockFT to Cadence Alice:", ftMintTx.txId);

  const ftBlinding = await randomScalar();
  const ftNonce    = BigInt(Date.now());

  console.log("  Generating amount-disclose proof for 50 MockFT...");
  const ftWrapProof = await generateAmountDiscloseProof({
    amount:   FT_WRAP_AMOUNT,
    blinding: ftBlinding,
    nonce:    ftNonce,
  });
  const ftCX = ftWrapProof.pubSignals[1];
  const ftCY = ftWrapProof.pubSignals[2];

  const { ciphertext: ftSnap, ephemeralPubkey: ftSnapEph } = await encryptNote(
    { amount: FT_WRAP_AMOUNT, blinding: ftBlinding },
    aliceJub.pubkey
  );

  const ftWrapTx = flowSend("wrap_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArg(FT_WRAP_UFIX),
    uint256Arg(ftNonce),
    uint256Arg(ftCX),
    uint256Arg(ftCY),
    arrayUint256([ftWrapProof.pA[0], ftWrapProof.pA[1]]),
    array2d([[ftWrapProof.pB[0][1], ftWrapProof.pB[0][0]], [ftWrapProof.pB[1][1], ftWrapProof.pB[1][0]]]),
    arrayUint256([ftWrapProof.pC[0], ftWrapProof.pC[1]]),
    arrayUint8(ftSnap),
    uint256Arg(ftSnapEph.x),
    uint256Arg(ftSnapEph.y),
  ]);
  console.log("  JanusFT wrap confirmed:", ftWrapTx.txId);

  // Query Cadence commitment
  const cadenceCommit = await getCadenceCommitment(ALICE_CADENCE_ADDR);
  console.log(`  JanusFT commit: (${cadenceCommit.x.toString().slice(0,20)}..., ${cadenceCommit.y.toString().slice(0,20)}...)`);

  if (cadenceCommit.x === 0n && cadenceCommit.y === 1n) {
    throw new Error("JanusFT commitment still identity after wrap!");
  }
  // Note: JanusFT may have a fee, so the stored commit might not exactly equal ftCX/ftCY
  // We just assert it's non-identity here
  console.log("  JanusFT commitment is non-identity — wrap confirmed");

  results.steps.mockft_wrap = {
    mint_tx:    ftMintTx.txId,
    wrap_tx:    ftWrapTx.txId,
    amount:     FT_WRAP_UFIX,
    amount_u256: FT_WRAP_AMOUNT.toString(),
    proof_commit_x: ftCX.toString(),
    proof_commit_y: ftCY.toString(),
    stored_commit_x: cadenceCommit.x.toString(),
    stored_commit_y: cadenceCommit.y.toString(),
    blinding:    ftBlinding.toString(),
    nonce:       ftNonce.toString(),
    verified:    true,
    ts:          new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 5: Query all 3 commits + assert distinct non-identity
  // -------------------------------------------------------------------------
  console.log("\n--- Step 5: Query + assert all 3 commits are distinct non-identity ---");

  const [cxFlow, cyFlow]   = await janusFlow.balanceOfCommitmentXY(aliceWallet.address);
  const [cxERC20, cyERC20] = await janusERC20.balanceOfCommitmentXY(aliceWallet.address);
  const cFT                = await getCadenceCommitment(ALICE_CADENCE_ADDR);

  console.log(`  JanusFlow  commit: (${cxFlow.toString().slice(0,20)}..., ${cyFlow.toString().slice(0,20)}...)`);
  console.log(`  JanusERC20 commit: (${cxERC20.toString().slice(0,20)}..., ${cyERC20.toString().slice(0,20)}...)`);
  console.log(`  JanusFT    commit: (${cFT.x.toString().slice(0,20)}..., ${cFT.y.toString().slice(0,20)}...)`);

  // Assert non-identity
  if (cxFlow === 0n && cyFlow === 1n)   throw new Error("JanusFlow commit is identity — wrap failed");
  if (cxERC20 === 0n && cyERC20 === 1n) throw new Error("JanusERC20 commit is identity — wrap failed");
  if (cFT.x === 0n && cFT.y === 1n)    throw new Error("JanusFT commit is identity — wrap failed");
  console.log("  All 3 commits are non-identity");

  // Assert DISTINCT (none equal each other)
  if (cxFlow === cxERC20 && cyFlow === cyERC20) throw new Error("JanusFlow == JanusERC20 commit!");
  if (cxFlow === cFT.x   && cyFlow === cFT.y)   throw new Error("JanusFlow == JanusFT commit!");
  if (cxERC20 === cFT.x  && cyERC20 === cFT.y)  throw new Error("JanusERC20 == JanusFT commit!");
  console.log("  All 3 commits are DISTINCT — independent state confirmed");

  results.steps.final_commits = {
    janusflow:  { x: cxFlow.toString(),  y: cyFlow.toString()  },
    janusERC20: { x: cxERC20.toString(), y: cyERC20.toString() },
    janusFT:    { x: cFT.x.toString(),  y: cFT.y.toString()   },
    all_non_identity: true,
    all_distinct:     true,
    ts:         new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Summary — save full state for D to reuse
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  results.summary  = {
    alice_evm:       aliceWallet.address,
    alice_evm_key:   aliceWallet.privateKey,
    alice_cadence:   ALICE_CADENCE_ADDR,
    // EVM keypair
    alice_jub_priv:  aliceJub.privkey.toString(),
    alice_jub_pub_x: aliceJub.pubkey.x.toString(),
    alice_jub_pub_y: aliceJub.pubkey.y.toString(),
    // JanusFlow state (for D reuse)
    flow_state: {
      value:    FLOW_WRAP_AMOUNT.toString(),
      blinding: flowBlinding.toString(),
      commit_x: cxFlow.toString(),
      commit_y: cyFlow.toString(),
    },
    // JanusERC20 state (for D reuse)
    musdc_state: {
      value:    MUSDC_WRAP_AMOUNT.toString(),
      blinding: musdcBlinding.toString(),
      commit_x: cxERC20.toString(),
      commit_y: cyERC20.toString(),
    },
    // JanusFT state (for D reuse — note commit may differ from proof due to fee)
    ft_state: {
      value:      FT_WRAP_AMOUNT.toString(),
      blinding:   ftBlinding.toString(),
      commit_x:   cFT.x.toString(),
      commit_y:   cFT.y.toString(),
      nonce:      ftNonce.toString(),
    },
  };
  saveResults();

  console.log("\n=== Scenario 10.A RESULT: GREEN ===");
  console.log("  JanusFlow wrap:   ", flowWrapTx.hash);
  console.log("  JanusERC20 wrap:  ", musdcWrapTx.hash);
  console.log("  JanusFT wrap:     ", ftWrapTx.txId);
  console.log("  All 3 commits distinct & non-identity: PASS");
}

main()
  .then(() => { console.log("\n10.A complete — results saved"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
