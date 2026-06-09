# JanusToken / JanusFlow — v0.2.1 Deployment Record

**Date:** 2026-05-26
**Network:** Flow EVM testnet (chainId 545) + Flow Cadence testnet
**Reason:**
1. Fix CRITICAL vulnerability `audits-kb/vulnerability-catalog/014` —
   `JanusToken.unwrap()` unit mismatch (ZK whole-FLOW vs EVM attoFLOW) that
   caused 100% of wrapped FLOW to be irrecoverable.
2. Decouple from the v0.2.0 router (`0xbef3c77681c15397`) whose `JanusFlow`
   contract has a 48h impl-swap time-lock, blocking immediate redeploy.
3. Introduce **UUPS upgradeability** so future bugfixes can ship without a
   fresh proxy address (admin authorizes implementation swap via
   `_authorizeUpgrade(onlyOwner)`).

Refer to `audits-kb/vulnerability-catalog/014-janustoken-unwrap-claimed-value-attoflow-unit-mismatch.md`
for the full root-cause analysis and to `audits-kb/vulnerability-catalog/015`
for the Cadence `self.account.address` privilege-escalation finding (out of scope
for this redeploy but cross-referenced).

---

## NEW addresses (USE THESE)

### EVM (Flow EVM testnet)

| Role                 | Address                                            | Notes                                         |
|----------------------|----------------------------------------------------|-----------------------------------------------|
| JanusToken **proxy** | `0x025efe7e89acdb8F315C804BE7245F348AA9c538`       | ERC1967 proxy — public entry-point            |
| JanusToken **impl**  | `0x28686066D28Eb86269190Eae76eD7170c21BB7FB`       | UUPS implementation (uninitialized directly)  |
| owner / admin (COA)  | `0x0000000000000000000000022f6b30af48a94787`       | Authorizes `proxy.upgradeToAndCall()`         |

EIP-1967 implementation slot value at proxy = impl address (verified on chain).

Re-used (unchanged) dependencies:

