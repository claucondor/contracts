#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# compile.sh — compile confidential_claim_batch.circom
#
# Prerequisites:
#   circom >= 2.0.0   (https://docs.circom.io/getting-started/installation/)
#   snarkjs >= 0.7    (npm install -g snarkjs or local dev-dep)
#   node_modules/     (npm install in this directory first)
#
# Usage:
#   cd circuits/aggregate-claim-batch
#   npm install          # install circomlib
#   bash compile.sh      # compile → build/
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CIRCUIT="confidential_claim_batch"
OUTDIR="build"

echo "==> Checking prerequisites..."
command -v circom  >/dev/null 2>&1 || { echo "ERROR: circom not found (install from https://docs.circom.io/)"; exit 1; }
command -v snarkjs >/dev/null 2>&1 || { echo "WARN: snarkjs not in PATH — constraint info step will be skipped"; SNARKJS_OK=0; } && SNARKJS_OK=1
[ -d node_modules/circomlib ] || { echo "ERROR: node_modules/circomlib not found — run 'npm install' first"; exit 1; }

echo "==> Compiling ${CIRCUIT}.circom..."
mkdir -p "${OUTDIR}"

circom "${CIRCUIT}.circom" \
  --r1cs \
  --wasm \
  --sym  \
  --c    \
  -o "${OUTDIR}"

echo ""
echo "==> Compilation complete. Artifacts in ${OUTDIR}/:"
ls -lh "${OUTDIR}/${CIRCUIT}.r1cs" "${OUTDIR}/${CIRCUIT}_js/${CIRCUIT}.wasm" "${OUTDIR}/${CIRCUIT}.sym" 2>/dev/null || true

if [ "${SNARKJS_OK:-0}" = "1" ]; then
  echo ""
  echo "==> R1CS constraint info:"
  snarkjs r1cs info "${OUTDIR}/${CIRCUIT}.r1cs"
fi

echo ""
echo "Done. Run 'npm test' to validate witness generation."
