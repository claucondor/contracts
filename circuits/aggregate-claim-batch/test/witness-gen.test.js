/**
 * test/witness-gen.test.js — Witness generation tests for ConfidentialClaimBatch(50)
 *
 * Validates the circuit via the WASM witness calculator (no zkey required).
 * Tests cover:
 *   - Happy path: N=5 active notes, zero-padded to 50
 *   - Happy path: N=10 active notes
 *   - Happy path: N=25 active notes
 *   - Happy path: full N=50 active notes
 *   - Edge: all 50 amounts are zero
 *   - Edge: oldBalance = 0
 *   - Edge: maximum-value 64-bit amounts (2^64 - 1)
 *   - Edge: maximum-value 252-bit blindings (SUBORDER - 1)
 *   - Edge: newBalance near 2^128 boundary
 *   - Negative: C_old commitment mismatch (wrong oldBlinding)
 *   - Negative: C_new commitment mismatch (wrong newBlinding)
 *   - Negative: C_consumed mismatch (tampered consumed point)
 *   - Negative: amount overflow — amount >= 2^64 (violates Num2Bits(64))
 *   - Negative: oldBalance >= 2^128 (violates Num2Bits(128) in Pedersen2Gen)
 *
 * Run: npm test
 * Prerequisite: compile.sh must have been run first (build/ directory must exist).
 */

"use strict";

const { expect } = require("chai");
const fs   = require("fs");
const path = require("path");

const {
  SUBORDER,
  buildClaimInput,
  padTo50,
} = require("./helpers/proof-inputs.cjs");

// ─────────────────────────────────────────────────────────────────────────────
// WASM witness calculator loader
// ─────────────────────────────────────────────────────────────────────────────
const BUILD_DIR = path.resolve(__dirname, "../build/confidential_claim_batch_js");
const WASM_PATH = path.join(BUILD_DIR, "confidential_claim_batch.wasm");
const WC_PATH   = path.join(BUILD_DIR, "witness_calculator.js");

async function loadWitnessCalculator() {
  const wc     = require(WC_PATH);
  const buffer = fs.readFileSync(WASM_PATH);
  return wc(buffer);
}

/**
 * Attempt to calculate a witness.
 * Returns { ok: true } on success or { ok: false, error } on constraint violation.
 */
