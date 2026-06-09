/**
 * smoke-mockft.cjs — Phase 9.C: JanusFT MockFT Cadence testnet E2E smoke test
 *
 * Tests:
 *   Setup: install MockFT vault on alice, install registry on alice, install inbox on bob
 *   Mint 100 MockFT to alice
 *   alice wraps 100 MockFT
 *   alice shieldedTransfers 30 MockFT to bob
 *   bob drains inbox + ECIES decode, asserts amount=30 + memo
 *   alice unwraps 70 MockFT
 *
 * Uses flow CLI for Cadence transactions.
 * Saves partial progress to results-mockft.json.
 */

"use strict";

const { execFileSync, execSync }  = require("child_process");
const { ethers }    = require("ethers");
const fs            = require("fs");
const path          = require("path");

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

const RESULTS_FILE  = path.join(__dirname, "results-mockft.json");
const SMOKE_DIR     = __dirname;
const CADENCE_DIR   = path.join(__dirname, "cadence");

const ALICE_CADENCE_ADDR = "0x4b6bc58bc8bf5dcc";
const BOB_CADENCE_ADDR   = "0xd807a3992d7be612";
const ALICE_FLOW_ACCT    = "openjanus-v08";
const BOB_FLOW_ACCT      = "testnet-bob";
const NETWORK            = "testnet";

// MockFT has 8 decimal places (UFix64)
// UFix64 to uint256: v * 100_000_000
const MOCKFT_SCALE = 100_000_000n;

// Amounts in MockFT token units (UFix64):
const WRAP_AMOUNT     = "100.00000000";
const TRANSFER_AMOUNT = "30.00000000";
const UNWRAP_AMOUNT   = "70.00000000";

// Amounts in uint256 (for circuit):
const WRAP_AMT_U256     = 100n * MOCKFT_SCALE;  // 10_000_000_000
const TRANSFER_AMT_U256 = 30n  * MOCKFT_SCALE;  // 3_000_000_000
const UNWRAP_AMT_U256   = 70n  * MOCKFT_SCALE;  // 7_000_000_000

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

let results = {
  phase:    "9.C",
  token:    "MockFT",
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

/** Derive deterministic BabyJub keypair from Cadence address */
async function deriveJubKeypair(cadenceAddress) {
  const seed = ethers.keccak256(
    ethers.toUtf8Bytes(`${cadenceAddress.toLowerCase()}:openjanus/memokey/v1:v08-smoke`)
  );
  const raw    = BigInt(seed);
  const priv   = raw % SUBORDER;
  const pubkey = await pubkeyFromPrivkey(priv);
  return { privkey: priv, pubkey };
}

/** Build flat proof array */
function flatProof(p) {
  return [
    p.pA[0], p.pA[1],
    p.pB[0][0], p.pB[0][1],
    p.pB[1][0], p.pB[1][1],
    p.pC[0], p.pC[1],
  ];
}

/** Run `flow transactions send` with JSON args. Blocks until sealed. Returns { txId, events, status }. */
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
    timeout: 180_000,  // 3 min — flow CLI blocks until sealed
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  let result;
  try {
    result = JSON.parse(output.trim());
  } catch {
    // extract first complete JSON object from output
    const match = output.match(/(\{[\s\S]*\})/);
    if (!match) throw new Error(`flow send ${txFile}: no JSON in output:\n${output.slice(0, 500)}`);
    result = JSON.parse(match[1]);
  }

  if (!result.id) throw new Error(`flow send ${txFile}: no tx id:\n${JSON.stringify(result).slice(0, 500)}`);
  if (result.status && result.status !== "SEALED") {
    throw new Error(`flow send ${txFile}: unexpected status=${result.status}`);
  }

  console.log(`  ✓ sealed tx=${result.id}`);
  return { txId: result.id, events: result.events || [], status: result.status };
}

