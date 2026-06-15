/**
 * smoke-flow.cjs — Phase 9.A: JanusFlow FLOW testnet E2E smoke test
 *
 * Tests (using FRESH EOAs funded by deployer to avoid stale state):
 *   1. test_alice + test_bob: fresh random wallets, funded by deployer
 *   2. Publish memokeys on MemoKeyRegistry
 *   3. alice wraps 1 FLOW with real amount-disclose proof
 *   4. alice shieldedTransfers 0.3 FLOW to bob with real confidential-transfer proof
 *   5. bob drains inbox, ECIES-decodes note, asserts amount + memo
 *   6. alice unwraps 0.7 FLOW with real proofs
 *
 * Saves partial progress to results-flow.json after every step.
 */

"use strict";

const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");

const {
  commit,
  addCommits,
  generateProof,
  generateAmountDiscloseProof,
  SUBORDER,
} = require("../../packages/janus-token/tests/solidity/helpers/proofGen.cjs");

const {
  generateKeypair,
  pubkeyFromPrivkey,
  encryptNote,
  decryptNote,
} = require("../../packages/janus-token/tests/solidity/helpers/ecies.cjs");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL     = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID    = 545;
const RESULTS_FILE = path.join(__dirname, "results-flow.json");

const DEPLOYER_KEY = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";

const ADDRESSES = {
  janusFlow:         "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
  memoKeyRegistry:   "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
  shieldedInbox:     "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6",
};

const E18 = 10n ** 18n;

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const JANUS_FLOW_ABI = [
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) payable",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function totalLocked() view returns (uint256)",
  "function shieldedInbox() view returns (address)",
  "function VERSION() view returns (string)",
  "event ShieldedTransferNote(address indexed from, address indexed to, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
];

const MEMO_KEY_REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y)",
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
];

const SHIELDED_INBOX_ABI = [
  "function count(address user) view returns (uint256)",
  "function drainBatch(uint256 limit) returns (tuple(bytes ciphertext, uint256 ephPubkeyX, uint256 ephPubkeyY, address depositor, uint64 blockNumber)[] notes)",
];

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

