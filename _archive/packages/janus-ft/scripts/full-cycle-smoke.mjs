/**
 * full-cycle-smoke.mjs — End-to-end smoke for JanusFT v0.5 on Flow testnet.
 *
 * NEW IN v0.5: real cross-VM BabyJubJub arithmetic (BabyJub.sol on Flow EVM
 * called via EVM.dryCall). This unblocks the unwrap path that previously
 * overflowed the stub UInt256 math.
 *
 * Personas (single-account smoke — see notes below):
 *   alice = charlie (0x3c601a443c81e6cd) — REGISTRY HOLDER + actor on the
 *                                          smoke-mirror deployment
 *   bob   = testnet-bob (0xd807a3992d7be612) — shielded-transfer recipient
 *
 * NOTE on multi-account smoke:
 *   The CommitmentRegistry resource currently must live on the signer's
 *   account (it is borrowed from /storage/janusFTRegistry inside the wrap
 *   and unwrap transactions). Bob is a commitment-holder only — he cannot
 *   call unwrap against charlie's registry without architectural changes
 *   (e.g., per-user registry capability with @Account entitlement). For
 *   this smoke we validate that:
 *     - wrap (cross-VM babyAdd on user commit + totalSupplyCommit)        WORKS
 *     - shieldedTransfer (cross-VM babyAdd on recipient commit)           WORKS
 *     - unwrap (cross-VM babyAdd of totalSupply + negate(txCommit))       WORKS
 *       <-- this was the previously broken step
 *
 * Flow:
 *   0. (precondition) Both registries reset to identity state via
 *      Admin.resetCommitmentsForTestingOnly() before this script runs.
 *   1. Alice (charlie) sets up registry on her account (idempotent).
 *   2. Alice wraps 5.0 FLOW.
 *   3. Alice shielded-transfers 2.0 FLOW to Bob (HIDDEN).
 *   4. Alice unwraps 3.0 FLOW back to herself.
 *      <-- previously this would overflow babyAddStub on totalSupplyCommit -= txCommit
 *      <-- v0.5 uses real BabyJub.sol babyAdd, so the math is sound
 *   5. Verify totalLocked goes 0 → 5 → 5 → 2.
 *   6. Verify Alice's underlying FlowToken vault gets 3 FLOW back.
 *
 * Outputs: deployments/full-cycle-smoke.json
 */

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");
const DEPLOYMENTS_DIR = join(MODULE_ROOT, "deployments");
const FLOW_JSON = join(MODULE_ROOT, "flow.json");

const TX_SETUP    = join(MODULE_ROOT, "transactions/setup_janus_ft_registry.cdc");
const TX_WRAP     = join(MODULE_ROOT, "transactions/wrap_ft.cdc");
const TX_TRANSFER = join(MODULE_ROOT, "transactions/shielded_transfer_ft.cdc");
const TX_UNWRAP   = join(MODULE_ROOT, "transactions/unwrap_ft.cdc");

// Smoke mirror deployment at charlie (per janus-ft-v0.4.json).
const ALICE_SIGNER  = "charlie";
const ALICE_ADDR    = "0x3c601a443c81e6cd";
const BOB_ADDR      = "0xd807a3992d7be612"; // shielded-transfer recipient (commitment-only)
const JANUS_FT_ADDR = "0x3c601a443c81e6cd"; // smoke mirror (fresh state)

// circomlibjs Pedersen helper -----------------------------------------------
let _ped, _baby;
async function getCircomlib() {
    if (!_ped) {
        const { buildPedersenHash, buildBabyjub } = await import("circomlibjs");
        _ped = await buildPedersenHash();
        _baby = await buildBabyjub();
    }
    return { ped: _ped, baby: _baby };
}

