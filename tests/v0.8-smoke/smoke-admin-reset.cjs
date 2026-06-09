/**
 * smoke-admin-reset.cjs — Phase 9.D: adminBatchResetSlots on all three tokens
 *
 * Resets commitment slots for all test addresses used in Phases 9.A, 9.B, 9.C.
 *
 * - JanusFlow (EVM):  reset Phase 9.A alice + bob  via COA EVM call
 * - JanusERC20 (EVM): reset Phase 9.B alice2 + bob2 via COA EVM call
 * - JanusFT (Cadence): reset Cadence alice + bob via Admin resource
 *
 * Saves partial results to results-admin.json after each step.
 */

"use strict";

const { execFileSync } = require("child_process");
const { ethers }       = require("ethers");
const fs               = require("fs");
const path             = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RESULTS_FILE = path.join(__dirname, "results-admin.json");
const SMOKE_DIR    = __dirname;
const CADENCE_DIR  = path.join(__dirname, "cadence");
const NETWORK      = "testnet";

// Deployed v0.8 addresses
const JANUS_FLOW_PROXY   = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";
const JANUS_ERC20_PROXY  = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d";

// Phase 9.A test addresses (fresh EOAs funded during 9.A)
const PHASE_A_ALICE = "0x6B5138D15763A9d5238EbAd4724e9EBf82286642";
const PHASE_A_BOB   = "0xd483b62801614c666A2c17e9437644216777E38B";

// Phase 9.B test addresses (fresh EOAs funded during 9.B)
const PHASE_B_ALICE = "0xB6Db10f6f90eb3E43037E746bE215F4F1C2DD20d";
const PHASE_B_BOB   = "0x39128aED50791869902750db81ba1Ee81665ed15";

// Phase 9.C Cadence addresses
const CADENCE_ALICE = "0x4b6bc58bc8bf5dcc";
const CADENCE_BOB   = "0xd807a3992d7be612";

// Flow accounts
const ALICE_FLOW_ACCT = "openjanus-v08";  // holds COA + JanusFT Admin

// Gas limit for EVM admin calls (~50k per reset, 2 users → use 200k headroom)
const GAS_LIMIT = 500_000n;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

let results = {
  phase:   "9.D",
  token:   "ALL",
  started: new Date().toISOString(),
  steps:   {},
  verdict: "RUNNING",
};

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v
  ));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `flow transactions send` with JSON args. Blocks until sealed. */
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
  try {
    result = JSON.parse(output.trim());
  } catch {
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

function strArg(s) { return { type: "String", value: s }; }
function uint64Arg(n) { return { type: "UInt64", value: n.toString() }; }
function addressArrayArg(addrs) {
  return { type: "Array", value: addrs.map(a => ({ type: "Address", value: a })) };
}

/**
 * ABI-encode calldata for adminBatchResetSlots(address[]).
 * Returns hex string WITHOUT 0x prefix (for Cadence decodeHex).
 */
function encodeAdminBatchReset(addresses) {
  const iface = new ethers.Interface([
    "function adminBatchResetSlots(address[] calldata users) external",
  ]);
  const calldata = iface.encodeFunctionData("adminBatchResetSlots", [addresses]);
  // strip leading 0x
  return calldata.slice(2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Phase 9.D — Admin Batch Reset All Tokens ===\n");
  saveResults();

  // -------------------------------------------------------------------------
  // Step 1: JanusFlow — reset Phase 9.A slots
  // -------------------------------------------------------------------------
  console.log("--- Step 1: JanusFlow adminBatchResetSlots [Alice, Bob] ---");

  const flowAddrs = [PHASE_A_ALICE, PHASE_A_BOB];
  const flowCalldata = encodeAdminBatchReset(flowAddrs);
  console.log(`  Calldata (${flowCalldata.length / 2} bytes): ${flowCalldata.slice(0, 16)}...`);

  // Strip the 0x prefix from the proxy address for Cadence
  const janusFlowTarget = JANUS_FLOW_PROXY.slice(2); // remove 0x

  const flowResetTx = flowSend("admin_evm_call.cdc", ALICE_FLOW_ACCT, [
    strArg(janusFlowTarget),
    strArg(flowCalldata),
    uint64Arg(GAS_LIMIT),
  ]);
  console.log(`  ✓ JanusFlow reset: ${flowResetTx.txId}`);

  results.steps.janusflow_reset = {
    tx:            flowResetTx.txId,
    contract:      JANUS_FLOW_PROXY,
    users_reset:   flowAddrs,
    verified:      true,
    ts:            new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 2: JanusERC20 — reset Phase 9.B slots
  // -------------------------------------------------------------------------
  console.log("\n--- Step 2: JanusERC20 adminBatchResetSlots [Alice2, Bob2] ---");

  const erc20Addrs   = [PHASE_B_ALICE, PHASE_B_BOB];
  const erc20Calldata = encodeAdminBatchReset(erc20Addrs);
  console.log(`  Calldata (${erc20Calldata.length / 2} bytes): ${erc20Calldata.slice(0, 16)}...`);

  const janusErc20Target = JANUS_ERC20_PROXY.slice(2);

  const erc20ResetTx = flowSend("admin_evm_call.cdc", ALICE_FLOW_ACCT, [
    strArg(janusErc20Target),
    strArg(erc20Calldata),
    uint64Arg(GAS_LIMIT),
  ]);
  console.log(`  ✓ JanusERC20 reset: ${erc20ResetTx.txId}`);

  results.steps.janus_erc20_reset = {
    tx:           erc20ResetTx.txId,
    contract:     JANUS_ERC20_PROXY,
    users_reset:  erc20Addrs,
    verified:     true,
    ts:           new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Step 3: JanusFT — reset Phase 9.C Cadence slots via Admin resource
  // -------------------------------------------------------------------------
  console.log("\n--- Step 3: JanusFT adminBatchResetSlots [Alice, Bob] ---");

  const cadenceAddrs = [CADENCE_ALICE, CADENCE_BOB];

  const janusFTResetTx = flowSend("admin_reset_janusFT.cdc", ALICE_FLOW_ACCT, [
    addressArrayArg(cadenceAddrs),
  ]);
  console.log(`  ✓ JanusFT reset: ${janusFTResetTx.txId}`);

  results.steps.janus_ft_reset = {
    tx:          janusFTResetTx.txId,
    users_reset: cadenceAddrs,
    verified:    true,
    ts:          new Date().toISOString(),
  };
  saveResults();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  results.verdict  = "GREEN";
  results.finished = new Date().toISOString();
  saveResults();

  console.log("\n=== Phase 9.D RESULT: GREEN ===");
  console.log("  JanusFlow reset:   ", results.steps.janusflow_reset.tx);
  console.log("  JanusERC20 reset:  ", results.steps.janus_erc20_reset.tx);
  console.log("  JanusFT reset:     ", results.steps.janus_ft_reset.tx);
}

main()
  .then(() => { console.log("\nPhase 9.D complete — results saved to results-admin.json"); process.exit(0); })
  .catch(err => {
    console.error("\n[FATAL]", err.message);
    if (err.stack) console.error(err.stack);
    results.verdict  = "RED";
    results.error    = { message: err.message, stack: err.stack };
    results.finished = new Date().toISOString();
    saveResults();
    process.exit(1);
  });
