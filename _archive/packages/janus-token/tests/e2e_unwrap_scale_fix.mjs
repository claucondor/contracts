/**
 * e2e_unwrap_scale_fix.mjs — Proves the SCALE=1e18 unwrap fix (vuln 014) works
 * end-to-end on the new UUPS proxy.
 *
 * Architecture target (Phase 2 of v0.2.1 sprint):
 *   EVM proxy: 0x025efe7e89acdb8F315C804BE7245F348AA9c538 (JanusToken UUPS)
 *   EVM impl:  0x28686066D28Eb86269190Eae76eD7170c21BB7FB
 *   Cadence router: 0x5dcbeb41055ec57e (openjanus-janusflow-router) — not used by this test
 *
 * What this test asserts:
 *   GIVEN  Charlie has FLOW in his Cadence wallet and a COA at /storage/evm
 *   WHEN   Charlie registers a BabyJub pubkey on the NEW proxy
 *          AND  wraps N FLOW for himself via JanusToken.wrap(...) (with msg.value = N * 1e18)
 *          AND  generates a decrypt_open proof claiming the slot total
 *          AND  calls JanusToken.unwrap(claimedUnits, charlieCOA, proof)
 *   THEN   Charlie's native FLOW balance recovers (≈ N - gas) — NOT zero, NOT 1 wei
 *          AND  locked[charlieCOA] decreases by claimedUnits * SCALE (= N * 1e18)
 *          AND  the slot resets to identity (0, 1, 0, 1)
 *
 * Gate semantics: if "FLOW recovered" is essentially zero (≤ 1e-15 FLOW), the
 * SCALE fix is not active. Fail loud.
 *
 * Charlie was chosen because (per Phase 1) he is the only Flow testnet user with
 * an existing COA at /storage/evm and sufficient FLOW. He has no pubkey on the
 * new proxy yet — this test registers it first.
 *
 * Usage:
 *   node tests/e2e_unwrap_scale_fix.mjs
 *
 * Env vars (all optional):
 *   WRAP_FLOW       — amount to wrap in whole FLOW (default 2)
 *   SKIP_REGISTER   — skip pubkey registration if already done in a prior run
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createHmac, randomBytes } from "crypto";
import { JsonRpcProvider, Interface, formatEther, getAddress } from "ethers";
import { buildBabyjub } from "circomlibjs";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(__dirname, "..");

// ─── Network + contract config (NEW v0.2.1 addresses) ─────────────────────────
const RPC_URL    = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID   = 545;
const PROXY_ADDR = "0x025efe7e89acdb8F315C804BE7245F348AA9c538";  // NEW proxy
const ENCRYPT_VERIF = "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e";
const DECRYPT_VERIF = "0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc";

// ─── Test fixtures ────────────────────────────────────────────────────────────
const CHARLIE_FLOW = "0x3c601a443c81e6cd";
// Signer name as declared in the janus-token package flow.json (NOT "testnet-charlie")
const CHARLIE_SIGNER = "charlie";
const CHARLIE_COA = "0x00000000000000000000000249065458581f9bf0";
const CHARLIE_PKEY = "/home/oydual3/.flow/testnet-charlie.pkey";

const WRAP_FLOW_UNITS = BigInt(process.env.WRAP_FLOW ?? "2");  // whole FLOW
const WRAP_FLOW_STR = WRAP_FLOW_UNITS.toString() + ".00000000";

// ─── Circuit artifacts (bundled in @openjanus/sdk) ────────────────────────────
const SDK_DIR = "/home/oydual3/openjanus-sdk";
const ENCRYPT_WASM = join(SDK_DIR, "circuits/build/encrypt_consistency.wasm");
const ENCRYPT_ZKEY = join(SDK_DIR, "circuits/setup/encrypt_consistency_final.zkey");
const DECRYPT_WASM = join(SDK_DIR, "circuits/build/decrypt_open.wasm");
const DECRYPT_ZKEY = join(SDK_DIR, "circuits/setup/decrypt_open_final.zkey");
const DECRYPT_VKEY = join(SDK_DIR, "circuits/setup/decrypt_open_vkey.json");

// ─── COA transactions (reuse from private-tip-v1) ─────────────────────────────
const COA_CALL_RAW  = "/home/oydual3/zkapps/private-tip-v1/cadence/transactions/coa_call_raw.cdc";
const COA_CALL_WITH_VALUE = "/home/oydual3/zkapps/private-tip-v1/cadence/transactions/coa_call_with_value.cdc";
const COA_CALL_AND_WITHDRAW = "/home/oydual3/zkapps/private-tip-v1/cadence/transactions/coa_call_and_withdraw.cdc";

// ─── JanusToken ABI (only what we call) ───────────────────────────────────────
const JANUS_ABI = [
  "function SCALE() view returns (uint256)",
  "function registerPubkey(uint256 x, uint256 y) external",
  "function hasPubkey(address) view returns (bool)",
  "function pubkeyOf(address) view returns (uint256 x, uint256 y)",
  "function slotOf(address) view returns (tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y))",
  "function nonce(address) view returns (uint256)",
  "function locked(address) view returns (uint256)",
  "function wrap(address to, tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y) ct, uint256 senderNonce, uint[6] publicInputs, uint[8] encryptProof) external payable",
  "function unwrap(uint256 claimedUnits, address recipient, uint[7] publicInputs, uint[8] decryptProof) external",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
const iface = new Interface(JANUS_ABI);

async function callView(func, ...args) {
  const data = iface.encodeFunctionData(func, args);
  const result = await provider.call({ to: PROXY_ADDR, data });
  const decoded = iface.decodeFunctionResult(func, result);
  return decoded.length === 1 ? decoded[0] : decoded;
}

function flowTx(cdcFile, argsJson, signer) {
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow transactions send "${cdcFile}" --args-json "${argsStr}" --signer ${signer} --network testnet --gas-limit 9999 -o json`;
  let out;
  try {
    out = execSync(cmd, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024, cwd: MODULE_ROOT });
  } catch (e) {
    const raw = (e.stdout || "") + (e.stderr || "");
    return { txId: "", error: raw.slice(0, 600) };
  }
  let parsed;
  try { parsed = JSON.parse(out); } catch { return { txId: "", error: out.slice(0, 400) }; }
  if (parsed.error) return { txId: parsed.id || "", error: parsed.error };
  if (parsed.status !== "SEALED") return { txId: parsed.id || "", error: `Not SEALED (status=${parsed.status})` };
  return { txId: parsed.id || "", raw: parsed };
}

async function deriveBabyJub(flowKeyHex) {
  const babyjub = await buildBabyjub();
  const Fr = babyjub.F;
  const flowKeyBuf = Buffer.from(flowKeyHex, "hex");
  const salt = Buffer.from("openjanus-privacy-v1", "utf8");
  const prk = createHmac("sha256", salt).update(flowKeyBuf).digest();
  const info = Buffer.from("babyjub-privkey", "utf8");
  const okm = createHmac("sha256", prk)
    .update(Buffer.concat([prk, info, Buffer.from([0x01])]))
    .digest();
  const ORDER = babyjub.subOrder;
  const raw = BigInt("0x" + okm.toString("hex"));
  const privkey = ((raw % ORDER) + ORDER) % ORDER || 1n;
  const pkPoint = babyjub.mulPointEscalar(babyjub.Base8, privkey);
  return {
    privkey,
    pubkey: { x: BigInt(Fr.toObject(pkPoint[0])), y: BigInt(Fr.toObject(pkPoint[1])) },
  };
}

async function randomBabyJubScalar() {
  const babyjub = await buildBabyjub();
  const ORDER = babyjub.subOrder;
  const bytes = randomBytes(32);
  const raw = BigInt("0x" + bytes.toString("hex"));
  return ((raw % ORDER) + ORDER) % ORDER || 1n;
}

function packProof(proof) {
  return [
    BigInt(proof.pi_a[0]),
    BigInt(proof.pi_a[1]),
    BigInt(proof.pi_b[0][1]),  // Fp2 swap for EIP-197
    BigInt(proof.pi_b[0][0]),
    BigInt(proof.pi_b[1][1]),
    BigInt(proof.pi_b[1][0]),
    BigInt(proof.pi_c[0]),
    BigInt(proof.pi_c[1]),
  ];
}

async function bsgsDecrypt(C1x, C1y, C2x, C2y, privkey, maxVal = 10000n) {
  const babyjub = await buildBabyjub();
  const Fr = babyjub.F;
  const G = babyjub.Base8;
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  const C1 = [Fr.e(C1x), Fr.e(C1y)];
  const skC1 = babyjub.mulPointEscalar(C1, privkey);
  const negSkC1 = [Fr.e(P - BigInt(Fr.toObject(skC1[0]))), skC1[1]];
  const vG = babyjub.addPoint([Fr.e(C2x), Fr.e(C2y)], negSkC1);

  const n = BigInt(Math.ceil(Math.sqrt(Number(maxVal) + 1)));
  const babies = new Map();
  let pt = [Fr.e(0n), Fr.e(1n)];
  for (let i = 0n; i <= n; i++) {
    babies.set(`${Fr.toObject(pt[0])},${Fr.toObject(pt[1])}`, i);
    pt = babyjub.addPoint(pt, G);
  }
  const step = babyjub.mulPointEscalar(G, n + 1n);
  const negStep = [Fr.e(P - BigInt(Fr.toObject(step[0]))), step[1]];
  let giant = vG;
  for (let j = 0n; j * (n + 1n) <= maxVal; j++) {
    const key = `${Fr.toObject(giant[0])},${Fr.toObject(giant[1])}`;
    if (babies.has(key)) {
      const i = babies.get(key);
      const v = i + j * (n + 1n);
      if (v <= maxVal) return v;
    }
    giant = babyjub.addPoint(giant, negStep);
  }
  return null;
}

async function getCadenceBalance(addr) {
  const out = execSync(
    `flow accounts get ${addr} --network testnet --output json`,
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
  );
  return BigInt(JSON.parse(out).balance);  // in attoflow? actually 8-decimal UFix64 stored as scaled int
  // Flow accounts get returns balance as integer in 1e-8 FLOW (UFix64 raw form)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("  JanusToken v0.2.1 SCALE-fix e2e (vuln 014 verification)");
  console.log("  Proxy:", PROXY_ADDR);
  console.log("=".repeat(70));

  let failures = 0;
  const ok = (m) => console.log(`  PASS: ${m}`);
  const fail = (m) => { console.error(`  FAIL: ${m}`); failures++; };
  const info = (m) => console.log(`  INFO: ${m}`);

  const results = {
    startedAt: new Date().toISOString(),
    proxy: PROXY_ADDR,
    charlie: { flow: CHARLIE_FLOW, coa: CHARLIE_COA },
    wrapFlowUnits: WRAP_FLOW_UNITS.toString(),
    steps: {},
    txHashes: {},
  };

  // ── 0. Verify SCALE constant exists on proxy ────────────────────────────────
  console.log("\n--- Step 0: Verify SCALE constant on proxy ---");
  const scale = await callView("SCALE");
  results.scale = scale.toString();
  if (scale === 10n ** 18n) {
    ok(`SCALE() = ${scale} (= 1e18)`);
  } else {
    fail(`SCALE() = ${scale}, expected 1e18`);
    return 1;
  }

  // ── 1. Derive Charlie keypair ───────────────────────────────────────────────
  console.log("\n--- Step 1: Derive Charlie BabyJub keypair from Flow signing key ---");
  const charlieKeyHex = readFileSync(CHARLIE_PKEY, "utf-8").trim();
  const charlieKp = await deriveBabyJub(charlieKeyHex);
  info(`pkx=${charlieKp.pubkey.x.toString().slice(0, 18)}...`);
  info(`pky=${charlieKp.pubkey.y.toString().slice(0, 18)}...`);

  // ── 2. Register pubkey if needed ───────────────────────────────────────────
  console.log("\n--- Step 2: Register pubkey on new proxy (if needed) ---");
  let hasPk = await callView("hasPubkey", CHARLIE_COA);
  if (hasPk) {
    info("Charlie already has pubkey on new proxy (idempotent run)");
    const [onPkx, onPky] = await callView("pubkeyOf", CHARLIE_COA);
    if (BigInt(onPkx) === charlieKp.pubkey.x && BigInt(onPky) === charlieKp.pubkey.y) {
      ok("On-chain pubkey matches derived");
    } else {
      fail(`Pubkey mismatch on new proxy: derived ${charlieKp.pubkey.x.toString().slice(0,12)} vs on-chain ${onPkx.toString().slice(0,12)}`);
      return 1;
    }
  } else {
    const data = iface.encodeFunctionData("registerPubkey", [charlieKp.pubkey.x, charlieKp.pubkey.y]).slice(2);
    const argsJson = [
      { type: "String", value: PROXY_ADDR },
      { type: "String", value: data },
      { type: "UInt64", value: "200000" },
    ];
    const r = flowTx(COA_CALL_RAW, argsJson, CHARLIE_SIGNER);
    if (r.error) { fail(`registerPubkey: ${r.error.slice(0, 300)}`); return 1; }
    ok(`Pubkey registered tx=${r.txId.slice(0, 16)}...`);
    results.txHashes.registerPubkey = r.txId;
  }

  // ── 3. Capture BEFORE state ─────────────────────────────────────────────────
  console.log("\n--- Step 3: Capture BEFORE state ---");
  const nonce0 = BigInt(await callView("nonce", CHARLIE_COA));
  const lockedBefore = BigInt(await callView("locked", CHARLIE_COA));
  const slotBefore = await callView("slotOf", CHARLIE_COA);

  // Cadence balance: parse via flow accounts get
  // Flow CLI returns balance as decimal-string UFix64 like "108.95076000".
  // We convert to 1e-8 raw units (BigInt) for safe arithmetic.
  function flowBal(addr) {
    const out = execSync(`flow accounts get ${addr} --network testnet -o json`, { encoding: "utf-8" });
    const parsed = JSON.parse(out);
    const balStr = String(parsed.balance);  // e.g. "108.95076000"
    if (balStr.includes(".")) {
      const [whole, frac] = balStr.split(".");
      const fracPadded = (frac + "00000000").slice(0, 8);
      return BigInt(whole) * 100_000_000n + BigInt(fracPadded);
    }
    return BigInt(balStr) * 100_000_000n;
  }

  const cadBalBefore = flowBal(CHARLIE_FLOW);
  info(`Charlie nonce on proxy: ${nonce0}`);
  info(`Charlie locked on proxy: ${lockedBefore} attoFLOW (= ${formatEther(lockedBefore)} FLOW)`);
  info(`Charlie Cadence balance: ${cadBalBefore} (1e-8 FLOW) = ${Number(cadBalBefore) / 1e8} FLOW`);
  const slotIsIdentity = (slotBefore.C1x === 0n && slotBefore.C1y === 1n && slotBefore.C2x === 0n && slotBefore.C2y === 1n);
  info(`Slot identity? ${slotIsIdentity}`);

  results.steps.before = {
    nonce: nonce0.toString(),
    lockedAttoFlow: lockedBefore.toString(),
    cadenceBalRaw: cadBalBefore.toString(),
    slotIdentity: slotIsIdentity,
  };

  // ── 4. Wrap N FLOW to self ──────────────────────────────────────────────────
  console.log(`\n--- Step 4: Charlie wraps ${WRAP_FLOW_UNITS} FLOW for self ---`);
  const randomness = await randomBabyJubScalar();

  const { buildEncryptProof } = await import("/home/oydual3/openjanus-sdk/dist/index.js");
  const encResult = await buildEncryptProof(
    { value: WRAP_FLOW_UNITS, randomness, recipientPubkey: charlieKp.pubkey },
    { wasmPath: ENCRYPT_WASM, zkeyPath: ENCRYPT_ZKEY }
  );
  info(`Encrypt proof: C1x=${encResult.ciphertext.C1.x.toString().slice(0, 12)}...`);

  const ct = encResult.ciphertext;
  const proof8 = packProof(encResult.rawProof);
  const pubInputs6 = encResult.publicInputs.slice(0, 6);

  const wrapCalldata = iface
    .encodeFunctionData("wrap", [
      CHARLIE_COA,
      [ct.C1.x, ct.C1.y, ct.C2.x, ct.C2.y],
      nonce0,
      pubInputs6,
      proof8,
    ])
    .slice(2);

  const wrapArgs = [
    { type: "String", value: PROXY_ADDR },
    { type: "String", value: wrapCalldata },
    { type: "UInt64", value: "600000" },
    { type: "UFix64", value: WRAP_FLOW_STR },
  ];
  info(`Submitting wrap tx (msg.value = ${WRAP_FLOW_STR} FLOW = ${WRAP_FLOW_UNITS * (10n ** 18n)} attoFLOW)...`);
  const wr = flowTx(COA_CALL_WITH_VALUE, wrapArgs, CHARLIE_SIGNER);
  if (wr.error) { fail(`wrap: ${wr.error.slice(0, 400)}`); return 1; }
  ok(`Wrap tx sealed: ${wr.txId}`);
  results.txHashes.wrap = wr.txId;

  // ── 5. Verify locked increased by WRAP_FLOW * 1e18 ─────────────────────────
  console.log("\n--- Step 5: Verify locked increased ---");
  const lockedAfterWrap = BigInt(await callView("locked", CHARLIE_COA));
  const lockedDelta = lockedAfterWrap - lockedBefore;
  const expectedDelta = WRAP_FLOW_UNITS * (10n ** 18n);
  info(`locked delta: ${lockedDelta} attoFLOW (= ${formatEther(lockedDelta)} FLOW)`);
  if (lockedDelta === expectedDelta) {
    ok(`locked increased by exactly ${WRAP_FLOW_UNITS} FLOW (= ${expectedDelta} attoFLOW)`);
  } else {
    fail(`locked delta ${lockedDelta} != expected ${expectedDelta}`);
    return 1;
  }
  results.steps.afterWrap = { lockedAttoFlow: lockedAfterWrap.toString(), deltaAttoFlow: lockedDelta.toString() };

  // ── 6. Read slot, BSGS-decrypt to confirm total = WRAP_FLOW_UNITS ──────────
  console.log("\n--- Step 6: Read slot + BSGS decrypt ---");
  const slotAfter = await callView("slotOf", CHARLIE_COA);
  info(`slot post-wrap: C1x=${slotAfter.C1x.toString().slice(0, 14)}...`);
  const total = await bsgsDecrypt(slotAfter.C1x, slotAfter.C1y, slotAfter.C2x, slotAfter.C2y, charlieKp.privkey, 10000n);
  if (total === null) { fail("BSGS could not decrypt"); return 1; }
  info(`BSGS total = ${total} units`);
  if (slotIsIdentity && total === WRAP_FLOW_UNITS) {
    ok(`Total = ${WRAP_FLOW_UNITS} (matches single wrap)`);
  } else if (!slotIsIdentity) {
    info(`Slot was non-identity pre-wrap, total=${total} (cumulative)`);
  }

  // ── 7. Generate decrypt_open proof for `total` ─────────────────────────────
  console.log("\n--- Step 7: Generate decrypt_open proof ---");
  const decryptInput = {
    privkey: charlieKp.privkey.toString(),
    pubkey: [charlieKp.pubkey.x.toString(), charlieKp.pubkey.y.toString()],
    C1: [slotAfter.C1x.toString(), slotAfter.C1y.toString()],
    C2: [slotAfter.C2x.toString(), slotAfter.C2y.toString()],
    claimed_value: total.toString(),
  };
  const { proof: dProof, publicSignals: dPubs } = await snarkjs.groth16.fullProve(
    decryptInput, DECRYPT_WASM, DECRYPT_ZKEY
  );
  const vkey = JSON.parse(readFileSync(DECRYPT_VKEY, "utf-8"));
  const ocValid = await snarkjs.groth16.verify(vkey, dPubs, dProof);
  if (!ocValid) { fail("off-chain decrypt verify = false"); return 1; }
  ok("Off-chain decrypt_open verify = true");

  // ── 8. Call unwrap(claimedUnits=total, recipient=CHARLIE_COA) ──────────────
  console.log(`\n--- Step 8: Charlie unwraps ${total} units → his COA ---`);
  const dProof8 = packProof(dProof);
  const dPubs7 = dPubs.map((s) => BigInt(s));

  // SANITY: publicInputs[6] must equal total
  if (dPubs7[6] !== total) {
    fail(`publicInputs[6] (${dPubs7[6]}) != claimedUnits (${total})`);
    return 1;
  }
  ok(`publicInputs[6] (${dPubs7[6]}) == claimedUnits (${total}) ✓`);

  const unwrapCalldata = iface
    .encodeFunctionData("unwrap", [total, CHARLIE_COA, dPubs7, dProof8])
    .slice(2);

  // Use coa_call_and_withdraw so the COA's received FLOW is auto-pulled back into
  // Charlie's Cadence FlowToken vault — this is what makes "FLOW recovered" observable
  // in the Cadence balance delta.
  const unwrapArgs = [
    { type: "String", value: PROXY_ADDR },
    { type: "String", value: unwrapCalldata },
    { type: "UInt64", value: "800000" },
  ];

  const ur = flowTx(COA_CALL_AND_WITHDRAW, unwrapArgs, CHARLIE_SIGNER);
  if (ur.error) {
    fail(`unwrap: ${ur.error.slice(0, 400)}`);
    return 1;
  }
  ok(`Unwrap tx sealed: ${ur.txId}`);
  results.txHashes.unwrap = ur.txId;

  // ── 9. Verify FLOW recovered ───────────────────────────────────────────────
  console.log("\n--- Step 9: Verify FLOW recovered ---");
  const lockedAfterUnwrap = BigInt(await callView("locked", CHARLIE_COA));
  const slotAfterUnwrap = await callView("slotOf", CHARLIE_COA);
  const cadBalAfter = flowBal(CHARLIE_FLOW);

  info(`locked post-unwrap: ${lockedAfterUnwrap} attoFLOW (= ${formatEther(lockedAfterUnwrap)} FLOW)`);
  info(`Cadence balance post-unwrap: ${cadBalAfter} (1e-8 FLOW) = ${Number(cadBalAfter) / 1e8} FLOW`);

  const expectedLockedDecrease = total * (10n ** 18n);
  const lockedDecrease = lockedAfterWrap - lockedAfterUnwrap;
  if (lockedDecrease === expectedLockedDecrease) {
    ok(`locked decreased by exactly ${total} FLOW (= ${expectedLockedDecrease} attoFLOW)`);
  } else {
    fail(`locked decrease ${lockedDecrease} != expected ${expectedLockedDecrease}`);
  }

  const slotResetOk = (slotAfterUnwrap.C1x === 0n && slotAfterUnwrap.C1y === 1n && slotAfterUnwrap.C2x === 0n && slotAfterUnwrap.C2y === 1n);
  if (slotResetOk) ok("Slot reset to identity (0,1,0,1)");
  else fail("Slot NOT reset to identity");

  // FLOW recovery — the gate criterion.
  // Cadence balance delta = (received from unwrap) - (gas paid for both wrap+unwrap+register).
  // We wrapped WRAP_FLOW_UNITS, so:
  //   raw delta in 1e-8 = (cadBalAfter - cadBalBefore)
  //   gas costs typically < 0.01 FLOW per tx → < 0.03 FLOW total
  //   If SCALE fix works: delta ≈ 0 - gas (we wrapped N, recovered ~N, paid gas)
  //   If SCALE fix BROKEN: delta ≈ -N - gas (we wrapped N, recovered 0 attoFLOW from N wei, paid gas)
  //
  // Pre-fix would show cadBalAfter ≈ cadBalBefore - WRAP_FLOW (lost the whole wrap).
  // Post-fix shows cadBalAfter ≈ cadBalBefore - gas (recovered the wrap).
  const cadDelta = cadBalAfter - cadBalBefore;
  const cadDeltaFlow = Number(cadDelta) / 1e8;
  const wrapFlowNum = Number(WRAP_FLOW_UNITS);
  info(`Cadence balance delta: ${cadDelta} (1e-8 FLOW) = ${cadDeltaFlow} FLOW`);
  info(`(wrapped: -${wrapFlowNum} FLOW, expected recovery: +${wrapFlowNum} FLOW, gas: ~−0.01 to −0.03 FLOW)`);

  // GATE: if recovery worked, |cadDelta + gas| << WRAP_FLOW. Bug case: cadDelta ≈ -WRAP_FLOW.
  // Concretely: post-fix delta should be > -0.1 FLOW. Pre-fix delta would be ~-WRAP_FLOW.
  const recovered = cadDeltaFlow > -0.5;  // generous; 2 FLOW wrap with ~0.05 max gas
  if (recovered) {
    ok(`FLOW RECOVERED: net balance change ${cadDeltaFlow.toFixed(8)} FLOW (≈ -gas only, NOT -${wrapFlowNum} FLOW)`);
    results.gate = "PROCEED";
  } else {
    fail(`FLOW NOT RECOVERED: net balance change ${cadDeltaFlow.toFixed(8)} FLOW (looks like pre-fix bug — wrap lost)`);
    results.gate = "BLOCKED";
  }

  results.steps.afterUnwrap = {
    lockedAttoFlow: lockedAfterUnwrap.toString(),
    slotReset: slotResetOk,
    cadBalRaw: cadBalAfter.toString(),
    cadDeltaRaw: cadDelta.toString(),
    cadDeltaFlow: cadDeltaFlow,
  };

  results.failures = failures;
  results.endedAt = new Date().toISOString();
  results.verdict = failures === 0 ? "PASS" : "FAIL";

  const resultsFile = join(MODULE_ROOT, "deployments/e2e_unwrap_scale_fix.json");
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));

  console.log("\n" + "=".repeat(70));
  console.log(`  Results: ${failures} failures`);
  console.log(`  Verdict: ${results.verdict}`);
  console.log(`  Gate:    ${results.gate || "N/A"}`);
  console.log(`  TX hashes:`);
  for (const [k, v] of Object.entries(results.txHashes)) {
    console.log(`    ${k.padEnd(16)} ${v}`);
  }
  console.log(`  Results saved: ${resultsFile}`);
  console.log("=".repeat(70));

  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FATAL:", err.message);
    console.error(err.stack?.split("\n").slice(0, 10).join("\n"));
    process.exit(1);
  });
