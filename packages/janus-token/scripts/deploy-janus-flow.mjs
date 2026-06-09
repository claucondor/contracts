/**
 * deploy-janus-flow.mjs — Deploy JanusFlow v0.8.0 implementation + UUPS proxy.
 *
 * Usage (run from packages/janus-token):
 *
 *   node scripts/deploy-janus-flow.mjs \
 *     --inbox   <ShieldedInbox EVM address>       \
 *     --checkpoint <ShieldedCheckpoint EVM address> \
 *     [--inbox-zero]   # omit inbox (pass address(0)) — for debugging only
 *
 * Alternatively, point to an existing deployments JSON:
 *
 *   DEPLOY_RECORD=/path/to/shielded-recovery.json node scripts/deploy-janus-flow.mjs
 *
 * The script reads existing supporting contracts (BabyJub, Verifiers, Pedersen2Gen,
 * MemoKeyRegistry) from ../../deployments/aggregate-testnet.json.
 *
 * Output: ../../deployments/janusflow-v080.json
 *
 * IMPORTANT: Deployment goes via COA (Cadence → EVM). No EOA private key is used.
 * The script encodes calldata for the operator to submit via a Cadence transaction.
 * It does NOT send any transactions itself.
 *
 * Initialize signature (v0.8.0):
 *   function initialize(
 *     address _babyJub,
 *     address _transferVerifier,
 *     address _amountDiscloseVerifier,
 *     address _owner,
 *     address _memoRegistry,
 *     address _pedersen2Gen,
 *     address _inboxAddress       <-- NEW: ShieldedInbox contract address
 *   )
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Interface } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT    = join(__dirname, "..");
const REPO_ROOT      = join(MODULE_ROOT, "../..");
const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let inboxAddress   = null;
let useZeroInbox   = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--inbox"      && args[i + 1]) inboxAddress  = args[++i];
    if (args[i] === "--inbox-zero") useZeroInbox = true;
}

// Fallback: read from DEPLOY_RECORD env var pointing to shielded-recovery deployments JSON
if (!inboxAddress && !useZeroInbox && process.env.DEPLOY_RECORD) {
    const rec = JSON.parse(readFileSync(process.env.DEPLOY_RECORD, "utf8"));
    inboxAddress = rec.contracts?.ShieldedInbox ?? rec.ShieldedInbox ?? null;
}

if (!inboxAddress && !useZeroInbox) {
    console.error("Error: --inbox <address> required (or --inbox-zero to skip inbox).");
    console.error("       Set DEPLOY_RECORD env to auto-read from a deployments JSON.");
    process.exit(1);
}

const resolvedInbox = useZeroInbox
    ? "0x0000000000000000000000000000000000000000"
    : inboxAddress;

// ---------------------------------------------------------------------------
// Read existing supporting contracts from aggregate-testnet.json
// ---------------------------------------------------------------------------

const existingDeploy = JSON.parse(
    readFileSync(join(DEPLOYMENTS_DIR, "aggregate-testnet.json"), "utf8")
);
const C = existingDeploy.contracts;

const BABYJUB          = C.BabyJub;
const TRANSFER_VERIFIER = C.ConfidentialTransferAggregateVerifier;
const AMOUNT_VERIFIER   = C.AmountDiscloseAggregateVerifier;
const PEDERSEN2GEN      = C.Pedersen2Gen_library;
const MEMO_REGISTRY     = C.MemoKeyRegistry;
const ADMIN_COA_EVM     = existingDeploy.admin.coa_evm_address;

// ---------------------------------------------------------------------------
// Load JanusFlow ABI
// ---------------------------------------------------------------------------

const jfArt   = JSON.parse(
    readFileSync(join(MODULE_ROOT, "artifacts/contracts/solidity/JanusFlow.sol/JanusFlow.json"), "utf8")
);
const jfIface = new Interface(jfArt.abi);

// ---------------------------------------------------------------------------
// Encode initialize calldata (v0.8.0 — 7 args)
// ---------------------------------------------------------------------------

const initCalldata = jfIface.encodeFunctionData("initialize", [
    BABYJUB,
    TRANSFER_VERIFIER,
    AMOUNT_VERIFIER,
    ADMIN_COA_EVM,          // owner = admin COA
    MEMO_REGISTRY,
    PEDERSEN2GEN,
    resolvedInbox,          // NEW: ShieldedInbox address
]);

// ---------------------------------------------------------------------------
// Output deployment instructions
// ---------------------------------------------------------------------------

const output = {
    version:    "0.8.0",
    date:       new Date().toISOString().slice(0, 10),
    network:    "flow-evm-testnet",
    chainId:    545,
    status:     "CALLDATA_READY — deploy via COA Cadence transaction",
    supporting_contracts: {
        BabyJub:          BABYJUB,
        TransferVerifier: TRANSFER_VERIFIER,
        AmountVerifier:   AMOUNT_VERIFIER,
        Pedersen2Gen:     PEDERSEN2GEN,
        MemoRegistry:     MEMO_REGISTRY,
        ShieldedInbox:    resolvedInbox,
    },
    admin_coa:  ADMIN_COA_EVM,
    deploy_steps: {
        step_1: "Deploy JanusFlow implementation contract (no constructor args — _disableInitializers()).",
        step_2: "Note the implementation address from step 1.",
        step_3: "Deploy JanusFlow_Proxy(implementation, initCalldata) below.",
        step_4: "The proxy is now a live JanusFlow v0.8.0 with ShieldedInbox integrated.",
    },
    init_calldata: initCalldata,
    init_args: {
        _babyJub:                BABYJUB,
        _transferVerifier:       TRANSFER_VERIFIER,
        _amountDiscloseVerifier: AMOUNT_VERIFIER,
        _owner:                  ADMIN_COA_EVM,
        _memoRegistry:           MEMO_REGISTRY,
        _pedersen2Gen:           PEDERSEN2GEN,
        _inboxAddress:           resolvedInbox,
    },
    notes: [
        "ShieldedCheckpoint is called by users directly — not wired into JanusFlow.",
        "adminBatchResetSlots replaces adminResetSlot for batch operations (testnet only).",
        "shieldedTransfer now atomically deposits to ShieldedInbox; recipients must drain.",
    ],
};

if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
const outPath = join(DEPLOYMENTS_DIR, "janusflow-v080.json");
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

console.log("=".repeat(72));
console.log("JanusFlow v0.8.0 deploy calldata prepared");
console.log("=".repeat(72));
console.log(`  ShieldedInbox:   ${resolvedInbox}`);
console.log(`  Admin COA:       ${ADMIN_COA_EVM}`);
console.log(`  Output:          ${outPath}`);
console.log();
console.log("init_calldata (pass as second arg to JanusFlow_Proxy constructor):");
console.log(initCalldata);
console.log("=".repeat(72));
