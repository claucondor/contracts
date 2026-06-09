/**
 * deploy_evm.mjs — Deploy JanusToken.sol to Flow EVM testnet via openjanus COA
 *
 * Deploy method: coa.deploy() via Cadence transaction
 * Signer: openjanus-testnet (0x28fef3d1d6a12800)
 * COA EVM address: 0x0000000000000000000000027eb18dc34b9966fd
 *
 * Reused ZK verifiers (DO NOT redeploy):
 *   BabyJub.sol:              0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   EncryptConsistencyVerifier: 0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C
 *   DecryptOpenVerifier:        0x3bB139B5404fD6b152813bC3532367AAa096638b
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { AbiCoder } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const ARTIFACT_PATH = join(
  MODULE_ROOT,
  "artifacts/contracts/JanusToken.sol/JanusToken.json"
);
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const TMP_TX = "/tmp/.deploy_janus_evm.cdc";
const TMP_FLOW_JSON = "/tmp/.openjanus_flow.json";

// ─── Deployed dependencies (DO NOT REDEPLOY) ─────────────────────────────
const BABYJUB_ADDRESS          = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";
const ENCRYPT_VERIFIER_ADDRESS = "0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C";
const DECRYPT_VERIFIER_ADDRESS = "0x3bB139B5404fD6b152813bC3532367AAa096638b";

// Flow CLI config — openjanus account
const FLOW_NETWORK = "testnet";
const FLOW_SIGNER  = "openjanus-testnet";
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
  console.log("=== Deploy JanusToken.sol to Flow EVM testnet ===\n");
  console.log("Signer: openjanus-testnet (0x28fef3d1d6a12800)");
  console.log("COA EVM: 0x0000000000000000000000027eb18dc34b9966fd");
  console.log();
  console.log("Reusing deployed dependencies:");
  console.log("  BabyJub:              ", BABYJUB_ADDRESS);
  console.log("  EncryptVerifier:      ", ENCRYPT_VERIFIER_ADDRESS);
  console.log("  DecryptVerifier:      ", DECRYPT_VERIFIER_ADDRESS);
  console.log();

  if (!existsSync(ARTIFACT_PATH)) {
    throw new Error(
      `Artifact not found: ${ARTIFACT_PATH}\n` +
      `Run: cd ${MODULE_ROOT} && npx hardhat compile --config hardhat.config.cjs\n` +
      `Or copy the artifact from cadence-crypto-lab.`
    );
  }

  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  const bytecode = artifact.bytecode;

  const abiCoder = new AbiCoder();
  const constructorArgs = abiCoder.encode(
    ["address", "address", "address"],
    [BABYJUB_ADDRESS, ENCRYPT_VERIFIER_ADDRESS, DECRYPT_VERIFIER_ADDRESS]
  );
  const argsHex = constructorArgs.slice(2);
  const deployBytecodeHex = bytecode.slice(2) + argsHex;

  console.log(`Bytecode: ${deployBytecodeHex.length / 2} bytes`);

  // Write Cadence deploy transaction
  const cadenceTx = `import "EVM"

transaction(bytecodeHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Deploy) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm — create one first")

        let result = coa.deploy(
            code: bytecodeHex.decodeHex(),
            gasLimit: 4_000_000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "JanusToken deploy failed: ".concat(result.errorMessage)
        )

        log("JanusToken deployed successfully")
    }
}
`;

  writeFileSync(TMP_TX, cadenceTx);
  writeFileSync(TMP_FLOW_JSON, JSON.stringify(flowJson, null, 2));

  const flowCmd = [
    "flow transactions send",
    TMP_TX,
    `"${deployBytecodeHex}"`,
    `--network ${FLOW_NETWORK}`,
    `--signer ${FLOW_SIGNER}`,
    "--gas-limit 9999",
    "--output json",
    `--config-path ${TMP_FLOW_JSON}`,
  ].join(" ");

  console.log("\nSubmitting deploy transaction via flow CLI...");

  let result;
  try {
    const stdout = execSync(flowCmd, {
      cwd: "/tmp",
      timeout: 180_000,
      encoding: "utf8",
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
  console.log("\nTX hash:", txHash);
  console.log("Status:", status);

  // Parse deployed address from EVM events
  const events = result?.events ?? [];
  let deployedAddress = null;
  for (const evt of events) {
    const type = evt?.type ?? "";
    if (type.includes("TransactionExecuted")) {
      const evtStr = JSON.stringify(evt);
      const match = evtStr.match(/"contractAddress"\s*[":]+\s*"(0x[0-9a-fA-F]+)"/);
      if (match) { deployedAddress = match[1]; break; }
    }
  }
  if (!deployedAddress) {
    const evtStr = JSON.stringify(events);
    const match = evtStr.match(/"contractAddress[^"]*"\s*[":]+\s*"(0x[0-9a-fA-F]+)"/);
    if (match) deployedAddress = match[1];
  }
  if (!deployedAddress) {
    console.log("\nWarning: Could not auto-parse deployed address.");
    console.log("Check: https://evm-testnet.flowscan.io/tx/" + txHash);
    deployedAddress = "PENDING - check tx " + txHash;
  } else {
    console.log("\nJanusToken deployed at:", deployedAddress);
  }

  if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

  const deployment = {
    network: "flow-evm-testnet",
    chain_id: 545,
    deployed_at: new Date().toISOString(),
    contract: "JanusToken",
    address: deployedAddress,
    deploy_tx: txHash,
    explorer_tx: `https://evm-testnet.flowscan.io/tx/${txHash}`,
    deployer_coa: "0x0000000000000000000000027eb18dc34b9966fd",
    deployer_flow: "0x28fef3d1d6a12800",
    dependencies: {
      BabyJub: BABYJUB_ADDRESS,
      EncryptConsistencyVerifier: ENCRYPT_VERIFIER_ADDRESS,
      DecryptOpenVerifier: DECRYPT_VERIFIER_ADDRESS,
    },
    bytecode_size_bytes: deployBytecodeHex.length / 2,
    deploy_method: "coa.deploy() via Cadence transaction",
    phase: "v2",
  };

  const DEPLOY_FILE = join(DEPLOYMENTS_DIR, "janus-token-evm.json");
  writeFileSync(DEPLOY_FILE, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment record saved: ${DEPLOY_FILE}`);
  console.log("\n=== EVM deploy complete ===");
  return deployment;
}

main().catch((err) => {
  console.error("Deploy error:", err.message);
  process.exit(1);
});