| Role                          | Address                                            |
|-------------------------------|----------------------------------------------------|
| BabyJub                       | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870`       |
| EncryptConsistencyVerifier    | `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e`       |
| DecryptOpenVerifier           | `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc`       |

### Cadence (Flow testnet)

| Contract        | Account                       | Storage paths                                       |
|-----------------|-------------------------------|-----------------------------------------------------|
| IJanusFlowImpl  | `0x5dcbeb41055ec57e`          | (interface; no storage)                             |
| JanusFlowImpl   | `0x5dcbeb41055ec57e`          | (stateless pure-logic)                              |
| JanusFlow       | `0x5dcbeb41055ec57e`          | `/storage/janusFlowVault`, `/storage/janusFlowAdmin`|

Account meta: `~/.flow/openjanus-janusflow-router.json`
Account pkey: `~/.flow/openjanus-janusflow-router.pkey`
Funded by: `openjanus-flow` (`0xbef3c77681c15397`) — initial 20 FLOW grant.

---

## Transaction hashes

### Phase A — EVM deploy (signer: openjanus-flow COA)

| Step                         | TX hash                                                              |
|------------------------------|----------------------------------------------------------------------|
| impl deploy                  | `bcad3efe59227ca78217dca48425bc21baa80bc5239192f7ceb59ff08dae2f28`   |
| proxy deploy (bundles initialize) | `48b0800621a156f2deaaf06f46b2452a8af55a8e7711469b8ed085d70c5a6875` |

Note: `ERC1967Proxy` constructor calls `impl.initialize()` atomically during
deploy, so initialize is bundled into the proxy-deploy tx — not a separate
transaction. Owner verification was a read-only `eth_call`, not an on-chain tx.

### Phase B — Cadence deploy (signer: openjanus-janusflow-router)

| Step                                      | TX hash                                                              |
|-------------------------------------------|----------------------------------------------------------------------|
| account create (funded by openjanus-flow) | `(via flow accounts create — see openjanus-janusflow-router.json)`   |
| account fund (20 FLOW from openjanus-flow)| `262037052172aebccd19a75dafceaab4b09118753b42998c7b4d5cde80f1d445`   |
| 3-contract deploy (IJanusFlowImpl, JanusFlowImpl, JanusFlow) | _bundled via `flow project deploy`; per-contract hashes were not captured separately by the CLI. State confirmed on chain — see verification scripts below._ |

### Verification reads (off-chain, not tx)

- `proxy.owner()` → `0x0000000000000000000000022f6b30af48a94787` (== admin COA)
- `proxy.SCALE()` → `1000000000000000000` (== 1e18)
- `proxy` EIP-1967 impl slot → `0x28686066d28eb86269190eae76ed7170c21bb7fb` (matches deployed impl)
- `impl.owner()` direct → `0x0000000000000000000000000000000000000000` (impl is locked, only callable via proxy)
- `JanusFlow.getJanusTokenAddress()` → `025efe7e89acdb8f315c804be7245f348aa9c538` (correctly wired to new proxy)
- `JanusFlow.getActiveImplVersion()` → `"0.1.0"`
- `JanusFlow.isPaused()` → `false`
- `JanusFlow.getTotalLocked()` → `0.00000000`

---

## What changed in the code

### `contracts/solidity/JanusToken.sol` — REWRITTEN
- Now inherits `Initializable + UUPSUpgradeable + OwnableUpgradeable`.
- `immutable` fields replaced with storage (UUPS requirement).
- `constructor()` only calls `_disableInitializers()`.
- New `initialize(babyJub, encrypt, decrypt, owner)` runs once via proxy.
- New `_authorizeUpgrade(address)` gated by `onlyOwner`.
- 40-slot `__gap` reserved for future upgrades.
- New `uint256 public constant SCALE = 1e18`.
- `wrap()`: requires `msg.value % SCALE == 0` (no dust accumulation).
- `unwrap()`: parameter renamed `amount` → `claimedUnits`; computes
  `amountAtto = claimedUnits * SCALE`; sends `amountAtto`; decrements
  `locked` by `amountAtto`. Proof `publicInputs[6]` continues to match
  `claimedUnits` (whole-FLOW from the circuit) — no circuit change.
- `confidentialTransfer()`: parameter renamed `transferAmount` → `transferUnits`;
  converts via `transferAtto = transferUnits * SCALE`.
- `Unwrapped` event field renamed `amount` → `amountAttoFlow` for clarity.

### `contracts/solidity/JanusTokenProxy.sol` — NEW
Thin re-export of `@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol` so
hardhat compiles a deployable artifact.

### `contracts/cadence/JanusFlow.cdc` — UPDATED
- Header: replaces previous router (`0xbef3c77681c15397`) — describes both 48h
  time-lock and zombie legacy.
- Imports moved from `0xbef3c77681c15397` → `0x5dcbeb41055ec57e`.

### `contracts/cadence/JanusFlowImpl.cdc` — UPDATED
- Import moved from `0xbef3c77681c15397` → `0x5dcbeb41055ec57e`.

### `contracts/cadence/IJanusFlowImpl.cdc` — UPDATED
- Header note updated to new account.

### `flow.json` — UPDATED
- New account `openjanus-janusflow-router` added.
- Deployments section now targets the new account (legacy openjanus-flow
  deployment entry removed to satisfy CLI uniqueness check; on-chain
  contracts at the old account remain — just no longer driven by this config).

### `scripts/deploy-proxy.mjs` — NEW
Single-script deploy of impl + proxy + initialize via COA Cadence txs.

### `scripts/verify-scale-fix.mjs` — NEW
Read-only verification of post-deploy state.

---

## DEPRECATED — DO NOT USE

| Address                                            | What it is                                  | Why deprecated                                                                 |
|----------------------------------------------------|---------------------------------------------|---------------------------------------------------------------------------------|
| `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499`       | OLD JanusToken (non-upgradeable EVM)       | Vuln 014 — `unwrap()` sends wei when circuit emits whole-FLOW. Funds stranded. |
| `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D`       | Earlier JanusToken v2 (pre-ceremony)       | Superseded by 0xb12E600... (and that one by the new proxy)                     |
| `0xbef3c77681c15397` (Cadence)                     | OLD JanusFlow router                        | Points at deprecated EVM token; 48h impl-swap time-lock blocked v0.2.1 fix.    |
| `0x28fef3d1d6a12800` (Cadence)                     | Legacy v1 Pedersen JanusFlow               | Pre-ceremony architecture; cannot be removed per Flow protocol rules.          |

**Any FLOW locked in `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499.locked[...]`
is currently unrecoverable** because the deployed `unwrap()` has no scaling
path. A separate "state-export + recovery contract" workflow would be required
for non-testnet impact. On testnet the lost amount is small (smoke-test
fixtures only).

---

## Cross-references

- `audits-kb/vulnerability-catalog/014-janustoken-unwrap-claimed-value-attoflow-unit-mismatch.md` — bug RCA + fix options
- `audits-kb/vulnerability-catalog/015-cadence-self-account-address-privilege-escalation.md` — companion Cadence-side finding (NOT addressed in this redeploy — Phase 3 or later)
- `audits-kb/case-studies/004-v0.2.1-fix-sprint-bug-discovery.md` — discovery narrative
- `deployments/janus-token-uups.json` — machine-readable deployment record

---

## SHA256 of compiled / source artifacts

```
artifacts/contracts/solidity/JanusToken.sol/JanusToken.json:   1e21fd86ab4ff918f9d9e1790483bf632543ed2c355869db6ce53934331b23f0
artifacts/contracts/solidity/JanusTokenProxy.sol/JanusTokenProxy.json: d896bb55bd04ae4bc6c87d66db0eba200f6cf8f7e69b953bfa237f5eb1d5dc85
contracts/cadence/JanusFlow.cdc:        b0d8c9f2532904aa418ce72f357dce67a52ed5e60a3229faec4e9a8c353c41a9
contracts/cadence/JanusFlowImpl.cdc:    8aa579fb08aa4771e77688eecc8dae6f04d4f5c66fde11232b543b0f7802d801
contracts/cadence/IJanusFlowImpl.cdc:   7f7af24e97df49240f050dda819aa2a10d7b1116652643e451ed613db7705a75
```

---

## Known gaps for Phase 3

1. **No live wrap+unwrap cycle ran in Phase 2.** The structural fix is verified
   (SCALE constant present, `wrap()` reachable, proxy correctly routes to
   impl), but a full ZK-gated round trip against the new addresses is deferred
   to Phase 3 (which will exercise the existing `tests/e2e_multiuser.mjs`
   against the new proxy + router with circuit artifacts from `openjanus-sdk`).
2. **Phase 2 did NOT migrate any locked FLOW** out of the old buggy
   `0xb12E600...` contract — it cannot, by definition of vuln 014.
3. **SDK + downstream apps** still point at the old addresses. Phase 3 will
   propagate the new proxy address into `openjanus-sdk`, `private-tip-v1`, and
   `openjanus-ai-tools` in a coherent commit.
4. **Cadence vuln 015** (self.account.address privilege escalation) is not
   patched here. Requires its own design conversation about admin model.
