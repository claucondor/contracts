/**
 * deploy_janustoken.mjs — Deploy JanusToken.sol with v0.2.0 verifier addresses
 * via openjanus COA (coa.deploy() Cadence transaction)
 *
 * Part of openjanus v0.2.0 ceremony deployment (Phase B).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { AbiCoder } from "ethers";

const MODULE_ROOT = "/home/oydual3/openjanus-contracts/packages/janus-token";
const ARTIFACT_PATH = join(MODULE_ROOT, "artifacts/contracts/solidity/JanusToken.sol/JanusToken.json");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

// v0.2.0 ceremony addresses
const BABYJUB_ADDRESS          = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870"; // KEEP - stateless
const ENCRYPT_VERIFIER_ADDRESS = "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e"; // NEW v0.2.0
const DECRYPT_VERIFIER_ADDRESS = "0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc"; // NEW v0.2.0

const FLOW_NETWORK = "testnet";
const TMP_TX = "/tmp/.phase_b_deploy_janustoken.cdc";

const CADENCE_DEPLOY_TX = `import "EVM"

transaction(bytecodeHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Deploy) &EVM.CadenceOwnedAccount>(from: /storage/openjanusCOA)
            ?? panic("No COA at /storage/openjanusCOA")

        let result = coa.deploy(
            code: bytecodeHex.decodeHex(),
            gasLimit: 6_000_000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "JanusToken deploy failed: ".concat(result.errorMessage)
        )

        log("JanusToken deployed at:")
        log(result.deployedContract?.toString() ?? "unknown")
    }
}
`;

writeFileSync(TMP_TX, CADENCE_DEPLOY_TX);

function parseDeployedAddress(result) {
  const evtStr = JSON.stringify(result);
  let match = evtStr.match(/"contractAddress"\s*:\s*"(0x[0-9a-fA-F]{40})"/i);
  if (match) return match[1];
  const allAddresses = [...evtStr.matchAll(/"value"\s*:\s*"(0x[0-9a-fA-F]{38,42})"/gi)];
  const known = new Set([
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000027eb18dc34b9966fd",
  ]);
  for (const m of allAddresses) {
    if (!known.has(m[1].toLowerCase())) return m[1];
  }
  return null;
}

async function main() {
  console.log("=== Phase B: Deploy JanusToken (v0.2.0 ceremony addresses) ===\n");
  console.log("BabyJub:          ", BABYJUB_ADDRESS, "(KEEP)");
  console.log("EncryptVerifier:  ", ENCRYPT_VERIFIER_ADDRESS, "(NEW v0.2.0)");
  console.log("DecryptVerifier:  ", DECRYPT_VERIFIER_ADDRESS, "(NEW v0.2.0)");
  console.log();

  if (!existsSync(ARTIFACT_PATH)) {
    throw new Error(`Artifact not found: ${ARTIFACT_PATH}`);
  }

  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  const bytecode = artifact.bytecode;

  // JanusToken constructor: (address _babyJub, address _encryptVerifier, address _decryptVerifier)
  // Check the ABI to confirm constructor argument order
  const constructorAbi = artifact.abi.find(x => x.type === "constructor");
  if (constructorAbi) {
    console.log("Constructor args (from ABI):", constructorAbi.inputs.map(i => `${i.type} ${i.name}`).join(", "));
  }

  const abiCoder = new AbiCoder();
  const constructorArgs = abiCoder.encode(
    ["address", "address", "address"],
    [BABYJUB_ADDRESS, ENCRYPT_VERIFIER_ADDRESS, DECRYPT_VERIFIER_ADDRESS]
  );
  const argsHex = constructorArgs.slice(2);
  const deployBytecodeHex = bytecode.slice(2) + argsHex;

  console.log(`Deploy payload: ${deployBytecodeHex.length / 2} bytes`);

  const flowCmd = [
    "flow transactions send",
    TMP_TX,
    `"${deployBytecodeHex}"`,
    `--network ${FLOW_NETWORK}`,
    `--signer openjanus-testnet`,
    "--gas-limit 9999",
    "--output json",
    `--config-path ${FLOW_JSON}`,
  ].join(" ");

  console.log("Submitting deploy transaction...");

  let result;
  try {
    const stdout = execSync(flowCmd, {
      cwd: MODULE_ROOT,
      timeout: 300_000,
      encoding: "utf8",
    });
    result = JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try { result = JSON.parse(err.stdout); } catch {
        throw new Error(`Deploy failed: ${err.stdout?.slice(0, 1000)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
      }
    } else {
      throw new Error(`Deploy failed: ${err.message}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
    }
  }

  const txHash = result?.id ?? result?.transactionId ?? "unknown";
  const status = result?.status ?? "unknown";
  console.log("TX hash:", txHash);
  console.log("Status:", status);

  if (result?.error) {
    console.error("Error:", result.error?.slice(0, 500));
  }

  // Dump EVM events
  const events = result?.events ?? [];
  for (const evt of events) {
    if (evt.type && evt.type.includes("TransactionExecuted")) {
      writeFileSync("/tmp/phase-b-janustoken-evmevent.json", JSON.stringify(evt, null, 2));
      console.log("EVM TransactionExecuted event saved to /tmp/phase-b-janustoken-evmevent.json");
    }
  }

  const deployedAddress = parseDeployedAddress(result);
  console.log("JanusToken deployed at:", deployedAddress ?? "PARSE_FAILED");

  if (!deployedAddress) {
    writeFileSync("/tmp/phase-b-janustoken-rawresult.json", JSON.stringify(result, null, 2));
    console.log("Raw result saved to /tmp/phase-b-janustoken-rawresult.json");
  }

  // Save deployment record
  const deployment = {
    network: "flow-evm-testnet",
    chain_id: 545,
    deployed_at: new Date().toISOString(),
    contract: "JanusToken",
    version: "0.2.0",
    address: deployedAddress,
    deploy_tx: txHash,
    status,
    deployer_coa_path: "/storage/openjanusCOA",
    deployer_flow: "0x28fef3d1d6a12800",
    dependencies: {
      BabyJub: BABYJUB_ADDRESS,
      EncryptConsistencyVerifier: ENCRYPT_VERIFIER_ADDRESS,
      DecryptOpenVerifier: DECRYPT_VERIFIER_ADDRESS,
    },
    ceremony: "v0.2.0 Hermez + Flow VRF beacon",
    bytecode_size_bytes: deployBytecodeHex.length / 2,
  };

  writeFileSync(join(DEPLOYMENTS_DIR, "janus-token-evm.json"), JSON.stringify(deployment, null, 2));
  console.log("Deployment record saved to:", join(DEPLOYMENTS_DIR, "janus-token-evm.json"));

  return deployment;
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
