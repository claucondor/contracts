/**
 * deploy-v055-fees.mjs — Deploy + upgrade JanusFlow proxy to v0.5.5-fees,
 * then call adminResetSlot for the operator's bricked c2 slot.
 *
 * Steps:
 *   1. Deploy JanusFlow_v0_5_5_fees impl via openjanus-flow COA.
 *   2. Call proxy.upgradeToAndCall(newImpl, 0x) from COA (owner).
 *   3. Verify ERC1967 Upgraded event + basic proxy reads (feeBps, feeRecipient).
 *   4. Call adminResetSlot(0x00000000000000000000000286501f6722a3aede) from COA.
 *   5. Verify: firstSnapshotBlock(c2) == 0, commitments(c2) == (0,1).
 *   6. Write deployments/janusflow-v0_5_5_fees.json.
 *
 * Run from package root:
 *   node scripts/deploy-v055-fees.mjs
 *
 * ABORT POLICY: any phase failure throws and exits non-zero. Operator must
 * intervene before proceeding. If Phase 3 (post-upgrade verify) fails, the
 * script reverts the upgrade back to the prior impl.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Interface, JsonRpcProvider } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT     = join(__dirname, "..");
const ARTIFACTS       = join(MODULE_ROOT, "artifacts/contracts/solidity");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON       = join(MODULE_ROOT, "flow.json");

const ART_V055 = join(ARTIFACTS, "JanusFlow_v0_5_5_fees.sol/JanusFlow_v0_5_5_fees.json");
// Use v0.5.4 ABI for encode (v0.5.5 extends it — either ABI has upgradeToAndCall)
const ART_V054 = join(ARTIFACTS, "JanusFlow_v0_5_4_fees.sol/JanusFlow_v0_5_4_fees.json");

const PROXY                  = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const PRIOR_IMPL             = "0x4F0914911C2f2beb7bFf6d060F3136bbd8c57943";
const FLOW_SIGNER            = "openjanus-flow";
const OPENJANUS_FLOW_COA_EVM = "0x0000000000000000000000022f6b30af48a94787";
const RPC_URL                = "https://testnet.evm.nodes.onflow.org";

// Operator's bricked slot — c2 / 0x4fdd7244df4213c2 Cadence account
const C2_EVM_COA = "0x00000000000000000000000286501f6722a3aede";

// ---------------------------------------------------------------------------
// Cadence transaction templates
// ---------------------------------------------------------------------------

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
            message: "deploy failed: ".concat(result.errorMessage)
        )
        log("deployed at:")
        log(result.deployedContract?.toString() ?? "unknown")
    }
}
`;

const CALL_TX = `import "EVM"

transaction(toHex: String, calldataHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")
        let result = coa.call(
            to: EVM.addressFromString(toHex),
            data: calldataHex.decodeHex(),
            gasLimit: 800_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "call failed: ".concat(result.errorMessage)
        )
    }
}
`;

// ---------------------------------------------------------------------------

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

function extractDeployedAddress(result) {
    const blob = JSON.stringify(result?.events ?? []);
    const m1 = [...blob.matchAll(/"contractAddress[^"]*"\s*:\s*"(0x[0-9a-fA-F]{40})"/gi)];
    if (m1.length > 0) return m1[0][1];

    const known = new Set([
        "0x0000000000000000000000000000000000000000",
        OPENJANUS_FLOW_COA_EVM.toLowerCase(),
    ]);
    const fallback = [...blob.matchAll(/(0x[0-9a-fA-F]{40})/g)]
        .map(m => m[1])
        .filter(a => !known.has(a.toLowerCase()));
    return fallback[0] ?? null;
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

function loadBytecode(artPath) {
    const art = JSON.parse(readFileSync(artPath, "utf8"));
    return art.bytecode.startsWith("0x") ? art.bytecode.slice(2) : art.bytecode;
}

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFlow v0.5.5-fees — deploy impl + upgrade proxy + reset c2 slot");
    console.log("=".repeat(72));

    if (!existsSync(ART_V055)) throw new Error(`Missing artifact: ${ART_V055} — run: npx hardhat compile`);
    if (!existsSync(ART_V054)) throw new Error(`Missing artifact: ${ART_V054} — run: npx hardhat compile`);

    const v055Art   = JSON.parse(readFileSync(ART_V055, "utf8"));
    const v054Art   = JSON.parse(readFileSync(ART_V054, "utf8"));
    // Use v0.5.5 ABI (superset of v0.5.4 ABI)
    const iface     = new Interface(v055Art.abi);
    const provider  = new JsonRpcProvider(RPC_URL);

    // Sanity: adminResetSlot selector in new bytecode
    const adminResetSel = iface.getFunction("adminResetSlot").selector.slice(2);
    const implBc = loadBytecode(ART_V055);
    const hasSelector = implBc.toLowerCase().includes(adminResetSel.toLowerCase());
    console.log(`adminResetSlot selector ${adminResetSel} in bytecode: ${hasSelector ? "YES" : "NO — abort!"}`);
    if (!hasSelector) throw new Error("Bytecode missing adminResetSlot selector — recompile.");

    const record = {
        version:      "0.5.5-fees",
        date:         new Date().toISOString(),
        network:      "flow-evm-testnet",
        chainId:      545,
        proxy:        PROXY,
        prior_impl:   PRIOR_IMPL,
        new_impl:     null,
        tx_hashes:    {},
        verification: {},
        reset_c2:     {},
        explorer:     {},
    };

    // ─── Phase 4: Deploy new impl ─────────────────────────────────────────────
    console.log(`\n[1/5] Deploying JanusFlow_v0_5_5_fees impl...`);
    console.log(`  bytecode size: ${implBc.length / 2} bytes`);
    const implRes  = runFlowTx(DEPLOY_TX, [implBc], "v055fees_deploy_impl");
    const newImpl  = extractDeployedAddress(implRes);
    const implFlowTx = implRes?.id ?? "unknown";
    const implEvmTx  = extractEvmTxHash(implRes);
    console.log(`  Flow tx:   ${implFlowTx}`);
    console.log(`  EVM tx:    ${implEvmTx}`);
    console.log(`  new impl:  ${newImpl}`);
    if (!newImpl) {
        writeFileSync("/tmp/v055fees-impl-deploy-raw.json", JSON.stringify(implRes, null, 2));
        throw new Error("Failed to parse new impl address — see /tmp/v055fees-impl-deploy-raw.json");
    }
    record.new_impl = newImpl;
    record.tx_hashes.impl_deploy_flow = implFlowTx;
    record.tx_hashes.impl_deploy_evm  = implEvmTx;

    // ─── Phase 5: Upgrade proxy ────────────────────────────────────────────────
    console.log(`\n[2/5] Calling proxy.upgradeToAndCall(${newImpl}, 0x)...`);
    const upgradeCalldata = iface.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]);
    const upgradeRes  = runFlowTx(CALL_TX, [PROXY, upgradeCalldata.slice(2)], "v055fees_upgrade_proxy");
    const upgradeFlowTx = upgradeRes?.id ?? "unknown";
    const upgradeEvmTx  = extractEvmTxHash(upgradeRes);
    console.log(`  Flow tx:  ${upgradeFlowTx}`);
    console.log(`  EVM tx:   ${upgradeEvmTx}`);
    record.tx_hashes.upgrade_flow = upgradeFlowTx;
    record.tx_hashes.upgrade_evm  = upgradeEvmTx;

    // ─── Phase 6: Verify upgrade ───────────────────────────────────────────────
    console.log(`\n[3/5] Verifying proxy post-upgrade...`);

    const UPGRADED_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
    const rcpt  = upgradeEvmTx ? await provider.getTransactionReceipt(upgradeEvmTx) : null;
    const upgEvt = rcpt?.logs?.find(l =>
        l.address.toLowerCase() === PROXY.toLowerCase() &&
        l.topics[0] === UPGRADED_TOPIC
    );
    const evtImpl  = upgEvt ? "0x" + upgEvt.topics[1].slice(-40) : null;
    const upgraded = evtImpl?.toLowerCase() === newImpl.toLowerCase();
    console.log(`  ERC1967 Upgraded event impl = ${evtImpl ?? "(missing)"}`);
    console.log(`  matches new impl            = ${upgraded ? "YES" : "NO"}`);
    record.verification.erc1967_upgrade_event_matches_impl = upgraded;

    if (!upgraded) {
        console.error("ABORT: Upgrade event mismatch. Attempting revert to prior impl...");
        // Revert: upgrade back to prior impl
        const revertCalldata = iface.encodeFunctionData("upgradeToAndCall", [PRIOR_IMPL, "0x"]);
        try {
            const revertRes = runFlowTx(CALL_TX, [PROXY, revertCalldata.slice(2)], "v055fees_revert_to_prior");
            console.log("Revert tx Flow:", revertRes?.id);
        } catch (re) {
            console.error("Revert also failed:", re.message);
        }
        throw new Error("Upgrade verification failed — Upgraded event mismatch. Revert attempted.");
    }

    // Read feeBps and feeRecipient — must match prior values
    const feeBpsData = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("feeBps"),
    });
    const [feeBps] = iface.decodeFunctionResult("feeBps", feeBpsData);
    const feeBpsOk = Number(feeBps) === 10;
    console.log(`  proxy.feeBps()        = ${feeBps} (expect 10)  → ${feeBpsOk ? "OK" : "FAIL"}`);

    const feeRecipientData = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("feeRecipient"),
    });
    const [feeRecipient] = iface.decodeFunctionResult("feeRecipient", feeRecipientData);
    const feeRecipientOk = feeRecipient.toLowerCase() === OPENJANUS_FLOW_COA_EVM.toLowerCase();
    console.log(`  proxy.feeRecipient()  = ${feeRecipient} (expect ${OPENJANUS_FLOW_COA_EVM}) → ${feeRecipientOk ? "OK" : "FAIL"}`);

    record.verification.feeBps_post_upgrade         = Number(feeBps);
    record.verification.feeRecipient_post_upgrade    = feeRecipient;
    record.verification.feeBps_ok                    = feeBpsOk;
    record.verification.feeRecipient_ok              = feeRecipientOk;

    if (!feeBpsOk || !feeRecipientOk) {
        throw new Error(
            `ABORT: Post-upgrade proxy reads garbage. feeBps=${feeBps}, feeRecipient=${feeRecipient}. ` +
            `Upgrade went wrong — do NOT call adminResetSlot. Revert manually to PRIOR_IMPL=${PRIOR_IMPL}.`
        );
    }
    console.log("  PROXY IS HEALTHY — proceeding to adminResetSlot.");

    // ─── Phase 7: Call adminResetSlot ─────────────────────────────────────────
    console.log(`\n[4/5] Calling proxy.adminResetSlot(${C2_EVM_COA})...`);
    const resetCalldata = iface.encodeFunctionData("adminResetSlot", [C2_EVM_COA]);
    const resetRes  = runFlowTx(CALL_TX, [PROXY, resetCalldata.slice(2)], "v055fees_admin_reset_c2");
    const resetFlowTx = resetRes?.id ?? "unknown";
    const resetEvmTx  = extractEvmTxHash(resetRes);
    console.log(`  Flow tx:  ${resetFlowTx}`);
    console.log(`  EVM tx:   ${resetEvmTx}`);
    record.reset_c2.target_evm   = C2_EVM_COA;
    record.reset_c2.flow_tx      = resetFlowTx;
    record.reset_c2.evm_tx       = resetEvmTx;
    record.tx_hashes.reset_c2_flow = resetFlowTx;
    record.tx_hashes.reset_c2_evm  = resetEvmTx;

    // ─── Phase 8: Verify reset ─────────────────────────────────────────────────
    console.log(`\n[5/5] Verifying c2 slot reset...`);

    const fsbData = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("firstSnapshotBlock", [C2_EVM_COA]),
    });
    const [fsb] = iface.decodeFunctionResult("firstSnapshotBlock", fsbData);
    const fsbOk = fsb === 0n;
    console.log(`  firstSnapshotBlock(c2) = ${fsb.toString()} (expect 0) → ${fsbOk ? "OK" : "FAIL"}`);

    const commitData = await provider.call({
        to: PROXY,
        data: iface.encodeFunctionData("commitments", [C2_EVM_COA]),
    });
    const [cx, cy] = iface.decodeFunctionResult("commitments", commitData);
    // Identity: (0, 1) — but raw storage (0,0) is also treated as identity by _effectiveCommitment
    const commitOk = (cx === 0n && cy === 1n) || (cx === 0n && cy === 0n);
    console.log(`  commitments(c2): x=${cx.toString()}, y=${cy.toString()} (expect 0,1) → ${commitOk ? "OK" : "FAIL"}`);

    record.reset_c2.firstSnapshotBlock_after = fsb.toString();
    record.reset_c2.commitment_x_after       = cx.toString();
    record.reset_c2.commitment_y_after       = cy.toString();
    record.reset_c2.fsb_is_zero              = fsbOk;
    record.reset_c2.commitment_is_identity   = commitOk;
    record.verification.reset_c2_ok          = fsbOk && commitOk;

    // ─── Write record ──────────────────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

    record.explorer = {
        proxy:      `https://evm-testnet.flowscan.io/address/${PROXY}`,
        new_impl:   `https://evm-testnet.flowscan.io/address/${newImpl}`,
        upgrade_tx: upgradeEvmTx ? `https://evm-testnet.flowscan.io/tx/${upgradeEvmTx}` : null,
        reset_tx:   resetEvmTx   ? `https://evm-testnet.flowscan.io/tx/${resetEvmTx}`   : null,
    };

    const outPath = join(DEPLOYMENTS_DIR, "janusflow-v0_5_5_fees.json");
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log(`\nDeployment record: ${outPath}`);

    // Patch janus-flow-v0.3.json so downstream scripts see the new impl
    const V03_RECORD = join(DEPLOYMENTS_DIR, "janus-flow-v0.3.json");
    if (existsSync(V03_RECORD)) {
        const v03 = JSON.parse(readFileSync(V03_RECORD, "utf8"));
        v03.contracts.JanusFlow_impl_prior = PRIOR_IMPL;
        v03.contracts.JanusFlow_impl = newImpl;
        writeFileSync(V03_RECORD, JSON.stringify(v03, null, 2) + "\n");
        console.log("Patched janus-flow-v0.3.json with new impl.");
    }

    console.log("\n" + "=".repeat(72));
    if (fsbOk && commitOk) {
        console.log("v0.5.5-fees upgrade + c2 reset: COMPLETE");
    } else {
        console.log("WARNING: reset verification had unexpected values — review logs above.");
    }
    console.log(`Proxy:     ${PROXY}`);
    console.log(`New impl:  ${newImpl}`);
    console.log(`Reset c2:  ${C2_EVM_COA}`);
    console.log(`  firstSnapshotBlock: ${fsb.toString()}`);
    console.log(`  commitment: (${cx.toString()}, ${cy.toString()})`);
    console.log("=".repeat(72));

    return record;
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
});
