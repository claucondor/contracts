/**
 * fix-underlying.mjs — Fixes JanusERC20 proxy where underlying was not set.
 *
 * Steps:
 *   1. Deploy new JanusERC20 implementation (with reinitializeUnderlying(address))
 *   2. upgradeToAndCall(newImpl, reinitializeUnderlying(mockUSDC)) via admin COA
 *
 * Run: node scripts/fix-underlying.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AbiCoder, Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const ARTIFACTS = join(MODULE_ROOT, "artifacts/contracts/solidity");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");
const IMPL_ART = join(ARTIFACTS, "JanusERC20.sol/JanusERC20.json");

const ADMIN_SIGNER = "v066-admin";
const FLOW_JSON_E2E = "/tmp/e2e-aggregate.flow.json";

const JANUSERC20_PROXY = "0xD5E6a52635599E6B2296B5BfEeC617E333561ea0";
const MOCKUSDC_ADDR    = "0x686E8d90A7B608540cAF46E527fD8a5631A1b658";

const provider = new JsonRpcProvider("https://testnet.evm.nodes.onflow.org");

function log(msg) { console.log(msg); }

function runFlowTx(txBody, args, label, signer, gasLimit = 9999) {
  const txPath = `/tmp/fix_${label}_${Date.now()}.cdc`;
  writeFileSync(txPath, txBody);
  const argStrs = args.map(a => `"${a}"`).join(" ");
  const cmd = [
    "flow transactions send", txPath, argStrs,
    "--network testnet",
    `--signer ${signer}`,
    `--gas-limit ${gasLimit}`,
    "--output json",
    `--config-path ${FLOW_JSON_E2E}`,
  ].join(" ");
  let result;
  try {
    const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8" });
    result = JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try { result = JSON.parse(err.stdout); } catch {
        throw new Error(`[${label}] non-JSON: ${err.stdout?.slice(0, 500)}`);
      }
    } else throw err;
  }
  if (result.status !== "SEALED") {
    throw new Error(`[${label}] status=${result.status}`);
  }
  const errMsg = result.error || result.errorMessage;
  if (errMsg) {
    throw new Error(`[${label}] SEALED but reverted: ${errMsg.slice(0, 500)}`);
  }
  return result;
}

function extractEvmTxHash(result) {
  const events = result?.events ?? [];
  for (const ev of events) {
    if (!ev?.type?.endsWith(".EVM.TransactionExecuted")) continue;
    const fields = ev?.values?.value?.fields ?? [];
    for (const f of fields) {
      const arr = f?.value?.value;
      if (Array.isArray(arr) && arr.length === 32 && arr.every(b => b?.type === "UInt8")) {
        return "0x" + arr.map(b => Number(b.value).toString(16).padStart(2, "0")).join("");
      }
    }
  }
  return null;
}

// Cadence tx: deploy contract bytecode from COA
const DEPLOY_TX = `import EVM from 0x8c5303eaa26202d6

transaction(bytecodeHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Deploy) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.deploy(
            code: bytecodeHex.decodeHex(),
            gasLimit: 8000000,
            value: EVM.Balance(attoflow: 0)
        )
        log("Deployed at: ".concat(result.deployedContract?.toString() ?? "nil"))
        log("Status: ".concat(result.status.rawValue.toString()))
    }
}
`;

// Cadence tx: upgradeToAndCall via COA
const UPGRADE_TX = `import EVM from 0x8c5303eaa26202d6

transaction(proxyAddress: String, calldataHex: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(proxyAddress),
            data: calldataHex.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "upgradeToAndCall failed: ".concat(result.errorCode.toString()).concat(" ").concat(result.errorMessage)
        )
    }
}
`;

async function main() {
  log("=== JanusERC20 Underlying Fix ===");

  // 1. Check current underlying
  const PROXY_ABI = ["function underlying() view returns (address)"];
  const proxy = new (await import("ethers")).ethers.Contract(JANUSERC20_PROXY, PROXY_ABI, provider);
  const currentUnderlying = await proxy.underlying();
  log(`Current underlying: ${currentUnderlying}`);
  if (currentUnderlying.toLowerCase() === MOCKUSDC_ADDR.toLowerCase()) {
    log("Underlying already set correctly. Nothing to do.");
    return;
  }

  // 2. Deploy new implementation
  log("\nDeploying new JanusERC20 implementation...");
  const implArt = JSON.parse(readFileSync(IMPL_ART, "utf8"));
  const bytecode = implArt.bytecode;
  log(`Bytecode length: ${bytecode.length} chars`);

  const deployRes = runFlowTx(DEPLOY_TX, [bytecode.slice(2)], "deploy-januserc20-impl", ADMIN_SIGNER, 9999);
  log(`Deploy tx: ${deployRes.id}`);

  // Extract deployed contract address from logs
  const logs = deployRes.events?.filter(e => e?.type?.includes("Log")) ?? [];
  let newImplAddr = null;
  for (const ev of logs) {
    const msg = ev?.values?.value?.fields?.[0]?.value?.value ?? "";
    const match = msg.match(/Deployed at: (0x[0-9a-fA-F]{40})/i);
    if (match) { newImplAddr = match[1]; break; }
  }

  if (!newImplAddr) {
    // Try to get it from EVM tx
    const evmHash = extractEvmTxHash(deployRes);
    if (evmHash) {
      const receipt = await provider.getTransactionReceipt(evmHash);
      newImplAddr = receipt?.contractAddress;
    }
  }

  if (!newImplAddr) {
    throw new Error("Could not determine deployed impl address");
  }
  log(`New impl deployed at: ${newImplAddr}`);

  // 3. Encode upgradeToAndCall calldata
  const UPGRADE_ABI = [
    "function upgradeToAndCall(address newImplementation, bytes calldata data) external payable",
  ];
  const REINIT_ABI = ["function reinitializeUnderlying(address _underlying) external"];

  const reinitCalldata = new Interface(REINIT_ABI).encodeFunctionData("reinitializeUnderlying", [MOCKUSDC_ADDR]);
  const upgradeCalldata = new Interface(UPGRADE_ABI).encodeFunctionData("upgradeToAndCall", [newImplAddr, reinitCalldata]);

  log(`\nCalling upgradeToAndCall(${newImplAddr}, reinitializeUnderlying(${MOCKUSDC_ADDR}))...`);
  const upgradeRes = runFlowTx(UPGRADE_TX, [JANUSERC20_PROXY, upgradeCalldata.slice(2), "1000000"], "upgrade-januserc20", ADMIN_SIGNER);
  log(`Upgrade tx: ${upgradeRes.id}`);
  log(`EVM hash: ${extractEvmTxHash(upgradeRes)}`);

  // 4. Verify
  const newUnderlying = await proxy.underlying();
  log(`\nNew underlying: ${newUnderlying}`);
  if (newUnderlying.toLowerCase() === MOCKUSDC_ADDR.toLowerCase()) {
    log("SUCCESS: underlying set correctly.");
  } else {
    throw new Error(`underlying still wrong: ${newUnderlying}`);
  }
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
