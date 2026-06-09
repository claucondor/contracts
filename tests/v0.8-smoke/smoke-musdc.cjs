/**
 * smoke-musdc.cjs — Phase 9.B: JanusERC20 mUSDC testnet E2E smoke test
 *
 * Tests (using fresh EOAs funded by deployer):
 *   1. Fresh alice2 + bob2, funded with FLOW gas money
 *   2. Mint 1000 mUSDC to alice2 (permissionless)
 *   3. Publish memokeys for alice2 + bob2
 *   4. alice2 approves JanusERC20 to spend mUSDC
 *   5. alice2 wraps 100 mUSDC with real amount-disclose proof
 *   6. alice2 shieldedTransfers 30 mUSDC to bob2
 *   7. bob2 drains inbox + ECIES decode, asserts amount=30 + memo
 *   8. alice2 unwraps 70 mUSDC
 *
 * Saves partial progress to results-musdc.json after every step.
 */

"use strict";

const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");

const {
  generateProof,
  generateAmountDiscloseProof,
  SUBORDER,
} = require("../../packages/janus-token/tests/solidity/helpers/proofGen.cjs");

const {
  pubkeyFromPrivkey,
  encryptNote,
  decryptNote,
} = require("../../packages/janus-token/tests/solidity/helpers/ecies.cjs");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL      = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID     = 545;
const RESULTS_FILE = path.join(__dirname, "results-musdc.json");

const DEPLOYER_KEY = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";

const ADDRESSES = {
  janusERC20:      "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
  mockUSDC:        "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
  memoKeyRegistry: "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
  shieldedInbox:   "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6",
};

// MockUSDC has 6 decimals
const E6 = 10n ** 6n;

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const JANUS_ERC20_ABI = [
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function totalLocked() view returns (uint256)",
  "function shieldedInbox() view returns (address)",
  "function underlying() view returns (address)",
  "function VERSION() view returns (string)",
  "event ShieldedTransferNote(address indexed from, address indexed to, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
];

const MOCK_USDC_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
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
  phase:    "9.B",
  token:    "mUSDC",
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

