# @openjanus/shielded-recovery

Per-user on-chain mailbox primitives for the Janus protocol.

## ShieldedInbox

A content-agnostic FIFO mailbox that lets anyone drop encrypted notes into a
user's inbox, while only the inbox owner can drain them.

### Design principles

- **Public deposit** — any address / account can append a note ciphertext +
  ephemeral public key to any user's inbox.
- **Owner-only drain** — only the inbox owner can consume notes.
  - Solidity: `msg.sender`-gated functions.
  - Cadence: `auth(Owner)` entitlement on `drainBatch` / `drainAll`.
- **FIFO** — `drainBatch` / `drainAll` return oldest notes first.
- **Opaque** — the inbox does not interpret ciphertext.  Apps define their own
  payload schema.  The inbox stores raw `bytes` / `[UInt8]`.
- **Immutable** — no upgradability, no admin key, no pause.

### Constraints

| Constant | Value | Purpose |
|---|---|---|
| `MAX_CIPHERTEXT_BYTES` | 8192 | 8 KB hard cap per note |
| `MAX_INBOX_NOTES` | 10000 | Pending-note overflow protection |

### Gas reference (EVM, optimizer 200 runs)

| Operation | Gas |
|---|---|
| `deposit` (64 B ciphertext) | ~185k |
| `deposit` (8192 B ciphertext) | ~5.95M |
| `drainBatch(10)` | ~305k |
| `drainBatch(100)` | ~2.7M |

Large-ciphertext deposits are expensive because the EVM charges 20k gas per
cold 32-byte storage slot (256 slots × 20k ≈ 5.1M for 8 KB).

---

## EVM (Solidity)

**Contract**: `contracts/solidity/ShieldedInbox.sol`

```solidity
// Anyone deposits
inbox.deposit(recipient, ciphertext, ephPubkeyX, ephPubkeyY);

// Owner reads without consuming
inbox.peek(owner, offset, limit);

// Owner drains
inbox.drainBatch(limit);   // up to N oldest
inbox.drainAll();           // all pending
```

---

## Cadence

**Contract**: `contracts/cadence/ShieldedInbox.cdc`

The Cadence version uses a resource-based per-user model.  The resource is
named `NoteInbox` (not `Inbox`) to avoid collision with the built-in
`Account.Inbox` capability delivery API.

### Installation

Run `transactions/install_inbox.cdc` once per account:

```cadence
import ShieldedInbox from <deployed-address>

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, StorageCapabilities, PublishCapability) &Account) {
        // Idempotent — safe to call multiple times
        if signer.storage.borrow<&ShieldedInbox.NoteInbox>(from: /storage/shieldedInbox) != nil {
            return
        }
        let inbox <- ShieldedInbox.createInbox(owner: signer.address)
        signer.storage.save(<-inbox, to: /storage/shieldedInbox)
        let receiverCap = signer.capabilities.storage
            .issue<&{ShieldedInbox.Receiver}>(/storage/shieldedInbox)
        signer.capabilities.publish(receiverCap, at: /public/shieldedInbox)
    }
}
```

### Depositing (any caller)

```cadence
let cap = getAccount(recipient)
    .capabilities.borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
    ?? panic("no inbox")
cap.deposit(ciphertext: ct, ephPubkeyX: px, ephPubkeyY: py, depositor: caller)
```

### Draining (owner only)

```cadence
let inbox = signer.storage
    .borrow<auth(ShieldedInbox.Owner) &ShieldedInbox.NoteInbox>(from: /storage/shieldedInbox)
    ?? panic("not installed")
let notes = inbox.drainBatch(limit: 10)
```

---

## Testing

```bash
# Solidity
npx hardhat test --config hardhat.config.cjs   # 38 tests

# Cadence
flow test test/cadence/ShieldedInbox_test.cdc  # 15 tests
```

---

## Integration notes

- This is a **primitive** — no memo logic, no tip logic, no encryption.
  Higher-level protocols (e.g. JanusFlow) build note schemas on top.
- The `ephPubkeyX / ephPubkeyY` fields carry a curve point for ECDH key
  agreement; the inbox does not validate them.
- `NoteDeposited` events are indexed by `recipient` and `depositor` for
  off-chain scanning.
- On EVM, prefer scanning events over calling `peek` in bulk (event logs are
  cheaper to read off-chain).
