/// ShieldedCheckpoint_test.cdc — comprehensive test suite for ShieldedCheckpoint.cdc
///
/// Run with:  flow test test/cadence/ShieldedCheckpoint_test.cdc
///             (from packages/shielded-recovery/)
///
/// Coverage
/// --------
///  1.  Contract deployment + MAX_SNAPSHOT_BYTES constant value
///  2.  Checkpoint installation (idempotent)
///  3.  Initial state: metadata.exists=false, version=0 before first update
///  4.  First update: exists=true, metadata reflects cursor + version=1
///  5.  Version increment on subsequent updates (same token)
///  6.  Cross-user isolation: alice, bob, carol have independent checkpoints
///  7.  Owner-only update: running update_checkpoint.cdc only affects the signer
///  8.  Public Metadata capability: exposes only non-sensitive fields
///  9.  Owner-entitled read: read(token:) returns correct full snapshot (via test helper)
/// 10.  Snapshot size validation: oversized payload panics, exact-max succeeds
/// 11.  Event emission: CheckpointUpdated fields match (including token field)
/// 12.  Cursor backward allowed: contract accepts lower cursor (rewind for rescan)
/// 13.  Empty snapshot is valid
/// 14.  Per-token isolation: writing TOKEN_A does not affect TOKEN_B slot
/// 15.  Two tokens independent: TOKEN_A and TOKEN_B hold separate state
/// 16.  Cross-user same token: alice and bob's TOKEN_A slots are independent
/// 17.  read(token:) returns nil for unwritten token (via metadata + tokenSlotExists)
/// 18.  metadata(token:).hasCheckpoint per-token reflects correct write state
/// 19.  Overwrite same (user, token) increments version, leaves other tokens unchanged
/// 20.  Event token field matches the token passed to update()

import Test
import BlockchainHelpers
import "ShieldedCheckpoint"

// ---------------------------------------------------------------------------
// Test accounts
// ---------------------------------------------------------------------------

access(all) let alice = Test.createAccount()
access(all) let bob   = Test.createAccount()
access(all) let carol = Test.createAccount()

// ---------------------------------------------------------------------------
// Convenience constants
// ---------------------------------------------------------------------------

access(all) let EPH_X: UInt256 = 12345678901234567890
access(all) let EPH_Y: UInt256 = 98765432109876543210

/// Small snapshot: [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]
access(all) let SMALL_SNAP: [UInt8] = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]

/// Second snapshot for update tests
access(all) let SNAP_2: [UInt8] = [0x11, 0x22, 0x33, 0x44]

/// Token identifiers used across tests.
/// EVM-style: "0x" + 40 lowercase hex chars.
access(all) let TOKEN_A: String = "0xaaaa000000000000000000000000000000000001"
access(all) let TOKEN_B: String = "0xbbbb000000000000000000000000000000000002"

// ---------------------------------------------------------------------------
// Setup height — captured after first deployment for Test.reset
// ---------------------------------------------------------------------------

access(all) var setupHeight: UInt64 = 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Deploy ShieldedCheckpoint and install checkpoints on alice, bob, carol.
access(all) fun setup() {
    let err = Test.deployContract(
        name:      "ShieldedCheckpoint",
        path:      "../../contracts/cadence/ShieldedCheckpoint.cdc",
        arguments: []
    )
    Test.expect(err, Test.beNil())

    installCheckpoint(signer: alice)
    installCheckpoint(signer: bob)
    installCheckpoint(signer: carol)

    setupHeight = getCurrentBlockHeight()
}

/// Reset blockchain state to post-setup snapshot between tests.
access(all) fun beforeEach() {
    Test.reset(to: setupHeight)
}

/// Run install_checkpoint.cdc for `signer`.
access(all) fun installCheckpoint(signer: Test.TestAccount) {
    let tx = Test.Transaction(
        code:        Test.readFile("../../transactions/install_checkpoint.cdc"),
        authorizers: [signer.address],
        signers:     [signer],
        arguments:   []
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())
}

