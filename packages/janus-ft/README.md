# janus-ft — JanusFT Confidential FT Wrapper (v0.8)

Cadence contract that wraps any `@{FungibleToken.Vault}` into a Pedersen-committed shielded pool. Amount-hiding uses BabyJubJub Pedersen commitments and Groth16 ZK proofs verified cross-VM on Flow EVM.

## v0.8 Changes

### Strict-mode ShieldedInbox (breaking)

`shieldedTransfer` now deposits the encrypted note directly to the recipient's `ShieldedInbox.NoteInbox`. Recipients **must** install ShieldedInbox before receiving. The inbox check fires **before** any EVM call — transfers to unregistered recipients revert immediately.

Install for a recipient:
```bash
flow transactions send transactions/user_install_janus_ft_registry.cdc --signer <account> --network testnet
```

### Removed sender snapshot params

`shieldedTransfer` no longer takes `encryptedSnapshotFrom`, `ephPubFromX`, `ephPubFromY`. The sender updates their `ShieldedCheckpoint` in a separate call, or atomically via `combined_shielded_transfer_with_checkpoint.cdc`.

### Admin slot reset

```cadence
adminResetSlot(user: Address)               // panics if slot absent
adminBatchResetSlots(users: [Address])      // skips nil; max 100 per call
MAX_BATCH_RESET(): Int                      // = 100
```

### AdminProofStoragePath constant

`AdminProofStoragePath` aliases `AdminStoragePath` (`/storage/janusFTAdmin`). Admin transactions borrow the `Admin` resource using either path.

### Public shieldedTransfer

`CommitmentRegistryPublic` now includes `shieldedTransfer`, so **any user with a COA** can call it via the public capability — they do not need to hold the registry resource. The deployer's registry address is available via `JanusFT.registryAddress()`.

## Architecture

```
Caller (COA) ─▶ CommitmentRegistryPublic.shieldedTransfer(...)
                    │
                    ├─ 1. Strict inbox check (Cadence, no EVM gas)
                    ├─ 2. C_old consistency check (no EVM)
                    ├─ 3. Groth16 ZK verification (cross-VM EVM call)
                    ├─ 4. Commitment state updates (Cadence)
                    ├─ 5. ShieldedInbox.deposit() (Cadence)
                    └─ 6. Emit ShieldedTransferNote
```

## Key Transactions

| File | Purpose |
|------|---------|
| `shielded_transfer_ft.cdc` | v0.8 transfer (uses public capability) |
| `combined_shielded_transfer_with_checkpoint.cdc` | Atomic: transfer + sender checkpoint update |
| `admin_reset_slot_ft.cdc` | Admin: clear a single commitment slot |
| `admin_batch_reset_slots_ft.cdc` | Admin: batch clear up to 100 slots |
| `setup_janus_ft_registry.cdc` | Deployer: initialize registry + fees |

## Tests

### Cadence unit tests (15/15)

```bash
cd packages/janus-ft
flow test tests/cadence/JanusFT.shielded-recovery_test.cdc --config-path flow.json
```

Tests cover: contract deployment, registry setup, inbox/checkpoint idempotency, admin paths, `adminResetSlot`, `adminBatchResetSlots`, strict-mode panic, ECIES byte preservation, FIFO order, multi-recipient isolation, event schema.

Cross-VM operations (shieldedTransfer with real ZK) are covered by the smoke test.

### ECIES decode tests (13/13)

```bash
node tests/JanusFT.ecies-decode.test.js
```

Verifies BabyJubJub ECDH + HKDF-SHA256 + AES-GCM encrypt/decrypt round-trip using the SDK.

### Smoke test (testnet)

```bash
node scripts/smoke-janusft-aggregate.mjs
```

**Prerequisites:** Bob (`0xd807a3992d7be612`) must have ShieldedInbox installed. ShieldedInbox testnet deployment is required — see `packages/shielded-recovery`.

## EVM Contracts (Flow EVM testnet, chainId 545)

| Contract | Address |
|----------|---------|
| `BabyJub.sol` | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| `ConfidentialTransferAggregateVerifier.sol` | `0x5702A545d2853b03B808aEA331f892c121b67243` |
| `AmountDiscloseAggregateVerifier.sol` | `0xa80283baB7fcEFC2c75De43DB5a1cBF00E96B984` |

## Security

EXPERIMENTAL. Not audited. Do not use with real funds. Mainnet preparation requires: OFAC Chainalysis Oracle hook on wrap, removal of `MAINNET-PREPARE-REMOVE` admin test helpers.
