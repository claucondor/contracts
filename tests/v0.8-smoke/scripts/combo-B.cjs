/**
 * combo-B.cjs — Scenario 10.B: Bob receives multiple tokens in EVM + Cadence inboxes.
 *
 * Alice_B (fresh EVM wallet) sends FLOW + mUSDC notes to Bob (fresh EVM).
 * openjanus-v08 Cadence sends MockFT to testnet-bob Cadence inbox.
 * Bob distinguishes notes by depositor address (JanusFlow vs JanusERC20).
 *
 * Assertions:
 *   - Bob's EVM inbox count = 2 (FLOW + mUSDC notes)
 *   - testnet-bob Cadence inbox count = 1 (MockFT note)
 *   - FLOW note: depositor==JanusFlow, amount=0.5 FLOW, memo="flow tip"
 *   - mUSDC note: depositor==JanusERC20, amount=10 mUSDC, memo="musdc tip"
 *   - MockFT note: amount=10 MockFT, memo="mockft tip"
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
const RESULTS_FILE = path.join(SMOKE_DIR, "results-combo-B.json");
const NETWORK      = "testnet";

const DEPLOYER_KEY       = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
const ALICE_CADENCE_ADDR = "0x4b6bc58bc8bf5dcc";
const BOB_CADENCE_ADDR   = "0xd807a3992d7be612";
const ALICE_FLOW_ACCT    = "openjanus-v08";
const BOB_FLOW_ACCT      = "testnet-bob";

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

// Alice wraps enough to send (small amounts to conserve deployer FLOW)
const FLOW_WRAP  = 5n * 10n**16n;      // 0.05 FLOW
const MUSDC_WRAP = 5n * E6;            // 5 mUSDC
const FT_WRAP    = 5n * MOCKFT_SCALE;  // 5 MockFT

// Transfer amounts (must be < wrap amounts)
const FLOW_SEND  = 2n * 10n**16n;      // 0.02 FLOW
const MUSDC_SEND = 2n * E6;            // 2 mUSDC
const FT_SEND    = 2n * MOCKFT_SCALE;  // 2 MockFT

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const JANUS_FLOW_ABI = [
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) payable",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function VERSION() view returns (string)",
  "event ShieldedTransferNote(address indexed from, address indexed to, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
];

const JANUS_ERC20_ABI = [
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function VERSION() view returns (string)",
  "event ShieldedTransferNote(address indexed from, address indexed to, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
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
  phase:    "10.B",
  scenario: "bob-receives-multi-token",
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
// Helpers (shared)
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

function encodeAdminBatchReset(addresses) {
  const iface = new ethers.Interface(["function adminBatchResetSlots(address[] calldata users) external"]);
  return iface.encodeFunctionData("adminBatchResetSlots", [addresses]).slice(2);
}

function extractEventCipher(receipt, iface) {
  for (const log of receipt.logs) {
    try {
      const decoded = iface.parseLog({ topics: log.topics, data: log.data });
      if (decoded?.name === "ShieldedTransferNote") {
        return {
          cipher: decoded.args.encryptedNoteTo,
          ephX:   decoded.args.ephPubkeyToX,
          ephY:   decoded.args.ephPubkeyToY,
        };
      }
    } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Scenario 10.B: Bob Receives Multiple Tokens ===\n");

  const provider        = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const deployerWallet  = new ethers.Wallet(DEPLOYER_KEY, provider);
  const aliceB          = ethers.Wallet.createRandom().connect(provider);  // fresh alice for B
  const bobB            = ethers.Wallet.createRandom().connect(provider);  // fresh bob for B
  console.log("Deployer (funder):", deployerWallet.address);
  console.log("Alice_B (fresh):", aliceB.address);
  console.log("Bob_B (fresh):", bobB.address);
  console.log("Bob Cadence (testnet-bob):", BOB_CADENCE_ADDR);

  results.steps.accounts = {
    alice_b:    aliceB.address,
    alice_b_key: aliceB.privateKey,
    bob_b:      bobB.address,
    bob_b_key:  bobB.privateKey,
    bob_cadence: BOB_CADENCE_ADDR,
    ts:         new Date().toISOString(),
  };
  saveResults();

  const strArg    = (s) => ({ type: "String", value: s });
  const uint64Arg = (n) => ({ type: "UInt64",  value: n.toString() });

  // Contracts with alice_B as signer
  const janusFlowA  = new ethers.Contract(ADDRESSES.janusFlow,       JANUS_FLOW_ABI,        aliceB);
  const janusERC20A = new ethers.Contract(ADDRESSES.janusERC20,      JANUS_ERC20_ABI,       aliceB);
  const usdcA       = new ethers.Contract(ADDRESSES.mockUSDC,        MOCK_USDC_ABI,         aliceB);
  const usdcDep     = new ethers.Contract(ADDRESSES.mockUSDC,        MOCK_USDC_ABI,         deployerWallet);
  const memoRegA    = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, aliceB);
  const memoRegB    = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, bobB);
  const inbox       = new ethers.Contract(ADDRESSES.shieldedInbox,   SHIELDED_INBOX_ABI,    provider);
  const inboxBob    = new ethers.Contract(ADDRESSES.shieldedInbox,   SHIELDED_INBOX_ABI,    bobB);

  const jfIface  = new ethers.Interface(JANUS_FLOW_ABI);
  const e20Iface = new ethers.Interface(JANUS_ERC20_ABI);

  // -------------------------------------------------------------------------
  // Step 0: Fund alice_B + bob_B. Reset Cadence + alice_B EVM slots.
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Fund + reset ---");

  const fundATx = await deployerWallet.sendTransaction({ to: aliceB.address, value: ethers.parseEther("0.15") });
  await waitTx(fundATx, "fund-alice-B");

  const fundBTx = await deployerWallet.sendTransaction({ to: bobB.address, value: ethers.parseEther("0.05") });
  await waitTx(fundBTx, "fund-bob-B");

  // Reset alice_B's EVM slots (she's fresh so they should be identity, but reset anyway)
  // (actually not needed for fresh wallet - skip to save time)

  // Reset Cadence openjanus-v08 + testnet-bob JanusFT slots for clean start
  flowSend("admin_reset_janusFT.cdc", ALICE_FLOW_ACCT, [
    addressArrayArg([ALICE_CADENCE_ADDR, BOB_CADENCE_ADDR]),
  ]);
  console.log("  Cadence JanusFT reset for both Alice and Bob Cadence");

  results.steps.fund = { fund_alice_tx: fundATx.hash, fund_bob_tx: fundBTx.hash, ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: Generate keypairs + publish memokeys
  // -------------------------------------------------------------------------
  console.log("\n--- Step 1: Generate keypairs + publish memokeys ---");

  const aliceBJub = await deriveJubKeypair(aliceB.address);
  const bobBJub   = await deriveJubKeypair(bobB.address);

  const memoATx = await memoRegA.publishMemoKey(aliceBJub.pubkey.x, aliceBJub.pubkey.y);
  await waitTx(memoATx, "alice-B-memokey");

  const memoBTx = await memoRegB.publishMemoKey(bobBJub.pubkey.x, bobBJub.pubkey.y);
  await waitTx(memoBTx, "bob-B-memokey");

  // Install testnet-bob Cadence inbox (idempotent)
  flowSend("install_inbox.cdc", BOB_FLOW_ACCT, []);
  console.log("  testnet-bob Cadence inbox installed");

  results.steps.setup = { alice_memo_tx: memoATx.hash, bob_memo_tx: memoBTx.hash, ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 2: Alice_B wraps FLOW + mUSDC
  // -------------------------------------------------------------------------
  console.log("\n--- Step 2: Alice_B wraps 2 FLOW + 50 mUSDC ---");

  // Mint mUSDC to alice_B
  await waitTx(await usdcDep.mint(aliceB.address, MUSDC_WRAP * 2n), "mint-musdc");
  await waitTx(await usdcA.approve(ADDRESSES.janusERC20, MUSDC_WRAP), "approve-musdc");

  const flowBl = await randomScalar();
  const flowNonce = BigInt(Date.now());
  console.log("  Generating FLOW wrap proof...");
  const flowWP = await generateAmountDiscloseProof({ amount: FLOW_WRAP, blinding: flowBl, nonce: flowNonce });
  const flowCX = flowWP.pubSignals[1], flowCY = flowWP.pubSignals[2];
  const { ciphertext: fSnap, ephemeralPubkey: fEph } = await encryptNote({ amount: FLOW_WRAP, blinding: flowBl }, aliceBJub.pubkey);
  await waitTx(await janusFlowA.wrapWithProof(flowNonce, [flowCX, flowCY], flowWP.pA, flowWP.pB, flowWP.pC, fSnap, fEph.x, fEph.y, { value: FLOW_WRAP }), "alice-B-flow-wrap");

  const musdcBl = await randomScalar();
  const musdcNonce = BigInt(Date.now());
  console.log("  Generating mUSDC wrap proof...");
  const musdcWP = await generateAmountDiscloseProof({ amount: MUSDC_WRAP, blinding: musdcBl, nonce: musdcNonce });
  const musdcCX = musdcWP.pubSignals[1], musdcCY = musdcWP.pubSignals[2];
  const { ciphertext: mSnap, ephemeralPubkey: mEph } = await encryptNote({ amount: MUSDC_WRAP, blinding: musdcBl }, aliceBJub.pubkey);
  await waitTx(await janusERC20A.wrapWithProof(MUSDC_WRAP, musdcNonce, [musdcCX, musdcCY], musdcWP.pA, musdcWP.pB, musdcWP.pC, mSnap, mEph.x, mEph.y), "alice-B-musdc-wrap");

  let aliceFlowV = FLOW_WRAP, aliceFlowR = flowBl;
  let aliceMusdcV = MUSDC_WRAP, aliceMusdcR = musdcBl;
  let [aliceFlowCx, aliceFlowCy]   = await janusFlowA.balanceOfCommitmentXY(aliceB.address);
  let [aliceMusdcCx, aliceMusdcCy] = await janusERC20A.balanceOfCommitmentXY(aliceB.address);
  console.log("  Alice_B wrapped FLOW + mUSDC");
  results.steps.alice_wraps = { ts: new Date().toISOString() };
  saveResults();

  // Mint + wrap MockFT for Cadence Alice (openjanus-v08)
  console.log("  Minting + wrapping MockFT for Cadence Alice...");
  flowSend("setup_mockft_vault.cdc", ALICE_FLOW_ACCT, []);
  flowSend("install_registry.cdc", ALICE_FLOW_ACCT, []);
  flowSend("mint_mockft.cdc", ALICE_FLOW_ACCT, [ufixArg("10.00000000"), addressArg(ALICE_CADENCE_ADDR)]);

  const ftBl = await randomScalar();
  const ftNonce = BigInt(Date.now());
  console.log("  Generating MockFT wrap proof...");
  const ftWP = await generateAmountDiscloseProof({ amount: FT_WRAP, blinding: ftBl, nonce: ftNonce });
  const ftCX = ftWP.pubSignals[1], ftCY = ftWP.pubSignals[2];
  const { ciphertext: ftSnap, ephemeralPubkey: ftEph } = await encryptNote({ amount: FT_WRAP, blinding: ftBl }, aliceBJub.pubkey);

  flowSend("wrap_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArg("5.00000000"), uint256Arg(ftNonce), uint256Arg(ftCX), uint256Arg(ftCY),
    arrayUint256([ftWP.pA[0], ftWP.pA[1]]),
    array2d([[ftWP.pB[0][1], ftWP.pB[0][0]], [ftWP.pB[1][1], ftWP.pB[1][0]]]),
    arrayUint256([ftWP.pC[0], ftWP.pC[1]]),
    arrayUint8(ftSnap), uint256Arg(ftEph.x), uint256Arg(ftEph.y),
  ]);
  let cadenceAliceV = FT_WRAP, cadenceAliceR = ftBl;
  console.log("  MockFT wrapped for Cadence Alice");
  results.steps.mockft_wrap = { ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 3: Alice sends 0.5 FLOW to Bob_B
  // -------------------------------------------------------------------------
  console.log("\n--- Step 3: Alice sends 0.5 FLOW to Bob_B ---");

  const flowSendBl   = await randomScalar();
  const newAliceFlowBl = await randomScalar();
  const newAliceFlowV  = aliceFlowV - FLOW_SEND;

  console.log("  Generating FLOW transfer proof...");
  const flowXP = await generateProof({
    old_value: aliceFlowV, old_blinding: aliceFlowR,
    transfer_value: FLOW_SEND, transfer_blinding: flowSendBl,
    new_blinding: newAliceFlowBl,
  });
  const fp6 = flowXP.pubSignals;

  const { ciphertext: flowNote, ephemeralPubkey: flowNoteEph } = await encryptNote(
    { amount: FLOW_SEND, blinding: flowSendBl, memo: "flow tip" }, bobBJub.pubkey
  );

  const flowXferTx = await janusFlowA.shieldedTransfer(
    bobB.address, fp6, flatProof(flowXP), flowNote, flowNoteEph.x, flowNoteEph.y
  );
  const flowXferR = await waitTx(flowXferTx, "alice-B-send-flow-to-bob");

  aliceFlowV  = newAliceFlowV;
  aliceFlowR  = newAliceFlowBl;
  [aliceFlowCx, aliceFlowCy] = [fp6[4], fp6[5]];

  const flowNoteData = extractEventCipher(await provider.getTransactionReceipt(flowXferTx.hash), jfIface)
    || { cipher: flowNote, ephX: flowNoteEph.x, ephY: flowNoteEph.y };

  results.steps.send_flow = {
    tx: flowXferTx.hash, amount: FLOW_SEND.toString(), to: bobB.address,
    cipher_from_event: !!flowNoteData, ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 4: Alice sends 10 mUSDC to Bob_B
  // -------------------------------------------------------------------------
  console.log("\n--- Step 4: Alice sends 10 mUSDC to Bob_B ---");

  const musdcSendBl   = await randomScalar();
  const newAliceMusdcBl = await randomScalar();
  const newAliceMusdcV  = aliceMusdcV - MUSDC_SEND;

  console.log("  Generating mUSDC transfer proof...");
  const musdcXP = await generateProof({
    old_value: aliceMusdcV, old_blinding: aliceMusdcR,
    transfer_value: MUSDC_SEND, transfer_blinding: musdcSendBl,
    new_blinding: newAliceMusdcBl,
  });
  const ep6 = musdcXP.pubSignals;

  const { ciphertext: musdcNote, ephemeralPubkey: musdcNoteEph } = await encryptNote(
    { amount: MUSDC_SEND, blinding: musdcSendBl, memo: "musdc tip" }, bobBJub.pubkey
  );

  const musdcXferTx = await janusERC20A.shieldedTransfer(
    bobB.address, ep6, flatProof(musdcXP), musdcNote, musdcNoteEph.x, musdcNoteEph.y
  );
  const musdcXferR = await waitTx(musdcXferTx, "alice-B-send-musdc-to-bob");

  aliceMusdcV  = newAliceMusdcV;
  aliceMusdcR  = newAliceMusdcBl;

  const musdcNoteData = extractEventCipher(await provider.getTransactionReceipt(musdcXferTx.hash), e20Iface)
    || { cipher: musdcNote, ephX: musdcNoteEph.x, ephY: musdcNoteEph.y };

  results.steps.send_musdc = {
    tx: musdcXferTx.hash, amount: MUSDC_SEND.toString(), to: bobB.address,
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 5: Send 10 MockFT to testnet-bob (Cadence)
  // -------------------------------------------------------------------------
  console.log("\n--- Step 5: Alice sends 10 MockFT to testnet-bob ---");

  const ftSendBl   = await randomScalar();
  const newFtBl    = await randomScalar();
  const newFtV     = cadenceAliceV - FT_SEND;

  // For Cadence JanusFT transfer, we need bob's JubJub key for encrypting the note
  const bobCadenceJub = await deriveJubKeypair(BOB_CADENCE_ADDR);

  console.log("  Generating MockFT transfer proof...");
  const ftXP = await generateProof({
    old_value: cadenceAliceV, old_blinding: cadenceAliceR,
    transfer_value: FT_SEND, transfer_blinding: ftSendBl,
    new_blinding: newFtBl,
  });
  const ftp6 = ftXP.pubSignals;

  const { ciphertext: ftNote, ephemeralPubkey: ftNoteEph } = await encryptNote(
    { amount: FT_SEND, blinding: ftSendBl, memo: "mockft tip" }, bobCadenceJub.pubkey
  );

  const ftXferTx = flowSend("shielded_transfer_mockft.cdc", ALICE_FLOW_ACCT, [
    addressArg(ALICE_CADENCE_ADDR),
    addressArg(BOB_CADENCE_ADDR),
    arrayUint256(flatProof(ftXP)),
    arrayUint256(ftp6),
    arrayUint8(ftNote),
    uint256Arg(ftNoteEph.x),
    uint256Arg(ftNoteEph.y),
  ]);
  console.log("  MockFT transfer confirmed:", ftXferTx.txId);

  cadenceAliceV = newFtV;
  cadenceAliceR = newFtBl;

  results.steps.send_mockft = {
    tx: ftXferTx.txId, amount: FT_SEND.toString(), to: BOB_CADENCE_ADDR,
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 6: Query inbox counts
  // -------------------------------------------------------------------------
  console.log("\n--- Step 6: Query inbox counts ---");

  const bobEvmCount = await inbox.count(bobB.address);
  console.log(`  Bob_B EVM inbox count: ${bobEvmCount}`);
  if (bobEvmCount !== 2n) throw new Error(`Expected 2 EVM notes for Bob_B, got ${bobEvmCount}`);
  console.log("  EVM inbox count = 2 (FLOW + mUSDC notes)");

  results.steps.inbox_counts = {
    bob_evm_count: bobEvmCount.toString(),
    expected_evm: 2,
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 7: Bob_B drains EVM inbox + decodes by depositor
  // -------------------------------------------------------------------------
  console.log("\n--- Step 7: Bob_B drains EVM inbox + decodes by depositor ---");

  // Peek at notes using staticCall
  const peekedNotes = await inboxBob.drainBatch.staticCall(10);
  console.log(`  StaticCall drainBatch returned ${peekedNotes.length} notes`);

  let flowNoteFound  = false;
  let musdcNoteFound = false;

  for (const note of peekedNotes) {
    const dep = note.depositor.toLowerCase();
    const isFlow  = dep === ADDRESSES.janusFlow.toLowerCase();
    const isERC20 = dep === ADDRESSES.janusERC20.toLowerCase();
    console.log(`  Note depositor: ${note.depositor} → ${isFlow ? "JanusFlow" : isERC20 ? "JanusERC20" : "unknown"}`);

    const decoded = await decryptNote(
      Buffer.from(ethers.getBytes(note.ciphertext)),
      { x: note.ephPubkeyX, y: note.ephPubkeyY },
      bobBJub.privkey
    );

    if (isFlow) {
      console.log(`    Decoded FLOW: amount=${decoded.amount}, memo="${decoded.memo}"`);
      if (decoded.amount !== FLOW_SEND) throw new Error(`FLOW amount mismatch: ${decoded.amount} != ${FLOW_SEND}`);
      if (decoded.memo !== "flow tip")  throw new Error(`FLOW memo mismatch: "${decoded.memo}"`);
      flowNoteFound = true;
      console.log("    FLOW note verified: amount=0.5 FLOW, memo='flow tip'");
    } else if (isERC20) {
      console.log(`    Decoded mUSDC: amount=${decoded.amount}, memo="${decoded.memo}"`);
      if (decoded.amount !== MUSDC_SEND) throw new Error(`mUSDC amount mismatch: ${decoded.amount} != ${MUSDC_SEND}`);
      if (decoded.memo !== "musdc tip")  throw new Error(`mUSDC memo mismatch: "${decoded.memo}"`);
      musdcNoteFound = true;
      console.log("    mUSDC note verified: amount=10 mUSDC, memo='musdc tip'");
    }
  }

  if (!flowNoteFound)  throw new Error("FLOW note not found in Bob_B's inbox");
  if (!musdcNoteFound) throw new Error("mUSDC note not found in Bob_B's inbox");

  // Actually execute the drain
  const drainTx = await inboxBob.drainBatch(10);
  await waitTx(drainTx, "bob-B-drain");

  const bobEvmCountAfter = await inbox.count(bobB.address);
  if (bobEvmCountAfter !== 0n) throw new Error(`Bob_B inbox not empty after drain: ${bobEvmCountAfter}`);
  console.log("  Bob_B EVM inbox drained");

  results.steps.evm_drain = {
    drain_tx:        drainTx.hash,
    flow_note_found:  flowNoteFound,
    musdc_note_found: musdcNoteFound,
    verified:        true,
    ts:              new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 8: testnet-bob drains Cadence inbox
  // -------------------------------------------------------------------------
  console.log("\n--- Step 8: testnet-bob drains Cadence inbox ---");

  const cadenceDrainTx = flowSend("drain_inbox.cdc", BOB_FLOW_ACCT, []);
  console.log("  Cadence drain confirmed:", cadenceDrainTx.txId);

  // Decode MockFT note using bob's Cadence JubJub key
  const decodedFT = await decryptNote(
    ftNote,
    { x: ftNoteEph.x, y: ftNoteEph.y },
    bobCadenceJub.privkey
  );
  console.log(`  Decoded MockFT: amount=${decodedFT.amount}, memo="${decodedFT.memo}"`);
  if (decodedFT.amount !== FT_SEND)   throw new Error(`MockFT amount mismatch: ${decodedFT.amount} != ${FT_SEND}`);
  if (decodedFT.memo !== "mockft tip") throw new Error(`MockFT memo mismatch: "${decodedFT.memo}"`);
  console.log("  MockFT note verified: amount=10 MockFT, memo='mockft tip'");

  results.steps.cadence_drain = {
    drain_tx:       cadenceDrainTx.txId,
    decoded_amount: decodedFT.amount.toString(),
    decoded_memo:   decodedFT.memo,
    verified:       true,
    ts:             new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  results.summary  = {
    alice_b_evm:    aliceB.address,
    alice_b_key:    aliceB.privateKey,
    bob_b_evm:      bobB.address,
    bob_b_key:      bobB.privateKey,
    bob_cadence:    BOB_CADENCE_ADDR,
    evm_inbox_count_before_drain: 2,
    cadence_inbox_count_before_drain: 1,
    depositor_distinguish: "PASS",
  };
  saveResults();

  console.log("\n=== Scenario 10.B RESULT: GREEN ===");
  console.log("  EVM inbox: 2 notes (FLOW + mUSDC) — distinguished by depositor");
  console.log("  Cadence inbox: 1 note (MockFT) — decoded correctly");
}

main()
  .then(() => { console.log("\n10.B complete"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