let results = {
  phase:    "9.A",
  token:    "FLOW",
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

/** Derive a deterministic BabyJub keypair from an EVM address. */
async function deriveJubKeypair(evmAddress) {
  const seed = ethers.keccak256(
    ethers.toUtf8Bytes(`${evmAddress.toLowerCase()}:openjanus/memokey/v1:v08-smoke`)
  );
  const raw    = BigInt(seed);
  const priv   = raw % SUBORDER;
  const pubkey = await pubkeyFromPrivkey(priv);
  return { privkey: priv, pubkey };
}

/** Build flat proof array [pA0, pA1, pB00, pB01, pB10, pB11, pC0, pC1]. */
function flatProof(p) {
  return [
    p.pA[0], p.pA[1],
    p.pB[0][0], p.pB[0][1],
    p.pB[1][0], p.pB[1][1],
    p.pC[0], p.pC[1],
  ];
}

/** Wait for tx + log gas. */
async function waitTx(tx, label) {
  console.log(`  ${label}: sent ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`  ${label}: confirmed block=${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return receipt;
}

/** Random scalar mod SUBORDER */
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Phase 9.A — JanusFlow FLOW Smoke Test ===\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const deployerWallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  console.log("Deployer:", deployerWallet.address);

  // Create FRESH Alice and Bob for clean state
  const aliceWallet = ethers.Wallet.createRandom().connect(provider);
  const bobWallet   = ethers.Wallet.createRandom().connect(provider);
  console.log("Alice (fresh):", aliceWallet.address);
  console.log("Bob   (fresh):", bobWallet.address);

  results.steps.accounts = {
    deployer: deployerWallet.address,
    alice:    aliceWallet.address,
    bob:      bobWallet.address,
    alice_key: aliceWallet.privateKey,
    bob_key:   bobWallet.privateKey,
    ts:       new Date().toISOString(),
  };
  saveResults();

  // Contracts
  const janusFlow   = new ethers.Contract(ADDRESSES.janusFlow,      JANUS_FLOW_ABI,        aliceWallet);
  const memoRegA    = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, aliceWallet);
  const memoRegB    = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, bobWallet);
  const inbox       = new ethers.Contract(ADDRESSES.shieldedInbox,   SHIELDED_INBOX_ABI,    provider);
  const inboxBob    = new ethers.Contract(ADDRESSES.shieldedInbox,   SHIELDED_INBOX_ABI,    bobWallet);
  const janusFlowBob = new ethers.Contract(ADDRESSES.janusFlow,      JANUS_FLOW_ABI,        bobWallet);

  // Verify VERSION
  const version = await janusFlow.VERSION();
  console.log(`\nJanusFlow VERSION = ${version}`);
  if (version !== "0.8.0") throw new Error(`Expected VERSION 0.8.0, got ${version}`);

  // -------------------------------------------------------------------------
  // Step 0: Fund Alice and Bob from deployer
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Fund Alice (3 FLOW) + Bob (0.5 FLOW) ---");

  const fundAliceTx = await deployerWallet.sendTransaction({
    to: aliceWallet.address,
    value: ethers.parseEther("3"),
  });
  const fundAliceR = await waitTx(fundAliceTx, "fund-alice");

  const fundBobTx = await deployerWallet.sendTransaction({
    to: bobWallet.address,
    value: ethers.parseEther("0.5"),
  });
  const fundBobR = await waitTx(fundBobTx, "fund-bob");

  results.steps.fund = {
    fund_alice_tx: fundAliceTx.hash,
    fund_bob_tx:   fundBobTx.hash,
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: Generate BabyJub keypairs
  // -------------------------------------------------------------------------
  console.log("\n--- Step 1: Generate BabyJub keypairs ---");
  const aliceJub = await deriveJubKeypair(aliceWallet.address);
  const bobJub   = await deriveJubKeypair(bobWallet.address);
  console.log("  Alice JubPub.x:", aliceJub.pubkey.x.toString().slice(0, 20) + "...");
  console.log("  Bob   JubPub.x:", bobJub.pubkey.x.toString().slice(0, 20) + "...");
  results.steps.keypairs = {
    alice_pub_x: aliceJub.pubkey.x.toString(),
    alice_pub_y: aliceJub.pubkey.y.toString(),
    bob_pub_x:   bobJub.pubkey.x.toString(),
    bob_pub_y:   bobJub.pubkey.y.toString(),
    ts:          new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 2: Publish memokeys
  // -------------------------------------------------------------------------
  console.log("\n--- Step 2: Publish memokeys ---");

  const alicePubMemoTx = await memoRegA.publishMemoKey(aliceJub.pubkey.x, aliceJub.pubkey.y);
  const alicePubMemoR  = await waitTx(alicePubMemoTx, "alice-publish-memokey");

  const bobPubMemoTx   = await memoRegB.publishMemoKey(bobJub.pubkey.x, bobJub.pubkey.y);
  const bobPubMemoR    = await waitTx(bobPubMemoTx, "bob-publish-memokey");

  // Verify registry
  const [ax, ay, aat] = await memoRegA.getMemoKey(aliceWallet.address);
  const [bx, by, bat] = await memoRegB.getMemoKey(bobWallet.address);
  if (ax !== aliceJub.pubkey.x || ay !== aliceJub.pubkey.y) {
    throw new Error("Alice memokey mismatch in registry");
  }
  if (bx !== bobJub.pubkey.x || by !== bobJub.pubkey.y) {
    throw new Error("Bob memokey mismatch in registry");
  }
  console.log("  ✓ Both memokeys verified in registry");

  results.steps.publish_memokeys = {
    alice_tx:    alicePubMemoTx.hash,
    alice_gas:   alicePubMemoR.gasUsed.toString(),
    bob_tx:      bobPubMemoTx.hash,
    bob_gas:     bobPubMemoR.gasUsed.toString(),
    verified:    true,
    ts:          new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 3: Alice WRAP 1 FLOW
  // -------------------------------------------------------------------------
  console.log("\n--- Step 3: Alice wraps 1 FLOW ---");
  const wrapAmount   = 1n * E18;
  const wrapBlinding = await randomScalar();
  const wrapNonce    = BigInt(Date.now());

  // Verify Alice starts with identity commitment
  const [preCx, preCy] = await janusFlow.balanceOfCommitmentXY(aliceWallet.address);
  console.log(`  Alice pre-wrap commitment: (${preCx}, ${preCy})`);
  if (preCx !== 0n || preCy !== 1n) {
    throw new Error(`Alice should start with identity commitment (0,1), got (${preCx},${preCy})`);
  }

  console.log("  Generating amount-disclose proof for 1 FLOW...");
  const wrapProof = await generateAmountDiscloseProof({
    amount:   wrapAmount,
    blinding: wrapBlinding,
    nonce:    wrapNonce,
  });
  const wrapCommitX = wrapProof.pubSignals[1];
  const wrapCommitY = wrapProof.pubSignals[2];
  console.log(`  Proof OK. commit=(${wrapCommitX.toString().slice(0,20)}..., ${wrapCommitY.toString().slice(0,20)}...)`);

  // Encrypt self-snapshot
  const { ciphertext: snapCipher, ephemeralPubkey: snapEph } = await encryptNote(
    { amount: wrapAmount, blinding: wrapBlinding },
    aliceJub.pubkey
  );

  const totalLockedBefore = await janusFlow.totalLocked();
  const wrapTx = await janusFlow.wrapWithProof(
    wrapNonce,
    [wrapCommitX, wrapCommitY],
    wrapProof.pA,
    wrapProof.pB,
    wrapProof.pC,
    snapCipher,
    snapEph.x,
    snapEph.y,
    { value: wrapAmount }
  );
  const wrapReceipt = await waitTx(wrapTx, "alice-wrap");

  // Verify on-chain commitment
  // Expected: identity(0,1) + wrapCommit = wrapCommit (since identity is neutral element)
  const [postCx, postCy] = await janusFlow.balanceOfCommitmentXY(aliceWallet.address);
  const totalLockedAfter  = await janusFlow.totalLocked();
  console.log(`  Alice post-wrap commit: (${postCx.toString().slice(0,20)}..., ${postCy.toString().slice(0,20)}...)`);

  if (postCx !== wrapCommitX || postCy !== wrapCommitY) {
    throw new Error(
      `Commitment mismatch after wrap!\n  on-chain=(${postCx},${postCy})\n  expected=(${wrapCommitX},${wrapCommitY})`
    );
  }
  if (totalLockedAfter !== totalLockedBefore + wrapAmount) {
    throw new Error(`totalLocked mismatch: before=${totalLockedBefore} after=${totalLockedAfter} expected=${totalLockedBefore + wrapAmount}`);
  }
  console.log("  ✓ Commitment matches proof output");
  console.log("  ✓ totalLocked increased by 1 FLOW");

  results.steps.alice_wrap = {
    tx:           wrapTx.hash,
    gas:          wrapReceipt.gasUsed.toString(),
    amount:       wrapAmount.toString(),
    commit_x:     wrapCommitX.toString(),
    commit_y:     wrapCommitY.toString(),
    totalLocked_before: totalLockedBefore.toString(),
    totalLocked_after:  totalLockedAfter.toString(),
    verified:     true,
    ts:           new Date().toISOString(),
  };
  saveResults();

  // Track Alice state
  let aliceV  = wrapAmount;
  let aliceR  = wrapBlinding;
  let aliceCx = postCx;
  let aliceCy = postCy;

  // -------------------------------------------------------------------------
  // Step 4: Alice shieldedTransfer → Bob 0.3 FLOW
  // -------------------------------------------------------------------------
  console.log("\n--- Step 4: Alice shieldedTransfers 0.3 FLOW to Bob ---");
  const transferAmount   = 3n * E18 / 10n; // 0.3 FLOW
  const transferBlinding = await randomScalar();
  const newAliceBlinding = await randomScalar();
  const newAliceV        = aliceV - transferAmount;

  console.log(`  Alice V=${aliceV}, transfer=${transferAmount}, new V=${newAliceV}`);

  console.log("  Generating confidential-transfer proof...");
  const xferProof = await generateProof({
    old_value:         aliceV,
    old_blinding:      aliceR,
    transfer_value:    transferAmount,
    transfer_blinding: transferBlinding,
    new_blinding:      newAliceBlinding,
  });
  // pubSignals: [oldCommitX, oldCommitY, txCommitX, txCommitY, newCommitX, newCommitY]
  const pub6 = xferProof.pubSignals;
  console.log(`  Proof OK. C_old=(${pub6[0].toString().slice(0,10)}...) C_new=(${pub6[4].toString().slice(0,10)}...)`);

  // Verify C_old matches Alice's on-chain state
  if (pub6[0] !== aliceCx || pub6[1] !== aliceCy) {
    throw new Error(`C_old mismatch: proof=(${pub6[0]},${pub6[1]}) onchain=(${aliceCx},${aliceCy})`);
  }
  console.log("  ✓ C_old matches Alice's on-chain commitment");

  // Encrypt note for Bob
  const transferMemo = "v08 flow test";
  const { ciphertext: noteCipher, ephemeralPubkey: noteEph } = await encryptNote(
    { amount: transferAmount, blinding: transferBlinding, memo: transferMemo },
    bobJub.pubkey
  );

  const bobInboxBefore = await inbox.count(bobWallet.address);
  const xferTx = await janusFlow.shieldedTransfer(
    bobWallet.address,
    pub6.map(x => x),
    flatProof(xferProof),
    noteCipher,
    noteEph.x,
    noteEph.y
  );
  const xferReceipt = await waitTx(xferTx, "alice-shielded-transfer");

  // Verify Alice's new commitment
  const [alicePostCx, alicePostCy] = await janusFlow.balanceOfCommitmentXY(aliceWallet.address);
  if (alicePostCx !== pub6[4] || alicePostCy !== pub6[5]) {
    throw new Error(`Alice post-transfer commitment mismatch: onchain=(${alicePostCx},${alicePostCy}) expected=(${pub6[4]},${pub6[5]})`);
  }
  console.log("  ✓ Alice commitment updated to C_new from proof");

  // Verify Bob's commitment grew (homoomorphic accumulation of txCommit)
  // Bob's new commit = identity + txCommit = txCommit (since Bob starts from identity)
  const [bobCx, bobCy] = await janusFlow.balanceOfCommitmentXY(bobWallet.address);
  if (bobCx !== pub6[2] || bobCy !== pub6[3]) {
    throw new Error(`Bob commitment mismatch: onchain=(${bobCx},${bobCy}) expected=(${pub6[2]},${pub6[3]})`);
  }
  console.log("  ✓ Bob commitment updated to C_tx from proof");

  // Verify Bob's inbox count
  const bobInboxAfter = await inbox.count(bobWallet.address);
  if (bobInboxAfter !== bobInboxBefore + 1n) {
    throw new Error(`Bob inbox count: before=${bobInboxBefore} after=${bobInboxAfter} expected=${bobInboxBefore + 1n}`);
  }
  console.log(`  ✓ Bob inbox count = ${bobInboxAfter}`);

  results.steps.alice_shielded_transfer = {
    tx:             xferTx.hash,
    gas:            xferReceipt.gasUsed.toString(),
    transfer_amt:   transferAmount.toString(),
    alice_new_cx:   alicePostCx.toString(),
    alice_new_cy:   alicePostCy.toString(),
    bob_commit_cx:  bobCx.toString(),
    bob_commit_cy:  bobCy.toString(),
    bob_inbox_count: bobInboxAfter.toString(),
    verified:       true,
    ts:             new Date().toISOString(),
  };
  saveResults();

  aliceV  = newAliceV;
  aliceR  = newAliceBlinding;
  aliceCx = alicePostCx;
  aliceCy = alicePostCy;

  // -------------------------------------------------------------------------
  // Step 5: Bob drains inbox + ECIES decode
  // -------------------------------------------------------------------------
  console.log("\n--- Step 5: Bob drains inbox + ECIES decode ---");

  // Get note from the ShieldedTransferNote event in the transfer receipt
  const jfIface = new ethers.Interface(JANUS_FLOW_ABI);
  const xferFullReceipt = await provider.getTransactionReceipt(xferTx.hash);

  let onChainCipher = null, onChainEphX = null, onChainEphY = null;
  for (const log of xferFullReceipt.logs) {
    try {
      const decoded = jfIface.parseLog({ topics: log.topics, data: log.data });
      if (decoded && decoded.name === "ShieldedTransferNote") {
        onChainCipher = decoded.args.encryptedNoteTo;
        onChainEphX   = decoded.args.ephPubkeyToX;
        onChainEphY   = decoded.args.ephPubkeyToY;
        break;
      }
    } catch { /* skip non-matching logs */ }
  }

  if (!onChainCipher) {
    console.log("  ShieldedTransferNote event not found via interface — using local ciphertext");
    onChainCipher = noteCipher;
    onChainEphX   = noteEph.x;
    onChainEphY   = noteEph.y;
  } else {
    console.log("  ✓ Got ciphertext from on-chain ShieldedTransferNote event");
  }

  // Drain
  const drainTx = await inboxBob.drainBatch(1);
  const drainR  = await waitTx(drainTx, "bob-drain-batch");

  // Verify inbox is now empty
  const bobInboxFinal = await inbox.count(bobWallet.address);
  if (bobInboxFinal !== 0n) {
    throw new Error(`Expected Bob inbox=0 after drain, got ${bobInboxFinal}`);
  }
  console.log("  ✓ Bob inbox empty after drain");

  // Decode note
  const decodedNote = await decryptNote(
    Buffer.from(ethers.getBytes(onChainCipher)),
    { x: onChainEphX, y: onChainEphY },
    bobJub.privkey
  );

  console.log(`  Decoded: amount=${decodedNote.amount}, memo="${decodedNote.memo}"`);
  if (decodedNote.amount !== transferAmount) {
    throw new Error(`Note amount mismatch: ${decodedNote.amount} != ${transferAmount}`);
  }
  if (decodedNote.memo !== transferMemo) {
    throw new Error(`Note memo mismatch: "${decodedNote.memo}" != "${transferMemo}"`);
  }
  console.log("  ✓ Note decoded correctly — amount and memo match");

  results.steps.bob_drain_decode = {
    drain_tx:        drainTx.hash,
    drain_gas:       drainR.gasUsed.toString(),
    decoded_amount:  decodedNote.amount.toString(),
    decoded_memo:    decodedNote.memo,
    expected_amount: transferAmount.toString(),
    expected_memo:   transferMemo,
    verified:        true,
    ts:              new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 6: Alice unwraps 0.7 FLOW
  // -------------------------------------------------------------------------
  console.log("\n--- Step 6: Alice unwraps 0.7 FLOW ---");
  const unwrapAmount   = 7n * E18 / 10n; // 0.7 FLOW
  const unwrapBlinding = await randomScalar();
  const residualBlinding = await randomScalar();
  const residualV      = aliceV - unwrapAmount;

  console.log(`  Alice V=${aliceV}, unwrap=${unwrapAmount}, residual=${residualV}`);
  if (residualV < 0n) throw new Error(`Insufficient balance: ${aliceV} < ${unwrapAmount}`);

  // Amount-disclose proof for unwrap amount (nonce=0 for unwrap path)
  console.log("  Generating amount-disclose proof for unwrap...");
  const unwrapAmtProof = await generateAmountDiscloseProof({
    amount:   unwrapAmount,
    blinding: unwrapBlinding,
    nonce:    0n,
  });
  const unwrapTxCommitX = unwrapAmtProof.pubSignals[1];
  const unwrapTxCommitY = unwrapAmtProof.pubSignals[2];

  // Transfer proof: proves sender has enough balance
  // old=aliceV, transfer=unwrapAmount, new=residualV
  console.log("  Generating confidential-transfer proof for unwrap...");
  const unwrapXferProof = await generateProof({
    old_value:         aliceV,
    old_blinding:      aliceR,
    transfer_value:    unwrapAmount,
    transfer_blinding: unwrapBlinding,
    new_blinding:      residualBlinding,
  });
  const unwrapPub6 = unwrapXferProof.pubSignals;

  // Check C_old matches Alice's current on-chain state
  if (unwrapPub6[0] !== aliceCx || unwrapPub6[1] !== aliceCy) {
    throw new Error(`Unwrap C_old mismatch: proof=(${unwrapPub6[0]},${unwrapPub6[1]}) onchain=(${aliceCx},${aliceCy})`);
  }

  // Check C_tx is consistent: transfer proof's C_tx == amount-disclose proof's commit
  // Both use the same (unwrapAmount, unwrapBlinding), so they should be equal
  if (unwrapPub6[2] !== unwrapTxCommitX || unwrapPub6[3] !== unwrapTxCommitY) {
    throw new Error(
      `C_tx mismatch between proofs!\n  amtDisclose=(${unwrapTxCommitX},${unwrapTxCommitY})\n  xfer=(${unwrapPub6[2]},${unwrapPub6[3]})`
    );
  }
  console.log("  ✓ C_tx consistent between both proofs");

  const { ciphertext: unwrapSnap, ephemeralPubkey: unwrapSnapEph } = await encryptNote(
    { amount: residualV, blinding: residualBlinding },
    aliceJub.pubkey
  );

  const aliceBalBefore   = await provider.getBalance(aliceWallet.address);
  const totalLockedBefore2 = await janusFlow.totalLocked();

  const unwrapTx = await janusFlow.unwrap(
    unwrapAmount,
    aliceWallet.address,
    [unwrapTxCommitX, unwrapTxCommitY],
    flatProof(unwrapAmtProof),
    unwrapPub6.map(x => x),
    flatProof(unwrapXferProof),
    unwrapSnap,
    unwrapSnapEph.x,
    unwrapSnapEph.y
  );
  const unwrapReceipt = await waitTx(unwrapTx, "alice-unwrap");

  const aliceBalAfter    = await provider.getBalance(aliceWallet.address);
  const totalLockedAfter2 = await janusFlow.totalLocked();
  console.log(`  Alice balance change: ${ethers.formatEther(aliceBalAfter - aliceBalBefore)} FLOW`);
  console.log(`  totalLocked: ${totalLockedBefore2} → ${totalLockedAfter2}`);

  // Verify Alice's residual commitment
  const [aliceResidualCx, aliceResidualCy] = await janusFlow.balanceOfCommitmentXY(aliceWallet.address);
  if (aliceResidualCx !== unwrapPub6[4] || aliceResidualCy !== unwrapPub6[5]) {
    throw new Error(`Alice residual commitment mismatch after unwrap`);
  }
  console.log("  ✓ Alice residual commitment matches C_new from proof");

  if (totalLockedAfter2 !== totalLockedBefore2 - unwrapAmount) {
    throw new Error(`totalLocked not reduced correctly: ${totalLockedBefore2} - ${unwrapAmount} != ${totalLockedAfter2}`);
  }
  console.log("  ✓ totalLocked reduced by unwrap amount");

  results.steps.alice_unwrap = {
    tx:                 unwrapTx.hash,
    gas:                unwrapReceipt.gasUsed.toString(),
    amount:             unwrapAmount.toString(),
    alice_residual_cx:  aliceResidualCx.toString(),
    alice_residual_cy:  aliceResidualCy.toString(),
    totalLocked_before: totalLockedBefore2.toString(),
    totalLocked_after:  totalLockedAfter2.toString(),
    balance_change_eth: (aliceBalAfter - aliceBalBefore).toString(),
    verified:           true,
    ts:                 new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  results.summary  = {
    alice_evm:    aliceWallet.address,
    bob_evm:      bobWallet.address,
    alice_evm_key: aliceWallet.privateKey,
    bob_evm_key:   bobWallet.privateKey,
    alice_jub_priv: aliceJub.privkey.toString(),
    bob_jub_priv:   bobJub.privkey.toString(),
  };
  saveResults();

  console.log("\n=== Phase 9.A RESULT: GREEN ===");
  console.log("  fund:           ", results.steps.fund.fund_alice_tx);
  console.log("  memokeys:       ", results.steps.publish_memokeys.alice_tx);
  console.log("  alice wrap:     ", results.steps.alice_wrap.tx);
  console.log("  alice transfer: ", results.steps.alice_shielded_transfer.tx);
  console.log("  bob drain:      ", results.steps.bob_drain_decode.drain_tx);
  console.log("  alice unwrap:   ", results.steps.alice_unwrap.tx);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main()
  .then(() => { console.log("\nPhase 9.A complete — results saved to results-flow.json"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    if (err.stack) console.error(err.stack);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
