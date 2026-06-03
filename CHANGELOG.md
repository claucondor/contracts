# Changelog

All notable changes to this project will be documented in this file.

---

## [0.6.4] — 2026-06-02

### Added

**Multi-token sprint deliverables — canonical v0.6 contracts migrated from cadence-crypto-lab.**

#### `@claucondor/janus-token`

- `JanusToken.sol` — Abstract base v0.6. Track B++ architectural change: replaces per-token
  `memoKeyPubX`/`memoKeyPubY` mappings (deprecated tombstones at slots 7-8) with a shared
  `MemoKeyRegistry` contract read from slot 90. UUPS-compatible (single-gap layout, 79-slot gap).
  Fee mechanism at slots 10 (feeBps 10 bps hard-coded, configurable by admin).
- `JanusFlow.sol` — Native-FLOW concrete token v0.6.3. Reads memo keys from shared
  `MemoKeyRegistry` at slot 90.
- `MemoKeyRegistry.sol` — Immutable BabyJubJub pubkey registry. No proxy, no admin. Single
  `publishMemoKey()` call covers all Janus EVM tokens. On-curve validation (ax²+y²=1+dx²y²).
  Deployed testnet: `0x05D104962ff087441f26BA11A1E1C3b9E091D663`.

#### `@claucondor/janus-erc20`

- `JanusERC20.sol` — ERC20-wrapping confidential token v0.6. Extends `JanusToken` base with
  `transferFrom`/`transfer` custody pattern. Supports WFLOW9 (native-FLOW) and any ERC20
  underlying. Storage slots 91+ (below the 79-slot gap at 11-89 + memoRegistry at 90).
- `mocks/WFLOW9.sol` — Canonical wrapped-FLOW (WETH9-compatible) for testnet JanusWFLOW.
  No canonical WFLOW exists on Flow EVM testnet; this is the authoritative v0.6 sprint deployment.
- `mocks/MockERC20.sol` — Minimal mintable ERC20 for JanusMockUSDC testing.

#### `@claucondor/janus-ft`

- `JanusFT.cdc` — Production v0.6 generic Cadence FT wrapper (replaces lab-spike v0.5 stub).
  Real cross-VM BabyJub arithmetic via `BabyJub.sol`, real Groth16 ZK via
  `ConfidentialTransferVerifier.sol` + `AmountDiscloseVerifier.sol`. Accepts any
  `@{FungibleToken.Vault}` underlying at deploy time. `FeeConfig` resource (upgrade-safe).
  Deployed testnet: `0x7599043aea001283`.
- `mocks/MockFT.cdc` — Generic mintable FungibleToken for testnet underlying.
- New transactions (user-facing templates):
  - `transactions/wrap_ft.cdc`
  - `transactions/unwrap_ft.cdc`
  - `transactions/shielded_transfer_ft.cdc`
  - `transactions/setup_janus_ft_registry.cdc`
  - `transactions/publish_memokey_ft.cdc`

### Testnet addresses (v0.6.4)

| Contract | Address |
|---|---|
| JanusFlow proxy (ERC1967 UUPS) | `0x2458ae2d26797c2ffa3B4f6612Bdc4aDf22b7156` |
| JanusWFLOW proxy | `0x00129E94d5340bd19d0b4ed9CDf718BB6e0A9400` |
| JanusMockUSDC proxy | `0xd45FDa099Cf67eD842eA379865AB08E18D62BAf3` |
| MemoKeyRegistry | `0x05D104962ff087441f26BA11A1E1C3b9E091D663` |
| JanusFT (Cadence) | `0x7599043aea001283` |
| All feeBps | 10 (0.1%) |

---

## [0.2.0] — 2026-05-26

### Changed

**Trusted setup ceremony — closes audit vuln/010**

- `EncryptConsistencyVerifier` and `DecryptOpenVerifier` redeployed from
  ceremony-backed zkeys: Hermez pot14 (200+ contributors) + Flow VRF beacon
  (testnet block 323555648, hash `30f1f68eed7ea6e7b4964e798ff8a0e2b77e7ca073ed80ac44d39ddc5fb395e7`).
- `JanusToken.sol` redeployed referencing new verifier addresses.
- SHA256 encrypt zkey: `17ab9353f2966336bbf380549a47721ccce4283f20000380e18ecab763c3da16`
- SHA256 decrypt zkey: `d87eda3b96f2eeab11f33583369519d041d25915cdbd49cedf41fd269b8e0745`

**New v0.2.0 addresses (ceremony-backed):**
- `JanusToken.sol`: `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499`
- `EncryptConsistencyVerifier`: `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e`
- `DecryptOpenVerifier`: `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc`

**v0.1.0 addresses DEPRECATED** — single-contributor lab setup, superseded above.

**E2E:** 27/27 PASS (419.4s, 2026-05-26) against new deployment + ceremony.

**JanusFlow Cadence (unchanged, deferred):**
On-chain `JanusFlow` at `0x28fef3d1d6a12800` remains legacy v1 (Pedersen).
Protocol restriction on contract removal; redeploy planned v0.3.0.

---

## [0.1.0] — 2026-05-25

### Added

**@openjanus/janus-token**

- `JanusToken.sol` — ElGamal accumulator-based confidential token with ZK-gated operations:
  - `wrap()` — deposit FLOW + encrypt ciphertext to recipient's slot (requires `encrypt_consistency` Groth16 proof)
  - `unwrap()` — prove decryption of accumulated slot + release FLOW (requires `decrypt_open` Groth16 proof)
  - `confidentialTransfer()` — reassign locked FLOW + accumulate ciphertext (no new FLOW deposit)
  - `registerPubkey()` — register BabyJubJub public key for COA address
  - `commitPubkeyRotation()` / `finalizePubkeyRotation()` — two-step key rotation with 1-hour testnet timelock
  - Per-sender nonce replay protection on all state-changing operations
  - Homomorphic ciphertext accumulation via BabyJub.babyAdd()
  - IND-CPA under DDH on BabyJubJub

- `JanusFlow.cdc` — Cadence wrapper for cross-VM access:
  - Per-user COA pattern: each user's COA is their independent `msg.sender` in JanusToken
  - `wrap()`, `confidentialTransfer()`, `unwrap()`, `registerPubkey()`, `commitRotation()`, `finalizeRotation()`
  - FLOW vault custody managed in Cadence, encrypted accounting in EVM

- Tests:
  - 24/24 multi-user e2e tests PASS (`tests/e2e_multiuser.mjs`)
  - Privacy property confirmed: Bob decrypts total=42, NOT individual amounts (10, 25, 7)
  - All fraud cases rejected: wrong amount, wrong privkey, BSGS boundary, range overflow, premature rotation
  - Pubkey rotation timelock enforced

- Deployed to Flow EVM testnet (canonical openjanus account):
  - `JanusToken.sol`: `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D`
  - `JanusFlow.cdc`: `0x28fef3d1d6a12800` (contract name `JanusFlow`)
  - EVM deploy tx: `01f053e10270f79c121b80fa93aafbff3148721e813ef597cded8a683853301b`
  - Cadence deploy tx: `6f5f551f6e7af4def5cd9d7d5098b4c13daff9eaaaf0598c10feddbac0b0e7b5`
  - ZK verifiers: `EncryptConsistencyVerifier` at `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C`, `DecryptOpenVerifier` at `0x3bB139B5404fD6b152813bC3532367AAa096638b`

- Documentation:
  - `PRIVACY.md` — cryptographic guarantees and what is/is not hidden
  - `deployments/DEPLOYMENTS.md` — canonical addresses + all e2e TX hashes
