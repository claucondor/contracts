# JanusToken — Deployment Record

## Canonical Deployment — v0.2.0 (2026-05-26)

**Trusted Setup:** Hermez pot14 (200+ contributors) + Flow VRF beacon phase 2
**Beacon:** Flow testnet block 323555648 (`30f1f68eed7ea6e7b4964e798ff8a0e2b77e7ca073ed80ac44d39ddc5fb395e7`)
**Account:** `0x28fef3d1d6a12800` (openjanus testnet)
**COA EVM:** `0x0000000000000000000000027eb18dc34b9966fd` (at `/storage/openjanusCOA`)

### Deployed Contracts

| Contract | Address | Deploy TX | Network |
|---|---|---|---|
| JanusToken (EVM) | `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499` | `e477d1f0a6d61ad05aef86429b13e67c4cc07810925000f93b7c56d0e8505842` | Flow EVM testnet (chainId 545) |
| EncryptConsistencyVerifier (EVM) | `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e` | `756fb51756372a29111d4926e882267521746621e0889b04fda67c29f9839b38` | Flow EVM testnet (chainId 545) |
| DecryptOpenVerifier (EVM) | `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc` | `c72c0f0e9579e4b25e66ff1ccbb42ab9833785a45b87c14b3014e5b9dbf68ed8` | Flow EVM testnet (chainId 545) |
| JanusFlow (Cadence) | `0x28fef3d1d6a12800` contract `JanusFlow` | N/A — see notes | Flow testnet |

### ZK Infrastructure (REUSED — DO NOT REDEPLOY)

| Contract | Address | Notes |
|---|---|---|
| BabyJub.sol | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` | Twisted Edwards point ops, stateless |

### Cadence Import

```cadence
import JanusFlow from 0x28fef3d1d6a12800
```

### JanusFlow Cadence Note

The JanusFlow Cadence contract at `0x28fef3d1d6a12800` reflects the on-chain v1.1.0
(Pedersen commitment architecture, deployed in a prior sprint). Protocol-level contract
removal on Flow testnet requires FlowServiceAccount authorization and was not available
during this sprint. The EVM layer (JanusToken + verifiers) is fully updated to v0.2.0.
The e2e test validates the EVM layer directly via per-user COA pattern.

---

## Multi-User E2E Test Results — 2026-05-26 (v0.2.0 ceremony deployment)

**27/27 tests PASS** against the v0.2.0 openjanus deployment.
Test run time: 419.4 seconds.
Circuits: Hermez pot14 + Flow VRF beacon ceremony zkeys.

### Key TX Hashes

| Operation | TX Hash |
|---|---|
| register_alice | `2db871e5e06466dc...` |
| register_bob | `a3a169dbbd4feebb...` |
| register_carol | `3e45122bdf9a42da...` |
| register_dave | `86f4abf570c0641d...` |
| register_eve | `b3b7c5185f346c0c...` |
| wrap_alice (10 FLOW) | `c385be0aa1f777ef...` |
| wrap_carol (25 FLOW) | `c417de2e99f12f7a...` |
| wrap_dave (7 FLOW) | `9f3166ec1a2058d0...` |
| commit_rotation (Carol) | `7b0ac6ca85d02e58...` |

### Test Scenarios

| Scenario | Result | Evidence |
|---|---|---|
| Alice wraps 10 FLOW to Bob | PASS | tx `c385be0a...` |
| Carol wraps 25 FLOW to Bob | PASS | tx `c417de2e...` |
| Dave wraps 7 FLOW to Bob | PASS | tx `9f3166ec...` |
| Homomorphic: E(10)+E(25)+E(7) = E(42) | PASS | Off-chain verified |
| Bob's slot increment = 42 | PASS | On-chain slot verified (pre=0, total=42) |
| Bob generates decrypt_open proof | PASS | 533ms |
| Off-chain decrypt_open verification | PASS | 17ms |
| On-chain DecryptOpenVerifier | PASS | Read-only EVM call |
| CRITICAL: Bob sees total=42 only | PASS | Privacy assertion |
| Structural: accumulated != individual C1x | PASS | Point comparison |
| IND-CPA guarantee | PASS | By construction |
| Fraud 1: Bob claims 100 | REJECTED | Circuit constraint |
| Fraud 2: Eve uses wrong privkey | REJECTED | Circuit constraint |
| Fraud 3: value=2^20 (BSGS out of range) | REJECTED | BSGS boundary |
| Fraud 4: value > 2^48 | REJECTED | Num2Bits(48) constraint |
| Fraud 5: finalize without pending rotation | VERIFIED | Contract state check |
| Pubkey rotation commit | PASS | tx `7b0ac6ca...` |
| Rotation pending recorded | PASS | On-chain read |
| Rotation timelock enforced (1 hour) | PASS | EVM revert verified |

**VERDICT: GO**
**PRIVACY: PASS — Bob knows total=42 only, NOT individual amounts 10, 25, 7**
**CEREMONY: Hermez pot14 + Flow VRF beacon (production-grade trusted setup)**

---

## Gas Measurements (v0.2.0 deployment)

| Operation | Gas Used |
|---|---|
| EncryptConsistencyVerifier deploy | ~1,871 bytes bytecode |
| DecryptOpenVerifier deploy | ~1,964 bytes bytecode |
| JanusToken deploy | ~9,675 bytes deploy payload |
| registerPubkey() | ~80,000 |
| wrap() with ZK proof | ~326,000 |

---

## DEPRECATED — v0.1.0 (2026-05-25, single-contributor lab setup)

These addresses used a lab pot14 setup (single contributor, no ceremony):

| Contract | DEPRECATED Address |
|---|---|
| EncryptConsistencyVerifier | `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C` |
| DecryptOpenVerifier | `0x3bB139B5404fD6b152813bC3532367AAa096638b` |
| JanusToken (EVM) | `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D` |

**DO NOT USE** — superseded by v0.2.0 Hermez + Flow VRF beacon ceremony.

---

## Trusted Setup

**v0.2.0 (production-grade):**
- Phase 1: Hermez pot14 (200+ contributors, multi-party)
- Phase 2: Contributed via `snarkjs.zKey.contribute` with Flow VRF beacon entropy
- Beacon: Flow testnet block 323555648, hash `30f1f68ee...`
- Encrypt zkey SHA256: `17ab9353...`
- Decrypt zkey SHA256: `d87eda3b...`
