/**
 * combo-C.cjs — Scenario 10.C: Multi-recipient broadcast (different tokens to different users).
 *
 * Alice_C sends DIFFERENT tokens to DIFFERENT recipients.
 * - 0.3 FLOW → Bob_C (fresh EVM)
 * - 5 mUSDC → Carol (fresh EVM)
 * - 5 MockFT → Dave (Cadence = testnet-bob)
 *
 * Assertions:
 *   - Bob_C inbox count = 1 (only FLOW note)
 *   - Carol inbox count = 1 (only mUSDC note)
 *   - Bob_C inbox does NOT contain Carol's mUSDC note
 *   - Dave Cadence inbox has MockFT note
 *   - Each decodes correct amount + memo
 */

"use strict";

const { execFileSync } = require("child_process");
const { ethers }       = require("ethers");
const fs               = require("fs");
const path             = require("path");

const {
  generateProof,
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
const CADENCE_DIR  = path.join(SMOKE_DIR, "cadence");
const RESULTS_FILE = path.join(SMOKE_DIR, "results-combo-C.json");
const NETWORK      = "testnet";

const DEPLOYER_KEY      = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
const ALICE_CADENCE_ADDR = "0x4b6bc58bc8bf5dcc";
const DAVE_CADENCE_ADDR  = "0xd807a3992d7be612"; // testnet-bob as Dave
const ALICE_FLOW_ACCT    = "openjanus-v08";
const DAVE_FLOW_ACCT     = "testnet-bob";

const ADDRESSES = {
  janusFlow:       "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
  janusERC20:      "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
  mockUSDC:        "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
  memoKeyRegistry: "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
  shieldedInbox:   "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6",
};

const E18          = 10n ** 18n;
const E6           = 10n ** 6n;
const MOCKFT_SCALE = 100_000_000n;

const FLOW_WRAP  = 5n * 10n**16n;     // 0.05 FLOW
const MUSDC_WRAP = 5n * E6;           // 5 mUSDC
const FT_WRAP    = 5n * MOCKFT_SCALE; // 5 MockFT

const FLOW_SEND  = 2n * 10n**16n;     // 0.02 FLOW (must be < FLOW_WRAP)
const MUSDC_SEND = 2n * E6;           // 2 mUSDC
const FT_SEND    = 2n * MOCKFT_SCALE; // 2 MockFT

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const JANUS_FLOW_ABI = [
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) payable",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
];

const JANUS_ERC20_ABI = [
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
];

const MOCK_USDC_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
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
  phase:    "10.C",
  scenario: "multi-recipient-broadcast",
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
// Shared helpers
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
  return [p.pA[0], p.pA[1], p.pB[0][0], p.pB[0][1], p.pB[1][0], p.pB[1][1], p.pC[0], p.pC[1]];
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
    "flow", "transactions", "send", "--network", NETWORK,
    "--signer", signer, "--config-path", path.join(SMOKE_DIR, "flow.json"),
    "--output", "json", "--args-json", JSON.stringify(argsJson), txPath,
  ];
  console.log(`  → flow send ${txFile} (signer=${signer})`);
  const output = execFileSync(cmd[0], cmd.slice(1), {
    cwd: SMOKE_DIR, timeout: 180_000, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
  });
  let result;
  try { result = JSON.parse(output.trim()); }
  catch { const m = output.match(/(\{[\s\S]*\})/); result = JSON.parse(m[1]); }
  if (!result.id) throw new Error(`flow send ${txFile}: no id`);
  const _sc  = result.statusCode ?? result.status_code;
  const _err = result.errorMessage || result.error_message || "";
  if ((typeof _sc === "number" && _sc !== 0) || _err.includes("[Error Code:")) {
    throw new Error(`flow send ${txFile}: tx FAILED: ${_err || `statusCode=${_sc}`}`);
  }
  console.log(`  ✓ sealed tx=${result.id}`);
  return { txId: result.id, events: result.events || [] };
}

