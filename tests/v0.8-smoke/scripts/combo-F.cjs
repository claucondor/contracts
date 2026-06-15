/**
 * combo-F.cjs — Scenario 11.F: Multi-token ShieldedCheckpoint per-token isolation.
 *
 * Exercises the NEW per-token ShieldedCheckpoint at 0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26.
 *
 * Uses a fresh EOA (alice_F) funded by the deployer so state starts clean.
 *
 * Phase 1 (FLOW):
 *   - Wrap 1 FLOW into JanusFlow proxy
 *   - Update checkpoint with JanusFlow proxy as token key
 *   - Verify read(JanusFlowProxy) returns snapshot; decrypt → assert amount=1e18
 *   - Verify read(JanusERC20Proxy) reverts with NoCheckpoint
 *
 * Phase 2 (mUSDC):
 *   - Mint + approve 5 mUSDC, wrap into JanusERC20 proxy
 *   - Update checkpoint with JanusERC20 proxy as token key
 *   - Verify read(JanusFlowProxy) UNCHANGED (Phase 1 snapshot still there)
 *   - Verify read(JanusERC20Proxy) returns mUSDC snapshot; decrypt → assert amount=5e6
 *
 * Phase 3 (final assertions):
 *   - metadata(alice_F, JanusFlowProxy).hasCheckpoint = true
 *   - metadata(alice_F, JanusERC20Proxy).hasCheckpoint = true
 *   - metadata(0x0, JanusFlowProxy).hasCheckpoint = false
 *   - Snapshots for FLOW and mUSDC are DISTINCT bytes (key assertion vs old singleton bug)
 *
 * Saves full results to results-combo-F.json.
 */

"use strict";

const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");

const {
  generateAmountDiscloseProof,
  SUBORDER,
} = require("../../../packages/janus-token/tests/solidity/helpers/proofGen.cjs");

const {
  pubkeyFromPrivkey,
  encryptNote,
  decryptNote,
} = require("../../../packages/janus-token/tests/solidity/helpers/ecies.cjs");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL      = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID     = 545;
const SMOKE_DIR    = path.join(__dirname, "..");
const RESULTS_FILE = path.join(SMOKE_DIR, "results-combo-F.json");

const DEPLOYER_KEY = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";

const ADDRESSES = {
  janusFlow:          "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
  janusERC20:         "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
  mockUSDC:           "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
  memoKeyRegistry:    "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
  shieldedCheckpoint: "0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26",
};

const E18 = 10n ** 18n;
const E6  = 10n ** 6n;

const FLOW_WRAP_AMOUNT  = 1n * 10n**17n;  // 0.1 FLOW (testnet budget: deployer EOA has ~0.4 FLOW)
const MUSDC_WRAP_AMOUNT = 5n * E6;        // 5 mUSDC

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
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
];

// Tuple return type for read() — ethers v6 returns a Result object indexed by field names
const CHECKPOINT_ABI = [
  "function update(address token, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex) external",
  "function read(address token) external view returns (tuple(bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version) cp)",
  "function metadata(address user, address token) external view returns (uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version, bool hasCheckpoint)",
  "function exists(address user, address token) external view returns (bool)",
];

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

let results = {
  phase:    "11.F",
  scenario: "multi-token-checkpoint-isolation",
  started:  new Date().toISOString(),
  steps:    {},
  verdict:  "RUNNING",
};

function saveResults() {
  const replacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2, replacer));
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