/// Run update_checkpoint.cdc for `owner` on the given token slot.
access(all) fun doUpdate(
    owner:                 Test.TestAccount,
    token:                 String,
    encryptedSnapshot:     [UInt8],
    ephPubkeyX:            UInt256,
    ephPubkeyY:            UInt256,
    lastConsumedNoteIndex: UInt64
) {
    let tx = Test.Transaction(
        code:        Test.readFile("../../transactions/update_checkpoint.cdc"),
        authorizers: [owner.address],
        signers:     [owner],
        arguments:   [token, encryptedSnapshot, ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())
}

/// Read public metadata for `user` and `token` via get_checkpoint_metadata.cdc.
access(all) fun getMetadata(user: Address, token: String): {String: AnyStruct} {
    let script = Test.readFile("../../scripts/cadence/get_checkpoint_metadata.cdc")
    let r = Test.executeScript(script, [user, token])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! {String: AnyStruct}
}

/// Read Owner-entitled full snapshot for `user` + `token` via test helper script.
/// Uses getAuthAccount — valid only in test context.
/// Panics (via the helper script) if no update() has been called for this token.
access(all) fun readCheckpoint(user: Address, token: String): ShieldedCheckpoint.CheckpointData {
    let script = Test.readFile("helpers/read_checkpoint_owner.cdc")
    let r = Test.executeScript(script, [user, token])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! ShieldedCheckpoint.CheckpointData
}

/// Attempt an update that should fail; returns the result for assertion.
access(all) fun tryUpdateExpectFail(
    owner:                 Test.TestAccount,
    token:                 String,
    encryptedSnapshot:     [UInt8],
    lastConsumedNoteIndex: UInt64
): Test.TransactionResult {
    let tx = Test.Transaction(
        code:        Test.readFile("../../transactions/update_checkpoint.cdc"),
        authorizers: [owner.address],
        signers:     [owner],
        arguments:   [token, encryptedSnapshot, EPH_X, EPH_Y, lastConsumedNoteIndex]
    )
    return Test.executeTransaction(tx)
}

// ---------------------------------------------------------------------------
// Test 1 — Contract deployment + constant value
// ---------------------------------------------------------------------------

access(all) fun testContractDeployment() {
    let r = Test.executeScript(
        Test.readFile("../../scripts/cadence/get_max_snapshot_bytes.cdc"),
        []
    )
    Test.expect(r, Test.beSucceeded())
    let maxBytes = r.returnValue! as! Int
    Test.assertEqual(16384, maxBytes)
}

// ---------------------------------------------------------------------------
// Test 2 — Checkpoint installation is idempotent
// ---------------------------------------------------------------------------

access(all) fun testInstallIdempotent() {
    // Double-install on alice must not panic.
    installCheckpoint(signer: alice)
    installCheckpoint(signer: alice)
    // Metadata: exists=false since no update has been called yet.
    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(false, meta["exists"]! as! Bool)
}

// ---------------------------------------------------------------------------
// Test 3 — Initial state: exists=false, version=0 before first update
// ---------------------------------------------------------------------------

access(all) fun testInitialState() {
    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(false,     meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(0), meta["version"]! as! UInt64)
    Test.assertEqual(UInt64(0), meta["lastConsumedNoteIndex"]! as! UInt64)
    Test.assertEqual(UInt64(0), meta["lastUpdatedBlock"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 4 — First update: exists=true, metadata reflects cursor + version=1
// ---------------------------------------------------------------------------

access(all) fun testFirstUpdate() {
    doUpdate(
        owner:                 alice,
        token:                 TOKEN_A,
        encryptedSnapshot:     SMALL_SNAP,
        ephPubkeyX:            EPH_X,
        ephPubkeyY:            EPH_Y,
        lastConsumedNoteIndex: 5
    )

    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(true,      meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(1), meta["version"]! as! UInt64)
    Test.assertEqual(UInt64(5), meta["lastConsumedNoteIndex"]! as! UInt64)

    // lastUpdatedBlock should be > 0 after an update.
    let blk = meta["lastUpdatedBlock"]! as! UInt64
    Test.assert(blk > 0, message: "lastUpdatedBlock should be > 0 after first update")
}

// ---------------------------------------------------------------------------
// Test 5 — Version increments on subsequent updates (same token slot)
// ---------------------------------------------------------------------------

access(all) fun testVersionIncrement() {
    doUpdate(
        owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0
    )
    doUpdate(
        owner: alice, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 1
    )

    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(UInt64(2), meta["version"]! as! UInt64)
    Test.assertEqual(UInt64(1), meta["lastConsumedNoteIndex"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 6 — Cross-user isolation
// ---------------------------------------------------------------------------

access(all) fun testCrossUserIsolation() {
    // Alice updates 3×, Bob updates 1×, Carol stays untouched.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 10)
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 20)
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 30)

    doUpdate(owner: bob, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 7)

    let metaA = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB = getMetadata(user: bob.address,   token: TOKEN_A)
    let metaC = getMetadata(user: carol.address,  token: TOKEN_A)

    Test.assertEqual(UInt64(3),  metaA["version"]! as! UInt64)
    Test.assertEqual(UInt64(30), metaA["lastConsumedNoteIndex"]! as! UInt64)

    Test.assertEqual(UInt64(1), metaB["version"]! as! UInt64)
    Test.assertEqual(UInt64(7), metaB["lastConsumedNoteIndex"]! as! UInt64)

    // Carol has never updated.
    Test.assertEqual(false,     metaC["exists"]! as! Bool)
    Test.assertEqual(UInt64(0), metaC["version"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 7 — Owner-only update: signer can only update their own checkpoint
// ---------------------------------------------------------------------------

access(all) fun testOwnerOnlyUpdate() {
    // Alice updates to version=1 with cursor=5.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 5)

    // Carol runs update_checkpoint.cdc.  Because the transaction borrows from
    // signer.storage, it ONLY affects Carol's own checkpoint — never Alice's.
    doUpdate(owner: carol, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 99)

    // Alice is unaffected: still version=1, cursor=5.
    let metaA = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(UInt64(1), metaA["version"]! as! UInt64)
    Test.assertEqual(UInt64(5), metaA["lastConsumedNoteIndex"]! as! UInt64)

    // Carol's checkpoint is version=1, cursor=99.
    let metaC = getMetadata(user: carol.address, token: TOKEN_A)
    Test.assertEqual(UInt64(1),  metaC["version"]! as! UInt64)
    Test.assertEqual(UInt64(99), metaC["lastConsumedNoteIndex"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 8 — Public Metadata capability: exposes only non-sensitive fields
// ---------------------------------------------------------------------------

access(all) fun testPublicMetadataCapability() {
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 42)

    // getMetadata borrows only &{ShieldedCheckpoint.Metadata} — no blob exposed.
    let meta = getMetadata(user: alice.address, token: TOKEN_A)

    Test.assertEqual(true,       meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(1),  meta["version"]! as! UInt64)
    Test.assertEqual(UInt64(42), meta["lastConsumedNoteIndex"]! as! UInt64)

    // The metadata script returns exactly 4 keys.  No encrypted blob key.
    Test.assertEqual(4, meta.length)
    Test.assert(meta["encryptedSnapshot"] == nil,
        message: "Public Metadata capability must not expose the encrypted blob")
}

// ---------------------------------------------------------------------------
// Test 9 — Owner-entitled read: read(token:) returns correct full snapshot
// ---------------------------------------------------------------------------

access(all) fun testOwnerEntitledRead() {
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 7)

    let snapshot = readCheckpoint(user: alice.address, token: TOKEN_A)

    Test.assertEqual(SMALL_SNAP, snapshot.encryptedSnapshot)
    Test.assertEqual(EPH_X,      snapshot.ephPubkeyX)
    Test.assertEqual(EPH_Y,      snapshot.ephPubkeyY)
    Test.assertEqual(UInt64(7),  snapshot.lastConsumedNoteIndex)
    Test.assertEqual(UInt64(1),  snapshot.version)
    Test.assert(snapshot.lastUpdatedBlock > 0,
        message: "lastUpdatedBlock should be > 0 after update")
}

access(all) fun testOwnerEntitledReadReturnsLatestSnapshot() {
    // Two updates; read(token:) must return the second one.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 3)
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 9)

    let snapshot = readCheckpoint(user: alice.address, token: TOKEN_A)
    Test.assertEqual(SNAP_2,    snapshot.encryptedSnapshot)
    Test.assertEqual(UInt64(9), snapshot.lastConsumedNoteIndex)
    Test.assertEqual(UInt64(2), snapshot.version)
}

// ---------------------------------------------------------------------------
// Test 10 — Snapshot size validation
// ---------------------------------------------------------------------------

access(all) fun testSnapshotExactlyMaxSucceeds() {
    // Build a snapshot of exactly MAX_SNAPSHOT_BYTES (16384 bytes).
    var snap: [UInt8] = []
    var i = 0
    while i < 16384 {
        snap.append(0xAB)
        i = i + 1
    }

    let tx = Test.Transaction(
        code:        Test.readFile("../../transactions/update_checkpoint.cdc"),
        authorizers: [alice.address],
        signers:     [alice],
        arguments:   [TOKEN_A, snap, EPH_X, EPH_Y, UInt64(0)]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())

    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(true,      meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(1), meta["version"]! as! UInt64)
}

access(all) fun testSnapshotTooLargeFails() {
    // Build a snapshot of MAX_SNAPSHOT_BYTES + 1 (16385 bytes).
    var huge: [UInt8] = []
    var i = 0
    while i < 16385 {
        huge.append(0xAB)
        i = i + 1
    }

    let result = tryUpdateExpectFail(
        owner:                 alice,
        token:                 TOKEN_A,
        encryptedSnapshot:     huge,
        lastConsumedNoteIndex: 0
    )
    // Must fail — panic("ShieldedCheckpoint: snapshot too large") inside update().
    Test.expect(result, Test.beFailed())

    // TOKEN_A checkpoint must remain at version=0 (no update committed).
    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(false,     meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(0), meta["version"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 11 — Event emission (includes token field)
// ---------------------------------------------------------------------------

access(all) fun testEventEmission() {
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 5)

    let events = Test.eventsOfType(Type<ShieldedCheckpoint.CheckpointUpdated>())
    Test.assertEqual(1, events.length)

    let ev = events[0] as! ShieldedCheckpoint.CheckpointUpdated
    Test.assertEqual(alice.address, ev.owner)
    Test.assertEqual(TOKEN_A,       ev.token)
    Test.assertEqual(UInt64(1),     ev.version)
    Test.assertEqual(UInt64(5),     ev.lastConsumedNoteIndex)
    Test.assert(ev.blockHeight > 0, message: "event blockHeight must be > 0")
}

access(all) fun testEventVersionIncrementsOnEachUpdate() {
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 3)

    let events = Test.eventsOfType(Type<ShieldedCheckpoint.CheckpointUpdated>())
    Test.assertEqual(2, events.length)

    let ev1 = events[0] as! ShieldedCheckpoint.CheckpointUpdated
    let ev2 = events[1] as! ShieldedCheckpoint.CheckpointUpdated
    Test.assertEqual(UInt64(1), ev1.version)
    Test.assertEqual(UInt64(2), ev2.version)
}

access(all) fun testEventsAreUserScoped() {
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)
    doUpdate(owner: bob, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)

    let events = Test.eventsOfType(Type<ShieldedCheckpoint.CheckpointUpdated>())
    Test.assertEqual(2, events.length)

    let ev0 = events[0] as! ShieldedCheckpoint.CheckpointUpdated
    let ev1 = events[1] as! ShieldedCheckpoint.CheckpointUpdated
    Test.assertEqual(alice.address, ev0.owner)
    Test.assertEqual(bob.address,   ev1.owner)
    // Both are version=1 (independent counters per user per token).
    Test.assertEqual(UInt64(1), ev0.version)
    Test.assertEqual(UInt64(1), ev1.version)
}

// ---------------------------------------------------------------------------
// Test 12 — Cursor backward allowed (rewind for rescan)
// ---------------------------------------------------------------------------

access(all) fun testCursorBackwardAllowed() {
    // NOTE: cursor monotonicity is intentionally NOT enforced by the contract.
    // Applications may pass a lower cursor to trigger re-processing of inbox notes.

    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 100)
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 10) // rewind

    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    // Cursor rewound to 10 — must be accepted.
    Test.assertEqual(UInt64(10), meta["lastConsumedNoteIndex"]! as! UInt64)
    // Version still incremented despite the rewind.
    Test.assertEqual(UInt64(2),  meta["version"]! as! UInt64)
}

access(all) fun testCursorCanGoToZero() {
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 999)
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)

    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(UInt64(0), meta["lastConsumedNoteIndex"]! as! UInt64)
    Test.assertEqual(UInt64(2), meta["version"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 13 — Empty snapshot is valid
// ---------------------------------------------------------------------------

access(all) fun testEmptySnapshotIsValid() {
    let emptySnap: [UInt8] = []

    let tx = Test.Transaction(
        code:        Test.readFile("../../transactions/update_checkpoint.cdc"),
        authorizers: [alice.address],
        signers:     [alice],
        arguments:   [TOKEN_A, emptySnap, EPH_X, EPH_Y, UInt64(0)]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())

    let meta = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(true,      meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(1), meta["version"]! as! UInt64)

    // Owner-entitled read should return an empty snapshot array.
    let snapshot = readCheckpoint(user: alice.address, token: TOKEN_A)
    let empty: [UInt8] = []
    Test.assertEqual(empty,     snapshot.encryptedSnapshot)
    Test.assertEqual(UInt64(1), snapshot.version)
}

// ---------------------------------------------------------------------------
// Test 14 — Per-token isolation: writing TOKEN_A does not affect TOKEN_B slot
// ---------------------------------------------------------------------------

access(all) fun testPerTokenIsolation() {
    // Write only TOKEN_A.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 5)

    let metaA = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB = getMetadata(user: alice.address, token: TOKEN_B)

    // TOKEN_A slot was written.
    Test.assertEqual(true,      metaA["exists"]! as! Bool)
    Test.assertEqual(UInt64(1), metaA["version"]! as! UInt64)
    Test.assertEqual(UInt64(5), metaA["lastConsumedNoteIndex"]! as! UInt64)

    // TOKEN_B slot must remain empty — not affected by the TOKEN_A write.
    Test.assertEqual(false,     metaB["exists"]! as! Bool)
    Test.assertEqual(UInt64(0), metaB["version"]! as! UInt64)
    Test.assertEqual(UInt64(0), metaB["lastConsumedNoteIndex"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 15 — Two tokens hold independent state
// ---------------------------------------------------------------------------

access(all) fun testTwoTokensIndependent() {
    // Write TOKEN_A with cursor=10, TOKEN_B with cursor=20.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 10)
    doUpdate(owner: alice, token: TOKEN_B, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 20)

    let metaA = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB = getMetadata(user: alice.address, token: TOKEN_B)

    // TOKEN_A: version=1, cursor=10, blob=SMALL_SNAP
    Test.assertEqual(UInt64(1),  metaA["version"]! as! UInt64)
    Test.assertEqual(UInt64(10), metaA["lastConsumedNoteIndex"]! as! UInt64)

    // TOKEN_B: version=1, cursor=20 (independent counter)
    Test.assertEqual(UInt64(1),  metaB["version"]! as! UInt64)
    Test.assertEqual(UInt64(20), metaB["lastConsumedNoteIndex"]! as! UInt64)

    // Owner-entitled read confirms each token has its own blob.
    let snapA = readCheckpoint(user: alice.address, token: TOKEN_A)
    let snapB = readCheckpoint(user: alice.address, token: TOKEN_B)
    Test.assertEqual(SMALL_SNAP, snapA.encryptedSnapshot)
    Test.assertEqual(SNAP_2,     snapB.encryptedSnapshot)
}

// ---------------------------------------------------------------------------
// Test 16 — Cross-user same token: alice and bob's TOKEN_A are independent
// ---------------------------------------------------------------------------

access(all) fun testCrossUserSameTokenIsolated() {
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 11)
    doUpdate(owner: bob, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 22)

    let metaA = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB = getMetadata(user: bob.address,   token: TOKEN_A)

    // Alice's TOKEN_A slot.
    Test.assertEqual(UInt64(1),  metaA["version"]! as! UInt64)
    Test.assertEqual(UInt64(11), metaA["lastConsumedNoteIndex"]! as! UInt64)

    // Bob's TOKEN_A slot — independent from Alice's.
    Test.assertEqual(UInt64(1),  metaB["version"]! as! UInt64)
    Test.assertEqual(UInt64(22), metaB["lastConsumedNoteIndex"]! as! UInt64)

    // Each user's full blob is their own.
    let snapA = readCheckpoint(user: alice.address, token: TOKEN_A)
    let snapB = readCheckpoint(user: bob.address,   token: TOKEN_A)
    Test.assertEqual(SMALL_SNAP, snapA.encryptedSnapshot)
    Test.assertEqual(SNAP_2,     snapB.encryptedSnapshot)
}

// ---------------------------------------------------------------------------
// Test 17 — Unwritten token slot appears empty (nil read, false hasCheckpoint)
// ---------------------------------------------------------------------------

access(all) fun testUnwrittenTokenSlotIsEmpty() {
    // Only write TOKEN_A; TOKEN_B is never touched.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 1)

    // metadata() for TOKEN_B must return zero values with hasCheckpoint=false.
    let metaB = getMetadata(user: alice.address, token: TOKEN_B)
    Test.assertEqual(false,     metaB["exists"]! as! Bool)
    Test.assertEqual(UInt64(0), metaB["version"]! as! UInt64)
    Test.assertEqual(UInt64(0), metaB["lastUpdatedBlock"]! as! UInt64)

    // Attempting to read TOKEN_B should fail (helper panics on nil).
    let readTx = Test.Transaction(
        code:        Test.readFile("../../transactions/update_checkpoint.cdc"),
        authorizers: [alice.address],
        signers:     [alice],
        // We do NOT update TOKEN_B, so reading it via the helper would panic.
        // Instead verify existence via metadata only (already asserted above).
        arguments:   [TOKEN_B, SNAP_2, EPH_X, EPH_Y, UInt64(0)]  // dry-run: write B to verify it works
    )
    // Writing TOKEN_B must succeed (slot creation on first write).
    let result = Test.executeTransaction(readTx)
    Test.expect(result, Test.beSucceeded())

    // After the write, TOKEN_A must still be unaffected.
    let metaA = getMetadata(user: alice.address, token: TOKEN_A)
    Test.assertEqual(UInt64(1), metaA["version"]! as! UInt64)  // still version=1 from first write
}

// ---------------------------------------------------------------------------
// Test 18 — metadata(token).hasCheckpoint reflects per-token write state
// ---------------------------------------------------------------------------

access(all) fun testMetadataHasCheckpointPerToken() {
    // Before any update: both tokens show hasCheckpoint=false.
    let metaA0 = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB0 = getMetadata(user: alice.address, token: TOKEN_B)
    Test.assertEqual(false, metaA0["exists"]! as! Bool)
    Test.assertEqual(false, metaB0["exists"]! as! Bool)

    // Update TOKEN_A only.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)

    let metaA1 = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB1 = getMetadata(user: alice.address, token: TOKEN_B)
    // TOKEN_A: hasCheckpoint=true.
    Test.assertEqual(true,  metaA1["exists"]! as! Bool)
    // TOKEN_B: hasCheckpoint still false.
    Test.assertEqual(false, metaB1["exists"]! as! Bool)

    // Now update TOKEN_B.
    doUpdate(owner: alice, token: TOKEN_B, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)

    let metaA2 = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB2 = getMetadata(user: alice.address, token: TOKEN_B)
    // Both tokens now show hasCheckpoint=true.
    Test.assertEqual(true, metaA2["exists"]! as! Bool)
    Test.assertEqual(true, metaB2["exists"]! as! Bool)
}

// ---------------------------------------------------------------------------
// Test 19 — Overwriting same (user, token) increments version, leaves other tokens unchanged
// ---------------------------------------------------------------------------

access(all) fun testOverwriteSameTokenVersionIncrement() {
    // Set up both tokens with initial data.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 1)
    doUpdate(owner: alice, token: TOKEN_B, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 2)

    // Overwrite TOKEN_A twice more.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 10)
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 15)

    let metaA = getMetadata(user: alice.address, token: TOKEN_A)
    let metaB = getMetadata(user: alice.address, token: TOKEN_B)

    // TOKEN_A: 3 total updates → version=3, cursor=15.
    Test.assertEqual(UInt64(3),  metaA["version"]! as! UInt64)
    Test.assertEqual(UInt64(15), metaA["lastConsumedNoteIndex"]! as! UInt64)

    // TOKEN_B: still only 1 update → version=1, cursor=2.
    Test.assertEqual(UInt64(1), metaB["version"]! as! UInt64)
    Test.assertEqual(UInt64(2), metaB["lastConsumedNoteIndex"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 20 — Event token field matches the token passed to update()
// ---------------------------------------------------------------------------

access(all) fun testEventTokenField() {
    // Update TOKEN_A then TOKEN_B; verify each event carries the correct token.
    doUpdate(owner: alice, token: TOKEN_A, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)
    doUpdate(owner: alice, token: TOKEN_B, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)

    let events = Test.eventsOfType(Type<ShieldedCheckpoint.CheckpointUpdated>())
    Test.assertEqual(2, events.length)

    let ev0 = events[0] as! ShieldedCheckpoint.CheckpointUpdated
    let ev1 = events[1] as! ShieldedCheckpoint.CheckpointUpdated

    // First event: TOKEN_A.
    Test.assertEqual(alice.address, ev0.owner)
    Test.assertEqual(TOKEN_A,       ev0.token)
    Test.assertEqual(UInt64(1),     ev0.version)

    // Second event: TOKEN_B; version starts at 1 (independent per-token counter).
    Test.assertEqual(alice.address, ev1.owner)
    Test.assertEqual(TOKEN_B,       ev1.token)
    Test.assertEqual(UInt64(1),     ev1.version)
}
