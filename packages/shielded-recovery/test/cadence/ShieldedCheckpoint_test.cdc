/// ShieldedCheckpoint_test.cdc — comprehensive test suite for ShieldedCheckpoint.cdc
///
/// Run with:  flow test test/cadence/ShieldedCheckpoint_test.cdc
///             (from packages/shielded-recovery/)
///
/// Coverage
/// --------
///  1.  Contract deployment + MAX_SNAPSHOT_BYTES constant value
///  2.  Checkpoint installation (idempotent)
///  3.  Initial state: exists()=false, version=0 before first update
///  4.  First update: exists()=true, metadata reflects cursor + version=1
///  5.  Version increment on subsequent updates
///  6.  Cross-user isolation: alice, bob, carol have independent checkpoints
///  7.  Owner-only update: running update_checkpoint.cdc only affects the signer
///  8.  Public Metadata capability: exposes only non-sensitive fields
///  9.  Owner-entitled read: read() returns correct full snapshot (via test helper)
/// 10.  Snapshot size validation: oversized payload panics, exact-max succeeds
/// 11.  Event emission: CheckpointUpdated fields match
/// 12.  Cursor backward allowed: contract accepts lower cursor (rewind for rescan)
/// 13.  Empty snapshot is valid

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

/// Run update_checkpoint.cdc for `owner`.
access(all) fun doUpdate(
    owner:                 Test.TestAccount,
    encryptedSnapshot:     [UInt8],
    ephPubkeyX:            UInt256,
    ephPubkeyY:            UInt256,
    lastConsumedNoteIndex: UInt64
) {
    let tx = Test.Transaction(
        code:        Test.readFile("../../transactions/update_checkpoint.cdc"),
        authorizers: [owner.address],
        signers:     [owner],
        arguments:   [encryptedSnapshot, ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())
}

/// Read public metadata for `user` via get_checkpoint_metadata.cdc.
access(all) fun getMetadata(user: Address): {String: AnyStruct} {
    let script = Test.readFile("../../scripts/cadence/get_checkpoint_metadata.cdc")
    let r = Test.executeScript(script, [user])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! {String: AnyStruct}
}

/// Read Owner-entitled full snapshot for `user` via test helper script.
/// Uses getAuthAccount — valid only in test context.
access(all) fun readCheckpoint(user: Address): ShieldedCheckpoint.CheckpointSnapshot {
    let script = Test.readFile("helpers/read_checkpoint_owner.cdc")
    let r = Test.executeScript(script, [user])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! ShieldedCheckpoint.CheckpointSnapshot
}

/// Attempt an update that should fail; returns the result for assertion.
access(all) fun tryUpdateExpectFail(
    owner:                 Test.TestAccount,
    encryptedSnapshot:     [UInt8],
    lastConsumedNoteIndex: UInt64
): Test.TransactionResult {
    let tx = Test.Transaction(
        code:        Test.readFile("../../transactions/update_checkpoint.cdc"),
        authorizers: [owner.address],
        signers:     [owner],
        arguments:   [encryptedSnapshot, EPH_X, EPH_Y, lastConsumedNoteIndex]
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
    let meta = getMetadata(user: alice.address)
    Test.assertEqual(false, meta["exists"]! as! Bool)
}

// ---------------------------------------------------------------------------
// Test 3 — Initial state: exists=false, version=0 before first update
// ---------------------------------------------------------------------------

access(all) fun testInitialState() {
    let meta = getMetadata(user: alice.address)
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
        encryptedSnapshot:     SMALL_SNAP,
        ephPubkeyX:            EPH_X,
        ephPubkeyY:            EPH_Y,
        lastConsumedNoteIndex: 5
    )

    let meta = getMetadata(user: alice.address)
    Test.assertEqual(true,      meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(1), meta["version"]! as! UInt64)
    Test.assertEqual(UInt64(5), meta["lastConsumedNoteIndex"]! as! UInt64)

    // lastUpdatedBlock should be > 0 after an update.
    let blk = meta["lastUpdatedBlock"]! as! UInt64
    Test.assert(blk > 0, message: "lastUpdatedBlock should be > 0 after first update")
}

// ---------------------------------------------------------------------------
// Test 5 — Version increments on subsequent updates
// ---------------------------------------------------------------------------

access(all) fun testVersionIncrement() {
    doUpdate(
        owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0
    )
    doUpdate(
        owner: alice, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 1
    )

    let meta = getMetadata(user: alice.address)
    Test.assertEqual(UInt64(2), meta["version"]! as! UInt64)
    Test.assertEqual(UInt64(1), meta["lastConsumedNoteIndex"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 6 — Cross-user isolation
// ---------------------------------------------------------------------------

access(all) fun testCrossUserIsolation() {
    // Alice updates 3×, Bob updates 1×, Carol stays untouched.
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 10)
    doUpdate(owner: alice, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 20)
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 30)

    doUpdate(owner: bob, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 7)

    let metaA = getMetadata(user: alice.address)
    let metaB = getMetadata(user: bob.address)
    let metaC = getMetadata(user: carol.address)

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
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 5)

    // Carol runs update_checkpoint.cdc.  Because the transaction borrows from
    // signer.storage, it ONLY affects Carol's own checkpoint — never Alice's.
    doUpdate(owner: carol, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 99)

    // Alice is unaffected: still version=1, cursor=5.
    let metaA = getMetadata(user: alice.address)
    Test.assertEqual(UInt64(1), metaA["version"]! as! UInt64)
    Test.assertEqual(UInt64(5), metaA["lastConsumedNoteIndex"]! as! UInt64)

    // Carol's checkpoint is version=1, cursor=99.
    let metaC = getMetadata(user: carol.address)
    Test.assertEqual(UInt64(1),  metaC["version"]! as! UInt64)
    Test.assertEqual(UInt64(99), metaC["lastConsumedNoteIndex"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 8 — Public Metadata capability: exposes only non-sensitive fields
// ---------------------------------------------------------------------------

access(all) fun testPublicMetadataCapability() {
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 42)

    // getMetadata borrows only &{ShieldedCheckpoint.Metadata} — no blob exposed.
    let meta = getMetadata(user: alice.address)

    Test.assertEqual(true,       meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(1),  meta["version"]! as! UInt64)
    Test.assertEqual(UInt64(42), meta["lastConsumedNoteIndex"]! as! UInt64)

    // The metadata script returns exactly 4 keys.  No encrypted blob key.
    Test.assertEqual(4, meta.length)
    Test.assert(meta["encryptedSnapshot"] == nil,
        message: "Public Metadata capability must not expose the encrypted blob")
}

// ---------------------------------------------------------------------------
// Test 9 — Owner-entitled read: read() returns correct full snapshot
// ---------------------------------------------------------------------------

access(all) fun testOwnerEntitledRead() {
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 7)

    let snapshot = readCheckpoint(user: alice.address)

    Test.assertEqual(SMALL_SNAP, snapshot.encryptedSnapshot)
    Test.assertEqual(EPH_X,      snapshot.ephPubkeyX)
    Test.assertEqual(EPH_Y,      snapshot.ephPubkeyY)
    Test.assertEqual(UInt64(7),  snapshot.lastConsumedNoteIndex)
    Test.assertEqual(UInt64(1),  snapshot.version)
    Test.assert(snapshot.lastUpdatedBlock > 0,
        message: "lastUpdatedBlock should be > 0 after update")
}

access(all) fun testOwnerEntitledReadReturnsLatestSnapshot() {
    // Two updates; read() must return the second one.
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 3)
    doUpdate(owner: alice, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 9)

    let snapshot = readCheckpoint(user: alice.address)
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
        arguments:   [snap, EPH_X, EPH_Y, UInt64(0)]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())

    let meta = getMetadata(user: alice.address)
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
        encryptedSnapshot:     huge,
        lastConsumedNoteIndex: 0
    )
    // Must fail — panic("ShieldedCheckpoint: snapshot too large") inside update().
    Test.expect(result, Test.beFailed())

    // Checkpoint must remain at version=0 (no update committed).
    let meta = getMetadata(user: alice.address)
    Test.assertEqual(false,     meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(0), meta["version"]! as! UInt64)
}