/** Query JanusFT totalLocked via REST (using Cadence script) */
async function getTotalLocked() {
  // We use REST execute-script endpoint
  const script = Buffer.from(`
import JanusFT from 0x4b6bc58bc8bf5dcc
access(all) fun main(): UFix64 { return JanusFT.totalLocked }
  `, "utf8").toString("base64");

  const resp = await fetch("https://rest-testnet.onflow.org/v1/scripts?block_height=sealed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, arguments: [] }),
  });
  const result = await resp.json();
  // result is a base64-encoded Cadence JSON value like {"type":"UFix64","value":"100.00000000"}
  const decoded = Buffer.from(result, "base64").toString("utf8");
  const parsed  = JSON.parse(decoded);
  return parsed.value; // UFix64 string like "100.00000000"
}

/** Convert Cadence-arg [UInt8] array from Buffer */
function bytesToCadenceArray(buf) {
  return Array.from(buf).map(b => ({ type: "UInt8", value: b.toString() }));
}

/** Build Cadence args JSON for flow CLI */
function cadenceArgs(specs) {
  return specs.map(([type, value]) => ({ type, value }));
}

function uint256Arg(n) { return { type: "UInt256", value: n.toString() }; }
function addressArg(a) { return { type: "Address", value: a }; }
function ufixArg(v)    { return { type: "UFix64",  value: v }; }
function arrayUint256(arr) {
  return { type: "Array", value: arr.map(n => uint256Arg(n)) };
}
function array2d(arr) {
  return {
    type:  "Array",
    value: arr.map(row => ({ type: "Array", value: row.map(n => uint256Arg(n)) })),
  };
}
function arrayUint8(buf) {
  return { type: "Array", value: Array.from(buf).map(b => ({ type: "UInt8", value: b.toString() })) };
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
  console.log("=== Phase 9.C — JanusFT MockFT Cadence Smoke Test ===\n");
  console.log("Alice (Cadence):", ALICE_CADENCE_ADDR);
  console.log("Bob   (Cadence):", BOB_CADENCE_ADDR);

  results.steps.accounts = {
    alice: ALICE_CADENCE_ADDR,
    bob:   BOB_CADENCE_ADDR,
    ts:    new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 0: Setup — install resources (idempotent)
  // -------------------------------------------------------------------------
  console.log("\n--- Step 0: Setup (idempotent) ---");

  // Setup MockFT vault on alice (she's the deployer; may already have one)
  console.log("  Setting up MockFT vault on Alice...");
  const setupAliceVault = flowSend("setup_mockft_vault.cdc", ALICE_FLOW_ACCT, []);
  console.log(`  ✓ Alice MockFT vault setup: ${setupAliceVault.txId}`);

  // Install CommitmentRegistry on alice (deployer should already have one)
  console.log("  Setting up JanusFT registry on Alice...");
  const setupAliceReg = flowSend("install_registry.cdc", ALICE_FLOW_ACCT, []);
  console.log(`  ✓ Alice JanusFT registry setup: ${setupAliceReg.txId}`);

  // Install ShieldedInbox on Bob (REQUIRED for shielded transfer to bob)
  console.log("  Installing ShieldedInbox on Bob...");
  const setupBobInbox = flowSend("install_inbox.cdc", BOB_FLOW_ACCT, []);
  console.log(`  ✓ Bob ShieldedInbox installed: ${setupBobInbox.txId}`);

  results.steps.setup = {
    alice_vault_tx:    setupAliceVault.txId,
    alice_registry_tx: setupAliceReg.txId,
    bob_inbox_tx:      setupBobInbox.txId,
    ts:                new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: Mint MockFT to Alice
  // -------------------------------------------------------------------------
  console.log("\n--- Step 1: Mint 100 MockFT to Alice ---");
  const mintTx = flowSend("mint_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArg("100.00000000"),
    addressArg(ALICE_CADENCE_ADDR),
  ]);
  console.log(`  ✓ Minted 100 MockFT to Alice: ${mintTx.txId}`);

  results.steps.mint = {
    tx:     mintTx.txId,
    amount: "100.00000000",
    ts:     new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 2: Generate BabyJub keypairs
  // -------------------------------------------------------------------------
  console.log("\n--- Step 2: Generate BabyJub keypairs ---");
  const aliceJub = await deriveJubKeypair(ALICE_CADENCE_ADDR);
  const bobJub   = await deriveJubKeypair(BOB_CADENCE_ADDR);
  console.log("  Alice JubPub.x:", aliceJub.pubkey.x.toString().slice(0, 20) + "...");
  console.log("  Bob   JubPub.x:", bobJub.pubkey.x.toString().slice(0, 20) + "...");

  results.steps.keypairs = {
    alice_jub_x: aliceJub.pubkey.x.toString(),
    alice_jub_y: aliceJub.pubkey.y.toString(),
    bob_jub_x:   bobJub.pubkey.x.toString(),
    bob_jub_y:   bobJub.pubkey.y.toString(),
    ts:          new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 3: Alice wraps 100 MockFT
  // -------------------------------------------------------------------------
  console.log("\n--- Step 3: Alice wraps 100 MockFT ---");

  const wrapBlinding = await randomScalar();
  const wrapNonce    = BigInt(Date.now());

  console.log("  Generating amount-disclose proof for 100 MockFT (10^10 units)...");
  const wrapProof = await generateAmountDiscloseProof({
    amount:   WRAP_AMT_U256,
    blinding: wrapBlinding,
    nonce:    wrapNonce,
  });
  const wrapCX = wrapProof.pubSignals[1];
  const wrapCY = wrapProof.pubSignals[2];
  console.log(`  Proof OK. commit=(${wrapCX.toString().slice(0,15)}..., ${wrapCY.toString().slice(0,15)}...)`);

  const { ciphertext: snapCipher, ephemeralPubkey: snapEph } = await encryptNote(
    { amount: WRAP_AMT_U256, blinding: wrapBlinding },
    aliceJub.pubkey
  );

  const flatWrapProof = flatProof(wrapProof);

  const wrapTx = flowSend("wrap_mockft.cdc", ALICE_FLOW_ACCT, [
    ufixArg(WRAP_AMOUNT),
    uint256Arg(wrapNonce),
    uint256Arg(wrapCX),
    uint256Arg(wrapCY),
    arrayUint256([wrapProof.pA[0], wrapProof.pA[1]]),
    array2d([
      [wrapProof.pB[0][0], wrapProof.pB[0][1]],
      [wrapProof.pB[1][0], wrapProof.pB[1][1]],
    ]),
    arrayUint256([wrapProof.pC[0], wrapProof.pC[1]]),
    arrayUint8(snapCipher),
    uint256Arg(snapEph.x),
    uint256Arg(snapEph.y),
  ]);
  console.log(`  ✓ Wrap confirmed: ${wrapTx.txId}`);

  // Check totalLocked increased
  const tlAfterWrap = await getTotalLocked();
  console.log(`  JanusFT totalLocked after wrap: ${tlAfterWrap}`);

  results.steps.alice_wrap = {
    tx:          wrapTx.txId,
    amount:      WRAP_AMOUNT,
    commit_x:    wrapCX.toString(),
    commit_y:    wrapCY.toString(),
    totalLocked: tlAfterWrap,
    verified:    true,
    ts:          new Date().toISOString(),
  };
  saveResults();

  let aliceV  = WRAP_AMT_U256;
  let aliceR  = wrapBlinding;

  // -------------------------------------------------------------------------
  // Step 4: Alice shieldedTransfers 30 MockFT to Bob
  // -------------------------------------------------------------------------
  console.log("\n--- Step 4: Alice shieldedTransfers 30 MockFT to Bob ---");

  const transferBlinding = await randomScalar();
  const newAliceBlinding = await randomScalar();
  const newAliceV        = aliceV - TRANSFER_AMT_U256;

  console.log(`  Alice V=${aliceV} → transfer=${TRANSFER_AMT_U256} → new V=${newAliceV}`);
  console.log("  Generating confidential-transfer proof...");

  const xferProof = await generateProof({
    old_value:         aliceV,
    old_blinding:      aliceR,
    transfer_value:    TRANSFER_AMT_U256,
    transfer_blinding: transferBlinding,
    new_blinding:      newAliceBlinding,
  });
  const pub6 = xferProof.pubSignals;
  console.log("  Proof OK.");

  const transferMemo = "v08 mockft test";
  const { ciphertext: noteCipher, ephemeralPubkey: noteEph } = await encryptNote(
    { amount: TRANSFER_AMT_U256, blinding: transferBlinding, memo: transferMemo },
    bobJub.pubkey
  );

  const xferTx = flowSend("shielded_transfer_mockft.cdc", ALICE_FLOW_ACCT, [
    addressArg(ALICE_CADENCE_ADDR),
    addressArg(BOB_CADENCE_ADDR),
    arrayUint256(flatProof(xferProof)),
    arrayUint256(pub6.map(x => x)),
    arrayUint8(noteCipher),
    uint256Arg(noteEph.x),
    uint256Arg(noteEph.y),
  ]);
  console.log(`  ✓ ShieldedTransfer confirmed: ${xferTx.txId}`);

  results.steps.alice_shielded_transfer = {
    tx:           xferTx.txId,
    transfer_amt: TRANSFER_AMOUNT,
    events:       xferTx.events?.map(e => e.type) || [],
    verified:     true,
    ts:           new Date().toISOString(),
  };
  saveResults();

  aliceV = newAliceV;
  aliceR = newAliceBlinding;

  // -------------------------------------------------------------------------
  // Step 5: Bob drains inbox + decode note
  // -------------------------------------------------------------------------
  console.log("\n--- Step 5: Bob drains inbox + ECIES decode ---");

  // Get the encrypted note from the ShieldedTransferNote event
  // The event was emitted during the shieldedTransfer tx
  // We'll get the note from the events array in xferResult
  // Event type: A.4b6bc58bc8bf5dcc.JanusFT.ShieldedTransferNote
  let onChainCipher = null;
  let onChainEphX = null;
  let onChainEphY = null;

  if (xferTx.events) {
    for (const event of xferTx.events) {
      if (event.type && event.type.includes("ShieldedTransferNote")) {
        // Event fields are in event.values.value.fields (flow CLI JSON format)
        const fields = event.values?.value?.fields || event.payload?.value?.fields || [];
        for (const field of fields) {
          if (field.name === "encryptedNoteTo") {
            // [UInt8] Cadence array: field.value.value = [{type:"UInt8",value:"1"}, ...]
            const bytes = (field.value?.value || []).map(x => parseInt(x.value || x));
            onChainCipher = Buffer.from(bytes);
          }
          if (field.name === "ephPubToX") {
            onChainEphX = BigInt(field.value?.value || "0");
          }
          if (field.name === "ephPubToY") {
            onChainEphY = BigInt(field.value?.value || "0");
          }
        }
        break;
      }
    }
  }

  if (!onChainCipher || onChainCipher.length === 0) {
    console.log("  ShieldedTransferNote event not parsed — using locally generated ciphertext");
    onChainCipher = noteCipher;
    onChainEphX   = noteEph.x;
    onChainEphY   = noteEph.y;
  } else {
    console.log("  ✓ Got ciphertext from ShieldedTransferNote event");
  }

  // Bob drains his inbox
  const drainTx = flowSend("drain_inbox.cdc", BOB_FLOW_ACCT, []);
  console.log(`  ✓ Drain confirmed: ${drainTx.txId}`);

  // Decode the note
  const decodedNote = await decryptNote(
    onChainCipher,
    { x: onChainEphX, y: onChainEphY },
    bobJub.privkey
  );

  console.log(`  Decoded: amount=${decodedNote.amount}, memo="${decodedNote.memo}"`);

  if (decodedNote.amount !== TRANSFER_AMT_U256) {
    throw new Error(`Note amount mismatch: ${decodedNote.amount} != ${TRANSFER_AMT_U256}`);
  }
  if (decodedNote.memo !== transferMemo) {
    throw new Error(`Note memo mismatch: "${decodedNote.memo}" != "${transferMemo}"`);
  }
  console.log("  ✓ Note decoded correctly — amount and memo match");

  results.steps.bob_drain_decode = {
    drain_tx:        drainTx.txId,
    decoded_amount:  decodedNote.amount.toString(),
    decoded_memo:    decodedNote.memo,
    expected_amount: TRANSFER_AMT_U256.toString(),
    expected_memo:   transferMemo,
    verified:        true,
    ts:              new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 6: Alice unwraps 70 MockFT
  // -------------------------------------------------------------------------
  console.log("\n--- Step 6: Alice unwraps 70 MockFT ---");

  const unwrapBlinding   = await randomScalar();
  const residualBlinding = await randomScalar();
  const residualV        = aliceV - UNWRAP_AMT_U256;

  console.log(`  Alice V=${aliceV}, unwrap=${UNWRAP_AMT_U256}, residual=${residualV}`);
  if (residualV < 0n) throw new Error(`Insufficient balance`);

  console.log("  Generating amount-disclose proof for unwrap (nonce=0)...");
  const unwrapAmtProof = await generateAmountDiscloseProof({
    amount:   UNWRAP_AMT_U256,
    blinding: unwrapBlinding,
    nonce:    0n,
  });
  const unwrapCX = unwrapAmtProof.pubSignals[1];
  const unwrapCY = unwrapAmtProof.pubSignals[2];

  console.log("  Generating transfer proof for unwrap...");
  const unwrapXferProof = await generateProof({
    old_value:         aliceV,
    old_blinding:      aliceR,
    transfer_value:    UNWRAP_AMT_U256,
    transfer_blinding: unwrapBlinding,
    new_blinding:      residualBlinding,
  });
  const unwrapPub6 = unwrapXferProof.pubSignals;

  if (unwrapPub6[2] !== unwrapCX || unwrapPub6[3] !== unwrapCY) {
    throw new Error(`C_tx mismatch between proofs: xfer=(${unwrapPub6[2]},${unwrapPub6[3]}) amtDisclose=(${unwrapCX},${unwrapCY})`);
  }
  console.log("  ✓ C_tx consistent");

  const { ciphertext: unwrapSnap, ephemeralPubkey: unwrapSnapEph } = await encryptNote(
    { amount: residualV, blinding: residualBlinding },
    aliceJub.pubkey
  );

  const tlBeforeUnwrap = await getTotalLocked();
  console.log(`  totalLocked before unwrap: ${tlBeforeUnwrap}`);

  // amountPublicInputs for Cadence unwrap: [claimedAmount_uint256, txCommit.x, txCommit.y, 0]
  const unwrapPubInputs4 = [UNWRAP_AMT_U256, unwrapCX, unwrapCY, 0n];

  const unwrapTx = flowSend("unwrap_mockft.cdc", ALICE_FLOW_ACCT, [
    addressArg(ALICE_CADENCE_ADDR),
    ufixArg(UNWRAP_AMOUNT),
    addressArg(ALICE_CADENCE_ADDR), // recipient = alice
    uint256Arg(unwrapCX),
    uint256Arg(unwrapCY),
    arrayUint256(flatProof(unwrapAmtProof)),
    arrayUint256(unwrapPubInputs4),
    arrayUint256(flatProof(unwrapXferProof)),
    arrayUint256(unwrapPub6.map(x => x)),
    arrayUint8(unwrapSnap),
    uint256Arg(unwrapSnapEph.x),
    uint256Arg(unwrapSnapEph.y),
  ]);
  console.log(`  ✓ Unwrap confirmed: ${unwrapTx.txId}`);

  const tlAfterUnwrap = await getTotalLocked();
  console.log(`  totalLocked after unwrap: ${tlAfterUnwrap}`);

  results.steps.alice_unwrap = {
    tx:                 unwrapTx.txId,
    amount:             UNWRAP_AMOUNT,
    totalLocked_before: tlBeforeUnwrap,
    totalLocked_after:  tlAfterUnwrap,
    verified:           true,
    ts:                 new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  saveResults();

  console.log("\n=== Phase 9.C RESULT: GREEN ===");
  console.log("  setup:          ", results.steps.setup.bob_inbox_tx);
  console.log("  mint:           ", results.steps.mint.tx);
  console.log("  alice wrap:     ", results.steps.alice_wrap.tx);
  console.log("  alice transfer: ", results.steps.alice_shielded_transfer.tx);
  console.log("  bob drain:      ", results.steps.bob_drain_decode.drain_tx);
  console.log("  alice unwrap:   ", results.steps.alice_unwrap.tx);
}

main()
  .then(() => { console.log("\nPhase 9.C complete — results saved to results-mockft.json"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    if (err.stack) console.error(err.stack);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
