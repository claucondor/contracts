/**
 * proofGen.js — ZK proof generation helper for aggregate-pedersen tests
 *
 * Wraps snarkjs groth16.fullProve to generate proofs for:
 *   - ConfidentialTransferAggregate witnesses (generateProof)
 *   - AmountDiscloseAggregate witnesses (generateAmountDiscloseProof)
 */

const snarkjs = require("snarkjs");
const path = require("path");

// Paths to transfer circuit artifacts (test zkey — single-contributor)
const WASM_PATH = path.join(
  __dirname,
  "../../../../..",
  "circuits/aggregate-ceremony/build/confidential_transfer_aggregate_js/confidential_transfer_aggregate.wasm"
);
const ZKEY_PATH = path.join(
  __dirname,
  "../../../../..",
  "circuits/aggregate-ceremony/setup/confidential_transfer_aggregate_test.zkey"
);

// Paths to amount-disclose circuit artifacts (test zkey — single-contributor)
const AMT_WASM_PATH = path.join(
  __dirname,
  "../../../../..",
  "circuits/aggregate-ceremony/build/amount_disclose_aggregate_js/amount_disclose_aggregate.wasm"
);
const AMT_ZKEY_PATH = path.join(
  __dirname,
  "../../../../..",
  "circuits/aggregate-ceremony/setup/amount_disclose_aggregate_test.zkey"
);

/** BabyJubJub prime-order subgroup order */
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/** BN254 base field prime */
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Generator G = Base8
const GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
const GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;

// Generator H (NUMS)
const HX = 20176122646359037043957983780698997220241005801156909477756461731029015465513n;
const HY = 12675495183377259114213499882541802147068931119123218019653136042509354750865n;

function modInv(a, m) {
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

function babyAdd(x1, y1, x2, y2) {
  const A = 168700n, D = 168696n;
  const tau = (x1 * x2 % P) * (y1 * y2 % P) % P;
  const dtau = D * tau % P;
  const numX = (x1 * y2 + y1 * x2) % P;
  const denX = (1n + dtau) % P;
  const numY = (y1 * y2 % P + P - A * x1 % P * x2 % P) % P;
  const denY = (1n + P - dtau) % P;
  return [numX * modInv(denX, P) % P, numY * modInv(denY, P) % P];
}

function pointMul(px, py, scalar) {
  let rx = 0n, ry = 1n;
  let ex = px, ey = py;
  let rem = scalar;
  while (rem > 0n) {
    if (rem & 1n) [rx, ry] = babyAdd(rx, ry, ex, ey);
    [ex, ey] = babyAdd(ex, ey, ex, ey);
    rem >>= 1n;
  }
  return [rx, ry];
}

function commit(v, r) {
  const vG = pointMul(GX, GY, v % SUBORDER);
  const rH = pointMul(HX, HY, r % SUBORDER);
  const [cx, cy] = babyAdd(vG[0], vG[1], rH[0], rH[1]);
  return { x: cx, y: cy };
}

function addCommits(p1, p2) {
  const [rx, ry] = babyAdd(p1.x, p1.y, p2.x, p2.y);
  return { x: rx, y: ry };
}

async function generateProof(input) {
  const oldCommit = commit(input.old_value, input.old_blinding);
  const txCommit  = commit(input.transfer_value, input.transfer_blinding);
  const newValue  = input.old_value - input.transfer_value;
  const newCommit = commit(newValue, input.new_blinding);

  const circuitInput = {
    old_value:         input.old_value.toString(),
    old_blinding:      input.old_blinding.toString(),
    transfer_value:    input.transfer_value.toString(),
    transfer_blinding: input.transfer_blinding.toString(),
    new_blinding:      input.new_blinding.toString(),
    old_commit:        [oldCommit.x.toString(), oldCommit.y.toString()],
    transfer_commit:   [txCommit.x.toString(), txCommit.y.toString()],
    new_commit:        [newCommit.x.toString(), newCommit.y.toString()],
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH
  );

  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    pubSignals: publicSignals.map(BigInt),
  };
}

/**
 * generateAmountDiscloseProof — generate a proof for the AmountDiscloseAggregate circuit.
 *
 * Circuit public inputs (order fixed): [amount, commitX, commitY, nonce]
 * Private input: blinding
 *
 * @param {Object} input
 * @param {bigint} input.amount   - wrap amount (== msg.value for JanusFlow)
 * @param {bigint} input.blinding - 252-bit blinding scalar
 * @param {bigint} input.nonce    - anti-replay nonce
 * @returns {Object} { pA, pB, pC, pubSignals }
 *   pubSignals[0] = amount
 *   pubSignals[1] = commitX
 *   pubSignals[2] = commitY
 *   pubSignals[3] = nonce
 */
async function generateAmountDiscloseProof(input) {
  const c = commit(input.amount, input.blinding);

  const circuitInput = {
    amount:   input.amount.toString(),
    commitX:  c.x.toString(),
    commitY:  c.y.toString(),
    nonce:    input.nonce.toString(),
    blinding: input.blinding.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    AMT_WASM_PATH,
    AMT_ZKEY_PATH
  );

  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    pubSignals: publicSignals.map(BigInt),
  };
}

module.exports = { commit, addCommits, generateProof, generateAmountDiscloseProof, SUBORDER, P, GX, GY, HX, HY };
