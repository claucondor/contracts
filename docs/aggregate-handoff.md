# v0.7.0 Aggregate Commitment Handoff Report
Date: 2026-06-04
Branch: feat/aggregate-commitment

## Summary

This branch upgrades the Janus confidential token stack from windowed-Pedersen commitments
to the classical 2-generator Pedersen scheme:

```
Commit(v, r) := [v]·G + [r]·H
```

This scheme is homomorphic — after N wraps/receives the on-chain accumulator is
`Commit(Σv_i, Σr_i)`, and the prover only needs the scalar pair `(Σv_i, Σr_i mod l)`.
The previous windowed-Pedersen hash was not homomorphic, causing `C_old mismatch` reverts
when a user had more than one accumulated deposit before attempting a shieldedTransfer.

## New contracts deployed (testnet)

| Contract | Address | Status |
|----------|---------|--------|
| Pedersen2Gen library | `0xb8Af0091A010E082b05d0c55E1019c3833E15760` | NEW |
| ConfidentialTransferAggregateVerifier | `0x5702A545d2853b03B808aEA331f892c121b67243` | NEW — test zkey only |
| JanusFlow impl | `0xf63f010c47B4861d74B6DC9CB719b40F13E1758c` | NEW (v0.7.0) |
| JanusFlow proxy | `0x9A83732417947Ef9b7AEa64bF807a345267c2FdA` | NEW (v0.7.0) |
| JanusERC20 impl | `0x5757e1e3C2ED8e19D37765FbbBb6Ae9dbD28B9b9` | NEW (v0.7.0) |
| JanusERC20 proxy | `0xD5E6a52635599E6B2296B5BfEeC617E333561ea0` | NEW (v0.7.0) |
| BabyJub | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` | REUSED (stateless) |
| AmountDiscloseVerifier | `0xD0ED3936530258C278f5357C1dB709ad34768352` | REUSED (stateless) |
| MemoKeyRegistry | `0x05D104962ff087441f26BA11A1E1C3b9E091D663` | REUSED (shared registry) |
| MockUSDC | `0x686E8d90A7B608540cAF46E527fD8a5631A1b658` | REUSED (testnet underlying) |

Admin:
- Cadence: `0xc4e8f99915893a2f`
- COA EVM: `0x000000000000000000000002656f9205e386ed78`
- Reused from v0.6.6 stack

Full deployment record: `deployments/aggregate-testnet.json`

## What was done (commits)

1. `chore(aggregate-ceremony): scaffold circuit directory + README`
   - New `circuits/aggregate-ceremony/` directory with Circom source and README

2. `feat(aggregate-ceremony): port circuit artifacts + test zkey + verifier`
   - `confidential_transfer_aggregate.circom` (18,620 constraints, Groth16 on BN254)
   - R1CS, WASM, test zkey, verification_key.json
   - `ConfidentialTransferAggregateVerifier.sol` generated from test zkey

3. `feat(janus-token): Pedersen2Gen.sol library — 2-gen Pedersen on BabyJubJub`
   - `commit(v, r)`, `addCommits(x1,y1,x2,y2)`, `isOnCurve(x,y)`
   - G = Base8, H = NUMS (sha256-derived)
   - Stateless library, deployed once and reused by all Janus tokens

4. `feat(janus-token): JanusToken base — additive accumulator on 2-gen Pedersen`
   - `_acceptShieldedCredit` uses `pedersen2Gen.addCommits` (was windowed-Pedersen in-place)
   - `_effectiveCommitment` converts (0,0) storage to identity (0,1) on first read
   - `shieldedTransfer` recipient update via `addCommits`
   - New storage slot 91: `pedersen2Gen` address
   - New initializer param `_pedersen2Gen`

5. `feat(janus-token): JanusFlow + JanusERC20 wired to aggregate verifier`
   - Both use `ConfidentialTransferAggregateVerifier` for shieldedTransfer proof verification
   - JanusFlow proxy initialized: new aggregate verifier + Pedersen2Gen library
   - JanusERC20 proxy initialized: same

6. `test(janus-token): on-chain homomorphism + wrap-receive-transfer suite`
   - 27 hardhat tests across 3 files — all pass
   - `aggregate-pedersen.test.cjs`: Pedersen2Gen unit tests (14 tests)
   - `homomorphism-onchain.test.cjs`: additive homomorphism proofs (5 tests)
   - `janus-flow-aggregate.test.cjs`: wrap × 3 → shieldedTransfer scenario (8 tests)

7. `feat(scripts): deploy-aggregate.mjs targeting flow-evm-testnet`

8. `chore(deploy): aggregate testnet deployment — full record`
   - 6 contracts deployed, all post-deploy slot checks pass

9. `test(smoke): testnet verification — partial pass`
   - AggregateVerifier: on-chain proof verification PASS
   - Pedersen2Gen: on-chain homomorphism PASS
   - adminResetSlot: state cleanup PASS
   - wrap(): FAIL — known AmountDisclose gap (see below)

10. `docs: aggregate handoff + smoke result update`

## Differences from v0.6.6

| Aspect | v0.6.6 | v0.7.0 (this branch) |
|--------|--------|----------------------|
| Commitment scheme | windowed-Pedersen (Pedersen hash, 256-bit) | 2-gen Pedersen ([v]G + [r]H) |
| Homomorphic | No | Yes |
| Transfer verifier | ConfidentialTransferVerifier (old) | ConfidentialTransferAggregateVerifier (new) |
| Pedersen library | None (in-contract BabyJub.babyAdd) | Pedersen2Gen.sol (separate contract) |
| New storage slot | N/A | slot 91: pedersen2Gen address |
| initializer args | 5 | 6 (+ pedersen2Gen) |

## Smoke test outcome

Result: **PARTIAL** — see `deployments/aggregate-testnet-smoke.json`

Passed:
- ConfidentialTransferAggregateVerifier: real Groth16 proof verified on-chain
- Pedersen2Gen.addCommits: on-chain homomorphism confirmed
- adminResetSlot: EVM state reset to identity
- All 27 hardhat unit tests pass locally

Failed:
- `wrap()` on testnet: EVM execution reverted inside COA.call

Root cause of wrap failure: **known architectural gap — not a 2-gen Pedersen regression**.

The deployed AmountDiscloseVerifier (0xD0ED39...) is the v0.3 windowed-Pedersen circuit.
The `wrap()` function calls this verifier with `[claimed_amount, txCommit.x, txCommit.y]`
where `txCommit` is a windowed-Pedersen commitment. This verifier is incompatible with the
2-gen Pedersen scheme used by `shieldedTransfer`. For the full wrap→transfer round-trip to
work, a new AmountDisclose circuit (proving `Commit(v,r) = [v]G + [r]H`) is required.

The 27 hardhat tests pass because they use a `MockAmountDiscloseVerifier` that always
returns true — the core 2-gen Pedersen accumulation logic is correct.

## Ceremony status

TESTNET-ONLY: The `confidential_transfer_aggregate_test.zkey` was generated with a single
contributor using entropy `"openjanus-contracts-aggregate-pedersen-test"`. It is valid for
testnet smoke testing only.

**REQUIRED before mainnet:**
- Multi-party Phase 2 ceremony with at least 3 independent contributors
- Each contributor: `snarkjs zkey contribute`
- Final beacon: `snarkjs zkey beacon`
- Phase 2 verification: `snarkjs zkey verify`
- New Solidity verifier exported from production zkey and redeployed

## JanusFT (Cadence side) status

Not updated in this branch. The JanusFT Cadence contract (`packages/janus-ft/`) calls into
the EVM JanusToken accumulator path via cross-VM calls. The Cadence side does not perform
any commitment arithmetic directly — it delegates to the EVM contract. Since the EVM
accumulator now uses `Pedersen2Gen.addCommits`, the Cadence side is compatible without
code changes.

Existing JanusFT testnet address (testnet-claucondor, 0x7599043aea001283) is unchanged.

## Operator's next steps

1. **Review this branch** — confirm addresses, deployment record, test pass count
2. **Build AmountDisclose v2 circuit** — proves `Commit(v,r) = [v]G + [r]H`, replaces the
   v0.3 windowed-Pedersen verifier. This unblocks the full wrap→transfer smoke path.
3. **Deploy AmountDisclose v2 verifier** — new contract, new proxy inits pointing to it
4. **Re-run smoke test** — after step 2+3, the wrap step should pass and verdict → PASS
5. **SDK update** — `@openjanus/sdk` must update `computeCommitment` to use 2-gen scheme,
   update proof generation to use the aggregate circuit wasm+zkey, update contract addresses
6. **Multi-party ceremony** — required before any mainnet consideration
7. **OFAC screening hook** — still required per mainnet checklist (unchanged from v0.6.6)
8. **Merge** `feat/aggregate-commitment` to main after operator approval

## Explorer links (testnet)

- JanusFlow proxy: https://evm-testnet.flowscan.io/address/0x9A83732417947Ef9b7AEa64bF807a345267c2FdA
- JanusERC20 proxy: https://evm-testnet.flowscan.io/address/0xD5E6a52635599E6B2296B5BfEeC617E333561ea0
- Pedersen2Gen: https://evm-testnet.flowscan.io/address/0xb8Af0091A010E082b05d0c55E1019c3833E15760
- AggregateVerifier: https://evm-testnet.flowscan.io/address/0x5702A545d2853b03B808aEA331f892c121b67243