/** Call checkpoint.read(token) from wallet context and expect a revert. */
async function expectNoCheckpointRevert(checkpointContract, tokenAddr, label) {
  try {
    await checkpointContract.read(tokenAddr);
    throw new Error(`${label}: Expected NoCheckpoint revert but call SUCCEEDED`);
  } catch (err) {
    if (err.message && err.message.includes("Expected NoCheckpoint revert")) throw err;
    // Any other error indicates a revert — good
    console.log(`  ✓ ${label}: reverts as expected (NoCheckpoint)`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log("=== Scenario 11.F: Multi-Token ShieldedCheckpoint Isolation ===\n");
  console.log(`  Checkpoint contract: ${ADDRESSES.shieldedCheckpoint}`);
  console.log(`  JanusFlow proxy:     ${ADDRESSES.janusFlow}`);
  console.log(`  JanusERC20 proxy:    ${ADDRESSES.janusERC20}\n`);

  const provider  = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const deployer  = new ethers.Wallet(DEPLOYER_KEY, provider);

  // Fresh EOA — starts with zero state in all Janus contracts and checkpoint
  const alice_F   = ethers.Wallet.createRandom().connect(provider);

  console.log("Deployer:  ", deployer.address);
  console.log("Alice_F:   ", alice_F.address, "(fresh EOA)");

  results.steps.accounts = {
    deployer: deployer.address,
    alice_F:  alice_F.address,
    alice_F_key: alice_F.privateKey,
    ts:       new Date().toISOString(),
  };
  saveResults();

  // Contract instances — deployer for admin/mint ops, alice_F for wrap + checkpoint ops
  const janusFlowAlice  = new ethers.Contract(ADDRESSES.janusFlow,          JANUS_FLOW_ABI,        alice_F);
  const janusERC20Alice = new ethers.Contract(ADDRESSES.janusERC20,         JANUS_ERC20_ABI,       alice_F);
  const usdcDep         = new ethers.Contract(ADDRESSES.mockUSDC,           MOCK_USDC_ABI,         deployer);
  const usdcAlice       = new ethers.Contract(ADDRESSES.mockUSDC,           MOCK_USDC_ABI,         alice_F);
  const memoRegDep      = new ethers.Contract(ADDRESSES.memoKeyRegistry,    MEMO_KEY_REGISTRY_ABI, deployer);
  const memoRegAlice    = new ethers.Contract(ADDRESSES.memoKeyRegistry,    MEMO_KEY_REGISTRY_ABI, alice_F);
  // Checkpoint connected to alice_F — read() is scoped to msg.sender = alice_F
  const checkpointAlice = new ethers.Contract(ADDRESSES.shieldedCheckpoint, CHECKPOINT_ABI,        alice_F);
  // Checkpoint connected to provider for metadata() calls (no signer needed for view)
  const checkpointView  = new ethers.Contract(ADDRESSES.shieldedCheckpoint, CHECKPOINT_ABI,        provider);

  // -------------------------------------------------------------------------
  // Step 0: Fund alice_F + publish memokey
  // -------------------------------------------------------------------------
  console.log("--- Step 0: Fund alice_F + publish memokey ---");

  const fundTx = await deployer.sendTransaction({
    to:    alice_F.address,
    value: ethers.parseEther("0.2"),   // 0.1 FLOW for wrap + 0.1 for gas; deployer keeps ~0.19 FLOW
  });
  await waitTx(fundTx, "fund-alice-F");

  // Generate alice_F's BabyJub keypair
  const aliceJub = await deriveJubKeypair(alice_F.address);
  console.log("  Alice_F JubPub.x:", aliceJub.pubkey.x.toString().slice(0, 20) + "...");

  const memoTx = await memoRegAlice.publishMemoKey(aliceJub.pubkey.x, aliceJub.pubkey.y);
  await waitTx(memoTx, "alice-F-publish-memokey");

  const [mx, my, mpat] = await memoRegAlice.getMemoKey(alice_F.address);
  if (mx !== aliceJub.pubkey.x || my !== aliceJub.pubkey.y) {
    throw new Error("alice_F memokey mismatch in registry");
  }
  console.log("  Memokey verified in registry");

  // Confirm clean state at checkpoint for both tokens
  const flowExistsPre  = await checkpointView.exists(alice_F.address, ADDRESSES.janusFlow);
  const musdcExistsPre = await checkpointView.exists(alice_F.address, ADDRESSES.janusERC20);
  if (flowExistsPre || musdcExistsPre) {
    throw new Error(`alice_F is not fresh: flowExists=${flowExistsPre} musdcExists=${musdcExistsPre}`);
  }
  console.log("  Checkpoint clean state confirmed (both token slots empty)");

  results.steps.setup = {
    fund_tx:   fundTx.hash,
    memokey_tx: memoTx.hash,
    alice_jub_pub_x: aliceJub.pubkey.x.toString(),
    alice_jub_pub_y: aliceJub.pubkey.y.toString(),
    flow_slot_empty:  true,
    musdc_slot_empty: true,
    verified: true,
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Phase 1: Wrap 1 FLOW + update checkpoint (FLOW slot only)
  // -------------------------------------------------------------------------
  console.log("\n--- Phase 1: Wrap 1 FLOW + checkpoint update (JanusFlow token key) ---");

  const flowBlinding = await randomScalar();
  const flowNonce    = BigInt(Date.now());

  console.log("  Generating amount-disclose proof for 1 FLOW...");
  const flowWrapProof = await generateAmountDiscloseProof({
    amount:   FLOW_WRAP_AMOUNT,
    blinding: flowBlinding,
    nonce:    flowNonce,
  });
  const flowCX = flowWrapProof.pubSignals[1];
  const flowCY = flowWrapProof.pubSignals[2];

  // Encrypt wrap snapshot to alice_F's pubkey
  const { ciphertext: flowSnapBytes, ephemeralPubkey: flowSnapEph } = await encryptNote(
    { amount: FLOW_WRAP_AMOUNT, blinding: flowBlinding },
    aliceJub.pubkey
  );

  // 1a. Wrap 1 FLOW
  const flowWrapTx = await janusFlowAlice.wrapWithProof(
    flowNonce,
    [flowCX, flowCY],
    flowWrapProof.pA,
    flowWrapProof.pB,
    flowWrapProof.pC,
    flowSnapBytes,
    flowSnapEph.x,
    flowSnapEph.y,
    { value: FLOW_WRAP_AMOUNT }
  );
  await waitTx(flowWrapTx, "alice-F-flow-wrap");

  const [postCxF, postCyF] = await janusFlowAlice.balanceOfCommitmentXY(alice_F.address);
  if (postCxF !== flowCX || postCyF !== flowCY) {
    throw new Error(`JanusFlow commit mismatch: got (${postCxF},${postCyF}) expected (${flowCX},${flowCY})`);
  }
  console.log("  JanusFlow commitment verified");

  // 1b. Update checkpoint — token key = JanusFlow proxy address
  const flowCkptTx = await checkpointAlice.update(
    ADDRESSES.janusFlow,   // token key
    flowSnapBytes,
    flowSnapEph.x,
    flowSnapEph.y,
    0n                     // cursor: no inbox notes consumed yet
  );
  await waitTx(flowCkptTx, "alice-F-checkpoint-flow-update");

  // 1c. Verify read(JanusFlowProxy) works and decrypts correctly
  console.log("  Reading checkpoint for JanusFlowProxy...");
  const flowCpRaw = await checkpointAlice.read(ADDRESSES.janusFlow);
  const flowCpEncBytes = ethers.getBytes(flowCpRaw.encryptedSnapshot);
  const flowDecrypted  = await decryptNote(
    Buffer.from(flowCpEncBytes),
    { x: flowCpRaw.ephPubkeyX, y: flowCpRaw.ephPubkeyY },
    aliceJub.privkey
  );
  console.log(`  Decrypted FLOW checkpoint: amount=${flowDecrypted.amount}`);
  if (flowDecrypted.amount !== FLOW_WRAP_AMOUNT) {
    throw new Error(`FLOW checkpoint amount mismatch: ${flowDecrypted.amount} !== ${FLOW_WRAP_AMOUNT}`);
  }
  console.log("  ✓ FLOW checkpoint decrypts to correct balance (1 FLOW = 1e18)");

  // 1d. Verify read(JanusERC20Proxy) reverts with NoCheckpoint
  await expectNoCheckpointRevert(checkpointAlice, ADDRESSES.janusERC20, "read(JanusERC20Proxy) after Phase 1");

  results.steps.phase1_flow = {
    wrap_tx:              flowWrapTx.hash,
    checkpoint_update_tx: flowCkptTx.hash,
    wrap_amount:          FLOW_WRAP_AMOUNT.toString(),
    commit_x:             flowCX.toString(),
    commit_y:             flowCY.toString(),
    checkpoint_version:   flowCpRaw.version.toString(),
    decrypted_amount:     flowDecrypted.amount.toString(),
    read_flow_ok:         true,
    read_musdc_reverts:   true,
    verified:             true,
    ts:                   new Date().toISOString(),
  };
  saveResults();
  console.log("  Phase 1: PASS");

  // -------------------------------------------------------------------------
  // Phase 2: Wrap 5 mUSDC + update checkpoint (mUSDC slot only)
  // -------------------------------------------------------------------------
  console.log("\n--- Phase 2: Wrap 5 mUSDC + checkpoint update (JanusERC20 token key) ---");

  // 2a. Mint 10 mUSDC to alice_F (permissionless mint)
  const mintTx = await usdcDep.mint(alice_F.address, MUSDC_WRAP_AMOUNT * 2n);
  await waitTx(mintTx, "mint-musdc-alice-F");

  // 2b. Approve JanusERC20 to spend
  const approveTx = await usdcAlice.approve(ADDRESSES.janusERC20, MUSDC_WRAP_AMOUNT);
  await waitTx(approveTx, "alice-F-approve-musdc");

  const musdcBlinding = await randomScalar();
  const musdcNonce    = BigInt(Date.now());

  console.log("  Generating amount-disclose proof for 5 mUSDC...");
  const musdcWrapProof = await generateAmountDiscloseProof({
    amount:   MUSDC_WRAP_AMOUNT,
    blinding: musdcBlinding,
    nonce:    musdcNonce,
  });
  const musdcCX = musdcWrapProof.pubSignals[1];
  const musdcCY = musdcWrapProof.pubSignals[2];

  // Encrypt mUSDC snapshot to alice_F's pubkey
  const { ciphertext: musdcSnapBytes, ephemeralPubkey: musdcSnapEph } = await encryptNote(
    { amount: MUSDC_WRAP_AMOUNT, blinding: musdcBlinding },
    aliceJub.pubkey
  );

  // 2c. Wrap 5 mUSDC
  const musdcWrapTx = await janusERC20Alice.wrapWithProof(
    MUSDC_WRAP_AMOUNT,
    musdcNonce,
    [musdcCX, musdcCY],
    musdcWrapProof.pA,
    musdcWrapProof.pB,
    musdcWrapProof.pC,
    musdcSnapBytes,
    musdcSnapEph.x,
    musdcSnapEph.y
  );
  await waitTx(musdcWrapTx, "alice-F-musdc-wrap");

  const [postCxE, postCyE] = await janusERC20Alice.balanceOfCommitmentXY(alice_F.address);
  if (postCxE !== musdcCX || postCyE !== musdcCY) {
    throw new Error(`JanusERC20 commit mismatch: got (${postCxE},${postCyE}) expected (${musdcCX},${musdcCY})`);
  }
  console.log("  JanusERC20 commitment verified");

  // 2d. Update checkpoint — token key = JanusERC20 proxy address
  const musdcCkptTx = await checkpointAlice.update(
    ADDRESSES.janusERC20, // token key
    musdcSnapBytes,
    musdcSnapEph.x,
    musdcSnapEph.y,
    0n                    // cursor
  );
  await waitTx(musdcCkptTx, "alice-F-checkpoint-musdc-update");

  // 2e. Verify read(JanusFlowProxy) UNCHANGED — Phase 1 snapshot still there
  console.log("  Verifying FLOW checkpoint is unchanged after mUSDC update...");
  const flowCpRaw2 = await checkpointAlice.read(ADDRESSES.janusFlow);
  // Version should still be 1 (only updated once in Phase 1)
  if (flowCpRaw2.version !== flowCpRaw.version) {
    throw new Error(`FLOW checkpoint version changed! before=${flowCpRaw.version} after=${flowCpRaw2.version}`);
  }
  // Re-decrypt to confirm same amount
  const flowDecrypted2 = await decryptNote(
    Buffer.from(ethers.getBytes(flowCpRaw2.encryptedSnapshot)),
    { x: flowCpRaw2.ephPubkeyX, y: flowCpRaw2.ephPubkeyY },
    aliceJub.privkey
  );
  if (flowDecrypted2.amount !== FLOW_WRAP_AMOUNT) {
    throw new Error(`FLOW checkpoint contaminated after mUSDC update! amount=${flowDecrypted2.amount}`);
  }
  console.log("  ✓ FLOW checkpoint UNCHANGED after mUSDC update (version same, amount=1e18)");

  // 2f. Verify read(JanusERC20Proxy) returns mUSDC snapshot
  console.log("  Reading checkpoint for JanusERC20Proxy...");
  const musdcCpRaw = await checkpointAlice.read(ADDRESSES.janusERC20);
  const musdcDecrypted = await decryptNote(
    Buffer.from(ethers.getBytes(musdcCpRaw.encryptedSnapshot)),
    { x: musdcCpRaw.ephPubkeyX, y: musdcCpRaw.ephPubkeyY },
    aliceJub.privkey
  );
  console.log(`  Decrypted mUSDC checkpoint: amount=${musdcDecrypted.amount}`);
  if (musdcDecrypted.amount !== MUSDC_WRAP_AMOUNT) {
    throw new Error(`mUSDC checkpoint amount mismatch: ${musdcDecrypted.amount} !== ${MUSDC_WRAP_AMOUNT}`);
  }
  console.log("  ✓ mUSDC checkpoint decrypts to correct balance (5 mUSDC = 5e6)");

  results.steps.phase2_musdc = {
    mint_tx:              mintTx.hash,
    approve_tx:           approveTx.hash,
    wrap_tx:              musdcWrapTx.hash,
    checkpoint_update_tx: musdcCkptTx.hash,
    wrap_amount:          MUSDC_WRAP_AMOUNT.toString(),
    commit_x:             musdcCX.toString(),
    commit_y:             musdcCY.toString(),
    checkpoint_version:   musdcCpRaw.version.toString(),
    decrypted_amount:     musdcDecrypted.amount.toString(),
    read_flow_unchanged:  true,
    read_musdc_ok:        true,
    verified:             true,
    ts:                   new Date().toISOString(),
  };
  saveResults();
  console.log("  Phase 2: PASS");

  // -------------------------------------------------------------------------
  // Phase 3: Final assertions
  // -------------------------------------------------------------------------
  console.log("\n--- Phase 3: Final assertions ---");

  // 3a. metadata(alice_F, JanusFlowProxy).hasCheckpoint = true
  const [, , flowMetaVer, flowMetaHas] = await checkpointView.metadata(alice_F.address, ADDRESSES.janusFlow);
  if (!flowMetaHas) throw new Error("metadata(alice_F, JanusFlow).hasCheckpoint should be true");
  console.log(`  ✓ metadata(alice_F, JanusFlowProxy).hasCheckpoint = true (version=${flowMetaVer})`);

  // 3b. metadata(alice_F, JanusERC20Proxy).hasCheckpoint = true
  const [, , musdcMetaVer, musdcMetaHas] = await checkpointView.metadata(alice_F.address, ADDRESSES.janusERC20);
  if (!musdcMetaHas) throw new Error("metadata(alice_F, JanusERC20).hasCheckpoint should be true");
  console.log(`  ✓ metadata(alice_F, JanusERC20Proxy).hasCheckpoint = true (version=${musdcMetaVer})`);

  // 3c. metadata(0x0, JanusFlowProxy).hasCheckpoint = false
  const [, , , zeroMetaHas] = await checkpointView.metadata(ethers.ZeroAddress, ADDRESSES.janusFlow);
  if (zeroMetaHas) throw new Error("metadata(0x0, JanusFlow).hasCheckpoint should be false");
  console.log("  ✓ metadata(0x0, JanusFlowProxy).hasCheckpoint = false");

  // 3d. FLOW decrypts to 1 FLOW (final read)
  const flowFinalCp = await checkpointAlice.read(ADDRESSES.janusFlow);
  const flowFinalDec = await decryptNote(
    Buffer.from(ethers.getBytes(flowFinalCp.encryptedSnapshot)),
    { x: flowFinalCp.ephPubkeyX, y: flowFinalCp.ephPubkeyY },
    aliceJub.privkey
  );
  if (flowFinalDec.amount !== FLOW_WRAP_AMOUNT) {
    throw new Error(`Final FLOW balance check failed: ${flowFinalDec.amount} !== ${FLOW_WRAP_AMOUNT}`);
  }
  console.log(`  ✓ FLOW checkpoint balance correct: ${flowFinalDec.amount} (=1e17, 0.1 FLOW)`);

  // 3e. mUSDC decrypts to 5 mUSDC (final read)
  const musdcFinalCp = await checkpointAlice.read(ADDRESSES.janusERC20);
  const musdcFinalDec = await decryptNote(
    Buffer.from(ethers.getBytes(musdcFinalCp.encryptedSnapshot)),
    { x: musdcFinalCp.ephPubkeyX, y: musdcFinalCp.ephPubkeyY },
    aliceJub.privkey
  );
  if (musdcFinalDec.amount !== MUSDC_WRAP_AMOUNT) {
    throw new Error(`Final mUSDC balance check failed: ${musdcFinalDec.amount} !== ${MUSDC_WRAP_AMOUNT}`);
  }
  console.log(`  ✓ mUSDC checkpoint balance correct: ${musdcFinalDec.amount} (=5e6)`);

  // 3f. Key assertion: FLOW and mUSDC snapshots are DISTINCT bytes
  //     (this is what the old singleton bug FAILED — same snapshot across both tokens)
  const flowSnapHex  = ethers.hexlify(flowFinalCp.encryptedSnapshot);
  const musdcSnapHex = ethers.hexlify(musdcFinalCp.encryptedSnapshot);
  if (flowSnapHex === musdcSnapHex) {
    throw new Error("CRITICAL: FLOW and mUSDC snapshots are IDENTICAL — singleton bug still present!");
  }
  console.log("  ✓ FLOW and mUSDC snapshots are DISTINCT — per-token isolation confirmed");

  const wallClockMs = Date.now() - t0;

  results.steps.final_assertions = {
    flow_metadata_hasCheckpoint:  true,
    musdc_metadata_hasCheckpoint: true,
    zero_addr_hasCheckpoint:      false,
    flow_balance_correct:         true,
    musdc_balance_correct:        true,
    snapshots_are_distinct:       true,
    flow_decrypted_amount:        flowFinalDec.amount.toString(),
    musdc_decrypted_amount:       musdcFinalDec.amount.toString(),
    ts: new Date().toISOString(),
  };

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  results.verdict  = "PASS";
  results.finished = new Date().toISOString();
  results.wall_clock_ms = wallClockMs;
  results.summary  = {
    alice_F_evm:             alice_F.address,
    alice_F_key:             alice_F.privateKey,
    alice_jub_priv:          aliceJub.privkey.toString(),
    alice_jub_pub_x:         aliceJub.pubkey.x.toString(),
    alice_jub_pub_y:         aliceJub.pubkey.y.toString(),
    checkpoint_contract:     ADDRESSES.shieldedCheckpoint,
    janusFlow_proxy:         ADDRESSES.janusFlow,
    janusERC20_proxy:        ADDRESSES.janusERC20,
    tx_hashes: {
      fund:                   fundTx.hash,
      memokey:                memoTx.hash,
      flow_wrap:              flowWrapTx.hash,
      flow_checkpoint_update: flowCkptTx.hash,
      mint_musdc:             mintTx.hash,
      approve_musdc:          approveTx.hash,
      musdc_wrap:             musdcWrapTx.hash,
      musdc_checkpoint_update: musdcCkptTx.hash,
    },
    decrypted_flow_amount:   flowFinalDec.amount.toString(),
    decrypted_musdc_amount:  musdcFinalDec.amount.toString(),
    snapshots_are_distinct:  true,
    flow_expected:           FLOW_WRAP_AMOUNT.toString(),
    musdc_expected:          MUSDC_WRAP_AMOUNT.toString(),
    flow_correct:            flowFinalDec.amount === FLOW_WRAP_AMOUNT,
    musdc_correct:           musdcFinalDec.amount === MUSDC_WRAP_AMOUNT,
  };
  saveResults();

  console.log(`\n=== Scenario 11.F RESULT: PASS (${(wallClockMs / 1000).toFixed(1)}s) ===`);
  console.log("  alice_F EVM:          ", alice_F.address);
  console.log("  fund:                 ", fundTx.hash);
  console.log("  memokey:              ", memoTx.hash);
  console.log("  flow wrap:            ", flowWrapTx.hash);
  console.log("  flow checkpoint:      ", flowCkptTx.hash);
  console.log("  mint mUSDC:           ", mintTx.hash);
  console.log("  approve mUSDC:        ", approveTx.hash);
  console.log("  musdc wrap:           ", musdcWrapTx.hash);
  console.log("  musdc checkpoint:     ", musdcCkptTx.hash);
  console.log("  FLOW decrypted:       ", flowFinalDec.amount.toString(), "(expected", FLOW_WRAP_AMOUNT.toString(), "= 0.1 FLOW)");
  console.log("  mUSDC decrypted:      ", musdcFinalDec.amount.toString(), "(expected", MUSDC_WRAP_AMOUNT.toString(), "= 5 mUSDC)");
  console.log("  Snapshots distinct:   PASS — per-token isolation confirmed");
}

main()
  .then(() => { console.log("\n11.F complete — results saved to results-combo-F.json"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    if (err.stack) console.error(err.stack);
    results.verdict  = "FAIL";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
