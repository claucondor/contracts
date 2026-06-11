# Deployments

## v0.8.2 — ShieldedCheckpoint per-token (2026-06-11)

**Context:** Sprint `docs/v0.8.2-MULTITOKEN-FIX.md` — singleton ShieldedCheckpoint (one snapshot per user) was overwriting state when the user wrapped a second token. Fix introduces per-token mapping `(user, token) → Checkpoint` on the EVM side. Cadence side is deferred to v0.8.3 (governance request needed to remove + re-deploy at `0x4b6bc58bc8bf5dcc`).

| Component | Address | Notes |
|-----------|---------|-------|
| `ShieldedCheckpoint` (EVM) — per-token | `0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26` | NEW · deploy tx `f17bec31a78c8c2d39df52f8dbe188b5d7c45c9e294f5edc30390960c4bb6955` |
| `ShieldedCheckpoint` (EVM) — singleton (archived) | `0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76` | OLD · do not use for new writes |
| `ShieldedCheckpoint` (Cadence) — singleton (still in use) | `0x4b6bc58bc8bf5dcc` | UNCHANGED · per-token upgrade blocked by validator (new field `slots` in `Checkpoint` resource); JanusFT/MockFT remains coupled to singleton |

**Migration impact:**
- SDK + front must point to new EVM address and pass token (proxy address) when calling `update / read / metadata`
- JanusFlow EVM `0xA64340…1Ad3` and JanusERC20 EVM `0xFD8F…5387d` continue at same proxies — they don't reference the checkpoint contract, callers do
- MockFT (Cadence FT) shielded balance still subject to singleton overwrite — flag as known limitation in front demo

---

## JanusToken — Flow EVM testnet (chainId 545) — v0.2.0 CURRENT

Trusted setup: Hermez pot14 (200+ contributors) + Flow VRF beacon
(testnet block 323555648, hash `30f1f68eed7ea6e7b4964e798ff8a0e2b77e7ca073ed80ac44d39ddc5fb395e7`).

| Component | Address | Notes |
|-----------|---------|-------|
| `JanusToken.sol` (EVM) | `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499` | ElGamal accumulator |
| `JanusFlow.cdc` (Cadence) | `0x28fef3d1d6a12800` | contract name: `JanusFlow` (LEGACY v1) |
| `EncryptConsistencyVerifier` | `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e` | ZK verifier |
| `DecryptOpenVerifier` | `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc` | ZK verifier |

See `packages/janus-token/deployments/` for full deploy TX hashes and ceremony details.

**JanusFlow Cadence note:** The on-chain JanusFlow contract is legacy v1 (Pedersen architecture).
Flow protocol requires FlowServiceAccount authorization to remove a Cadence contract. For v0.2.0,
use JanusToken EVM directly via COA. Redeploy planned for v0.3.0.

**E2E validation:** 27/27 tests PASS against v0.2.0 deployment (2026-05-26).

---

## DEPRECATED — v0.1.0 (2026-05-25, single-contributor lab setup)

These addresses used a single-contributor lab pot14 setup. DO NOT USE.

| Component | DEPRECATED Address |
|-----------|--------------------|
| `JanusToken.sol` (EVM) | `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D` |
| `EncryptConsistencyVerifier` | `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C` |
| `DecryptOpenVerifier` | `0x3bB139B5404fD6b152813bC3532367AAa096638b` |

---

## JanusFlow — Cadence FLOW wrapper (testnet)

> JanusFlow wraps Cadence FLOW tokens into ElGamal-encrypted commitments.
> Wrap mechanism: **Option Y (Cadence-native)** — FlowToken.Vault custody.

| Component | Address | Notes |
|-----------|---------|-------|
| `JanusFlow.cdc` (Cadence) | `0x28fef3d1d6a12800` | contract name: `JanusFlow` |

### JanusFlow deploy transactions

| What | Transaction |
|------|------------|
| JanusFlow.cdc initial deploy | `5c05cb4543ca067613bdf6a37db030088f77b5e253b322d1c4b4cbd717eaff7b` |
| JanusFlow.cdc update (v1.0) | `ccff0e143d20a4a4963a1faab17120654866cabe73f8cee3d3b771b0756d4628` |
| JanusFlow.cdc update (v1.1.0 — multi-user + homomorphic fix) | `9828ed5075d05579765c6aeb4ff3514beb925a70529ccaf12d2a686ff5aa4171` |

### JanusFlow v1.1.0 changes

- **Bug fix**: v1.0 used a single shared `TRACKING_EVM_ADDRESS = "0xdad"` for all users. v1.1.0 uses each user's own COA EVM address as their commitment slot.
- **Architecture fix**: `JanusToken._mintXY` is homomorphic (additive), not a setter. All slot writes now use delta arithmetic: `delta = babyAdd(target, neg(current))`, so `mintXY(delta)` correctly transitions the slot.
- **New helper**: `babyNeg()` — dryCall to `BabyJub.negate()` for point negation.
- **Cross-VM design**: ZK proof verification via `EVM.dryCall` to ConfidentialTransferVerifier, no msg.sender issues.

### JanusFlow write test results (2026-05-24)

| Test | TX Hash | Result |
|------|---------|--------|
| Wrap 10 FLOW (v1.0) | `5403f9f7fb8f0f9c1ded060ebce7b33685e8b1c4c39a441571947f572f208cbd` | SEALED ✓ |
| Unwrap 10 FLOW (v1.0) | `d47ac8c8dfcb33d8481be0ca4c6d6221c7efc065ac3031731758d8bc508486eb` | SEALED ✓ |

### JanusFlow v1.1.0 multi-user E2E test results (2026-05-25)

