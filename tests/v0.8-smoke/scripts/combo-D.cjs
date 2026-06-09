/**
 * combo-D.cjs — Scenario 10.D: Cross-token state independence under mixed operations.
 *
 * Reads Alice's EXISTING state from results-combo-A.json:
 *   - JanusFlow: alice has 0.1 FLOW commitment (preserved from combo-A, not touched by B/C)
 *   - JanusERC20: alice has 5 mUSDC commitment (preserved from combo-A, not touched by B/C)
 *   - JanusFT: alice needs a fresh wrap (combo-B and/or C may have reset it)
 *
 * Operations:
 *   Op1: shieldedTransfer 0.01 FLOW → bob_D → assert ONLY JanusFlow changed
 *   Op2: shieldedTransfer 0.5 mUSDC → carol_D → assert ONLY JanusERC20 changed
 *   Op3: unwrap 0.5 mUSDC → assert ONLY JanusERC20 changed (JanusFlow + JanusFT untouched)
 *   Op4: shieldedTransfer 1 MockFT → testnet-bob → assert ONLY JanusFT changed
 *
 * After each op: snapshot all 3 commits + assert only operated token changed.
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
} = require("../../../packages/janus-token/tests/solidity/helpers/ecies.cjs");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL      = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID     = 545;
const SMOKE_DIR    = path.join(__dirname, "..");
const CADENCE_DIR  = path.join(SMOKE_DIR, "cadence");
const RESULTS_A    = path.join(SMOKE_DIR, "results-combo-A.json");
const RESULTS_FILE = path.join(SMOKE_DIR, "results-combo-D.json");
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

// Operations (small, must fit within combo-A balances)
const E6           = 10n ** 6n;
const MOCKFT_SCALE = 100_000_000n;
const FLOW_OP_SEND     = 1n * 10n**16n;   // 0.01 FLOW to bob_D
const MUSDC_OP_SEND    = 500_000n;         // 0.5 mUSDC to carol_D
const MUSDC_OP_UNWRAP  = 500_000n;         // 0.5 mUSDC back to alice
const FT_WRAP_AMOUNT   = 3n * MOCKFT_SCALE; // 3 MockFT to wrap fresh
const FT_OP_SEND       = 1n * MOCKFT_SCALE; // 1 MockFT to testnet-bob

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
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
];

const MEMO_KEY_REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y)",
  "function rotateMemoKey(uint256 x, uint256 y)",
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
  phase:    "10.D",
  scenario: "cross-token-independence",
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
  const priv = BigInt(seed) % SUBORDER;
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
  if (!resp.ok) throw new Error(`Cadence script HTTP ${resp.status}: ${await resp.text()}`);
  const raw = await resp.json();
  if (typeof raw !== "string") throw new Error(`Cadence script error: ${JSON.stringify(raw).slice(0, 200)}`);
  const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  return { x: BigInt(parsed.value[0].value), y: BigInt(parsed.value[1].value) };
}

async function snapshotAllCommits(aliceEVM, provider) {
  const jfView = new ethers.Contract(ADDRESSES.janusFlow,  JANUS_FLOW_ABI,  provider);
  const jeView = new ethers.Contract(ADDRESSES.janusERC20, JANUS_ERC20_ABI, provider);
  const [cxF, cyF] = await jfView.balanceOfCommitmentXY(aliceEVM);
  const [cxE, cyE] = await jeView.balanceOfCommitmentXY(aliceEVM);
  const cFT        = await getCadenceCommitment(ALICE_CADENCE_ADDR);
  return {
    flow:   { x: cxF, y: cyF },
    musdc:  { x: cxE, y: cyE },
    mockft: { x: cFT.x, y: cFT.y },
  };
}

function commitEq(a, b) { return a.x === b.x && a.y === b.y; }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Scenario 10.D: Cross-Token State Independence (reusing combo-A state) ===\n");

  // Load alice's existing state from combo-A
  if (!fs.existsSync(RESULTS_A)) throw new Error("results-combo-A.json not found — run combo-A first");
  const comboA = JSON.parse(fs.readFileSync(RESULTS_A, "utf8"));
  if (comboA.verdict !== "GREEN") throw new Error(`combo-A verdict is not GREEN: ${comboA.verdict}`);

  const { summary } = comboA;
  const aliceFlowV_A  = BigInt(summary.flow_state.value);
  const aliceFlowR_A  = BigInt(summary.flow_state.blinding);
  const aliceMusdcV_A = BigInt(summary.musdc_state.value);
  const aliceMusdcR_A = BigInt(summary.musdc_state.blinding);

  console.log("Loaded combo-A state:");
  console.log(`  FLOW balance in JanusFlow:   ${aliceFlowV_A} wei (${Number(aliceFlowV_A) / 1e18} FLOW)`);
  console.log(`  mUSDC balance in JanusERC20: ${aliceMusdcV_A} units (${Number(aliceMusdcV_A) / 1e6} mUSDC)`);

  const provider   = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const alice      = new ethers.Wallet(DEPLOYER_KEY, provider);
  const bobD       = ethers.Wallet.createRandom().connect(provider);
  const carolD     = ethers.Wallet.createRandom().connect(provider);

  console.log("Alice (deployer):", alice.address);
  console.log("Bob_D (fresh):", bobD.address);
  console.log("Carol_D (fresh):", carolD.address);

  results.steps.accounts = {
    alice: alice.address, bob_d: bobD.address, bob_d_key: bobD.privateKey,
    carol_d: carolD.address, carol_d_key: carolD.privateKey,
    combo_a_flow_v: aliceFlowV_A.toString(), combo_a_musdc_v: aliceMusdcV_A.toString(),
    ts: new Date().toISOString(),
  };
  saveResults();

  const jfA  = new ethers.Contract(ADDRESSES.janusFlow,       JANUS_FLOW_ABI,        alice);
  const jeA  = new ethers.Contract(ADDRESSES.janusERC20,      JANUS_ERC20_ABI,       alice);
  const mrA  = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, alice);
  const mrB  = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, bobD);
  const mrC  = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, carolD);
  const inboxB = new ethers.Contract(ADDRESSES.shieldedInbox, SHIELDED_INBOX_ABI, bobD);
  const inboxC = new ethers.Contract(ADDRESSES.shieldedInbox, SHIELDED_INBOX_ABI, carolD);

  // -------------------------------------------------------------------------
  // Step 0: Fund recipients, ensure memokeys, refresh JanusFT
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Fund recipients + ensure memokeys + refresh JanusFT ---");

  await waitTx(await alice.sendTransaction({ to: bobD.address,   value: ethers.parseEther("0.05") }), "fund-bob-D");
  await waitTx(await alice.sendTransaction({ to: carolD.address, value: ethers.parseEther("0.05") }), "fund-carol-D");

  const aliceJub = await deriveJubKeypair(alice.address);
  const bobDJub  = await deriveJubKeypair(bobD.address);
  const carolDJub = await deriveJubKeypair(carolD.address);
  const bobCadenceJub = await deriveJubKeypair(BOB_CADENCE_ADDR);

  // Alice may already have memokey (from fase 9 / combo-A) — rotate
  const [, , alicePubAt] = await mrA.getMemoKey(alice.address);
  if (alicePubAt > 0n) {
    await waitTx(await mrA.rotateMemoKey(aliceJub.pubkey.x, aliceJub.pubkey.y), "alice-D-rotate-memo");
  } else {
    await waitTx(await mrA.publishMemoKey(aliceJub.pubkey.x, aliceJub.pubkey.y), "alice-D-memo");
  }
  await waitTx(await mrB.publishMemoKey(bobDJub.pubkey.x, bobDJub.pubkey.y), "bob-D-memo");
  await waitTx(await mrC.publishMemoKey(carolDJub.pubkey.x, carolDJub.pubkey.y), "carol-D-memo");
  flowSend("install_inbox.cdc", BOB_FLOW_ACCT, []);

  // JanusFT: ensure vault type + registry, reset alice's slot (may have been reset by B/C already,
  // but this is idempotent + adds certainty), then wrap fresh MockFT
  flowSend("set_underlying_vault_type.cdc", ALICE_FLOW_ACCT, [strArg("A.4b6bc58bc8bf5dcc.MockFT.Vault")]);
  flowSend("install_registry.cdc", ALICE_FLOW_ACCT, []);
  flowSend("setup_mockft_vault.cdc", ALICE_FLOW_ACCT, []);

  // Reset JanusFT slot for alice (clean start) — does NOT affect JanusFlow/JanusERC20
  // (those are EVM-side and are untouched by this Cadence tx)
  flowSend("admin_reset_janusFT.cdc", ALICE_FLOW_ACCT, [addressArrayArg([ALICE_CADENCE_ADDR])]);

  // Mint + wrap MockFT
  flowSend("mint_mockft.cdc", ALICE_FLOW_ACCT, [ufixArg("5.00000000"), addressArg(ALICE_CADENCE_ADDR)]);
  const ftBl = await randomScalar(), ftNonce = BigInt(Date.now());
  console.log("  Generating MockFT wrap proof...");
  const ftWP = await generateAmountDiscloseProof({ amount: FT_WRAP_AMOUNT, blinding: ftBl, nonce: ftNonce });
  const { ciphertext: ftSnap, ephemeralPubkey: ftEph } = await encryptNote(
    { amount: FT_WRAP_AMOUNT, blinding: ftBl }, aliceJub.pubkey
  );
  flowSend("wrap_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArg("3.00000000"), uint256Arg(ftNonce),
    uint256Arg(ftWP.pubSignals[1]), uint256Arg(ftWP.pubSignals[2]),
    arrayUint256([ftWP.pA[0], ftWP.pA[1]]),
    array2d([[ftWP.pB[0][1], ftWP.pB[0][0]], [ftWP.pB[1][1], ftWP.pB[1][0]]]),
    arrayUint256([ftWP.pC[0], ftWP.pC[1]]),
    arrayUint8(ftSnap), uint256Arg(ftEph.x), uint256Arg(ftEph.y),
  ]);
  let aliceFTV = FT_WRAP_AMOUNT, aliceFTR = ftBl;

  // Confirm JanusFlow/JanusERC20 are still at combo-A state (not touched by our Cadence ops)
  const [cxFCheck, cyFCheck] = await jfA.balanceOfCommitmentXY(alice.address);
  const [cxECheck, cyECheck] = await jeA.balanceOfCommitmentXY(alice.address);
  if (cxFCheck !== BigInt(summary.flow_state.commit_x) || cyFCheck !== BigInt(summary.flow_state.commit_y)) {
    throw new Error(`JanusFlow state drifted from combo-A: got (${cxFCheck},${cyFCheck})`);
  }
  if (cxECheck !== BigInt(summary.musdc_state.commit_x) || cyECheck !== BigInt(summary.musdc_state.commit_y)) {
    throw new Error(`JanusERC20 state drifted from combo-A: got (${cxECheck},${cyECheck})`);
  }
  console.log("  JanusFlow/JanusERC20 confirmed at combo-A state (untouched by JanusFT ops)");

  results.steps.setup = {
    alice_flow_v: aliceFlowV_A.toString(), alice_musdc_v: aliceMusdcV_A.toString(),
    alice_ft_v: aliceFTV.toString(), ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Snapshot initial state (all 3 non-identity)
  // -------------------------------------------------------------------------
  const s0 = await snapshotAllCommits(alice.address, provider);
  console.log("Initial commits (all should be non-identity):");
  console.log(`  JanusFlow:  (${s0.flow.x.toString().slice(0,15)}...)`);
  console.log(`  JanusERC20: (${s0.musdc.x.toString().slice(0,15)}...)`);
  console.log(`  JanusFT:    (${s0.mockft.x.toString().slice(0,15)}...)`);

  if (s0.flow.x === 0n && s0.flow.y === 1n)   throw new Error("JanusFlow is identity — combo-A state not found");
  if (s0.musdc.x === 0n && s0.musdc.y === 1n) throw new Error("JanusERC20 is identity — combo-A state not found");
  if (s0.mockft.x === 0n && s0.mockft.y === 1n) throw new Error("JanusFT is identity — fresh wrap failed");
  console.log("  All 3 non-identity: PASS");

  // Track alice's running state
  let aliceFlowV = aliceFlowV_A, aliceFlowR = aliceFlowR_A;
  let aliceMusdcV = aliceMusdcV_A, aliceMusdcR = aliceMusdcR_A;

  // -------------------------------------------------------------------------
  // Op 1: shieldedTransfer 0.01 FLOW to Bob_D
  // -------------------------------------------------------------------------
  console.log("\n--- Op 1: shieldedTransfer 0.01 FLOW → Bob_D ---");
  const preOp1 = await snapshotAllCommits(alice.address, provider);

  const flowSendBl = await randomScalar(), newFlowBl = await randomScalar();
  console.log("  Generating FLOW transfer proof...");
  const flowXP = await generateProof({
    old_value: aliceFlowV, old_blinding: aliceFlowR,
    transfer_value: FLOW_OP_SEND, transfer_blinding: flowSendBl, new_blinding: newFlowBl,
  });
  const { ciphertext: fNote, ephemeralPubkey: fEph } = await encryptNote(
    { amount: FLOW_OP_SEND, blinding: flowSendBl }, bobDJub.pubkey
  );
  const op1Tx = await jfA.shieldedTransfer(bobD.address, flowXP.pubSignals, flatProof(flowXP), fNote, fEph.x, fEph.y);
  await waitTx(op1Tx, "op1-flow-send");
  aliceFlowV -= FLOW_OP_SEND; aliceFlowR = newFlowBl;

  const postOp1 = await snapshotAllCommits(alice.address, provider);
  const op1_flow_chg   = !commitEq(preOp1.flow,   postOp1.flow);
  const op1_musdc_same =  commitEq(preOp1.musdc,  postOp1.musdc);
  const op1_ft_same    =  commitEq(preOp1.mockft, postOp1.mockft);

  console.log(`  JanusFlow changed:   ${op1_flow_chg} (expected true)`);
  console.log(`  JanusERC20 same:     ${op1_musdc_same} (expected true)`);
  console.log(`  JanusFT same:        ${op1_ft_same} (expected true)`);

  if (!op1_flow_chg)   throw new Error("Op1: JanusFlow should have changed!");
  if (!op1_musdc_same) throw new Error("Op1: JanusERC20 should be UNCHANGED!");
  if (!op1_ft_same)    throw new Error("Op1: JanusFT should be UNCHANGED!");
  console.log("  Op1 isolation: PASS");

  results.steps.op1_flow_send = {
    tx: op1Tx.hash, flow_changed: true, musdc_same: true, ft_same: true,
    isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  // drain bob_D inbox
  await waitTx(await inboxB.drainBatch(10), "drain-bob-D-op1");

  // -------------------------------------------------------------------------
  // Op 2: shieldedTransfer 0.5 mUSDC to Carol_D
  // -------------------------------------------------------------------------
  console.log("\n--- Op 2: shieldedTransfer 0.5 mUSDC → Carol_D ---");
  const preOp2 = await snapshotAllCommits(alice.address, provider);

  const musdcSendBl = await randomScalar(), newMusdcBl = await randomScalar();
  console.log("  Generating mUSDC transfer proof...");
  const musdcXP = await generateProof({
    old_value: aliceMusdcV, old_blinding: aliceMusdcR,
    transfer_value: MUSDC_OP_SEND, transfer_blinding: musdcSendBl, new_blinding: newMusdcBl,
  });
  const { ciphertext: mNote, ephemeralPubkey: mEph } = await encryptNote(
    { amount: MUSDC_OP_SEND, blinding: musdcSendBl }, carolDJub.pubkey
  );
  const op2Tx = await jeA.shieldedTransfer(carolD.address, musdcXP.pubSignals, flatProof(musdcXP), mNote, mEph.x, mEph.y);
  await waitTx(op2Tx, "op2-musdc-send");
  aliceMusdcV -= MUSDC_OP_SEND; aliceMusdcR = newMusdcBl;

  const postOp2 = await snapshotAllCommits(alice.address, provider);
  const op2_flow_same  =  commitEq(preOp2.flow,   postOp2.flow);
  const op2_musdc_chg  = !commitEq(preOp2.musdc,  postOp2.musdc);
  const op2_ft_same    =  commitEq(preOp2.mockft, postOp2.mockft);

  console.log(`  JanusFlow same:      ${op2_flow_same} (expected true)`);
  console.log(`  JanusERC20 changed:  ${op2_musdc_chg} (expected true)`);
  console.log(`  JanusFT same:        ${op2_ft_same} (expected true)`);

  if (!op2_flow_same)  throw new Error("Op2: JanusFlow should be UNCHANGED!");
  if (!op2_musdc_chg)  throw new Error("Op2: JanusERC20 should have changed!");
  if (!op2_ft_same)    throw new Error("Op2: JanusFT should be UNCHANGED!");
  console.log("  Op2 isolation: PASS");

  results.steps.op2_musdc_send = {
    tx: op2Tx.hash, flow_same: true, musdc_changed: true, ft_same: true,
    isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  await waitTx(await inboxC.drainBatch(10), "drain-carol-D-op2");

  // -------------------------------------------------------------------------
  // Op 3: unwrap 0.5 mUSDC back to alice
  // -------------------------------------------------------------------------
  console.log("\n--- Op 3: unwrap 0.5 mUSDC → alice ---");
  const preOp3 = await snapshotAllCommits(alice.address, provider);

  const unwrapBl   = await randomScalar();
  const residualBl = await randomScalar();
  const residualV  = aliceMusdcV - MUSDC_OP_UNWRAP;

  console.log("  Generating mUSDC unwrap proofs...");
  const unwrapAmtP = await generateAmountDiscloseProof({ amount: MUSDC_OP_UNWRAP, blinding: unwrapBl, nonce: 0n });
  const unwrapCX = unwrapAmtP.pubSignals[1], unwrapCY = unwrapAmtP.pubSignals[2];
  const unwrapXP  = await generateProof({
    old_value: aliceMusdcV, old_blinding: aliceMusdcR,
    transfer_value: MUSDC_OP_UNWRAP, transfer_blinding: unwrapBl, new_blinding: residualBl,
  });
  // Verify C_tx matches
  if (unwrapXP.pubSignals[2] !== unwrapCX || unwrapXP.pubSignals[3] !== unwrapCY) {
    throw new Error("C_tx mismatch — proof inputs inconsistent");
  }
  const { ciphertext: uSnap, ephemeralPubkey: uEph } = await encryptNote(
    { amount: residualV, blinding: residualBl }, aliceJub.pubkey
  );
  const op3Tx = await jeA.unwrap(
    MUSDC_OP_UNWRAP, alice.address, [unwrapCX, unwrapCY],
    flatProof(unwrapAmtP), unwrapXP.pubSignals, flatProof(unwrapXP), uSnap, uEph.x, uEph.y
  );
  await waitTx(op3Tx, "op3-musdc-unwrap");
  aliceMusdcV = residualV; aliceMusdcR = residualBl;

  const postOp3 = await snapshotAllCommits(alice.address, provider);
  const op3_flow_same  =  commitEq(preOp3.flow,   postOp3.flow);
  const op3_musdc_chg  = !commitEq(preOp3.musdc,  postOp3.musdc);
  const op3_ft_same    =  commitEq(preOp3.mockft, postOp3.mockft);

  console.log(`  JanusFlow same:      ${op3_flow_same} (expected true)`);
  console.log(`  JanusERC20 changed:  ${op3_musdc_chg} (expected true)`);
  console.log(`  JanusFT same:        ${op3_ft_same} (expected true)`);

  if (!op3_flow_same)  throw new Error("Op3: JanusFlow should be UNCHANGED!");
  if (!op3_musdc_chg)  throw new Error("Op3: JanusERC20 should have changed!");
  if (!op3_ft_same)    throw new Error("Op3: JanusFT should be UNCHANGED!");
  console.log("  Op3 isolation: PASS");

  results.steps.op3_musdc_unwrap = {
    tx: op3Tx.hash, flow_same: true, musdc_changed: true, ft_same: true,
    isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Op 4: shieldedTransfer 1 MockFT to testnet-bob (Cadence)
  // -------------------------------------------------------------------------
  console.log("\n--- Op 4: shieldedTransfer 1 MockFT → testnet-bob ---");
  const preOp4 = await snapshotAllCommits(alice.address, provider);

  const ftSendBl = await randomScalar(), newFTBl = await randomScalar();
  console.log("  Generating MockFT transfer proof...");
  const ftXP = await generateProof({
    old_value: aliceFTV, old_blinding: aliceFTR,
    transfer_value: FT_OP_SEND, transfer_blinding: ftSendBl, new_blinding: newFTBl,
  });
  const { ciphertext: ftNote, ephemeralPubkey: ftNoteEph } = await encryptNote(
    { amount: FT_OP_SEND, blinding: ftSendBl }, bobCadenceJub.pubkey
  );
  flowSend("shielded_transfer_mockft.cdc", ALICE_FLOW_ACCT, [
    addressArg(ALICE_CADENCE_ADDR), addressArg(BOB_CADENCE_ADDR),
    arrayUint256(flatProof(ftXP)), arrayUint256(ftXP.pubSignals),
    arrayUint8(ftNote), uint256Arg(ftNoteEph.x), uint256Arg(ftNoteEph.y),
  ]);
  aliceFTV -= FT_OP_SEND; aliceFTR = newFTBl;

  const postOp4 = await snapshotAllCommits(alice.address, provider);
  const op4_flow_same  =  commitEq(preOp4.flow,   postOp4.flow);
  const op4_musdc_same =  commitEq(preOp4.musdc,  postOp4.musdc);
  const op4_ft_chg     = !commitEq(preOp4.mockft, postOp4.mockft);

  console.log(`  JanusFlow same:   ${op4_flow_same} (expected true)`);
  console.log(`  JanusERC20 same:  ${op4_musdc_same} (expected true)`);
  console.log(`  JanusFT changed:  ${op4_ft_chg} (expected true)`);

  if (!op4_flow_same)  throw new Error("Op4: JanusFlow should be UNCHANGED!");
  if (!op4_musdc_same) throw new Error("Op4: JanusERC20 should be UNCHANGED!");
  if (!op4_ft_chg)     throw new Error("Op4: JanusFT should have changed!");
  console.log("  Op4 isolation: PASS");

  results.steps.op4_ft_send = {
    flow_same: true, musdc_same: true, ft_changed: true,
    isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  results.summary  = {
    alice_evm: alice.address, ops_tested: 4, all_isolation_pass: true,
    ops: {
      op1_flow_send:   true,
      op2_musdc_send:  true,
      op3_musdc_unwrap: true,
      op4_ft_send:     true,
    },
  };
  saveResults();

  console.log("\n=== Scenario 10.D RESULT: GREEN ===");
  console.log("  All 4 ops showed cross-token isolation — only operated token changed");
}

main()
  .then(() => { console.log("\n10.D complete"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
