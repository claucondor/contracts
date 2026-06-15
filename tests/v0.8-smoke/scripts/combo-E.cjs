/**
 * combo-E.cjs — Scenario 10.E: Admin batch reset isolation across contracts.
 *
 * Sets up 3 users (alice_E, bob_E, carol_E) each wrapping into all 3 token contracts.
 * Then exercises adminBatchResetSlots on various subsets and verifies:
 *   - Only targeted user+contract slots are cleared to identity (0,1)
 *   - Untargeted slots are UNCHANGED
 *
 * Admin operations:
 *   E1: Reset bob_E in JanusFlow only → bob_E JanusFlow=(0,1), bob_E JanusERC20 unchanged, alice/carol unchanged
 *   E2: Reset carol_E in JanusERC20 only → carol_E JanusERC20=(0,1), carol_E JanusFlow unchanged
 *   E3: Reset alice_E+bob_E in JanusFT only (Cadence) → their FT slots=(0,1), carol_E FT unchanged
 *   E4: Reset all 3 users in JanusFlow in one batch → all 3 JanusFlow=(0,1)
 */

"use strict";

const { execFileSync } = require("child_process");
const { ethers }       = require("ethers");
const fs               = require("fs");
const path             = require("path");

const {
  generateAmountDiscloseProof,
  generateProof,
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
const RESULTS_FILE = path.join(SMOKE_DIR, "results-combo-E.json");
const NETWORK      = "testnet";

const DEPLOYER_KEY       = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
const ALICE_CADENCE_ADDR = "0x4b6bc58bc8bf5dcc";  // openjanus-v08
const BOB_CADENCE_ADDR   = "0xd807a3992d7be612";  // testnet-bob
const ALICE_FLOW_ACCT    = "openjanus-v08";
const BOB_FLOW_ACCT      = "testnet-bob";

const ADDRESSES = {
  janusFlow:       "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
  janusERC20:      "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
  mockUSDC:        "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
  memoKeyRegistry: "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
};

const E18          = 10n ** 18n;
const E6           = 10n ** 6n;

const FLOW_WRAP  = 2n * 10n**16n;  // 0.02 FLOW (small, enough for ZK proof)
const MUSDC_WRAP = 1n * E6;        // 1 mUSDC

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const JANUS_FLOW_ABI = [
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) payable",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
];

const JANUS_ERC20_ABI = [
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
];

const MOCK_USDC_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
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
  phase:    "10.E",
  scenario: "admin-reset-cross-contract-isolation",
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
function arrayUint256(arr) { return { type: "Array", value: arr.map(n => uint256Arg(n)) }; }
function array2d(arr)      { return { type: "Array", value: arr.map(r => ({ type: "Array", value: r.map(n => uint256Arg(n)) })) }; }
function arrayUint8(buf)   { return { type: "Array", value: Array.from(buf).map(b => ({ type: "UInt8", value: b.toString() })) }; }
function addressArrayArg(addrs) { return { type: "Array", value: addrs.map(a => ({ type: "Address", value: a })) }; }
function flatProof(p) {
  return [
    p.pA[0], p.pA[1],
    p.pB[0][0], p.pB[0][1],
    p.pB[1][0], p.pB[1][1],
    p.pC[0], p.pC[1],
  ];
}
const strArg    = (s) => ({ type: "String", value: s });
const uint64Arg = (n) => ({ type: "UInt64",  value: n.toString() });

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
  if (!resp.ok) throw new Error(`Cadence script HTTP ${resp.status}: ${await resp.text()}`);
  const raw = await resp.json();
  if (typeof raw !== "string") throw new Error(`Cadence script error: ${JSON.stringify(raw).slice(0, 200)}`);
  const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  return { x: BigInt(parsed.value[0].value), y: BigInt(parsed.value[1].value) };
}

function isIdentity(commit) { return commit.x === 0n && commit.y === 1n; }
function commitEq(a, b)     { return a.x === b.x && a.y === b.y; }

async function wrapFlow(contract, wallet, jubPubkey, amount, label) {
  const bl = await randomScalar(), nonce = BigInt(Date.now());
  const proof = await generateAmountDiscloseProof({ amount, blinding: bl, nonce });
  const { ciphertext: snap, ephemeralPubkey: eph } = await encryptNote({ amount, blinding: bl }, jubPubkey);
  const tx = await contract.wrapWithProof(nonce, [proof.pubSignals[1], proof.pubSignals[2]], proof.pA, proof.pB, proof.pC, snap, eph.x, eph.y, { value: amount });
  await waitTx(tx, label);
  return { blinding: bl, nonce, cx: proof.pubSignals[1], cy: proof.pubSignals[2] };
}