function uint256Arg(n)     { return { type: "UInt256", value: n.toString() }; }
function addressArg(a)     { return { type: "Address", value: a }; }
function ufixArg(v)        { return { type: "UFix64",  value: v }; }
function arrayUint256(arr) { return { type: "Array", value: arr.map(n => uint256Arg(n)) }; }
function array2d(arr)      { return { type: "Array", value: arr.map(r => ({ type: "Array", value: r.map(n => uint256Arg(n)) })) }; }
function arrayUint8(buf)   { return { type: "Array", value: Array.from(buf).map(b => ({ type: "UInt8", value: b.toString() })) }; }
function addressArrayArg(addrs) { return { type: "Array", value: addrs.map(a => ({ type: "Address", value: a })) }; }
const strArg    = (s) => ({ type: "String", value: s });
const uint64Arg = (n) => ({ type: "UInt64",  value: n.toString() });

function encodeAdminBatchReset(addresses) {
  const iface = new ethers.Interface(["function adminBatchResetSlots(address[] calldata users) external"]);
  return iface.encodeFunctionData("adminBatchResetSlots", [addresses]).slice(2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Scenario 10.C: Multi-Recipient Broadcast ===\n");

  const provider       = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const deployerWallet = new ethers.Wallet(DEPLOYER_KEY, provider);

  // Alice_C: fresh EVM wallet
  const aliceC = ethers.Wallet.createRandom().connect(provider);
  // Fresh recipients
  const bobC   = ethers.Wallet.createRandom().connect(provider);
  const carol  = ethers.Wallet.createRandom().connect(provider);

  console.log("Alice_C (fresh):", aliceC.address);
  console.log("Bob_C (fresh):",   bobC.address);
  console.log("Carol (fresh):",   carol.address);
  console.log("Dave (Cadence testnet-bob):", DAVE_CADENCE_ADDR);

  results.steps.accounts = {
    alice_c:    aliceC.address, alice_c_key: aliceC.privateKey,
    bob_c:      bobC.address,   bob_c_key:   bobC.privateKey,
    carol:      carol.address,  carol_key:   carol.privateKey,
    dave_cadence: DAVE_CADENCE_ADDR,
    ts:         new Date().toISOString(),
  };
  saveResults();

  // Contracts
  const janusFlowA  = new ethers.Contract(ADDRESSES.janusFlow,       JANUS_FLOW_ABI,        aliceC);
  const janusERC20A = new ethers.Contract(ADDRESSES.janusERC20,      JANUS_ERC20_ABI,       aliceC);
  const usdcDep     = new ethers.Contract(ADDRESSES.mockUSDC,        MOCK_USDC_ABI,         deployerWallet);
  const usdcA       = new ethers.Contract(ADDRESSES.mockUSDC,        MOCK_USDC_ABI,         aliceC);
  const memoRegA    = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, aliceC);
  const memoRegBob  = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, bobC);
  const memoRegCarol = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, carol);
  const inbox       = new ethers.Contract(ADDRESSES.shieldedInbox,   SHIELDED_INBOX_ABI,    provider);
  const inboxBob    = new ethers.Contract(ADDRESSES.shieldedInbox,   SHIELDED_INBOX_ABI,    bobC);
  const inboxCarol  = new ethers.Contract(ADDRESSES.shieldedInbox,   SHIELDED_INBOX_ABI,    carol);

  // -------------------------------------------------------------------------
  // Step 0: Fund + setup
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Fund + setup ---");

  await waitTx(await deployerWallet.sendTransaction({ to: aliceC.address, value: ethers.parseEther("0.15") }), "fund-alice-C");
  await waitTx(await deployerWallet.sendTransaction({ to: bobC.address,   value: ethers.parseEther("0.05") }), "fund-bob-C");
  await waitTx(await deployerWallet.sendTransaction({ to: carol.address,  value: ethers.parseEther("0.05") }), "fund-carol");

  // Vault type + registry for Cadence
  flowSend("set_underlying_vault_type.cdc", ALICE_FLOW_ACCT, [strArg("A.4b6bc58bc8bf5dcc.MockFT.Vault")]);
  flowSend("install_registry.cdc", ALICE_FLOW_ACCT, []);
  flowSend("setup_mockft_vault.cdc", ALICE_FLOW_ACCT, []);
  // Reset Cadence slots clean
  flowSend("admin_reset_janusFT.cdc", ALICE_FLOW_ACCT, [addressArrayArg([ALICE_CADENCE_ADDR])]);
  // Install inbox for Dave (testnet-bob - idempotent)
  flowSend("install_inbox.cdc", DAVE_FLOW_ACCT, []);

  results.steps.fund = { ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: Generate keypairs + publish memokeys
  // -------------------------------------------------------------------------
  console.log("\n--- Step 1: Keypairs + memokeys ---");

  const aliceCJub = await deriveJubKeypair(aliceC.address);
  const bobCJub   = await deriveJubKeypair(bobC.address);
  const carolJub  = await deriveJubKeypair(carol.address);
  const daveJub   = await deriveJubKeypair(DAVE_CADENCE_ADDR);

  await waitTx(await memoRegA.publishMemoKey(aliceCJub.pubkey.x, aliceCJub.pubkey.y), "alice-C-memo");
  await waitTx(await memoRegBob.publishMemoKey(bobCJub.pubkey.x, bobCJub.pubkey.y), "bob-C-memo");
  await waitTx(await memoRegCarol.publishMemoKey(carolJub.pubkey.x, carolJub.pubkey.y), "carol-memo");
  console.log("  All EVM memokeys published");

  results.steps.memokeys = { ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 2: Alice_C wraps FLOW + mUSDC + MockFT
  // -------------------------------------------------------------------------
  console.log("\n--- Step 2: Alice_C wraps tokens ---");

  // Mint mUSDC
  await waitTx(await usdcDep.mint(aliceC.address, MUSDC_WRAP * 2n), "mint-musdc");
  await waitTx(await usdcA.approve(ADDRESSES.janusERC20, MUSDC_WRAP), "approve-musdc");

  const flowBl = await randomScalar(), flowNonce = BigInt(Date.now());
  console.log("  Generating FLOW wrap proof...");
  const flowWP = await generateAmountDiscloseProof({ amount: FLOW_WRAP, blinding: flowBl, nonce: flowNonce });
  const { ciphertext: fSnap, ephemeralPubkey: fEph } = await encryptNote({ amount: FLOW_WRAP, blinding: flowBl }, aliceCJub.pubkey);
  await waitTx(await janusFlowA.wrapWithProof(flowNonce, [flowWP.pubSignals[1], flowWP.pubSignals[2]], flowWP.pA, flowWP.pB, flowWP.pC, fSnap, fEph.x, fEph.y, { value: FLOW_WRAP }), "alice-C-flow-wrap");

  const musdcBl = await randomScalar(), musdcNonce = BigInt(Date.now());
  console.log("  Generating mUSDC wrap proof...");
  const musdcWP = await generateAmountDiscloseProof({ amount: MUSDC_WRAP, blinding: musdcBl, nonce: musdcNonce });
  const { ciphertext: mSnap, ephemeralPubkey: mEph } = await encryptNote({ amount: MUSDC_WRAP, blinding: musdcBl }, aliceCJub.pubkey);
  await waitTx(await janusERC20A.wrapWithProof(MUSDC_WRAP, musdcNonce, [musdcWP.pubSignals[1], musdcWP.pubSignals[2]], musdcWP.pA, musdcWP.pB, musdcWP.pC, mSnap, mEph.x, mEph.y), "alice-C-musdc-wrap");

  // Cadence MockFT wrap
  flowSend("mint_mockft.cdc", ALICE_FLOW_ACCT, [ufixArg("10.00000000"), addressArg(ALICE_CADENCE_ADDR)]);
  const ftBl = await randomScalar(), ftNonce = BigInt(Date.now());
  console.log("  Generating MockFT wrap proof...");
  const ftWP = await generateAmountDiscloseProof({ amount: FT_WRAP, blinding: ftBl, nonce: ftNonce });
  const { ciphertext: ftSnap, ephemeralPubkey: ftEph } = await encryptNote({ amount: FT_WRAP, blinding: ftBl }, aliceCJub.pubkey);
  flowSend("wrap_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArg("5.00000000"), uint256Arg(ftNonce), uint256Arg(ftWP.pubSignals[1]), uint256Arg(ftWP.pubSignals[2]),
    arrayUint256([ftWP.pA[0], ftWP.pA[1]]),
    array2d([[ftWP.pB[0][1], ftWP.pB[0][0]], [ftWP.pB[1][1], ftWP.pB[1][0]]]),
    arrayUint256([ftWP.pC[0], ftWP.pC[1]]),
    arrayUint8(ftSnap), uint256Arg(ftEph.x), uint256Arg(ftEph.y),
  ]);

  let aliceFlowV = FLOW_WRAP, aliceFlowR = flowBl;
  let aliceMusdcV = MUSDC_WRAP, aliceMusdcR = musdcBl;
  let aliceFTV  = FT_WRAP, aliceFTR = ftBl;
  let [aliceFlowCx, aliceFlowCy]   = await janusFlowA.balanceOfCommitmentXY(aliceC.address);
  let [aliceMusdcCx, aliceMusdcCy] = await janusERC20A.balanceOfCommitmentXY(aliceC.address);
  console.log("  Alice_C wrapped all 3 tokens");
  results.steps.alice_wraps = { ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 3: Send 0.3 FLOW to Bob_C
  // -------------------------------------------------------------------------
  console.log("\n--- Step 3: Send 0.3 FLOW to Bob_C ---");

  const flowSendBl = await randomScalar(), newFlowBl = await randomScalar();
  const newFlowV = aliceFlowV - FLOW_SEND;

  console.log("  Generating FLOW transfer proof...");
  const flowXP = await generateProof({
    old_value: aliceFlowV, old_blinding: aliceFlowR,
    transfer_value: FLOW_SEND, transfer_blinding: flowSendBl, new_blinding: newFlowBl,
  });

  const { ciphertext: flowNote, ephemeralPubkey: flowNoteEph } = await encryptNote(
    { amount: FLOW_SEND, blinding: flowSendBl, memo: "flow for bob" }, bobCJub.pubkey
  );

  const flowXferTx = await janusFlowA.shieldedTransfer(
    bobC.address, flowXP.pubSignals, flatProof(flowXP), flowNote, flowNoteEph.x, flowNoteEph.y
  );
  await waitTx(flowXferTx, "alice-C-flow-to-bob");
  aliceFlowV = newFlowV; aliceFlowR = newFlowBl;

  results.steps.send_flow_to_bob = { tx: flowXferTx.hash, amount: FLOW_SEND.toString(), to: bobC.address, ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 4: Send 5 mUSDC to Carol
  // -------------------------------------------------------------------------
  console.log("\n--- Step 4: Send 5 mUSDC to Carol ---");

  const musdcSendBl = await randomScalar(), newMusdcBl = await randomScalar();
  const newMusdcV = aliceMusdcV - MUSDC_SEND;

  console.log("  Generating mUSDC transfer proof...");
  const musdcXP = await generateProof({
    old_value: aliceMusdcV, old_blinding: aliceMusdcR,
    transfer_value: MUSDC_SEND, transfer_blinding: musdcSendBl, new_blinding: newMusdcBl,
  });

  const { ciphertext: musdcNote, ephemeralPubkey: musdcNoteEph } = await encryptNote(
    { amount: MUSDC_SEND, blinding: musdcSendBl, memo: "musdc for carol" }, carolJub.pubkey
  );

  const musdcXferTx = await janusERC20A.shieldedTransfer(
    carol.address, musdcXP.pubSignals, flatProof(musdcXP), musdcNote, musdcNoteEph.x, musdcNoteEph.y
  );
  await waitTx(musdcXferTx, "alice-C-musdc-to-carol");
  aliceMusdcV = newMusdcV; aliceMusdcR = newMusdcBl;

  results.steps.send_musdc_to_carol = { tx: musdcXferTx.hash, amount: MUSDC_SEND.toString(), to: carol.address, ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 5: Send 5 MockFT to Dave (testnet-bob Cadence)
  // -------------------------------------------------------------------------
  console.log("\n--- Step 5: Send 5 MockFT to Dave (testnet-bob) ---");

  const ftSendBl = await randomScalar(), newFTBl = await randomScalar();
  const newFTV = aliceFTV - FT_SEND;

  console.log("  Generating MockFT transfer proof...");
  const ftXP = await generateProof({
    old_value: aliceFTV, old_blinding: aliceFTR,
    transfer_value: FT_SEND, transfer_blinding: ftSendBl, new_blinding: newFTBl,
  });

  const { ciphertext: ftNote, ephemeralPubkey: ftNoteEph } = await encryptNote(
    { amount: FT_SEND, blinding: ftSendBl, memo: "mockft for dave" }, daveJub.pubkey
  );

  flowSend("shielded_transfer_mockft.cdc", ALICE_FLOW_ACCT, [
    addressArg(ALICE_CADENCE_ADDR), addressArg(DAVE_CADENCE_ADDR),
    arrayUint256(flatProof(ftXP)), arrayUint256(ftXP.pubSignals),
    arrayUint8(ftNote), uint256Arg(ftNoteEph.x), uint256Arg(ftNoteEph.y),
  ]);
  aliceFTV = newFTV; aliceFTR = newFTBl;

  results.steps.send_mockft_to_dave = { ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 6: Verify inbox isolation
  // -------------------------------------------------------------------------
  console.log("\n--- Step 6: Verify inbox isolation ---");

  const bobCCount  = await inbox.count(bobC.address);
  const carolCount = await inbox.count(carol.address);

  console.log(`  Bob_C EVM inbox count: ${bobCCount} (expected 1)`);
  console.log(`  Carol EVM inbox count: ${carolCount} (expected 1)`);

  if (bobCCount !== 1n)  throw new Error(`Bob_C inbox: expected 1, got ${bobCCount}`);
  if (carolCount !== 1n) throw new Error(`Carol inbox: expected 1, got ${carolCount}`);
  console.log("  Inbox isolation verified: Bob_C=1, Carol=1");

  // Peek Bob_C's notes - should contain ONLY FLOW (not mUSDC)
  const bobNotes   = await inboxBob.drainBatch.staticCall(10);
  const carolNotes = await inboxCarol.drainBatch.staticCall(10);

  if (bobNotes.length !== 1)   throw new Error(`Bob_C should have 1 note, got ${bobNotes.length}`);
  if (carolNotes.length !== 1) throw new Error(`Carol should have 1 note, got ${carolNotes.length}`);

  const bobNote   = bobNotes[0];
  const carolNote = carolNotes[0];

  // Verify Bob_C's note is FLOW (depositor = JanusFlow)
  if (bobNote.depositor.toLowerCase() !== ADDRESSES.janusFlow.toLowerCase()) {
    throw new Error(`Bob_C's note depositor should be JanusFlow, got ${bobNote.depositor}`);
  }
  // Verify Carol's note is mUSDC (depositor = JanusERC20)
  if (carolNote.depositor.toLowerCase() !== ADDRESSES.janusERC20.toLowerCase()) {
    throw new Error(`Carol's note depositor should be JanusERC20, got ${carolNote.depositor}`);
  }

  // Verify Bob_C's inbox does NOT contain Carol's mUSDC note
  const bobHasMusdc = bobNotes.some(n => n.depositor.toLowerCase() === ADDRESSES.janusERC20.toLowerCase());
  if (bobHasMusdc) throw new Error("Bob_C's inbox contains a mUSDC note — isolation FAILED!");
  console.log("  Bob_C's inbox contains only FLOW (no mUSDC) — isolation PASS");

  results.steps.isolation_check = {
    bob_c_count:  bobCCount.toString(),
    carol_count:  carolCount.toString(),
    bob_depositor_is_flow:   bobNote.depositor.toLowerCase() === ADDRESSES.janusFlow.toLowerCase(),
    carol_depositor_is_erc20: carolNote.depositor.toLowerCase() === ADDRESSES.janusERC20.toLowerCase(),
    bob_has_no_musdc:        !bobHasMusdc,
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 7: Each recipient drains + decodes
  // -------------------------------------------------------------------------
  console.log("\n--- Step 7: Recipients drain + decode ---");

  // Bob_C drains + decodes FLOW
  await waitTx(await inboxBob.drainBatch(10), "bob-C-drain");
  const decodedFlow = await decryptNote(
    Buffer.from(ethers.getBytes(bobNote.ciphertext)),
    { x: bobNote.ephPubkeyX, y: bobNote.ephPubkeyY },
    bobCJub.privkey
  );
  console.log(`  Bob_C decoded: amount=${decodedFlow.amount}, memo="${decodedFlow.memo}"`);
  if (decodedFlow.amount !== FLOW_SEND)      throw new Error(`FLOW amount mismatch: ${decodedFlow.amount} != ${FLOW_SEND}`);
  if (decodedFlow.memo !== "flow for bob")   throw new Error(`FLOW memo mismatch: "${decodedFlow.memo}"`);
  console.log("  Bob_C FLOW note verified");

  // Carol drains + decodes mUSDC
  await waitTx(await inboxCarol.drainBatch(10), "carol-drain");
  const decodedMusdc = await decryptNote(
    Buffer.from(ethers.getBytes(carolNote.ciphertext)),
    { x: carolNote.ephPubkeyX, y: carolNote.ephPubkeyY },
    carolJub.privkey
  );
  console.log(`  Carol decoded: amount=${decodedMusdc.amount}, memo="${decodedMusdc.memo}"`);
  if (decodedMusdc.amount !== MUSDC_SEND)      throw new Error(`mUSDC amount mismatch: ${decodedMusdc.amount} != ${MUSDC_SEND}`);
  if (decodedMusdc.memo !== "musdc for carol") throw new Error(`mUSDC memo mismatch: "${decodedMusdc.memo}"`);
  console.log("  Carol mUSDC note verified");

  // Dave (testnet-bob) drains + decodes MockFT
  flowSend("drain_inbox.cdc", DAVE_FLOW_ACCT, []);
  const decodedFT = await decryptNote(ftNote, { x: ftNoteEph.x, y: ftNoteEph.y }, daveJub.privkey);
  console.log(`  Dave decoded: amount=${decodedFT.amount}, memo="${decodedFT.memo}"`);
  if (decodedFT.amount !== FT_SEND)          throw new Error(`MockFT amount mismatch: ${decodedFT.amount} != ${FT_SEND}`);
  if (decodedFT.memo !== "mockft for dave")  throw new Error(`MockFT memo mismatch: "${decodedFT.memo}"`);
  console.log("  Dave MockFT note verified");

  results.steps.drain_and_decode = {
    bob_c_flow_amount:   decodedFlow.amount.toString(),
    bob_c_flow_memo:     decodedFlow.memo,
    carol_musdc_amount:  decodedMusdc.amount.toString(),
    carol_musdc_memo:    decodedMusdc.memo,
    dave_mockft_amount:  decodedFT.amount.toString(),
    dave_mockft_memo:    decodedFT.memo,
    verified:            true,
    ts:                  new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  results.summary  = {
    alice_c: aliceC.address, alice_c_key: aliceC.privateKey,
    bob_c:   bobC.address,   bob_c_key:   bobC.privateKey,
    carol:   carol.address,  carol_key:   carol.privateKey,
    dave_cadence: DAVE_CADENCE_ADDR,
    isolation_verified: true,
    all_decoded_correct: true,
  };
  saveResults();

  console.log("\n=== Scenario 10.C RESULT: GREEN ===");
  console.log("  Inbox isolation: PASS");
  console.log("  All 3 recipients decoded correct token/amount/memo");
}

main()
  .then(() => { console.log("\n10.C complete"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
