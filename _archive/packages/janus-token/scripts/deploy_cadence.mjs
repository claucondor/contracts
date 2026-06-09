/**
 * deploy_cadence.mjs — Deploy JanusFlow.cdc to openjanus testnet account
 *
 * Signer: openjanus-testnet (0x28fef3d1d6a12800)
 * Contract name: JanusFlow (separate from JanusFlow v1)
 *
 * Prerequisites:
 *   - JanusToken.sol must be deployed first (see deploy_evm.mjs)
 *   - Update JANUS_TOKEN_ADDR below with the v2 EVM address
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const CADENCE_CONTRACT = join(MODULE_ROOT, "contracts/cadence/JanusFlow.cdc");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const DEPLOY_TX_FILE = "/tmp/.deploy_janusflow_cadence.cdc";
const ARGS_FILE = "/tmp/.deploy_janusflow_args.json";
const TMP_FLOW_JSON = "/tmp/.openjanus_flow.json";

// ─── UPDATE THIS after EVM deploy ────────────────────────────────────────
// Read from the EVM deployment record if available
let JANUS_TOKEN_ADDR;
const evmDeployFile = join(DEPLOYMENTS_DIR, "janus-token-evm.json");
if (existsSync(evmDeployFile)) {
  const evmDeploy = JSON.parse(readFileSync(evmDeployFile, "utf8"));
  JANUS_TOKEN_ADDR = evmDeploy.address;
  if (!JANUS_TOKEN_ADDR || JANUS_TOKEN_ADDR.startsWith("PENDING")) {
    throw new Error("EVM address is PENDING — check deploy_evm.mjs result first.");
  }
  console.log("Read EVM address from deployment record:", JANUS_TOKEN_ADDR);
} else {
  throw new Error(
    "No EVM deployment record found. Run deploy_evm.mjs first.\n" +
    "Expected: " + evmDeployFile
  );
}

const BABYJUB_ADDR = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const OPENJANUS_ADDR = "28fef3d1d6a12800";

const flowJson = {
  networks: { testnet: "access.devnet.nodes.onflow.org:9000" },
  accounts: {
    "openjanus-testnet": {
      address: OPENJANUS_ADDR,
      key: {
        type: "file",
        location: "/home/oydual3/.flow/openjanus-testnet.pkey",
      }
    }
  },
  contracts: {},
  deployments: {},
};

async function main() {
  console.log("=== Deploy JanusFlow.cdc to openjanus testnet account ===\n");
  console.log("Signer: openjanus-testnet (0x28fef3d1d6a12800)");
  console.log("JanusToken EVM:", JANUS_TOKEN_ADDR);
  console.log("BabyJub EVM:     ", BABYJUB_ADDR);
  console.log();

  const contractCode = readFileSync(CADENCE_CONTRACT, "utf8");
  console.log("Contract source:", contractCode.length, "chars");

  // Cadence deploy transaction (inline)
  const deployTx = `
transaction(
    contractCode: String,
    janusTokenHex: String,
    babyJubHex: String
) {
    prepare(signer: auth(AddContract) &Account) {
        signer.contracts.add(
            name: "JanusFlow",
            code: contractCode.utf8,
            janusTokenHex: janusTokenHex,
            babyJubHex: babyJubHex
        )
    }
}
`;

  const argsJson = JSON.stringify([
    { type: "String", value: contractCode },
    { type: "String", value: JANUS_TOKEN_ADDR },
    { type: "String", value: BABYJUB_ADDR },
  ]);

  writeFileSync(DEPLOY_TX_FILE, deployTx);
  writeFileSync(ARGS_FILE, argsJson);
  writeFileSync(TMP_FLOW_JSON, JSON.stringify(flowJson, null, 2));

  const flowCmd = [
    "flow transactions send",
    DEPLOY_TX_FILE,
    `--args-json "$(cat ${ARGS_FILE})"`,
    `--network testnet`,
    `--signer openjanus-testnet`,
    "--gas-limit 9999",
    "--output json",
    `--config-path ${TMP_FLOW_JSON}`,
  ].join(" ");

  console.log("Submitting Cadence contract deploy...");

  let result;
  try {
    const stdout = execSync(flowCmd, {
      cwd: "/tmp",
      timeout: 180_000,
      encoding: "utf8",
      shell: "/bin/bash",
    });
    result = JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try { result = JSON.parse(err.stdout); } catch {
        console.error("stdout:", err.stdout?.slice(0, 600));
        console.error("stderr:", err.stderr?.slice(0, 400));
        throw new Error("Deploy failed: " + err.message);
      }
    } else {
      console.error("stderr:", err.stderr?.slice(0, 400));
      throw err;
    }
  }

  const txHash = result?.id ?? result?.transactionId ?? "unknown";
  const status = result?.status ?? "unknown";
  console.log("TX hash:", txHash);
  console.log("Status:", status);

  if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

  const deployment = {
    network: "flow-testnet",
    deployed_at: new Date().toISOString(),
    contract: "JanusFlow",
    cadence_address: "0x28fef3d1d6a12800",
    deploy_tx: txHash,
    status,
    evm_dependency: {
      JanusToken: JANUS_TOKEN_ADDR,
      BabyJub: BABYJUB_ADDR,
    },
    import_pattern: "import JanusFlow from 0x28fef3d1d6a12800",
  };

  const DEPLOY_FILE = join(DEPLOYMENTS_DIR, "janus-flow-cadence.json");
  writeFileSync(DEPLOY_FILE, JSON.stringify(deployment, null, 2));
  console.log("\nDeployment record saved:", DEPLOY_FILE);
  console.log("=== JanusFlow Cadence deploy complete ===");
  return deployment;
}

main().catch((err) => {
  console.error("Deploy error:", err.message);
  process.exit(1);
});
