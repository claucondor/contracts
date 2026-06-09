/**
 * upgrade-to-v0_5.mjs -- Deploy JanusERC20 v0.5 impl and upgrade the proxy.
 *
 * Steps:
 *   1. Deploy new JanusERC20 impl (uninitialised -- _disableInitializers in base)
 *   2. UUPS upgrade via proxy owner COA: upgradeToAndCall(newImpl, "")
 *   3. setMemoRegistry(0x05D104962ff087441f26BA11A1E1C3b9E091D663) via COA
 *   4. Verify impl slot + 9-arg shieldedTransfer selector
 *   5. Write janus-erc20-v0.5.json
 *
 * Run:
 *   node --experimental-vm-modules scripts/upgrade-to-v0_5.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const ARTIFACTS = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

const JANUSERC20_ART = join(ARTIFACTS, "JanusERC20.sol/JanusERC20.json");

// --- Deployed addresses ---
const PROXY_ADDRESS  = "0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e";
const MEMO_REGISTRY  = "0x05D104962ff087441f26BA11A1E1C3b9E091D663";

// --- Deployer ---
const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";

const RPC_URL = "https://testnet.evm.nodes.onflow.org";

// Cadence tx that just deploys EVM bytecode via COA
const DEPLOY_TX = `import "EVM"

transaction(bytecodeHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Deploy) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.deploy(
            code: bytecodeHex.decodeHex(),
            gasLimit: 8_000_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "deploy failed"
        )
        log("deployed")
    }
}
`;

// Cadence tx that forwards pre-encoded calldata via COA
const CALL_TX = `import "EVM"

transaction(proxyHex: String, calldataHex: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let proxy = EVM.addressFromString(proxyHex)
        let result = coa.call(
            to: proxy,
            data: calldataHex.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "call failed: ".concat(result.errorCode.toString())
                .concat(" ").concat(result.errorMessage)
        )
        log("call ok")
    }
}
`;

// ---------------------------------------------------------------------------

function runFlowTx(txContent, args, label) {
    const txPath = `/tmp/.${label}.cdc`;
    writeFileSync(txPath, txContent);

    const argStr = args.map(a => `"${a}"`).join(" ");
    const cmd = [
        "flow transactions send",
        txPath,
        argStr,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        "--gas-limit 9999",
        "--output json",
        `--config-path ${FLOW_JSON}`,
    ].join(" ");

    let result;
    try {
        const stdout = execSync(cmd, { cwd: MODULE_ROOT, timeout: 300_000, encoding: "utf8" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); }
            catch {
                throw new Error(`[${label}] flow CLI non-JSON:\n${err.stdout?.slice(0, 800)}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 400)}`);
        }
    }

    // Check for Cadence-level errors in the result
    const errCode = result?.errorMessage ?? result?.error ?? "";
    if (errCode && typeof errCode === "string" && errCode.length > 0) {
        throw new Error(`[${label}] Cadence tx error: ${errCode.slice(0, 400)}`);
    }

    return result;
}

function extractDeployedAddress(result) {
    const blob = JSON.stringify(result?.events ?? []);
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        OPENJANUS_FLOW_COA_EVM.toLowerCase(),
        PROXY_ADDRESS.toLowerCase(),
        MEMO_REGISTRY.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    return fallback[0] ?? null;
}

function extractTxHash(result) {
    return result?.id ?? result?.txId ?? "unknown";
}

// ABI-encode upgradeToAndCall(address,bytes) calldata
// selector: 0x4f1ef286
// params: [newImpl (address), "" (bytes)]
// layout: 4 + 32 (addr) + 32 (bytes offset = 0x40) + 32 (bytes length = 0) = 100 bytes
function encodeUpgradeCalldata(newImplAddr) {
    const selector = "4f1ef286";
    const addr = newImplAddr.toLowerCase().replace("0x", "").padStart(64, "0");
    const bytesOffset = "0000000000000000000000000000000000000000000000000000000000000040";
    const bytesLength = "0000000000000000000000000000000000000000000000000000000000000000";
    return selector + addr + bytesOffset + bytesLength;
}

// ABI-encode setMemoRegistry(address) calldata
// selector: 0x6c4e0d53
function encodeSetMemoRegistryCalldata(registryAddr) {
    const selector = "6c4e0d53";
    const addr = registryAddr.toLowerCase().replace("0x", "").padStart(64, "0");
    return selector + addr;
}

async function main() {
    console.log("=== JanusERC20 v0.5 upgrade ===\n");

    if (!existsSync(JANUSERC20_ART)) {
        throw new Error(`Missing artifact: ${JANUSERC20_ART} -- run 'npm run compile' first`);
    }

    const jeArt = JSON.parse(readFileSync(JANUSERC20_ART, "utf8"));
    const provider = new JsonRpcProvider(RPC_URL);

    // Check balance
    const balance = await provider.getBalance(OPENJANUS_FLOW_COA_EVM);
    console.log("COA EVM balance (wei):", balance.toString());

    // --- 1. Deploy new impl (already deployed -- reuse) ----------------------
    // impl 0x10348fc1e29751B79EDAd427d1098bC83B10028D was deployed in prior run.
    // VERSION() = "0.5.0" confirmed on-chain. Skip redeploy to save gas.
    console.log("\n[1/3] Using existing JanusERC20 v0.5 impl (already deployed)...");
    const implAddress = "0x10348fc1e29751B79EDAd427d1098bC83B10028D";
    const implTxHash  = "ea44cf16d72b6bd9ed3428ba3702c8decdc962a57296f8fb8001f9095ab3397a";
    console.log("  impl address:", implAddress);
    console.log("  deploy tx:", implTxHash);

    // --- 2. UUPS upgrade proxy -----------------------------------------------
    console.log("\n[2/3] Upgrading proxy via COA upgradeToAndCall...");
    const upgradeCalldata = encodeUpgradeCalldata(implAddress);
    console.log("  upgradeToAndCall calldata:", upgradeCalldata.slice(0, 40) + "...");

    const upgradeResult = runFlowTx(
        CALL_TX,
        [PROXY_ADDRESS, upgradeCalldata, "500000"],
        "upgrade_janus_erc20_v05"
    );
    const upgradeTxHash = extractTxHash(upgradeResult);
    console.log("  tx:", upgradeTxHash);

    // --- 3. setMemoRegistry --------------------------------------------------
    console.log("\n[3/3] Setting memoRegistry on proxy...");
    const memoCalldata = encodeSetMemoRegistryCalldata(MEMO_REGISTRY);
    console.log("  setMemoRegistry calldata:", memoCalldata);

    const memoResult = runFlowTx(
        CALL_TX,
        [PROXY_ADDRESS, memoCalldata, "100000"],
        "set_memo_registry_v05"
    );
    const memoTxHash = extractTxHash(memoResult);
    console.log("  tx:", memoTxHash);

    // --- Verify --------------------------------------------------------------
    console.log("\n=== Verifying upgrade ===");
    const iface = new Interface(jeArt.abi);

    // implementation() via cast-style eth_call to EIP-1967 admin slot
    // Use eth_getStorageAt instead
    const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dcef422a4d9a8c8f7ea84a3c97e7a6cca";
    const implSlotHex = await provider.getStorage(PROXY_ADDRESS, IMPL_SLOT);
    const implFromSlot = "0x" + implSlotHex.slice(-40);
    console.log("  EIP-1967 impl slot:", implFromSlot);
    const implMatch = implFromSlot.toLowerCase() === implAddress.toLowerCase();
    console.log("  impl matches deployed:", implMatch ? "YES" : "NO");

    // VERSION()
    let versionCheck = "unknown";
    try {
        // VERSION is a string constant
        const versionData = "0xffa1ad74"; // keccak256("VERSION()") first 4 bytes
        const versionHex = await provider.call({ to: PROXY_ADDRESS, data: versionData });
        // decode as string: skip offset (32 bytes) + length (32 bytes) + content
        const lenOffset = 64;
        const strLen = parseInt(versionHex.slice(2 + lenOffset + 32, 2 + lenOffset + 64), 16);
        versionCheck = Buffer.from(versionHex.slice(2 + lenOffset + 64, 2 + lenOffset + 64 + strLen * 2), "hex").toString("utf8");
    } catch (e) {
        versionCheck = "err: " + e.message.slice(0, 60);
    }
    console.log("  VERSION():", versionCheck);

    // memoRegistry()
    let memoRegistryCheck = "unknown";
    try {
        const memoData = iface.encodeFunctionData("memoRegistry", []);
        const memoHex = await provider.call({ to: PROXY_ADDRESS, data: memoData });
        memoRegistryCheck = "0x" + memoHex.slice(-40);
    } catch (e) {
        memoRegistryCheck = "err: " + e.message.slice(0, 60);
    }
    console.log("  memoRegistry():", memoRegistryCheck);
    const memoMatch = memoRegistryCheck.toLowerCase() === MEMO_REGISTRY.toLowerCase();
    console.log("  memoRegistry matches:", memoMatch ? "YES" : "NO");

    // 9-arg shieldedTransfer: should revert with proof error, not empty
    let shieldedTransferCheck = "unknown";
    const ST_SELECTOR = "6218f5d9";
    try {
        // encode minimal 9-arg call: address + uint256[6] + uint256[8] + bytes(0) + 0 + 0 + bytes(0) + 0 + 0
        // Just use a minimal ABI call and check revert type
        const frag = "function shieldedTransfer(address,uint256[6],uint256[8],bytes,uint256,uint256,bytes,uint256,uint256)";
        const mini = new Interface([frag]);
        const stData = mini.encodeFunctionData("shieldedTransfer", [
            "0x0000000000000000000000000000000000000001",
            [0n, 0n, 0n, 0n, 0n, 0n],
            [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
            "0x",
            0n, 0n,
            "0x",
            0n, 0n,
        ]);
        await provider.call({ to: PROXY_ADDRESS, data: stData });
        shieldedTransferCheck = "no revert (unexpected)";
    } catch (e) {
        const msg = String(e.message ?? e);
        if (msg.includes("transfer to zero") || msg.includes("C_old") || msg.includes("JanusERC20")) {
            shieldedTransferCheck = "selector present (reverts w/ contract error as expected)";
        } else if (msg.includes("execution reverted") && msg.length > 50) {
            shieldedTransferCheck = "selector present (revert with data)";
        } else if (msg.includes("execution reverted") && msg.length < 50) {
            shieldedTransferCheck = "selector NOT present (empty revert -- still missing)";
        } else {
            shieldedTransferCheck = msg.slice(0, 100);
        }
    }
    console.log("  shieldedTransfer(9-arg):", shieldedTransferCheck);

    // --- Write record --------------------------------------------------------
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

    const record = {
        version: "0.5.0",
        date: new Date().toISOString().slice(0, 10),
        network: "flow-evm-testnet",
        chainId: 545,
        contracts: {
            JanusERC20_proxy: PROXY_ADDRESS,
            JanusERC20_impl_prev: "0x7FE0B05ED77E0540519B6f10DD4b4521e867590D",
            JanusERC20_impl: implAddress,
            MemoKeyRegistry: MEMO_REGISTRY,
        },
        contract_status: {
            JanusERC20_proxy: "EXISTING -- UUPS upgraded to v0.5",
            JanusERC20_impl: "NEW (v0.5 -- adds 9-arg shieldedTransfer, 6-arg wrap/unwrap, fees, firstSnapshotBlock, memoRegistry)",
            MemoKeyRegistry: "EXISTING -- wired via setMemoRegistry post-upgrade",
        },
        tx_hashes: {
            janus_erc20_impl_deploy: implTxHash,
            proxy_upgrade: upgradeTxHash,
            set_memo_registry: memoTxHash,
        },
        owner: OPENJANUS_FLOW_COA_EVM,
        deployer_flow_account: "0xbef3c77681c15397",
        deployer_coa_evm: OPENJANUS_FLOW_COA_EVM,
        upgrade_method: "UUPS upgradeToAndCall via COA (P-256 Flow signing)",
        post_upgrade_checks: {
            impl_slot_matches: implMatch,
            version: versionCheck,
            memo_registry_set: memoMatch,
            shielded_transfer_9arg: shieldedTransferCheck,
        },
        explorer: {
            proxy: `https://evm-testnet.flowscan.io/address/${PROXY_ADDRESS}`,
            impl: `https://evm-testnet.flowscan.io/address/${implAddress}`,
        },
    };

    const outPath = join(DEPLOYMENTS_DIR, "janus-erc20-v0.5.json");
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log("\nRecord written:", outPath);

    console.log("\n=== Summary ===");
    console.log("  New impl:   ", implAddress);
    console.log("  Upgrade tx: ", upgradeTxHash);
    console.log("  MemoReg tx: ", memoTxHash);
    console.log("  VERSION:    ", versionCheck);
    console.log("  memoReg:    ", memoRegistryCheck);

    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