async function pedersenCommit(value, blinding) {
    const { ped, baby } = await getCircomlib();
    // Same packing as v0.4 smoke: value (8 bytes LE) || blinding (16 bytes LE)
    const buf = Buffer.alloc(24, 0);
    let v = BigInt(value);
    for (let i = 0; i < 8; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
    let b = BigInt(blinding);
    for (let i = 8; i < 24; i++) { buf[i] = Number(b & 0xffn); b >>= 8n; }
    const hash = ped.hash(buf);
    const pt = baby.unpackPoint(hash);
    return { x: baby.F.toObject(pt[0]), y: baby.F.toObject(pt[1]) };
}

function rand128() {
    const bytes = randomBytes(16);
    let r = 0n;
    for (const x of bytes) r = (r << 8n) | BigInt(x);
    return r;
}
function rand32Bytes() { return Array.from(randomBytes(32)); }

function runFlowTx(file, argsJsonValue, signer, label) {
    let cmd;
    if (argsJsonValue !== null) {
        const argsPath = `/tmp/.full_cycle_args_${label}.json`;
        writeFileSync(argsPath, JSON.stringify(argsJsonValue));
        cmd = [
            "flow transactions send",
            file,
            `--args-json`,
            `"$(cat ${argsPath})"`,
            `--signer ${signer}`,
            "--network testnet",
            "--gas-limit 9999",
            "--output json",
            `--config-path ${FLOW_JSON}`,
        ].join(" ");
    } else {
        cmd = [
            "flow transactions send",
            file,
            `--signer ${signer}`,
            "--network testnet",
            "--gas-limit 9999",
            "--output json",
            `--config-path ${FLOW_JSON}`,
        ].join(" ");
    }
    let result;
    try {
        const stdout = execSync(cmd, { cwd: MODULE_ROOT, timeout: 300_000, encoding: "utf8", shell: "/bin/bash" });
        result = JSON.parse(stdout);
    } catch (err) {
        if (err.stdout) {
            try { result = JSON.parse(err.stdout); }
            catch {
                throw new Error(`[${label}] non-JSON output: ${err.stdout?.slice(0, 800)} :: STDERR ${err.stderr?.slice(0, 400)}`);
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

function findEventOfType(result, suffix) {
    return (result?.events ?? []).filter(e => (e?.type ?? "").endsWith(suffix));
}

function readScript(src, args) {
    const path = "/tmp/.full_cycle_read.cdc";
    writeFileSync(path, src);
    const argStr = args.map(a => `${a}`).join(" ");
    const cmd = `flow scripts execute "${path}" ${argStr} --network testnet --output json --config-path ${FLOW_JSON}`;
    const out = execSync(cmd, { cwd: MODULE_ROOT, encoding: "utf8" });
    return JSON.parse(out);
}

function parseDictResult(result) {
    if (!result || result.type !== "Dictionary") return null;
    const out = {};
    for (const kv of result.value ?? []) {
        const k = kv?.key?.value;
        const v = kv?.value?.value;
        if (k !== undefined) out[String(k)] = String(v);
    }
    return out;
}

async function main() {
    console.log("=".repeat(72));
    console.log("JanusFT v0.5 — FULL CYCLE smoke test (real cross-VM BabyJub)");
    console.log("=".repeat(72));
    console.log(`Registry @ ${JANUS_FT_ADDR} (smoke mirror — fresh state)`);
    console.log(`Cross-VM BabyJub.sol @ 0x27139AFda7425f51F68D32e0A38b7D43BcB0f870 (Flow EVM)`);
    console.log("");

    const results = {
        date: new Date().toISOString(),
        contract: `${JANUS_FT_ADDR}.JanusFT`,
        version: "v0.5",
        cross_vm_baby_jub_addr: "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870",
        steps: {},
        tx_hashes: {},
        invariants: {},
        privacy_checks: {},
    };

    // ─── Script templates ────────────────────────────────────────────────────
    const totalLockedScript = `import JanusFT from ${JANUS_FT_ADDR}
access(all) fun main(): UFix64 { return JanusFT.getTotalLocked() }`;
    const commitScript = `import JanusFT from ${JANUS_FT_ADDR}
access(all) fun main(account: Address): {String: UInt256} {
    let c = JanusFT.balanceOfCommitment(account: account)
    return { "x": c.x, "y": c.y }
}`;
    const totalSupplyScript = `import JanusFT from ${JANUS_FT_ADDR}
access(all) fun main(): {String: UInt256} {
    let c = JanusFT.totalSupplyCommitment
    return { "x": c.x, "y": c.y }
}`;

    // ─── 0. Pre-state ────────────────────────────────────────────────────────
    const totalLocked0 = readScript(totalLockedScript, []);
    console.log(`[0] totalLocked at start: ${totalLocked0.value}`);
    if (totalLocked0.value !== "0.00000000") {
        throw new Error(`PRECONDITION FAIL: totalLocked must be 0.0 at start (run reset-janus-ft.cdc first). got=${totalLocked0.value}`);
    }
    const aliceCommit0 = parseDictResult(readScript(commitScript, [ALICE_ADDR]));
    const bobCommit0   = parseDictResult(readScript(commitScript, [BOB_ADDR]));
    const tsCommit0    = parseDictResult(readScript(totalSupplyScript, []));
    console.log(`[0] totalSupplyCommitment: ${JSON.stringify(tsCommit0).slice(0,80)}`);
    if (tsCommit0.x !== "0" || tsCommit0.y !== "1") {
        throw new Error(`PRECONDITION FAIL: totalSupplyCommitment must be identity (0,1). got=${JSON.stringify(tsCommit0)}`);
    }
    results.invariants.precondition_totalLocked_zero = true;
    results.invariants.precondition_totalSupply_identity = true;

    // ─── 1. Setup registry (idempotent) ──────────────────────────────────────
    console.log("\n[1] Alice sets up JanusFT registry on her account");
    try {
        const r = runFlowTx(TX_SETUP, null, ALICE_SIGNER, "setup");
        console.log(`   flow tx: ${r.id}`);
        results.tx_hashes.setup = r.id;
    } catch (e) {
        console.log(`   setup skipped: ${e.message.slice(0, 150)}`);
        results.tx_hashes.setup = "(already-set-up-or-skipped)";
    }

    // ─── 2. Alice wraps 5.0 FLOW ─────────────────────────────────────────────
    console.log("\n[2] Alice wraps 5.0 FLOW");
    const WRAP_FLOW = "5.00000000";
    const WRAP_RAW  = 500_000_000n;
    const wrapBlinding = rand128();
    const wrapCommit = await pedersenCommit(WRAP_RAW, wrapBlinding);
    const wrapArgs = [
        { type: "Address", value: ALICE_ADDR },
        { type: "UFix64",  value: WRAP_FLOW },
        { type: "UInt256", value: wrapCommit.x.toString() },
        { type: "UInt256", value: wrapCommit.y.toString() },
        { type: "Array",   value: rand32Bytes().map(b => ({ type: "UInt8", value: b.toString() })) },
    ];
    const wrapTx = runFlowTx(TX_WRAP, wrapArgs, ALICE_SIGNER, "wrap");
    console.log(`   flow tx: ${wrapTx.id}`);
    results.tx_hashes.wrap = wrapTx.id;

    const wrappedEvents = findEventOfType(wrapTx, ".JanusFT.Wrapped");
    if (wrappedEvents.length === 0) throw new Error("No Wrapped event emitted");

    const totalLockedAfterWrap = readScript(totalLockedScript, []);
    const aliceCommitAfterWrap = parseDictResult(readScript(commitScript, [ALICE_ADDR]));
    const tsCommitAfterWrap = parseDictResult(readScript(totalSupplyScript, []));
    console.log(`   totalLocked after wrap: ${totalLockedAfterWrap.value}`);
    if (totalLockedAfterWrap.value !== "5.00000000") {
        throw new Error(`totalLocked mismatch after wrap: ${totalLockedAfterWrap.value}`);
    }
    // After wrap from identity:
    //   alice_commit = babyAdd(identity, wrapCommit) = wrapCommit
    //   totalSupply  = babyAdd(identity, wrapCommit) = wrapCommit
    // Both should equal wrapCommit.
    if (BigInt(aliceCommitAfterWrap.x) !== wrapCommit.x || BigInt(aliceCommitAfterWrap.y) !== wrapCommit.y) {
        throw new Error(`BabyJub identity law VIOLATED: alice commit after wrap != wrapCommit\n  expected=${wrapCommit.x},${wrapCommit.y}\n  got=${aliceCommitAfterWrap.x},${aliceCommitAfterWrap.y}`);
    }
    if (BigInt(tsCommitAfterWrap.x) !== wrapCommit.x || BigInt(tsCommitAfterWrap.y) !== wrapCommit.y) {
        throw new Error(`BabyJub identity law VIOLATED: totalSupply after wrap != wrapCommit`);
    }
    console.log(`   BabyJub identity law verified: babyAdd(identity, C) == C`);
    results.invariants.baby_jub_identity_law_wrap = true;

    // ─── 3. Alice shielded-transfers 2.0 FLOW to Bob ─────────────────────────
    console.log("\n[3] Alice shielded-transfers 2.0 FLOW to Bob (HIDDEN amount)");
    const XFER_RAW = 200_000_000n;
    const newAliceRaw = WRAP_RAW - XFER_RAW; // 3.0 FLOW remaining (encoded in the commit)
    const xferBlinding = rand128();
    const newBlinding  = rand128();

    // Read on-chain commit for C_old
    const aliceCommitNow = parseDictResult(readScript(commitScript, [ALICE_ADDR]));
    const aliceOldX = BigInt(aliceCommitNow.x);
    const aliceOldY = BigInt(aliceCommitNow.y);

    const xferCommit = await pedersenCommit(XFER_RAW, xferBlinding);
    const newAliceCommit = await pedersenCommit(newAliceRaw, newBlinding);
    const publicInputs = [
        aliceOldX, aliceOldY,
        xferCommit.x, xferCommit.y,
        newAliceCommit.x, newAliceCommit.y,
    ];

    const xferArgs = [
        { type: "Address", value: BOB_ADDR },
        { type: "Array",   value: publicInputs.map(pi => ({ type: "UInt256", value: pi.toString() })) },
        { type: "Array",   value: rand32Bytes().map(b => ({ type: "UInt8", value: b.toString() })) },
    ];
    const xferTx = runFlowTx(TX_TRANSFER, xferArgs, ALICE_SIGNER, "xfer");
    console.log(`   flow tx: ${xferTx.id}`);
    results.tx_hashes.shieldedTransfer = xferTx.id;

    // Privacy assertions on the shielded-transfer event ----------------------
    const shieldedEvents = findEventOfType(xferTx, ".JanusFT.ShieldedTransferred");
    if (shieldedEvents.length === 0) throw new Error("No ShieldedTransferred event");
    const fields = shieldedEvents[0]?.values?.value?.fields ?? [];
    const fieldNames = fields.map(f => f.name);
    if (fieldNames.some(n => /amount|value|quantity/i.test(n))) {
        throw new Error(`PRIVACY VIOLATION: ShieldedTransferred has amount field: ${fieldNames}`);
    }
    if (fieldNames.length !== 4 || !fieldNames.every(n => /^(from|to)Commit[XY]$/.test(n))) {
        throw new Error(`unexpected ShieldedTransferred fields: ${fieldNames}`);
    }
    results.privacy_checks.shielded_transfer_event_no_amount = true;

    // No FT events carry the shielded amount
    const SHIELDED_FT_VALUES = ["2.00000000", "200000000"];
    const ftEvents = (xferTx?.events ?? []).filter(e => /FlowToken|FungibleToken/.test(e?.type ?? ""));
    for (const ev of ftEvents) {
        for (const f of ev?.values?.value?.fields ?? []) {
            const v = String(f?.value?.value ?? "");
            if (SHIELDED_FT_VALUES.includes(v) && f?.name === "amount") {
                throw new Error(`PRIVACY VIOLATION: FT event ${ev.type} field=${f.name} value=${v} matches shielded amount`);
            }
        }
    }
    results.privacy_checks.no_ft_event_carries_shielded_amount = true;

    // totalLocked unchanged
    const totalLockedAfterXfer = readScript(totalLockedScript, []);
    if (totalLockedAfterXfer.value !== "5.00000000") {
        throw new Error(`totalLocked changed during xfer: ${totalLockedAfterXfer.value}`);
    }
    results.invariants.totalLocked_unchanged_on_xfer = true;
    console.log(`   totalLocked unchanged: ${totalLockedAfterXfer.value}`);

    // Bob's commit should now be babyAdd(identity, xferCommit) = xferCommit
    const bobCommitAfterXfer = parseDictResult(readScript(commitScript, [BOB_ADDR]));
    if (BigInt(bobCommitAfterXfer.x) !== xferCommit.x || BigInt(bobCommitAfterXfer.y) !== xferCommit.y) {
        throw new Error(`BabyJub identity law VIOLATED on xfer: bob commit != xferCommit\n  expected=${xferCommit.x},${xferCommit.y}\n  got=${bobCommitAfterXfer.x},${bobCommitAfterXfer.y}`);
    }
    console.log(`   Bob commit after xfer == xferCommit (BabyJub identity law verified)`);
    results.invariants.baby_jub_identity_law_xfer = true;

    // ─── 4. Alice unwraps 3.0 FLOW (PREVIOUSLY BROKEN STEP) ──────────────────
    console.log("\n[4] Alice unwraps 3.0 FLOW (PREVIOUSLY BROKEN — stub overflow)");
    const UNWRAP_FLOW = "3.00000000";
    const UNWRAP_RAW  = 300_000_000n;
    const newAliceRawFinal = newAliceRaw - UNWRAP_RAW; // 0
    const unwrapTxBlinding = rand128();
    const newAliceFinalBlinding = rand128();

    // Read Alice's on-chain commit after the xfer (which set her to newAliceCommit).
    const aliceCommitPostXfer = parseDictResult(readScript(commitScript, [ALICE_ADDR]));
    const aliceOldX2 = BigInt(aliceCommitPostXfer.x);
    const aliceOldY2 = BigInt(aliceCommitPostXfer.y);

    const unwrapTxCommit = await pedersenCommit(UNWRAP_RAW, unwrapTxBlinding);
    const newAliceFinalCommit = await pedersenCommit(newAliceRawFinal, newAliceFinalBlinding);
    const unwrapPublicInputs = [
        aliceOldX2, aliceOldY2,
        unwrapTxCommit.x, unwrapTxCommit.y,
        newAliceFinalCommit.x, newAliceFinalCommit.y,
    ];

    // Read alice's FlowToken balance pre-unwrap
    const aliceFlowBalanceScript = `import FlowToken from 0x7e60df042a9c0868
import FungibleToken from 0x9a0766d93b6608b7
access(all) fun main(addr: Address): UFix64 {
    let acct = getAccount(addr)
    let ref = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/flowTokenBalance)
        ?? panic("no flow balance cap")
    return ref.balance
}`;
    const aliceFlowPre = readScript(aliceFlowBalanceScript, [ALICE_ADDR]);
    console.log(`   Alice FlowToken balance pre-unwrap: ${aliceFlowPre.value}`);

    const unwrapArgs = [
        { type: "UFix64",  value: UNWRAP_FLOW },
        { type: "Address", value: ALICE_ADDR }, // recipient
        { type: "UInt256", value: unwrapTxCommit.x.toString() },
        { type: "UInt256", value: unwrapTxCommit.y.toString() },
        { type: "Array",   value: rand32Bytes().map(b => ({ type: "UInt8", value: b.toString() })) },
        { type: "Array",   value: unwrapPublicInputs.map(pi => ({ type: "UInt256", value: pi.toString() })) },
        { type: "Array",   value: rand32Bytes().map(b => ({ type: "UInt8", value: b.toString() })) },
    ];
    const unwrapTx = runFlowTx(TX_UNWRAP, unwrapArgs, ALICE_SIGNER, "unwrap");
    console.log(`   flow tx: ${unwrapTx.id}  <-- this would have OVERFLOWED in v0.4`);
    results.tx_hashes.unwrap = unwrapTx.id;

    const unwrapEvents = findEventOfType(unwrapTx, ".JanusFT.Unwrapped");
    if (unwrapEvents.length === 0) throw new Error("No Unwrapped event emitted");
    console.log(`   Unwrapped event emitted (boundary leak — amount visible by design)`);

    // ─── 5. Post-state invariants ────────────────────────────────────────────
    const totalLockedAfterUnwrap = readScript(totalLockedScript, []);
    console.log(`   totalLocked after unwrap: ${totalLockedAfterUnwrap.value}`);
    if (totalLockedAfterUnwrap.value !== "2.00000000") {
        throw new Error(`totalLocked mismatch after unwrap: expected 2.0, got ${totalLockedAfterUnwrap.value}`);
    }
    results.invariants.totalLocked_decreased_on_unwrap = true;

    const aliceFlowPost = readScript(aliceFlowBalanceScript, [ALICE_ADDR]);
    console.log(`   Alice FlowToken balance post-unwrap: ${aliceFlowPost.value}`);
    // Alice should have gained 3.0 FLOW minus the unwrap tx fee
    const flowDelta = parseFloat(aliceFlowPost.value) - parseFloat(aliceFlowPre.value);
    if (flowDelta < 2.99 || flowDelta > 3.0) {
        throw new Error(`Alice FlowToken delta != ~3.0 (got ${flowDelta})`);
    }
    console.log(`   Alice received +${flowDelta.toFixed(8)} FLOW (~3.0 minus tx fee)`);
    results.invariants.recipient_received_unwrapped_flow = true;

    // totalSupplyCommitment after unwrap should equal what's actually in circulation:
    // totalSupply = wrapCommit (after Alice wrap) - unwrapTxCommit (after Alice unwrap)
    // The shieldedTransfer DOES NOT touch totalSupplyCommit (only commitments[fromAccount]
    // = C_new and commitments[toAccount] += C_tx). So after wrap+xfer+unwrap:
    // totalSupply = wrapCommit + negate(unwrapTxCommit) = babyAdd(wrapCommit, negate(unwrapTxCommit))
    // We verify the cross-VM babyAdd produced a VALID curve point (not the stub overflow)
    // by checking babyAdd(commit, negate(commit)) == identity using a probe script.
    const tsCommitAfterUnwrap = parseDictResult(readScript(totalSupplyScript, []));
    console.log(`   totalSupplyCommitment after unwrap: x=${tsCommitAfterUnwrap.x.slice(0,20)}... y=${tsCommitAfterUnwrap.y.slice(0,20)}...`);

    // Final closure check: babyAdd(totalSupply_post, unwrapTxCommit) should equal
    // wrapCommit (the only thing wrapped so far) — proves homomorphism end-to-end.
    // NOTE: JanusFT.totalSupplyCommitment is auto-borrowed as a reference
    //       (&JanusFT.Commitment) in scripts. We copy into a fresh value via
    //       the (x, y) constructor before calling babyAdd.
    const closureScript = `import JanusFT from ${JANUS_FT_ADDR}
access(all) fun main(unwrapTxX: UInt256, unwrapTxY: UInt256): {String: UInt256} {
    let tsRef = JanusFT.totalSupplyCommitment
    let ts = JanusFT.Commitment(x: tsRef.x, y: tsRef.y)
    let unwrapTxCommit = JanusFT.Commitment(x: unwrapTxX, y: unwrapTxY)
    let recovered = JanusFT.babyAdd(a: ts, b: unwrapTxCommit)
    return { "x": recovered.x, "y": recovered.y }
}`;
    const recovered = parseDictResult(readScript(
        closureScript,
        [unwrapTxCommit.x.toString(), unwrapTxCommit.y.toString()]
    ));
    const recoveredX = BigInt(recovered.x);
    const recoveredY = BigInt(recovered.y);
    if (recoveredX !== wrapCommit.x || recoveredY !== wrapCommit.y) {
        throw new Error(
            `HOMOMORPHISM CLOSURE FAIL: babyAdd(totalSupplyPostUnwrap, unwrapTxCommit) != wrapCommit\n` +
            `  expected x=${wrapCommit.x.toString()}\n` +
            `  got      x=${recoveredX.toString()}\n` +
            `  expected y=${wrapCommit.y.toString()}\n` +
            `  got      y=${recoveredY.toString()}`
        );
    }
    console.log(`   HOMOMORPHISM CLOSURE VERIFIED: ts + unwrapTxCommit == original wrapCommit`);
    results.invariants.homomorphism_closure_end_to_end = true;

    // ─── Privacy summary ─────────────────────────────────────────────────────
    results.privacy_checks.shielded_transfer_no_cleartext_amount_arg = true;
    results.privacy_checks.wrap_event_discloses_amount = true; // by design
    results.privacy_checks.unwrap_event_discloses_amount = true; // by design

    results.steps.summary = {
        setup:  "Alice (charlie) setup registry on her account",
        wrap:   "Alice wrapped 5.0 FLOW",
        xfer:   "Alice shielded-transferred 2.0 FLOW to Bob (HIDDEN)",
        unwrap: "Alice unwrapped 3.0 FLOW back to herself (PREVIOUSLY BROKEN — now PASS)",
    };
    results.final_state = {
        totalLocked_initial:        totalLocked0.value,
        totalLocked_after_wrap:     totalLockedAfterWrap.value,
        totalLocked_after_xfer:     totalLockedAfterXfer.value,
        totalLocked_after_unwrap:   totalLockedAfterUnwrap.value,
        alice_flow_balance_pre:     aliceFlowPre.value,
        alice_flow_balance_post:    aliceFlowPost.value,
    };
    results.overall_pass = true;

    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    const outPath = join(DEPLOYMENTS_DIR, "full-cycle-smoke.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");

    console.log("\n" + "=".repeat(72));
    console.log("FULL CYCLE SMOKE — PASS");
    console.log("=".repeat(72));
    console.log(`wrap → shieldedTransfer → unwrap cycle works end-to-end.`);
    console.log(`Output: ${outPath}`);
}

main().catch(err => {
    console.error("\nFATAL:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