// ---------------------------------------------------------------------------
// Test 11 — Event emission
// ---------------------------------------------------------------------------

access(all) fun testEventEmission() {
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 5)

    let events = Test.eventsOfType(Type<ShieldedCheckpoint.CheckpointUpdated>())
    Test.assertEqual(1, events.length)

    let ev = events[0] as! ShieldedCheckpoint.CheckpointUpdated
    Test.assertEqual(alice.address, ev.owner)
    Test.assertEqual(UInt64(1),     ev.version)
    Test.assertEqual(UInt64(5),     ev.lastConsumedNoteIndex)
    Test.assert(ev.blockHeight > 0, message: "event blockHeight must be > 0")
}

access(all) fun testEventVersionIncrementsOnEachUpdate() {
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)
    doUpdate(owner: alice, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 3)

    let events = Test.eventsOfType(Type<ShieldedCheckpoint.CheckpointUpdated>())
    Test.assertEqual(2, events.length)

    let ev1 = events[0] as! ShieldedCheckpoint.CheckpointUpdated
    let ev2 = events[1] as! ShieldedCheckpoint.CheckpointUpdated
    Test.assertEqual(UInt64(1), ev1.version)
    Test.assertEqual(UInt64(2), ev2.version)
}

access(all) fun testEventsAreUserScoped() {
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)
    doUpdate(owner: bob, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)

    let events = Test.eventsOfType(Type<ShieldedCheckpoint.CheckpointUpdated>())
    Test.assertEqual(2, events.length)

    let ev0 = events[0] as! ShieldedCheckpoint.CheckpointUpdated
    let ev1 = events[1] as! ShieldedCheckpoint.CheckpointUpdated
    Test.assertEqual(alice.address, ev0.owner)
    Test.assertEqual(bob.address,   ev1.owner)
    // Both are version=1 (independent counters per user).
    Test.assertEqual(UInt64(1), ev0.version)
    Test.assertEqual(UInt64(1), ev1.version)
}