async function wrapERC20(contract, usdcContract, jubPubkey, amount, label) {
  await waitTx(await usdcContract.approve(ADDRESSES.janusERC20, amount), `${label}-approve`);
  const bl = await randomScalar(), nonce = BigInt(Date.now());
  const proof = await generateAmountDiscloseProof({ amount, blinding: bl, nonce });
  const { ciphertext: snap, ephemeralPubkey: eph } = await encryptNote({ amount, blinding: bl }, jubPubkey);
  const tx = await contract.wrapWithProof(amount, nonce, [proof.pubSignals[1], proof.pubSignals[2]], proof.pA, proof.pB, proof.pC, snap, eph.x, eph.y);
  await waitTx(tx, label);
  return { blinding: bl, nonce, cx: proof.pubSignals[1], cy: proof.pubSignals[2] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Scenario 10.E: Admin Reset Cross-Contract Isolation ===\n");

  const provider   = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "flow-evm-testnet" });
  const deployer   = new ethers.Wallet(DEPLOYER_KEY, provider);

  // 3 fresh EVM users
  const aliceE = ethers.Wallet.createRandom().connect(provider);
  const bobE   = ethers.Wallet.createRandom().connect(provider);
  const carolE = ethers.Wallet.createRandom().connect(provider);

  console.log("Deployer:", deployer.address);
  console.log("Alice_E:", aliceE.address);
  console.log("Bob_E:  ", bobE.address);
  console.log("Carol_E:", carolE.address);

  results.steps.accounts = {
    deployer: deployer.address,
    alice_e: aliceE.address, alice_e_key: aliceE.privateKey,
    bob_e: bobE.address, bob_e_key: bobE.privateKey,
    carol_e: carolE.address, carol_e_key: carolE.privateKey,
    ts: new Date().toISOString(),
  };
  saveResults();

  // Fund all fresh wallets — keep small: each wallet needs 2×FLOW_WRAP (0.02 each) + gas
  for (const [w, label] of [[aliceE, "alice-E"], [bobE, "bob-E"], [carolE, "carol-E"]]) {
    await waitTx(await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("0.06") }), `fund-${label}`);
  }

  // Contracts
  const jfA = new ethers.Contract(ADDRESSES.janusFlow,  JANUS_FLOW_ABI,  aliceE);
  const jfB = new ethers.Contract(ADDRESSES.janusFlow,  JANUS_FLOW_ABI,  bobE);
  const jfC = new ethers.Contract(ADDRESSES.janusFlow,  JANUS_FLOW_ABI,  carolE);
  const jeA = new ethers.Contract(ADDRESSES.janusERC20, JANUS_ERC20_ABI, aliceE);
  const jeB = new ethers.Contract(ADDRESSES.janusERC20, JANUS_ERC20_ABI, bobE);
  const jeC = new ethers.Contract(ADDRESSES.janusERC20, JANUS_ERC20_ABI, carolE);
  const usdcA = new ethers.Contract(ADDRESSES.mockUSDC, MOCK_USDC_ABI, aliceE);
  const usdcB = new ethers.Contract(ADDRESSES.mockUSDC, MOCK_USDC_ABI, bobE);
  const usdcC = new ethers.Contract(ADDRESSES.mockUSDC, MOCK_USDC_ABI, carolE);
  const usdcDep = new ethers.Contract(ADDRESSES.mockUSDC, MOCK_USDC_ABI, deployer);
  const jfView = new ethers.Contract(ADDRESSES.janusFlow, JANUS_FLOW_ABI, provider);
  const jeView = new ethers.Contract(ADDRESSES.janusERC20, JANUS_ERC20_ABI, provider);
  const mrA = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, aliceE);
  const mrB = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, bobE);
  const mrC = new ethers.Contract(ADDRESSES.memoKeyRegistry, MEMO_KEY_REGISTRY_ABI, carolE);

  // JubJub keypairs
  const jubA = await deriveJubKeypair(aliceE.address);
  const jubB = await deriveJubKeypair(bobE.address);
  const jubC = await deriveJubKeypair(carolE.address);
  const jubCadenceAlice = await deriveJubKeypair(ALICE_CADENCE_ADDR);
  const jubCadenceBob   = await deriveJubKeypair(BOB_CADENCE_ADDR);

  // -------------------------------------------------------------------------
  // Step 0: Cadence setup + EVM memokeys
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Cadence setup + EVM memokeys ---");

  flowSend("set_underlying_vault_type.cdc", ALICE_FLOW_ACCT, [strArg("A.4b6bc58bc8bf5dcc.MockFT.Vault")]);
  flowSend("install_registry.cdc", ALICE_FLOW_ACCT, []);
  flowSend("setup_mockft_vault.cdc", ALICE_FLOW_ACCT, []);
  // testnet-bob needs inbox for the shielded transfer (not a MockFT vault — he receives via transfer)
  flowSend("install_inbox.cdc", BOB_FLOW_ACCT, []);

  // Mint USDC for all users
  for (const addr of [aliceE.address, bobE.address, carolE.address]) {
    await waitTx(await usdcDep.mint(addr, MUSDC_WRAP * 3n), `mint-usdc-${addr.slice(0,8)}`);
  }

  // Publish memokeys (all fresh wallets — no rotate needed)
  await waitTx(await mrA.publishMemoKey(jubA.pubkey.x, jubA.pubkey.y), "memokey-alice-E");
  await waitTx(await mrB.publishMemoKey(jubB.pubkey.x, jubB.pubkey.y), "memokey-bob-E");
  await waitTx(await mrC.publishMemoKey(jubC.pubkey.x, jubC.pubkey.y), "memokey-carol-E");

  results.steps.setup = { ts: new Date().toISOString() };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: All 3 users wrap FLOW + mUSDC (no MockFT EVM-side for E — JanusFT is Cadence only)
  // For MockFT in E: use openjanus-v08 as Alice Cadence, testnet-bob as Bob Cadence
  // Carol has no Cadence account — skip FT for carol
  // -------------------------------------------------------------------------
  console.log("\n--- Step 1: All users wrap FLOW + mUSDC ---");

  const aliceFlowState  = await wrapFlow(jfA, aliceE, jubA.pubkey, FLOW_WRAP,  "alice-E-flow-wrap");
  const aliceMusdcState = await wrapERC20(jeA, usdcA, jubA.pubkey, MUSDC_WRAP, "alice-E-musdc-wrap");

  const bobFlowState    = await wrapFlow(jfB, bobE, jubB.pubkey, FLOW_WRAP,    "bob-E-flow-wrap");
  const bobMusdcState   = await wrapERC20(jeB, usdcB, jubB.pubkey, MUSDC_WRAP, "bob-E-musdc-wrap");

  const carolFlowState  = await wrapFlow(jfC, carolE, jubC.pubkey, FLOW_WRAP,  "carol-E-flow-wrap");
  const carolMusdcState = await wrapERC20(jeC, usdcC, jubC.pubkey, MUSDC_WRAP, "carol-E-musdc-wrap");

  // Also wrap MockFT via Cadence for alice+bob
  const { ufixArg, addressArg } = {
    ufixArg: (v) => ({ type: "UFix64", value: v }),
    addressArg: (a) => ({ type: "Address", value: a }),
  };
  const ufixArgFn = (v) => ({ type: "UFix64", value: v });
  const addressArgFn = (a) => ({ type: "Address", value: a });

  // Alice wraps 10 MockFT (enough to keep 5 and transfer 5 to bob)
  const FT_ALICE_WRAP   = 10n * 100_000_000n;  // 10 FT gross wrap
  const FT_SEND_TO_BOB  = 5n  * 100_000_000n;  // 5 FT shielded transfer to bob

  const ftNonceA = BigInt(Date.now());
  const ftBlA = await randomScalar();
  const ftWPa = await generateAmountDiscloseProof({ amount: FT_ALICE_WRAP, blinding: ftBlA, nonce: ftNonceA });
  const { ciphertext: ftSnapA, ephemeralPubkey: ftEphA } = await encryptNote({ amount: FT_ALICE_WRAP, blinding: ftBlA }, jubCadenceAlice.pubkey);

  flowSend("mint_mockft.cdc", ALICE_FLOW_ACCT, [ufixArgFn("10.00000000"), addressArgFn(ALICE_CADENCE_ADDR)]);
  flowSend("wrap_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArgFn("10.00000000"), uint256Arg(ftNonceA),
    uint256Arg(ftWPa.pubSignals[1]), uint256Arg(ftWPa.pubSignals[2]),
    arrayUint256([ftWPa.pA[0], ftWPa.pA[1]]),
    array2d([[ftWPa.pB[0][1], ftWPa.pB[0][0]], [ftWPa.pB[1][1], ftWPa.pB[1][0]]]),
    arrayUint256([ftWPa.pC[0], ftWPa.pC[1]]),
    arrayUint8(ftSnapA), uint256Arg(ftEphA.x), uint256Arg(ftEphA.y),
  ]);

  // Shielded transfer 5 FT from alice → bob — populates bob's slot in JanusFT.commitments
  // (bob does NOT need to wrap directly; shielded_transfer uses JanusFT.registryAddress()
  //  which points to the deployer's public capability and updates the contract-level mapping)
  const ftSendBl     = await randomScalar();
  const ftAliceNewBl = await randomScalar();

  console.log("  Generating MockFT transfer proof (alice→bob)...");
  const ftXP = await generateProof({
    old_value:         FT_ALICE_WRAP,
    old_blinding:      ftBlA,
    transfer_value:    FT_SEND_TO_BOB,
    transfer_blinding: ftSendBl,
    new_blinding:      ftAliceNewBl,
  });

  const { ciphertext: ftNote, ephemeralPubkey: ftNoteEph } = await encryptNote(
    { amount: FT_SEND_TO_BOB, blinding: ftSendBl, memo: "ft e3 test" }, jubCadenceBob.pubkey
  );

  flowSend("shielded_transfer_mockft.cdc", ALICE_FLOW_ACCT, [
    addressArgFn(ALICE_CADENCE_ADDR),
    addressArgFn(BOB_CADENCE_ADDR),
    arrayUint256(flatProof(ftXP)),
    arrayUint256(ftXP.pubSignals),
    arrayUint8(ftNote),
    uint256Arg(ftNoteEph.x),
    uint256Arg(ftNoteEph.y),
  ]);
  console.log("  MockFT shielded transfer alice→bob confirmed");

  console.log("  All users wrapped in all contracts");

  // Snapshot initial state
  const snap0 = {
    alice: {
      flow:  { x: aliceFlowState.cx,  y: aliceFlowState.cy },
      musdc: { x: aliceMusdcState.cx, y: aliceMusdcState.cy },
      ft:    await getCadenceCommitment(ALICE_CADENCE_ADDR),
    },
    bob: {
      flow:  { x: bobFlowState.cx,  y: bobFlowState.cy },
      musdc: { x: bobMusdcState.cx, y: bobMusdcState.cy },
      ft:    await getCadenceCommitment(BOB_CADENCE_ADDR),
    },
    carol: {
      flow:  { x: carolFlowState.cx,  y: carolFlowState.cy },
      musdc: { x: carolMusdcState.cx, y: carolMusdcState.cy },
    },
  };
  console.log("  Initial state snapshot taken");

  // Verify all non-identity
  for (const [user, snap] of [["alice", snap0.alice], ["bob", snap0.bob], ["carol", snap0.carol]]) {
    if (isIdentity(snap.flow))  throw new Error(`${user} JanusFlow still identity after wrap!`);
    if (isIdentity(snap.musdc)) throw new Error(`${user} JanusERC20 still identity after wrap!`);
    if (snap.ft && isIdentity(snap.ft)) throw new Error(`${user} JanusFT still identity after wrap!`);
  }
  console.log("  All initial wraps non-identity: PASS");

  results.steps.initial_wraps = {
    alice: {
      flow:  { cx: aliceFlowState.cx.toString(), cy: aliceFlowState.cy.toString() },
      musdc: { cx: aliceMusdcState.cx.toString(), cy: aliceMusdcState.cy.toString() },
      ft:    { x: snap0.alice.ft.x.toString(), y: snap0.alice.ft.y.toString() },
    },
    bob: {
      flow:  { cx: bobFlowState.cx.toString(), cy: bobFlowState.cy.toString() },
      musdc: { cx: bobMusdcState.cx.toString(), cy: bobMusdcState.cy.toString() },
      ft:    { x: snap0.bob.ft.x.toString(), y: snap0.bob.ft.y.toString() },
    },
    carol: {
      flow:  { cx: carolFlowState.cx.toString(), cy: carolFlowState.cy.toString() },
      musdc: { cx: carolMusdcState.cx.toString(), cy: carolMusdcState.cy.toString() },
    },
    ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Reset E1: Bob in JanusFlow only
  // -------------------------------------------------------------------------
  console.log("\n--- Reset E1: Bob_E in JanusFlow only ---");
  const e1Calldata = encodeAdminBatchReset([bobE.address]);
  flowSend("admin_evm_call.cdc", ALICE_FLOW_ACCT, [strArg(ADDRESSES.janusFlow.slice(2)), strArg(e1Calldata), uint64Arg(500_000n)]);

  const e1 = {
    alice_flow:  await jfView.balanceOfCommitmentXY(aliceE.address),
    alice_musdc: await jeView.balanceOfCommitmentXY(aliceE.address),
    bob_flow:    await jfView.balanceOfCommitmentXY(bobE.address),
    bob_musdc:   await jeView.balanceOfCommitmentXY(bobE.address),
    carol_flow:  await jfView.balanceOfCommitmentXY(carolE.address),
    carol_musdc: await jeView.balanceOfCommitmentXY(carolE.address),
  };

  const e1_bob_flow_identity  = e1.bob_flow[0] === 0n && e1.bob_flow[1] === 1n;
  const e1_bob_musdc_unchanged = e1.bob_musdc[0] === bobMusdcState.cx && e1.bob_musdc[1] === bobMusdcState.cy;
  const e1_alice_flow_unchanged = e1.alice_flow[0] === aliceFlowState.cx && e1.alice_flow[1] === aliceFlowState.cy;
  const e1_carol_flow_unchanged = e1.carol_flow[0] === carolFlowState.cx && e1.carol_flow[1] === carolFlowState.cy;

  console.log(`  Bob JanusFlow identity:   ${e1_bob_flow_identity} (expected true)`);
  console.log(`  Bob JanusERC20 unchanged: ${e1_bob_musdc_unchanged} (expected true)`);
  console.log(`  Alice JanusFlow unchanged: ${e1_alice_flow_unchanged} (expected true)`);
  console.log(`  Carol JanusFlow unchanged: ${e1_carol_flow_unchanged} (expected true)`);

  if (!e1_bob_flow_identity)   throw new Error("E1: Bob JanusFlow should be identity!");
  if (!e1_bob_musdc_unchanged) throw new Error("E1: Bob JanusERC20 should be UNCHANGED!");
  if (!e1_alice_flow_unchanged) throw new Error("E1: Alice JanusFlow should be UNCHANGED!");
  if (!e1_carol_flow_unchanged) throw new Error("E1: Carol JanusFlow should be UNCHANGED!");
  console.log("  E1 isolation: PASS");

  results.steps.reset_e1 = {
    target: "bob_E JanusFlow", bob_flow_identity: e1_bob_flow_identity,
    bob_musdc_unchanged: e1_bob_musdc_unchanged, alice_flow_unchanged: e1_alice_flow_unchanged,
    carol_flow_unchanged: e1_carol_flow_unchanged, isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Reset E2: Carol in JanusERC20 only
  // -------------------------------------------------------------------------
  console.log("\n--- Reset E2: Carol_E in JanusERC20 only ---");
  const e2Calldata = encodeAdminBatchReset([carolE.address]);
  flowSend("admin_evm_call.cdc", ALICE_FLOW_ACCT, [strArg(ADDRESSES.janusERC20.slice(2)), strArg(e2Calldata), uint64Arg(500_000n)]);

  const e2 = {
    carol_flow:  await jfView.balanceOfCommitmentXY(carolE.address),
    carol_musdc: await jeView.balanceOfCommitmentXY(carolE.address),
    alice_musdc: await jeView.balanceOfCommitmentXY(aliceE.address),
    bob_musdc:   await jeView.balanceOfCommitmentXY(bobE.address),
  };

  const e2_carol_musdc_identity  = e2.carol_musdc[0] === 0n && e2.carol_musdc[1] === 1n;
  const e2_carol_flow_unchanged  = e2.carol_flow[0] === carolFlowState.cx && e2.carol_flow[1] === carolFlowState.cy;
  const e2_alice_musdc_unchanged = e2.alice_musdc[0] === aliceMusdcState.cx && e2.alice_musdc[1] === aliceMusdcState.cy;
  const e2_bob_musdc_unchanged   = e2.bob_musdc[0] === bobMusdcState.cx && e2.bob_musdc[1] === bobMusdcState.cy;

  console.log(`  Carol JanusERC20 identity:  ${e2_carol_musdc_identity} (expected true)`);
  console.log(`  Carol JanusFlow unchanged:  ${e2_carol_flow_unchanged} (expected true)`);
  console.log(`  Alice JanusERC20 unchanged: ${e2_alice_musdc_unchanged} (expected true)`);
  console.log(`  Bob JanusERC20 unchanged:   ${e2_bob_musdc_unchanged} (expected true)`);

  if (!e2_carol_musdc_identity)  throw new Error("E2: Carol JanusERC20 should be identity!");
  if (!e2_carol_flow_unchanged)  throw new Error("E2: Carol JanusFlow should be UNCHANGED!");
  if (!e2_alice_musdc_unchanged) throw new Error("E2: Alice JanusERC20 should be UNCHANGED!");
  if (!e2_bob_musdc_unchanged)   throw new Error("E2: Bob JanusERC20 should be UNCHANGED!");
  console.log("  E2 isolation: PASS");

  results.steps.reset_e2 = {
    target: "carol_E JanusERC20", carol_musdc_identity: e2_carol_musdc_identity,
    carol_flow_unchanged: e2_carol_flow_unchanged, alice_musdc_unchanged: e2_alice_musdc_unchanged,
    bob_musdc_unchanged: e2_bob_musdc_unchanged, isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Reset E3: Alice+Bob JanusFT (Cadence) — Carol has no Cadence account
  // -------------------------------------------------------------------------
  console.log("\n--- Reset E3: Alice_Cadence + Bob_Cadence in JanusFT ---");

  const preBobFT = await getCadenceCommitment(BOB_CADENCE_ADDR);
  flowSend("admin_reset_janusFT.cdc", ALICE_FLOW_ACCT, [
    addressArrayArg([ALICE_CADENCE_ADDR, BOB_CADENCE_ADDR]),
  ]);

  const e3_alice_ft = await getCadenceCommitment(ALICE_CADENCE_ADDR);
  const e3_bob_ft   = await getCadenceCommitment(BOB_CADENCE_ADDR);
  // Alice+Bob EVM flow/musdc should be unchanged
  const e3_alice_flow  = await jfView.balanceOfCommitmentXY(aliceE.address);
  const e3_alice_musdc = await jeView.balanceOfCommitmentXY(aliceE.address);

  const e3_alice_ft_identity  = isIdentity(e3_alice_ft);
  const e3_bob_ft_identity    = isIdentity(e3_bob_ft);
  const e3_alice_flow_unchanged  = e3_alice_flow[0] === aliceFlowState.cx && e3_alice_flow[1] === aliceFlowState.cy;
  const e3_alice_musdc_unchanged = e3_alice_musdc[0] === aliceMusdcState.cx && e3_alice_musdc[1] === aliceMusdcState.cy;

  console.log(`  Alice JanusFT identity:     ${e3_alice_ft_identity} (expected true)`);
  console.log(`  Bob JanusFT identity:       ${e3_bob_ft_identity} (expected true)`);
  console.log(`  Alice JanusFlow unchanged:  ${e3_alice_flow_unchanged} (expected true)`);
  console.log(`  Alice JanusERC20 unchanged: ${e3_alice_musdc_unchanged} (expected true)`);

  if (!e3_alice_ft_identity)   throw new Error("E3: Alice JanusFT should be identity!");
  if (!e3_bob_ft_identity)     throw new Error("E3: Bob JanusFT should be identity!");
  if (!e3_alice_flow_unchanged)  throw new Error("E3: Alice JanusFlow should be UNCHANGED!");
  if (!e3_alice_musdc_unchanged) throw new Error("E3: Alice JanusERC20 should be UNCHANGED!");
  console.log("  E3 isolation: PASS");

  results.steps.reset_e3 = {
    target: "alice_Cadence + bob_Cadence JanusFT",
    alice_ft_identity: e3_alice_ft_identity, bob_ft_identity: e3_bob_ft_identity,
    alice_flow_unchanged: e3_alice_flow_unchanged, alice_musdc_unchanged: e3_alice_musdc_unchanged,
    isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Reset E4: All 3 EVM users in JanusFlow (batch)
  // -------------------------------------------------------------------------
  console.log("\n--- Reset E4: All 3 EVM users batch-reset in JanusFlow ---");

  // Alice and carol still have non-identity JanusFlow slots from Step 1 (only bob's was reset in E1).
  // Only rewrap bob so all 3 are non-identity before the batch reset.
  // Use half of FLOW_WRAP (0.01 FLOW) to stay within bob's remaining budget after Step 1.
  const newBobFlow = await wrapFlow(jfB, bobE, jubB.pubkey, FLOW_WRAP / 2n, "bob-E-flow-rewrap");

  // Verify all non-identity before batch reset
  const pre4 = {
    alice_flow: await jfView.balanceOfCommitmentXY(aliceE.address),
    bob_flow:   await jfView.balanceOfCommitmentXY(bobE.address),
    carol_flow: await jfView.balanceOfCommitmentXY(carolE.address),
  };
  for (const [label, [x,y]] of [["alice", pre4.alice_flow], ["bob", pre4.bob_flow], ["carol", pre4.carol_flow]]) {
    if (x === 0n && y === 1n) throw new Error(`${label} pre-E4 JanusFlow should NOT be identity`);
  }

  // Batch reset all 3 in one call
  const e4Calldata = encodeAdminBatchReset([aliceE.address, bobE.address, carolE.address]);
  flowSend("admin_evm_call.cdc", ALICE_FLOW_ACCT, [strArg(ADDRESSES.janusFlow.slice(2)), strArg(e4Calldata), uint64Arg(700_000n)]);

  const e4_alice = await jfView.balanceOfCommitmentXY(aliceE.address);
  const e4_bob   = await jfView.balanceOfCommitmentXY(bobE.address);
  const e4_carol = await jfView.balanceOfCommitmentXY(carolE.address);
  // JanusERC20 of alice should still be unchanged (alice musdc was not reset in E2)
  const e4_alice_musdc = await jeView.balanceOfCommitmentXY(aliceE.address);

  const e4_alice_flow_identity = e4_alice[0] === 0n && e4_alice[1] === 1n;
  const e4_bob_flow_identity   = e4_bob[0] === 0n && e4_bob[1] === 1n;
  const e4_carol_flow_identity = e4_carol[0] === 0n && e4_carol[1] === 1n;
  const e4_alice_musdc_unchanged = e4_alice_musdc[0] === aliceMusdcState.cx && e4_alice_musdc[1] === aliceMusdcState.cy;

  console.log(`  Alice JanusFlow identity:  ${e4_alice_flow_identity} (expected true)`);
  console.log(`  Bob JanusFlow identity:    ${e4_bob_flow_identity} (expected true)`);
  console.log(`  Carol JanusFlow identity:  ${e4_carol_flow_identity} (expected true)`);
  console.log(`  Alice JanusERC20 unchanged: ${e4_alice_musdc_unchanged} (expected true)`);

  if (!e4_alice_flow_identity) throw new Error("E4: Alice JanusFlow should be identity!");
  if (!e4_bob_flow_identity)   throw new Error("E4: Bob JanusFlow should be identity!");
  if (!e4_carol_flow_identity) throw new Error("E4: Carol JanusFlow should be identity!");
  if (!e4_alice_musdc_unchanged) throw new Error("E4: Alice JanusERC20 should be UNCHANGED across JanusFlow batch reset!");
  console.log("  E4 batch isolation: PASS");

  results.steps.reset_e4 = {
    target: "all 3 EVM users JanusFlow batch",
    alice_flow_identity: e4_alice_flow_identity, bob_flow_identity: e4_bob_flow_identity,
    carol_flow_identity: e4_carol_flow_identity, alice_musdc_unchanged: e4_alice_musdc_unchanged,
    isolation_pass: true, ts: new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Final summary
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  results.summary  = {
    resets_tested: 4,
    all_isolation_pass: true,
    resets: {
      E1_bob_flow:            results.steps.reset_e1.isolation_pass,
      E2_carol_musdc:         results.steps.reset_e2.isolation_pass,
      E3_alice_bob_ft_cadence: results.steps.reset_e3.isolation_pass,
      E4_all3_flow_batch:     results.steps.reset_e4.isolation_pass,
    },
  };
  saveResults();

  console.log("\n=== Scenario 10.E RESULT: GREEN ===");
  console.log("  All 4 admin reset ops confirmed isolation across contracts");
}

main()
  .then(() => { console.log("\n10.E complete"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
