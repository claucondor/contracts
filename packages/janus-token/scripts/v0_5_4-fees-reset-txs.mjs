/**
 * v0_5_4-fees-reset-txs.mjs — Reset 4 test wallets after JanusFlow v0.5.4-fees upgrade.
 *
 * All pre-fee test commitments are stale (built without fee deduction). Reset
 * the slots so wallets start fresh with the new 0.1% fee economics.
 *
 * Wallets reset: alice (openjanus-flow COA), bob, dave, c2.
 *
 * Run from package root:
 *   node scripts/v0_5_4-fees-reset-txs.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT     = join(__dirname, "..");
const ARTIFACTS       = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON       = join(MODULE_ROOT, "flow.json");

const ART_JANUSFLOW = join(
    ARTIFACTS,
    "JanusFlow_v0_5_4_fees.sol/JanusFlow_v0_5_4_fees.json"
);
const PROXY   = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const RPC_URL = "https://testnet.evm.nodes.onflow.org";

const FLOW_SIGNER = "openjanus-flow";

// 4 test wallets — EVM COA full 20-byte addresses (Flow EVM COA format: 0x...0002... prefix)
const TEST_WALLETS = [
    {
        name:            "alice",
        cadence_address: "0x7599043aea001283",
        alias:           "testnet-claucondor (openjanus-flow signer)",
        evm_coa_full:    "0x0000000000000000000000022f6b30af48a94787",
    },
    {
        name:            "bob",
        cadence_address: "0xd807a3992d7be612",
        evm_coa_full:    "0x00000000000000000000000250d93efba617e0bf",
    },
    {
        name:            "dave",
        cadence_address: "0xd32d9100e1fe983b",
        evm_coa_full:    "0x0000000000000000000000027b94cfc8a64971cd",
    },
    {
        name:            "c2",
        cadence_address: "0x4fdd7244df4213c2",
        evm_coa_full:    "0x00000000000000000000000286501f6722a3aede",
    },
];

const CALL_TX = `import "EVM"

transaction(toHex: String, calldataHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(toHex),
            data: calldataHex.decodeHex(),
            gasLimit: 300_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "call failed: ".concat(result.errorMessage)
        )
    }
}
`;

function runFlowTx(txBody, args, label, gasLimit = 9999) {
    const txPath = `/tmp/.${label}.cdc`;
    writeFileSync(txPath, txBody);
    const argStrs = args.map(a => `"${a}"`).join(" ");
    const cmd = [
        "flow transactions send",
        txPath,
        argStrs,
        "--network testnet",
        `--signer ${FLOW_SIGNER}`,
        `--gas-limit ${gasLimit}`,
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
                throw new Error(`[${label}] non-JSON flow CLI output:\n${err.stdout?.slice(0, 1500)}\nSTDERR: ${err.stderr?.slice(0, 500)}`);
            }
        } else {
            throw new Error(`[${label}] ${err.message}\nSTDERR: ${err.stderr?.slice(0, 600)}`);
        }
    }
    if (result.status !== "SEALED" || result.errorMessage) {
        throw new Error(`[${label}] tx not SEALED or errored: status=${result.status} errMsg=${result.errorMessage}`);
    }
    return result;
}

function extractEvmTxHash(result) {
    const events = result?.events ?? [];
    for (const ev of events) {
        const t = ev?.type ?? "";
        if (!t.endsWith(".EVM.TransactionExecuted")) continue;
        const fields = ev?.values?.value?.fields ?? [];
        for (const f of fields) {
            const arr = f?.value?.value;
            if (Array.isArray(arr) && arr.length === 32 &&
                arr.every(b => b?.type === "UInt8")) {
                const hex = arr.map(b => Number(b.value).toString(16).padStart(2, "0")).join("");
                return "0x" + hex;
            }
        }
    }
    return null;
}

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.5.4-fees — Reset 4 test wallets");
    console.log("=".repeat(72));

    if (!existsSync(ART_JANUSFLOW)) {
        throw new Error(`Missing artifact: ${ART_JANUSFLOW} — run: npx hardhat compile`);
    }

    const jfArt   = JSON.parse(readFileSync(ART_JANUSFLOW, "utf8"));
    const jfIface = new Interface(jfArt.abi);
    const provider = new JsonRpcProvider(RPC_URL);

    const resets = {};

    for (const wallet of TEST_WALLETS) {
        console.log(`\n[reset] ${wallet.name} (${wallet.cadence_address})...`);

        // Check current commitment before reset
        let priorX = "0", priorY = "0";
        try {
            const commitData = await provider.call({
                to: PROXY,
                data: jfIface.encodeFunctionData("balanceOfCommitmentXY", [wallet.evm_coa_full]),
            });
            const [cx, cy] = jfIface.decodeFunctionResult("balanceOfCommitmentXY", commitData);
            priorX = cx.toString();
            priorY = cy.toString();
            console.log(`  prior commitment: (${priorX.slice(0, 8)}..., ${priorY.slice(0, 8)}...)`);
        } catch (e) {
            console.log(`  could not read prior commitment: ${e.message}`);
        }

        // Encode adminResetSlot(address)
        const resetCalldata = jfIface.encodeFunctionData("adminResetSlot", [wallet.evm_coa_full]);

        const res        = runFlowTx(CALL_TX, [PROXY, resetCalldata.slice(2)], `v054fees_reset_${wallet.name}`);
        const flowTxId   = res?.id ?? "unknown";
        const evmTxHash  = extractEvmTxHash(res);
        console.log(`  Flow tx:  ${flowTxId}`);
        console.log(`  EVM tx:   ${evmTxHash}`);

        resets[wallet.name] = {
            cadence_address: wallet.cadence_address,
            evm_coa: wallet.evm_coa_full,
            prior_commitment_x: priorX,
            prior_commitment_y: priorY,
            flow_tx: flowTxId,
            evm_tx: evmTxHash,
            flow_tx_explorer: `https://testnet.flowscan.io/tx/${flowTxId}`,
            status: "SEALED",
        };
    }

    const feesRecord = existsSync(join(DEPLOYMENTS_DIR, "janusflow-fees.json"))
        ? JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, "janusflow-fees.json"), "utf8"))
        : {};

    const out = {
        version:    "0.5.4-fees",
        date:       new Date().toISOString(),
        purpose:    "Reset 4 test wallets after JanusFlow v0.5.4-fees upgrade. Pre-fee commitments cleared; fresh start with 0.1% fee economics.",
        network:    "flow-cadence-testnet + flow-evm-testnet",
        chainId:    545,
        evm_proxy:  PROXY,
        evm_impl:   feesRecord.impl_address ?? "see janusflow-fees.json",
        resets,
        manual_steps_for_operator:
            "Clear localStorage for all 4 test wallets in DevTools: " +
            "localStorage.clear() or remove keys starting with 'openjanus:'. " +
            "Then re-setup MemoKey and wrap fresh — all slots start at identity point.",
    };

    const OUT_FILE = join(DEPLOYMENTS_DIR.replace("deployments", "scripts"), "v0_5_4-fees-reset-txs.json");
    // Actually write to scripts dir
    writeFileSync(
        join(MODULE_ROOT, "scripts", "v0_5_4-fees-reset-txs.json"),
        JSON.stringify(out, null, 2) + "\n"
    );
    console.log(`\nReset record: scripts/v0_5_4-fees-reset-txs.json`);

    console.log("\n" + "=".repeat(72));
    console.log("Reset complete — 4 test wallets cleared");
    console.log("NEXT: node scripts/v0_5_4-fees-smoke.mjs");
    console.log("=".repeat(72));
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
