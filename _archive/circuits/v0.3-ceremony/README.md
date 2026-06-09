# v0.3 Ceremony — `amount_disclose.circom`

Production-grade Groth16 trusted setup for the `amount_disclose` circuit used by
ConfidentialFLOW (v0.3) wrap/unwrap flows.

## What was done

| Phase | Action |
|-------|--------|
| 1 — ptau | Reused **Hermez `pot14_hez.ptau`** (community ceremony, 200+ contributors). No new phase 1. |
| 2.0 — initial zkey | `snarkjs g16s amount_disclose.r1cs pot14_hez.ptau amount_disclose_0000.zkey` |
| 2.1 — contributor #1 | `snarkjs zkc 0000 → 0001 --name="openjanus operator"` (64-byte `/dev/urandom` entropy) |
| 2.2 — contributor #2 | `snarkjs zkc 0001 → 0002 --name="claude code contributor"` (fresh 64-byte `/dev/urandom` entropy, distinct process) |
| 2.3 — beacon | `snarkjs zkb 0002 → final <flow-vrf-hex> 10 -n="Flow VRF beacon block 323723000"` |
| 2.4 — export vkey | `snarkjs zkev amount_disclose_final.zkey verification_key.json` |
| 2.5 — verify chain | `snarkjs zkv amount_disclose.r1cs pot14_hez.ptau amount_disclose_final.zkey` → **`ZKey Ok!`** |
| 3 — Solidity verifier | `snarkjs zkesv amount_disclose_final.zkey AmountDiscloseVerifier.sol`. Contract renamed from snarkjs default `Groth16Verifier` to `AmountDiscloseVerifier`. |

Full SHA256s for every artifact: see `CEREMONY-RECORD.json`.

## How to verify zkey integrity

```bash
sha256sum amount_disclose_final.zkey
# Expected: bb50c5aadcd435c27bfca83b46c216d21162281220bc77ea2d554fa135fe439c

sha256sum verification_key.json
# Expected: 4bd4c1d9d717626e7161da5e4facf87a8fa5c4cd726d0c18710944c598b6cacf

sha256sum AmountDiscloseVerifier.sol
# Expected: e995055a150a451d635372aeb77ece69375e8f02b594e05773c3134f5f354aa3
```

To verify the ceremony chain itself (re-runs the cryptographic check):
```bash
snarkjs zkv amount_disclose.r1cs pot14_hez.ptau amount_disclose_final.zkey
# Expected output ends with: ZKey Ok!
# And shows the three contributions in reverse order (beacon, contributor #2, contributor #1).
```

## How to verify the Flow VRF beacon

The beacon entropy was the on-chain Flow VRF random source for block 323723000 on
**flow-testnet**, fetched via:

```cadence
import RandomBeaconHistory from 0x8c5303eaa26202d6

access(all) fun main(blockHeight: UInt64): String {
    let source = RandomBeaconHistory.sourceOfRandomness(atBlockHeight: blockHeight)
    return String.encodeHex(source.value)
}
```

Re-run any time (the value is permanent and publicly verifiable):
```bash
flow scripts execute get_vrf.cdc 323723000 --network testnet
# Expected: "d6b697bcffcb3b2a126d4e348ce0aec87192aa0388ea72c0f5965c0f75be6eeb"
```

The same hex appears in `CEREMONY-RECORD.json → beacon.beacon_hex` and in the snarkjs
`zkv` transcript line `Beacon generator: d6b697bc...`. Since the VRF value for a finalized
block is unforgeable and was unknown to all phase-2 contributors before the block was sealed,
this provides bias-resistance: no contributor could have biased their entropy to produce a
specific outcome of the ceremony chain.

## How to reproduce

The full ceremony was executed in this directory. The non-reproducible parts are the two
contributor entropies (consumed from `/dev/urandom` and destroyed). The reproducible parts
are:

- The Hermez `pot14_hez.ptau` (SHA256 in record — fetch from any Hermez mirror to compare).
- The Flow VRF beacon (deterministic given block height 323723000 on testnet).
- The contribution chain structure (3 contributions, beacon as #3).

A fresh re-run would produce different per-contribution hashes (different entropy) and a
different final zkey hash — that is the **intended** property of a trusted setup. What
should reproduce: `snarkjs zkv` on any honest run must say `ZKey Ok!`, and the SHA256
of any artifact you receive should match the value published in `CEREMONY-RECORD.json` for
that exact artifact.

## pi_b Fp2 swap (snarkjs vs EIP-197)

The generated `AmountDiscloseVerifier.sol` follows the **canonical snarkjs 0.7.6 layout**:
the verifier does **not** swap the `pi_b` Fp2 coordinates internally. Callers must apply
the `(real, imag) → (imag, real)` swap before calling `verifyProof`. The openjanus SDK
handles this via `applyPiBSwap` (see `openjanus-sdk/src/utils/pi-b-swap.ts`).

This is the same convention as the v0.2.0 verifiers; no patch required. See
audits-kb vulnerability 003 for the full background and the swap function.

## Grade & forward path

This ceremony is **pre-mainnet** grade:
- Phase 1: production-quality (Hermez, 200+ contributors).
- Phase 2: 2 named contributors + Flow VRF beacon.

For mainnet deployment with significant TVL, the ZK security community recommends a
3rd contributor from outside the openjanus team (e.g., an external auditor or community
member). Doing so only requires running `snarkjs zkc amount_disclose_final.zkey
amount_disclose_v0.3.1.zkey --name="<their name>" -e="<their entropy>"` and republishing
the resulting zkey + verifier. The Hermez ptau and r1cs do not change.

## Files in this directory

| File | Purpose |
|------|---------|
| `pot14_hez.ptau` | Phase 1 input (Hermez community ceremony, 200+ contributors). |
| `amount_disclose.r1cs` | Circuit constraint system (compiled from `amount_disclose.circom`). |
| `amount_disclose_0000.zkey` | Initial phase 2 zkey from `groth16 setup`. |
| `amount_disclose_0001.zkey` | After contribution #1 (openjanus operator). |
| `amount_disclose_0002.zkey` | After contribution #2 (claude code contributor). |
| `amount_disclose_final.zkey` | **Production zkey** after Flow VRF beacon. Use this for proving. |
| `verification_key.json` | Off-chain vkey for `snarkjs groth16 verify`. |
| `AmountDiscloseVerifier.sol` | **Production Solidity verifier**. Deploy this to Flow EVM. |
| `CEREMONY-RECORD.json` | Full audit trail with every SHA256, contributor name, contribution hash, and beacon source. |
| `README.md` | This file. |
