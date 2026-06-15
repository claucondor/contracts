/**
 * test/helpers/proof-inputs.cjs
 *
 * BabyJubJub math + input generation for ConfidentialClaimBatch witness tests.
 *
 * Implements the same elliptic-curve arithmetic as proofGen.cjs in janus-token
 * tests (self-contained for isolation; no external imports required at test time).
 *
 * Public API:
 *   buildClaimInput(opts)   — construct valid circuit inputs + expected publics
 *   commitPoint(v, r)       — compute Commit(v, r) = [v]·G + [r]·H
 *   babyAdd(x1,y1,x2,y2)   — BabyJubJub point addition
 *   SUBORDER                — prime-order subgroup order l
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// BN254 base-field prime (= BabyJubJub field prime)
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// BabyJubJub prime-order subgroup order l (scalar field)
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// Generator G = Base8 (prime-order subgroup generator, [l]·G = identity)
const GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
const GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;

// Generator H = NUMS second generator
const HX = 20176122646359037043957983780698997220241005801156909477756461731029015465513n;
const HY = 12675495183377259114213499882541802147068931119123218019653136042509354750865n;
// ─────────────────────────────────────────────────────────────────────────────

/** Modular inverse of a mod m (extended Euclidean) */
function modInv(a, m) {
  let [old_r, r] = [((a % m) + m) % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

/**
 * BabyJubJub point addition in twisted-Edwards form.
 * Handles the identity (0, 1) correctly.
 */
function babyAdd(x1, y1, x2, y2) {
  const A = 168700n;
  const D = 168696n;
  // tau = x1*x2*y1*y2 mod P
  const tau = ((x1 * x2 % P) * (y1 * y2 % P)) % P;
  const dtau = D * tau % P;
  // xout = (x1*y2 + y1*x2) / (1 + d*tau)
  const numX = (x1 * y2 % P + y1 * x2 % P) % P;
  const denX = (1n + dtau) % P;
  // yout = (y1*y2 - a*x1*x2) / (1 - d*tau)
  const numY = (y1 * y2 % P + P - A * (x1 * x2 % P) % P) % P;
  const denY = (1n + P - dtau) % P;
  return [numX * modInv(denX, P) % P, numY * modInv(denY, P) % P];
}

/**
 * Fixed-base scalar multiplication: scalar * (px, py)
 * Uses double-and-add on the bit decomposition of scalar.
 */
function pointMul(px, py, scalar) {
  // Reduce scalar to range [0, l) — matches circuit Num2Bits behavior
  const s = ((scalar % SUBORDER) + SUBORDER) % SUBORDER;
  let [rx, ry] = [0n, 1n]; // identity
  let [ex, ey] = [px, py];
  let rem = s;
  while (rem > 0n) {
    if (rem & 1n) {
      [rx, ry] = babyAdd(rx, ry, ex, ey);
    }
    [ex, ey] = babyAdd(ex, ey, ex, ey);
    rem >>= 1n;
  }
  return [rx, ry];
}

/**
 * Compute 2-generator Pedersen commitment:
 *   Commit(v, r) = [v]·G + [r]·H
 *
 * @param {bigint} v  token amount
 * @param {bigint} r  blinding scalar
 * @returns {{ x: bigint, y: bigint }}
 */
function commitPoint(v, r) {
  const vG = pointMul(GX, GY, v);
  const rH = pointMul(HX, HY, r);
  const [cx, cy] = babyAdd(vG[0], vG[1], rH[0], rH[1]);
  return { x: cx, y: cy };
}

/**
 * Add two commitment points (homomorphic accumulation).
 */
function addPoints(p1, p2) {
  const [x, y] = babyAdd(p1.x, p1.y, p2.x, p2.y);
  return { x, y };
}

/**
 * Build a complete, valid input object for ConfidentialClaimBatch(50).
 *
 * @param {object} opts
 * @param {bigint}   opts.oldBalance   — user's current hidden balance
 * @param {bigint}   opts.oldBlinding  — user's current blinding factor
 * @param {bigint}   opts.newBlinding  — fresh blinding for new commitment
 * @param {bigint[]} opts.amounts      — array of N note amounts (each 64-bit)
 * @param {bigint[]} opts.blindings    — array of N note blindings (each 252-bit)
 *
 * @returns {object}  { circuitInput, expected }
 *   circuitInput — JSON-serialisable input for the circuit (all values as strings)
 *   expected     — { C_old, C_new, C_consumed } as { x, y } bigints for assertions
 */
function buildClaimInput({ oldBalance, oldBlinding, newBlinding, amounts, blindings }) {
  const N = 50; // circuit is instantiated with N=50

  if (amounts.length !== N || blindings.length !== N) {
    throw new Error(`amounts and blindings must each have exactly ${N} elements`);
  }

  // Compute C_old = Commit(oldBalance, oldBlinding)
  const C_old = commitPoint(oldBalance, oldBlinding);

  // Compute newBalance = oldBalance + sum(amounts)
  const sumAmounts = amounts.reduce((acc, a) => acc + a, 0n);
  const newBalance = oldBalance + sumAmounts;

  // Compute C_new = Commit(newBalance, newBlinding)
  const C_new = commitPoint(newBalance, newBlinding);

  // Compute C_consumed = Σ Commit(amounts[i], blindings[i])
  let C_consumed = { x: 0n, y: 1n }; // identity
  for (let i = 0; i < N; i++) {
    C_consumed = addPoints(C_consumed, commitPoint(amounts[i], blindings[i]));
  }

  const circuitInput = {
    // Public inputs
    C_old:      [C_old.x.toString(), C_old.y.toString()],
    C_new:      [C_new.x.toString(), C_new.y.toString()],
    C_consumed: [C_consumed.x.toString(), C_consumed.y.toString()],
    // Private inputs
    oldBalance:  oldBalance.toString(),
    oldBlinding: oldBlinding.toString(),
    newBlinding: newBlinding.toString(),
    amounts:     amounts.map(a => a.toString()),
    blindings:   blindings.map(b => b.toString()),
  };

  return { circuitInput, expected: { C_old, C_new, C_consumed, newBalance } };
}

/**
 * Return N=50 elements from the given prefix, padding the rest with `fill`.
 */
function padTo50(arr, fill) {
  const N = 50;
  const out = arr.slice(0, N);
  while (out.length < N) out.push(fill);
  return out;
}

module.exports = {
  SUBORDER,
  P,
  GX, GY, HX, HY,
  babyAdd,
  pointMul,
  commitPoint,
  addPoints,
  buildClaimInput,
  padTo50,
};