async function deriveJubKeypair(evmAddress) {
  const seed = ethers.keccak256(
    ethers.toUtf8Bytes(`${evmAddress.toLowerCase()}:openjanus/memokey/v1:v08-smoke`)
  );
  const raw    = BigInt(seed);
  const priv   = raw % SUBORDER;
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Phase 9.B — JanusERC20 mUSDC Smoke Test ===\n");

  const provider       = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const deployerWallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  console.log("Deployer:", deployerWallet.address);

  const alice2 = ethers.Wallet.createRandom().connect(provider);
  const bob2   = ethers.Wallet.createRandom().connect(provider);
  console.log("Alice2 (fresh):", alice2.address);
  console.log("Bob2   (fresh):", bob2.address);

  results.steps.accounts = {
    deployer:  deployerWallet.address,
    alice2:    alice2.address,
    bob2:      bob2.address,
    alice2_key: alice2.privateKey,
    bob2_key:   bob2.privateKey,
    ts:        new Date().toISOString(),
  };
  saveResults();

  // Contracts
  const erc20A     = new ethers.Contract(ADDRESSES.janusERC20,      JANUS_ERC20_ABI,       alice2);
  const erc20B     = new ethers.Contract(ADDRESSES.janusERC20,      JANUS_ERC20_ABI,       bob2);
  const usdcA      = new ethers.Contract(ADDRESSES.mockUSDC,         MOCK_USDC_ABI,         alice2);
  const usdcDep    = new ethers.Contract(ADDRESSES.mockUSDC,         MOCK_USDC_ABI,         deployerWallet);
  const memoRegA   = new ethers.Contract(ADDRESSES.memoKeyRegistry,  MEMO_KEY_REGISTRY_ABI, alice2);
  const memoRegB   = new ethers.Contract(ADDRESSES.memoKeyRegistry,  MEMO_KEY_REGISTRY_ABI, bob2);
  const inbox      = new ethers.Contract(ADDRESSES.shieldedInbox,    SHIELDED_INBOX_ABI,    provider);
  const inboxBob   = new ethers.Contract(ADDRESSES.shieldedInbox,    SHIELDED_INBOX_ABI,    bob2);

  // Verify contracts
  const version   = await erc20A.VERSION();
  const inboxAddr = await erc20A.shieldedInbox();
  const underlying = await erc20A.underlying();
  console.log(`JanusERC20 VERSION = ${version}`);
  if (version !== "0.8.0") throw new Error(`Expected VERSION 0.8.0, got ${version}`);
  if (inboxAddr.toLowerCase() !== ADDRESSES.shieldedInbox.toLowerCase()) {
    throw new Error(`ShieldedInbox mismatch: ${inboxAddr}`);
  }
  if (underlying.toLowerCase() !== ADDRESSES.mockUSDC.toLowerCase()) {
    throw new Error(`Underlying mismatch: ${underlying}`);
  }
  console.log("  ✓ Contract wiring verified");

  // -------------------------------------------------------------------------
  // Step 0: Fund alice2 + bob2 with FLOW for gas
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Fund Alice2 + Bob2 with FLOW for gas ---");

  const fundA2Tx = await deployerWallet.sendTransaction({
    to: alice2.address,
    value: ethers.parseEther("0.2"),
  });
  const fundA2R = await waitTx(fundA2Tx, "fund-alice2");

  const fundB2Tx = await deployerWallet.sendTransaction({
    to: bob2.address,
    value: ethers.parseEther("0.15"),
  });
  const fundB2R = await waitTx(fundB2Tx, "fund-bob2");

  results.steps.fund = {
    fund_alice2_tx: fundA2Tx.hash,
    fund_bob2_tx:   fundB2Tx.hash,
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: Mint mUSDC to Alice2 (permissionless)
  // -------------------------------------------------------------------------
  console.log("\n--- Step 1: Mint 1000 mUSDC to Alice2 ---");
  const mintAmount = 1000n * E6; // 1000 mUSDC
  const mintTx = await usdcDep.mint(alice2.address, mintAmount);
  const mintR  = await waitTx(mintTx, "mint-musdc");

  const alice2Balance = await usdcA.balanceOf(alice2.address);
  console.log(`  Alice2 mUSDC balance: ${alice2Balance.toString()} (${Number(alice2Balance) / 1e6} mUSDC)`);
  if (alice2Balance < mintAmount) throw new Error(`Mint failed: got ${alice2Balance}`);
  console.log("  ✓ 1000 mUSDC minted to Alice2");

  results.steps.mint_musdc = {
    tx:      mintTx.hash,
    gas:     mintR.gasUsed.toString(),
    amount:  mintAmount.toString(),
    balance: alice2Balance.toString(),
    ts:      new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 2: Generate BabyJub keypairs + publish memokeys
  // -------------------------------------------------------------------------
  console.log("\n--- Step 2: Generate keypairs + publish memokeys ---");
  const alice2Jub = await deriveJubKeypair(alice2.address);
  const bob2Jub   = await deriveJubKeypair(bob2.address);

  const aTx = await memoRegA.publishMemoKey(alice2Jub.pubkey.x, alice2Jub.pubkey.y);
  const aR  = await waitTx(aTx, "alice2-publish-memokey");

  const bTx = await memoRegB.publishMemoKey(bob2Jub.pubkey.x, bob2Jub.pubkey.y);
  const bR  = await waitTx(bTx, "bob2-publish-memokey");

  // Verify
  const [ax, ay] = await memoRegA.getMemoKey(alice2.address);
  const [bx, by] = await memoRegB.getMemoKey(bob2.address);
  if (ax !== alice2Jub.pubkey.x || ay !== alice2Jub.pubkey.y) throw new Error("Alice2 memokey mismatch");
  if (bx !== bob2Jub.pubkey.x   || by !== bob2Jub.pubkey.y  ) throw new Error("Bob2 memokey mismatch");
  console.log("  ✓ Both memokeys verified in registry");

  results.steps.memokeys = {
    alice2_tx: aTx.hash,
    alice2_gas: aR.gasUsed.toString(),
    bob2_tx:   bTx.hash,
    bob2_gas:  bR.gasUsed.toString(),
    verified:  true,
    ts:        new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 3: Alice2 approves JanusERC20 + wrap 100 mUSDC
  // -------------------------------------------------------------------------
  console.log("\n--- Step 3: Alice2 approves + wraps 100 mUSDC ---");
  const wrapAmount   = 100n * E6; // 100 mUSDC
  const wrapBlinding = await randomScalar();
  const wrapNonce    = BigInt(Date.now());

  // Approve first
  const approveTx = await usdcA.approve(ADDRESSES.janusERC20, wrapAmount);
  const approveR  = await waitTx(approveTx, "alice2-approve");

  const allowance = await usdcA.allowance(alice2.address, ADDRESSES.janusERC20);
  if (allowance < wrapAmount) throw new Error(`Allowance insufficient: ${allowance}`);
  console.log("  ✓ Allowance set");

  // Verify pre-wrap commitment is identity
  const [preCx, preCy] = await erc20A.balanceOfCommitmentXY(alice2.address);
  if (preCx !== 0n || preCy !== 1n) throw new Error(`Alice2 should start with identity (0,1), got (${preCx},${preCy})`);

  console.log("  Generating amount-disclose proof for 100 mUSDC...");
  const wrapProof = await generateAmountDiscloseProof({
    amount:   wrapAmount,
    blinding: wrapBlinding,
    nonce:    wrapNonce,
  });
  const wrapCX = wrapProof.pubSignals[1];
  const wrapCY = wrapProof.pubSignals[2];

  const { ciphertext: snapCipher, ephemeralPubkey: snapEph } = await encryptNote(
    { amount: wrapAmount, blinding: wrapBlinding },
    alice2Jub.pubkey
  );

  const totalLockedBefore = await erc20A.totalLocked();
  const wrapTx = await erc20A.wrapWithProof(
    wrapAmount,
    wrapNonce,
    [wrapCX, wrapCY],
    wrapProof.pA,
    wrapProof.pB,
    wrapProof.pC,
    snapCipher,
    snapEph.x,
    snapEph.y
  );
  const wrapR = await waitTx(wrapTx, "alice2-wrap");

  // Verify commitment
  const [postCx, postCy] = await erc20A.balanceOfCommitmentXY(alice2.address);
  if (postCx !== wrapCX || postCy !== wrapCY) {
    throw new Error(`Commitment mismatch after wrap: on-chain=(${postCx},${postCy}) expected=(${wrapCX},${wrapCY})`);
  }

  const totalLockedAfter = await erc20A.totalLocked();
  if (totalLockedAfter !== totalLockedBefore + wrapAmount) {
    throw new Error(`totalLocked mismatch: ${totalLockedBefore} + ${wrapAmount} != ${totalLockedAfter}`);
  }

  // Verify Alice2's mUSDC balance decreased
  const alice2BalAfterWrap = await usdcA.balanceOf(alice2.address);
  if (alice2BalAfterWrap !== mintAmount - wrapAmount) {
    throw new Error(`Alice2 mUSDC balance after wrap: ${alice2BalAfterWrap}, expected ${mintAmount - wrapAmount}`);
  }
  console.log(`  ✓ Commitment matches proof output`);
  console.log(`  ✓ totalLocked increased by 100 mUSDC`);
  console.log(`  ✓ Alice2 mUSDC balance = ${alice2BalAfterWrap} (${Number(alice2BalAfterWrap) / 1e6} mUSDC)`);

  results.steps.alice2_wrap = {
    approve_tx: approveTx.hash,
    tx:         wrapTx.hash,
    gas:        wrapR.gasUsed.toString(),
    amount:     wrapAmount.toString(),
    commit_x:   wrapCX.toString(),
    commit_y:   wrapCY.toString(),
    totalLocked_before: totalLockedBefore.toString(),
    totalLocked_after:  totalLockedAfter.toString(),
    verified:   true,
    ts:         new Date().toISOString(),
  };
  saveResults();

  let aliceV  = wrapAmount;
  let aliceR  = wrapBlinding;
  let aliceCx = postCx;
  let aliceCy = postCy;

  // -------------------------------------------------------------------------
  // Step 4: Alice2 shieldedTransfer → Bob2 30 mUSDC
  // -------------------------------------------------------------------------
  console.log("\n--- Step 4: Alice2 shieldedTransfers 30 mUSDC to Bob2 ---");
  const transferAmount   = 30n * E6;
  const transferBlinding = await randomScalar();
  const newAliceBlinding = await randomScalar();
  const newAliceV        = aliceV - transferAmount;

  console.log(`  Alice2 V=${aliceV}, transfer=${transferAmount}, new V=${newAliceV}`);

  console.log("  Generating confidential-transfer proof...");
  const xferProof = await generateProof({
    old_value:         aliceV,
    old_blinding:      aliceR,
    transfer_value:    transferAmount,
    transfer_blinding: transferBlinding,
    new_blinding:      newAliceBlinding,
  });
  const pub6 = xferProof.pubSignals;

  if (pub6[0] !== aliceCx || pub6[1] !== aliceCy) {
    throw new Error(`C_old mismatch: proof=(${pub6[0]},${pub6[1]}) onchain=(${aliceCx},${aliceCy})`);
  }
  console.log("  ✓ C_old matches Alice2's on-chain commitment");

  const transferMemo = "v08 musdc test";
  const { ciphertext: noteCipher, ephemeralPubkey: noteEph } = await encryptNote(
    { amount: transferAmount, blinding: transferBlinding, memo: transferMemo },
    bob2Jub.pubkey
  );

  const xferTx = await erc20A.shieldedTransfer(
    bob2.address,
    pub6.map(x => x),
    flatProof(xferProof),
    noteCipher,
    noteEph.x,
    noteEph.y
  );
  const xferR = await waitTx(xferTx, "alice2-shielded-transfer");

  // Verify Alice2 commitment
  const [a2PostCx, a2PostCy] = await erc20A.balanceOfCommitmentXY(alice2.address);
  if (a2PostCx !== pub6[4] || a2PostCy !== pub6[5]) {
    throw new Error(`Alice2 post-transfer commitment mismatch`);
  }
  console.log("  ✓ Alice2 commitment updated to C_new");

  // Verify Bob2 commitment
  const [b2Cx, b2Cy] = await erc20B.balanceOfCommitmentXY(bob2.address);
  if (b2Cx !== pub6[2] || b2Cy !== pub6[3]) {
    throw new Error(`Bob2 commitment mismatch: onchain=(${b2Cx},${b2Cy}) expected=(${pub6[2]},${pub6[3]})`);
  }
  console.log("  ✓ Bob2 commitment updated to C_tx");

  const bob2InboxCount = await inbox.count(bob2.address);
  if (bob2InboxCount !== 1n) throw new Error(`Bob2 inbox count: ${bob2InboxCount} != 1`);
  console.log(`  ✓ Bob2 inbox count = 1`);

  results.steps.alice2_shielded_transfer = {
    tx:           xferTx.hash,
    gas:          xferR.gasUsed.toString(),
    transfer_amt: transferAmount.toString(),
    alice2_new_cx: a2PostCx.toString(),
    alice2_new_cy: a2PostCy.toString(),
    bob2_inbox_count: bob2InboxCount.toString(),
    verified:     true,
    ts:           new Date().toISOString(),
  };
  saveResults();

  aliceV  = newAliceV;
  aliceR  = newAliceBlinding;
  aliceCx = a2PostCx;
  aliceCy = a2PostCy;

  // -------------------------------------------------------------------------
  // Step 5: Bob2 drain + decode
  // -------------------------------------------------------------------------
  console.log("\n--- Step 5: Bob2 drains inbox + ECIES decode ---");

  // Get ciphertext from event
  const erc20Iface = new ethers.Interface(JANUS_ERC20_ABI);
  const xferFullReceipt = await provider.getTransactionReceipt(xferTx.hash);

  let onChainCipher = null, onChainEphX = null, onChainEphY = null;
  for (const log of xferFullReceipt.logs) {
    try {
      const decoded = erc20Iface.parseLog({ topics: log.topics, data: log.data });
      if (decoded && decoded.name === "ShieldedTransferNote") {
        onChainCipher = decoded.args.encryptedNoteTo;
        onChainEphX   = decoded.args.ephPubkeyToX;
        onChainEphY   = decoded.args.ephPubkeyToY;
        break;
      }
    } catch { /* skip */ }
  }

  if (!onChainCipher) {
    console.log("  ShieldedTransferNote not found in logs — using local ciphertext");
    onChainCipher = noteCipher;
    onChainEphX   = noteEph.x;
    onChainEphY   = noteEph.y;
  } else {
    console.log("  ✓ Got ciphertext from on-chain ShieldedTransferNote event");
  }

  const drainTx = await inboxBob.drainBatch(1);
  const drainR  = await waitTx(drainTx, "bob2-drain-batch");

  const bob2InboxFinal = await inbox.count(bob2.address);
  if (bob2InboxFinal !== 0n) throw new Error(`Bob2 inbox not empty after drain: ${bob2InboxFinal}`);
  console.log("  ✓ Bob2 inbox empty after drain");

  const decodedNote = await decryptNote(
    Buffer.from(ethers.getBytes(onChainCipher)),
    { x: onChainEphX, y: onChainEphY },
    bob2Jub.privkey
  );

  console.log(`  Decoded: amount=${decodedNote.amount}, memo="${decodedNote.memo}"`);
  if (decodedNote.amount !== transferAmount) {
    throw new Error(`Note amount mismatch: ${decodedNote.amount} != ${transferAmount}`);
  }
  if (decodedNote.memo !== transferMemo) {
    throw new Error(`Note memo mismatch: "${decodedNote.memo}" != "${transferMemo}"`);
  }
  console.log("  ✓ Note decoded correctly — amount and memo match");

  results.steps.bob2_drain_decode = {
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
  // Step 6: Alice2 unwraps 70 mUSDC
  // -------------------------------------------------------------------------
  console.log("\n--- Step 6: Alice2 unwraps 70 mUSDC ---");
  const unwrapAmount     = 70n * E6;
  const unwrapBlinding   = await randomScalar();
  const residualBlinding = await randomScalar();
  const residualV        = aliceV - unwrapAmount;

  console.log(`  Alice2 V=${aliceV}, unwrap=${unwrapAmount}, residual=${residualV}`);
  if (residualV < 0n) throw new Error(`Insufficient balance`);

  console.log("  Generating amount-disclose proof for unwrap...");
  const unwrapAmtProof = await generateAmountDiscloseProof({
    amount:   unwrapAmount,
    blinding: unwrapBlinding,
    nonce:    0n,
  });
  const unwrapCX = unwrapAmtProof.pubSignals[1];
  const unwrapCY = unwrapAmtProof.pubSignals[2];

  console.log("  Generating confidential-transfer proof for unwrap...");
  const unwrapXferProof = await generateProof({
    old_value:         aliceV,
    old_blinding:      aliceR,
    transfer_value:    unwrapAmount,
    transfer_blinding: unwrapBlinding,
    new_blinding:      residualBlinding,
  });
  const unwrapPub6 = unwrapXferProof.pubSignals;

  if (unwrapPub6[0] !== aliceCx || unwrapPub6[1] !== aliceCy) {
    throw new Error(`Unwrap C_old mismatch`);
  }
  if (unwrapPub6[2] !== unwrapCX || unwrapPub6[3] !== unwrapCY) {
    throw new Error(`C_tx mismatch between proofs`);
  }
  console.log("  ✓ C_tx consistent between proofs");

  const { ciphertext: unwrapSnap, ephemeralPubkey: unwrapSnapEph } = await encryptNote(
    { amount: residualV, blinding: residualBlinding },
    alice2Jub.pubkey
  );

  const alice2BalBefore     = await usdcA.balanceOf(alice2.address);
  const totalLockedBefore3  = await erc20A.totalLocked();

  const unwrapTx = await erc20A.unwrap(
    unwrapAmount,
    alice2.address,
    [unwrapCX, unwrapCY],
    flatProof(unwrapAmtProof),
    unwrapPub6.map(x => x),
    flatProof(unwrapXferProof),
    unwrapSnap,
    unwrapSnapEph.x,
    unwrapSnapEph.y
  );
  const unwrapR = await waitTx(unwrapTx, "alice2-unwrap");

  const alice2BalAfter     = await usdcA.balanceOf(alice2.address);
  const totalLockedAfter3  = await erc20A.totalLocked();

  console.log(`  Alice2 mUSDC change: ${alice2BalAfter - alice2BalBefore} (expected ${unwrapAmount})`);
  if (alice2BalAfter - alice2BalBefore !== unwrapAmount) {
    throw new Error(`mUSDC balance didn't increase by ${unwrapAmount}, change = ${alice2BalAfter - alice2BalBefore}`);
  }
  console.log("  ✓ Alice2 received mUSDC back");

  if (totalLockedAfter3 !== totalLockedBefore3 - unwrapAmount) {
    throw new Error(`totalLocked not reduced correctly`);
  }
  console.log("  ✓ totalLocked reduced by unwrap amount");

  const [alice2ResCx, alice2ResCy] = await erc20A.balanceOfCommitmentXY(alice2.address);
  if (alice2ResCx !== unwrapPub6[4] || alice2ResCy !== unwrapPub6[5]) {
    throw new Error(`Alice2 residual commitment mismatch after unwrap`);
  }
  console.log("  ✓ Alice2 residual commitment matches C_new from proof");

  results.steps.alice2_unwrap = {
    tx:                 unwrapTx.hash,
    gas:                unwrapR.gasUsed.toString(),
    amount:             unwrapAmount.toString(),
    alice2_bal_change:  (alice2BalAfter - alice2BalBefore).toString(),
    alice2_residual_cx: alice2ResCx.toString(),
    alice2_residual_cy: alice2ResCy.toString(),
    totalLocked_before: totalLockedBefore3.toString(),
    totalLocked_after:  totalLockedAfter3.toString(),
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
    alice2_evm:    alice2.address,
    bob2_evm:      bob2.address,
    alice2_evm_key: alice2.privateKey,
    bob2_evm_key:   bob2.privateKey,
  };
  saveResults();

  console.log("\n=== Phase 9.B RESULT: GREEN ===");
  console.log("  mint:           ", results.steps.mint_musdc.tx);
  console.log("  memokeys:       ", results.steps.memokeys.alice2_tx);
  console.log("  alice2 wrap:    ", results.steps.alice2_wrap.tx);
  console.log("  alice2 transfer:", results.steps.alice2_shielded_transfer.tx);
  console.log("  bob2 drain:     ", results.steps.bob2_drain_decode.drain_tx);
  console.log("  alice2 unwrap:  ", results.steps.alice2_unwrap.tx);
}

main()
  .then(() => { console.log("\nPhase 9.B complete — results saved to results-musdc.json"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    if (err.stack) console.error(err.stack);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