async function tryWitness(calculator, input) {
  try {
    await calculator.calculateWitness(input, /* sanityCheck */ true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixed test seeds (deterministic — no Math.random)
// ─────────────────────────────────────────────────────────────────────────────
const OLD_BALANCE = 1_000_000n;
const OLD_BLIND   = 111_111_111_111_111_111n;
const NEW_BLIND   = 999_999_999_999_999_999n;

/** Generate n deterministic (amount, blinding) pairs from seeds. */
function makeNotes(n, amtSeed = 7n, bldSeed = 13n) {
  const amounts   = [];
  const blindings = [];
  for (let i = 0; i < n; i++) {
    amounts.push(  (amtSeed  * BigInt(i + 1) * 1000n)        % (2n ** 64n - 1n)  + 1n);
    blindings.push((bldSeed  * BigInt(i + 2) * 10_000_000_007n) % (SUBORDER - 1n) + 1n);
  }
  return { amounts, blindings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────
describe("ConfidentialClaimBatch(50) — witness generation", function () {
  this.timeout(600_000);

  let calc;

  before(async function () {
    if (!fs.existsSync(WASM_PATH)) {
      throw new Error(
        `WASM not found at ${WASM_PATH}\n` +
        "Run 'bash compile.sh' in circuits/aggregate-claim-batch first."
      );
    }
    calc = await loadWitnessCalculator();
  });

  // ── Happy-path tests ───────────────────────────────────────────────────────

  it("happy path — N=5 active notes, rest zero-padded", async function () {
    const { amounts: a5, blindings: b5 } = makeNotes(5);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:     padTo50(a5,  0n),
      blindings:   padTo50(b5,  0n), // Commit(0, 0) = identity, safe to zero-pad
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  it("happy path — N=10 active notes", async function () {
    const { amounts: a10, blindings: b10 } = makeNotes(10, 3n, 17n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(a10, 0n),
      blindings: padTo50(b10, 0n),
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  it("happy path — N=25 active notes", async function () {
    const { amounts: a25, blindings: b25 } = makeNotes(25, 11n, 23n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(a25, 0n),
      blindings: padTo50(b25, 0n),
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  it("happy path — full N=50 active notes", async function () {
    const { amounts, blindings } = makeNotes(50, 19n, 37n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts,
      blindings,
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it("edge — all 50 amounts are zero (empty batch)", async function () {
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   Array(50).fill(0n),
      blindings: Array(50).fill(0n),  // Commit(0, 0) = identity; C_consumed = identity (0, 1)
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  it("edge — oldBalance = 0 (fresh account claiming first notes)", async function () {
    const { amounts, blindings } = makeNotes(5, 5n, 41n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  0n,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(amounts,  0n),
      blindings: padTo50(blindings, 0n),
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  it("edge — maximum 64-bit amounts (2^64 - 1, small count N=3)", async function () {
    // 3 notes of max size; oldBalance = 0 so newBalance = 3*(2^64-1) << 2^128
    const maxAmt    = 2n ** 64n - 1n;
    const amounts   = padTo50([maxAmt, maxAmt, maxAmt], 0n);
    const blindings = padTo50([1n, 2n, 3n], 0n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  0n,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts,
      blindings,
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  it("edge — maximum 252-bit blindings (SUBORDER - 1)", async function () {
    const maxBlind = SUBORDER - 1n;
    const { amounts } = makeNotes(5, 2n, 1n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: maxBlind,
      newBlinding: maxBlind,
      amounts:   padTo50(amounts, 0n),
      blindings: padTo50(Array(5).fill(maxBlind), 0n),
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  it("edge — newBalance at 2^128 - 1 (maximum valid balance)", async function () {
    // Place 5 notes of 1000 each; set oldBalance = 2^128 - 1 - 5*1000
    const noteAmt = 1000n;
    const nNotes  = 5n;
    const maxBal  = 2n ** 128n - 1n;
    const { blindings } = makeNotes(Number(nNotes), 7n, 29n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  maxBal - nNotes * noteAmt,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(Array(Number(nNotes)).fill(noteAmt), 0n),
      blindings: padTo50(blindings, 0n),
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, result.error).to.be.true;
  });

  // ── Negative cases (constraint violations expected) ────────────────────────

  it("negative — C_old mismatch: wrong oldBlinding supplied", async function () {
    const { amounts, blindings } = makeNotes(3, 2n, 5n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(amounts, 0n),
      blindings: padTo50(blindings, 0n),
    });
    // Correct C_old is in circuitInput; tamper the private oldBlinding
    const tampered = { ...circuitInput, oldBlinding: (OLD_BLIND + 1n).toString() };
    const result = await tryWitness(calc, tampered);
    expect(result.ok, "must fail: wrong oldBlinding vs correct C_old").to.be.false;
  });

  it("negative — C_new mismatch: declared C_new x/y swapped", async function () {
    const { amounts, blindings } = makeNotes(3, 2n, 5n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(amounts, 0n),
      blindings: padTo50(blindings, 0n),
    });
    const tampered = {
      ...circuitInput,
      C_new: [circuitInput.C_new[1], circuitInput.C_new[0]], // swap x/y
    };
    const result = await tryWitness(calc, tampered);
    expect(result.ok, "must fail: invalid C_new").to.be.false;
  });

  it("negative — C_consumed mismatch: x coordinate incremented by 1", async function () {
    const { amounts, blindings } = makeNotes(3, 2n, 5n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(amounts, 0n),
      blindings: padTo50(blindings, 0n),
    });
    const tampered = {
      ...circuitInput,
      C_consumed: [
        (BigInt(circuitInput.C_consumed[0]) + 1n).toString(),
        circuitInput.C_consumed[1],
      ],
    };
    const result = await tryWitness(calc, tampered);
    expect(result.ok, "must fail: tampered C_consumed").to.be.false;
  });

  it("negative — amount overflow: amounts[0] = 2^64 (one beyond 64-bit range)", async function () {
    const { amounts, blindings } = makeNotes(3, 2n, 5n);
    const overflowAmounts = padTo50(amounts.slice(), 0n);
    overflowAmounts[0] = 2n ** 64n; // exactly 2^64 — violates Num2Bits(64)
    const { circuitInput } = buildClaimInput({
      oldBalance:  OLD_BALANCE,
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   overflowAmounts,
      blindings: padTo50(blindings, 0n),
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, "must fail: amount >= 2^64").to.be.false;
  });

  it("negative — oldBalance overflow: oldBalance = 2^128 (one beyond 128-bit range)", async function () {
    const { amounts, blindings } = makeNotes(2, 2n, 5n);
    const { circuitInput } = buildClaimInput({
      oldBalance:  2n ** 128n, // violates Num2Bits(128) in Pedersen2Gen
      oldBlinding: OLD_BLIND,
      newBlinding: NEW_BLIND,
      amounts:   padTo50(amounts, 0n),
      blindings: padTo50(blindings, 0n),
    });
    const result = await tryWitness(calc, circuitInput);
    expect(result.ok, "must fail: oldBalance >= 2^128").to.be.false;
  });
});