// ---------------------------------------------------------------------------
// Test 12 — Cursor backward allowed (rewind for rescan)
// ---------------------------------------------------------------------------

access(all) fun testCursorBackwardAllowed() {
    // NOTE: cursor monotonicity is intentionally NOT enforced by the contract.
    // Applications may pass a lower cursor to trigger re-processing of inbox notes.

    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 100)
    doUpdate(owner: alice, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 10) // rewind

    let meta = getMetadata(user: alice.address)
    // Cursor rewound to 10 — must be accepted.
    Test.assertEqual(UInt64(10), meta["lastConsumedNoteIndex"]! as! UInt64)
    // Version still incremented despite the rewind.
    Test.assertEqual(UInt64(2),  meta["version"]! as! UInt64)
}

access(all) fun testCursorCanGoToZero() {
    doUpdate(owner: alice, encryptedSnapshot: SMALL_SNAP,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 999)
    doUpdate(owner: alice, encryptedSnapshot: SNAP_2,
        ephPubkeyX: EPH_X, ephPubkeyY: EPH_Y, lastConsumedNoteIndex: 0)

    let meta = getMetadata(user: alice.address)
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
        arguments:   [emptySnap, EPH_X, EPH_Y, UInt64(0)]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())

    let meta = getMetadata(user: alice.address)
    Test.assertEqual(true,      meta["exists"]! as! Bool)
    Test.assertEqual(UInt64(1), meta["version"]! as! UInt64)

    // Owner-entitled read should return an empty snapshot array.
    let snapshot = readCheckpoint(user: alice.address)
    let empty: [UInt8] = []
    Test.assertEqual(empty,     snapshot.encryptedSnapshot)
    Test.assertEqual(UInt64(1), snapshot.version)
}