| Test | Scenario | Result | Duration |
|------|----------|--------|----------|
| Test 1 | Alice wraps 10 FLOW, transfers 3 to Bob, Bob unwraps 3 | **PASS** | 94s |
| Test 2 | Bob tries to transfer with wrong old commitment | **PASS** (correctly rejected) | 34s |
| Test 3 | Charlie receives from Alice (10) + Bob (5), unwraps 15 | **PASS** (homomorphic accumulation verified) | 180s |
| Test 4 | Dave tries to unwrap with fake commitment | **PASS** (correctly rejected) | 31s |

#### Test 1 TX hashes

| Step | TX Hash |
|------|---------|
| Alice wrap 10 FLOW | `a08a6e4106ae6e425e5daa2c97e6693424cc5ea620a2a83b523d82eecf41d19e` |
| Alice → Bob confidentialTransfer | `b18e4517c59344fdc88d5527321f83fa2fb26df47b43a6c0866845d013f41399` |
| Bob unwrap 3 FLOW | `5938fd26af0ad510a04d4be299e13734174ffe2b415f2f687e2934e152fee8a7` |

#### Test 2 TX hashes

| Step | TX Hash |
|------|---------|
| Bob bad transfer (rejected) | `a858b0324ad850b666b82c26a6cf0b06f8eb9c4cf567405f67f7554f4fd0cfb0` |

#### Test 3 TX hashes

| Step | TX Hash |
|------|---------|
| Alice wrap 50 FLOW | `d8491d167b466233140b868e23bbb873e5d3e605af020a4e6c21950317ee0a28` |
| Bob wrap 30 FLOW | `a2d1dba0f63a0c2a83f5158df3e036f4d3503c5aff7bcc04a6c1ea0ec06cc8b7` |
| Alice → Charlie transfer (10 FLOW commitment) | `21665c5f726538c13f3e722c2a2d66c42ac7c6cbee40705c159a26ab63393b61` |
| Bob → Charlie transfer (5 FLOW commitment) | `630804253f8b762f1e879caff5f28525a7251edb4954924a07ce9f19726e6c6d` |
| Charlie unwrap 15 FLOW | `7db94ebd29903e556bc741b93b4707c715a68cfe5b5569ffce3b416cb92a6d34` |

#### Test 4 TX hashes

| Step | TX Hash |
|------|---------|
| Dave bad unwrap (rejected) | `8f91944e268520669fc874e598d9ce9afb085588f293b3da98e94b5cf431dfb3` |

### Test accounts (testnet)

| Account | Cadence address | COA EVM address |
|---------|----------------|-----------------|
| Alice (lab) | `0x7599043aea001283` | `0x000000000000000000000002b7557ee5d4a32d06` |
| Bob | `0xd807a3992d7be612` | `0x00000000000000000000000250d93efba617e0bf` |
| Charlie | `0x3c601a443c81e6cd` | `0x00000000000000000000000249065458581f9bf0` |
| Dave | `0xd32d9100e1fe983b` | `0x0000000000000000000000027b94cfc8a64971cd` |
| Eve | `0x374a28ddf00498e4` | (COA created, unused in e2e tests) |

### Flowscan links

- [JanusFlow deploy](https://testnet.flowscan.io/transaction/5c05cb4543ca067613bdf6a37db030088f77b5e253b322d1c4b4cbd717eaff7b)
- [JanusFlow v1.1.0 update](https://testnet.flowscan.io/transaction/9828ed5075d05579765c6aeb4ff3514beb925a70529ccaf12d2a686ff5aa4171)
- [Wrap TX (v1.0)](https://testnet.flowscan.io/transaction/5403f9f7fb8f0f9c1ded060ebce7b33685e8b1c4c39a441571947f572f208cbd)
- [Unwrap TX (v1.0)](https://testnet.flowscan.io/transaction/d47ac8c8dfcb33d8481be0ca4c6d6221c7efc065ac3031731758d8bc508486eb)

---

## Primitives (openjanus/primitives — TIER 1, do not redeploy)

| Primitive | Address |
|-----------|---------|
| `BabyJub.sol` | `0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07` |
| `Groth16Verifier` (ConfidentialTransferVerifier) | `0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5` |
| `PedersenBabyJub.cdc` | `0x28fef3d1d6a12800` |
| openjanus COA EVM | `0x0000000000000000000000027eb18dc34b9966fd` |

---

## How to deploy your own JanusToken instance

### Wrapper mode (wraps FLOW or USDC)

```bash
cd packages/janus-token
PRIVATE_KEY=0x... UNDERLYING_ADDRESS=0xFLOWEVMADDRESS npx ts-node examples/deploy-wrapper.ts
```

### Native mode (own supply)

```bash
cd packages/janus-token
PRIVATE_KEY=0x... npx ts-node examples/deploy-wrapper.ts
# (omit UNDERLYING_ADDRESS for native mode)
```

Then use the printed address with the SDK:

```typescript
import { JanusToken } from "@openjanus/janus-token";

const myToken = new JanusToken({
  address: "YOUR_DEPLOYED_ADDRESS",
  network: "testnet",
  // Optional — include if wrapper mode:
  // underlying: { address: "0x...", symbol: "FLOW", decimals: 8 }
});
await myToken.connect();
```

---

## Deployment notes

- The openjanus COA (`0x0000...27eb18dc34b9966fd`) is the EVM `owner` of the demo JanusToken.
- Only this COA can call `mintXY`/`burnXY` on the demo instance.
- Apps that deploy their own instances become the `owner` of their deployed contract.
- Primitives (BabyJub, Groth16Verifier) are immutable — pinned at deploy time.
