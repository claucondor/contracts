"use strict";

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Representative BN254 field element values for ephemeral pubkeys. */
const EPH_X = 12345678901234567890123456789012345678901234567890123456789012345n;
const EPH_Y = 98765432109876543219876543210987654321098765432109876543210987654n;

/**
 * Fake token addresses used as per-token slot keys.
 * TOKEN_A is address(0) — the brief requires at least one test with ZeroAddress.
 * TOKEN_B is a digit-only address (EIP-55 checksum-safe: digits have no case ambiguity).
 */
const TOKEN_A = ethers.ZeroAddress;
const TOKEN_B = "0x1111111111111111111111111111111111111111";

/** Build a snapshot buffer of `length` bytes filled with pattern byte `fill`. */
function makeSnapshot(length, fill = 0xcd) {
  return "0x" + Buffer.alloc(length, fill).toString("hex");
}

/** Deploy a fresh ShieldedCheckpoint contract. */
async function deployFresh() {
  return ethers.deployContract("ShieldedCheckpoint");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ShieldedCheckpoint", function () {
  let checkpoint;
  let alice, bob, carol;

  beforeEach(async () => {
    [alice, bob, carol] = await ethers.getSigners();
    checkpoint = await deployFresh();
  });

  // -------------------------------------------------------------------------
  // 1. Initial state — fresh contract, no checkpoints
  // -------------------------------------------------------------------------
  describe("initial state", function () {
    it("exists(user, token) returns false for user with no checkpoint", async function () {
      expect(await checkpoint.exists(alice.address, TOKEN_A)).to.equal(false);
      expect(await checkpoint.exists(bob.address, TOKEN_A)).to.equal(false);
    });

    it("metadata returns all-zero values and hasCheckpoint=false for unknown (user, token)", async function () {
      const [idx, block, version, ex] = await checkpoint.metadata(alice.address, TOKEN_A);
      expect(idx).to.equal(0n);
      expect(block).to.equal(0n);
      expect(version).to.equal(0n);
      expect(ex).to.equal(false);
    });

    it("MAX_SNAPSHOT_BYTES is 16384", async function () {
      expect(await checkpoint.MAX_SNAPSHOT_BYTES()).to.equal(16384n);
    });
  });

  // -------------------------------------------------------------------------
  // 2. First update — happy path
  // -------------------------------------------------------------------------
  describe("first update — happy path", function () {
    it("exists becomes true after first update", async function () {
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 5n);
      expect(await checkpoint.exists(alice.address, TOKEN_A)).to.equal(true);
    });

    it("metadata reflects cursor and version=1 after first update", async function () {
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 5n);
      const [idx, blk, version, ex] = await checkpoint.metadata(alice.address, TOKEN_A);
      expect(idx).to.equal(5n);
      expect(version).to.equal(1n);
      expect(ex).to.equal(true);
      // lastUpdatedBlock should be a non-zero block number
      expect(blk).to.be.gt(0n);
    });

    it("exists is still false for other users after one user updates", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(64), EPH_X, EPH_Y, 0n);
      expect(await checkpoint.exists(bob.address, TOKEN_A)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Version increments on subsequent updates
  // -------------------------------------------------------------------------
  describe("version increment", function () {
    it("version goes 1 → 2 on second update", async function () {
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 0n);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 1n);
      const [, , version] = await checkpoint.metadata(alice.address, TOKEN_A);
      expect(version).to.equal(2n);
    });

    it("version increments independently for each user", async function () {
      const snap = makeSnapshot(32);
      // Alice updates 3 times, Bob updates once
      for (let i = 0; i < 3; i++) {
        await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, BigInt(i));
      }
      await checkpoint.connect(bob).update(TOKEN_A, snap, EPH_X, EPH_Y, 0n);

      const [, , aliceVersion] = await checkpoint.metadata(alice.address, TOKEN_A);
      const [, , bobVersion]   = await checkpoint.metadata(bob.address, TOKEN_A);
      expect(aliceVersion).to.equal(3n);
      expect(bobVersion).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple users — checkpoint isolation (same token)
  // -------------------------------------------------------------------------
  describe("user isolation", function () {
    it("alice and bob have independent checkpoints for the same token", async function () {
      const snapA = makeSnapshot(64, 0xAA);
      const snapB = makeSnapshot(64, 0xBB);

      await checkpoint.connect(alice).update(TOKEN_A, snapA, EPH_X, EPH_Y, 10n);
      await checkpoint.connect(bob).update(TOKEN_A, snapB, EPH_X, EPH_Y, 20n);

      const [idxA, , vA] = await checkpoint.metadata(alice.address, TOKEN_A);
      const [idxB, , vB] = await checkpoint.metadata(bob.address, TOKEN_A);

      expect(idxA).to.equal(10n);
      expect(idxB).to.equal(20n);
      expect(vA).to.equal(1n);
      expect(vB).to.equal(1n);
    });

    it("carol's checkpoint is unaffected by alice and bob updates", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(32), EPH_X, EPH_Y, 0n);
      await checkpoint.connect(bob).update(TOKEN_A, makeSnapshot(32), EPH_X, EPH_Y, 0n);
      expect(await checkpoint.exists(carol.address, TOKEN_A)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. read(token) returns caller's own full checkpoint data
  // -------------------------------------------------------------------------
  describe("read(token) — owner read", function () {
    it("read(token) returns correct encryptedSnapshot after update", async function () {
      const snap = makeSnapshot(128, 0xDE);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 7n);
      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.encryptedSnapshot).to.equal(snap);
    });

    it("read(token) returns correct ephemeral pubkey coordinates", async function () {
      const px = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
      const py = 0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210n;
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(32), px, py, 0n);
      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.ephPubkeyX).to.equal(px);
      expect(cp.ephPubkeyY).to.equal(py);
    });

    it("read(token) returns correct cursor and version", async function () {
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 42n);
      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.lastConsumedNoteIndex).to.equal(42n);
      expect(cp.version).to.equal(1n);
      expect(cp.lastUpdatedBlock).to.be.gt(0n);
    });

    it("read(token) reflects latest update after multiple writes", async function () {
      const snap1 = makeSnapshot(64, 0x11);
      const snap2 = makeSnapshot(64, 0x22);
      await checkpoint.connect(alice).update(TOKEN_A, snap1, EPH_X, EPH_Y, 3n);
      await checkpoint.connect(alice).update(TOKEN_A, snap2, EPH_X, EPH_Y, 9n);
      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.encryptedSnapshot).to.equal(snap2);
      expect(cp.lastConsumedNoteIndex).to.equal(9n);
      expect(cp.version).to.equal(2n);
    });
  });

  // -------------------------------------------------------------------------
  // 6. read(token) reverts NoCheckpoint if slot was never written
  // -------------------------------------------------------------------------
  describe("read(token) — NoCheckpoint revert", function () {
    it("read(token) reverts with NoCheckpoint(user, token) if caller has never updated", async function () {
      await expect(checkpoint.connect(alice).read(TOKEN_A))
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint")
        .withArgs(alice.address, TOKEN_A);
    });

    it("read(token) for alice does not revert after alice updates, even if bob has no checkpoint", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(32), EPH_X, EPH_Y, 0n);
      // alice can read her own checkpoint
      await expect(checkpoint.connect(alice).read(TOKEN_A)).to.not.be.reverted;
      // bob still has no checkpoint for TOKEN_A
      await expect(checkpoint.connect(bob).read(TOKEN_A))
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint")
        .withArgs(bob.address, TOKEN_A);
    });
  });

  // -------------------------------------------------------------------------
  // 7. read(token) is msg.sender scoped — privacy design
  // -------------------------------------------------------------------------
  describe("read(token) — msg.sender scoped (privacy design)", function () {
    it("contract ABI has read(address) taking exactly one address arg (the token)", async function () {
      const fns = checkpoint.interface.fragments
        .filter(f => f.type === "function" && f.name === "read");
      expect(fns.length).to.equal(1);
      expect(fns[0].inputs.length).to.equal(1);
      expect(fns[0].inputs[0].type).to.equal("address");
    });

    it("alice cannot read bob's encrypted blob (she only gets her own via read(token))", async function () {
      const snapB = makeSnapshot(64, 0xBB);
      await checkpoint.connect(bob).update(TOKEN_A, snapB, EPH_X, EPH_Y, 10n);

      // Alice has no checkpoint for TOKEN_A — her read() reverts
      await expect(checkpoint.connect(alice).read(TOKEN_A))
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint")
        .withArgs(alice.address, TOKEN_A);

      // Alice updates with her own different payload for the same token
      const snapA = makeSnapshot(64, 0xAA);
      await checkpoint.connect(alice).update(TOKEN_A, snapA, EPH_X, EPH_Y, 0n);

      // Alice's read() returns her own data, not bob's
      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.encryptedSnapshot).to.equal(snapA);
      expect(cp.encryptedSnapshot).to.not.equal(snapB);
    });
  });

  // -------------------------------------------------------------------------
  // 8. metadata is public — anyone can read non-sensitive fields
  // -------------------------------------------------------------------------
  describe("metadata(user, token) — public access", function () {
    it("bob can read alice's metadata for a token after alice updates", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(64), EPH_X, EPH_Y, 15n);
      // Bob reads Alice's metadata for TOKEN_A
      const [idx, blk, version, ex] = await checkpoint.connect(bob).metadata(alice.address, TOKEN_A);
      expect(idx).to.equal(15n);
      expect(version).to.equal(1n);
      expect(ex).to.equal(true);
      expect(blk).to.be.gt(0n);
    });

    it("metadata does not expose the encrypted blob", async function () {
      const snap = makeSnapshot(64, 0xFF);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 5n);

      // metadata() returns a 4-tuple: (cursor, block, version, exists)
      const result = await checkpoint.metadata(alice.address, TOKEN_A);
      // There should be exactly 4 values — no blob in the tuple
      expect(result.length).to.equal(4);
      // None of the returned values should be the blob
      for (const v of result) {
        expect(typeof v).to.not.equal("object"); // no bytes object
      }
    });

    it("carol can read bob's metadata without credentials", async function () {
      await checkpoint.connect(bob).update(TOKEN_A, makeSnapshot(32), EPH_X, EPH_Y, 99n);
      const [idx, , version, ex] = await checkpoint.connect(carol).metadata(bob.address, TOKEN_A);
      expect(idx).to.equal(99n);
      expect(version).to.equal(1n);
      expect(ex).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Snapshot too large — revert SnapshotTooLarge
  // -------------------------------------------------------------------------
  describe("snapshot size validation", function () {
    it("update with exactly MAX_SNAPSHOT_BYTES succeeds", async function () {
      const maxSnap = makeSnapshot(16384);
      await expect(
        checkpoint.connect(alice).update(TOKEN_A, maxSnap, EPH_X, EPH_Y, 0n)
      ).to.not.be.reverted;
      expect(await checkpoint.exists(alice.address, TOKEN_A)).to.equal(true);
    });

    it("update with MAX_SNAPSHOT_BYTES + 1 reverts SnapshotTooLarge", async function () {
      const tooBig = makeSnapshot(16385);
      await expect(
        checkpoint.connect(alice).update(TOKEN_A, tooBig, EPH_X, EPH_Y, 0n)
      ).to.be.revertedWithCustomError(checkpoint, "SnapshotTooLarge");
    });

    it("update with very large snapshot (65536 bytes) reverts SnapshotTooLarge", async function () {
      const huge = makeSnapshot(65536);
      await expect(
        checkpoint.connect(alice).update(TOKEN_A, huge, EPH_X, EPH_Y, 0n)
      ).to.be.revertedWithCustomError(checkpoint, "SnapshotTooLarge");
    });

    it("rejected update does not create a checkpoint", async function () {
      const tooBig = makeSnapshot(16385);
      await expect(
        checkpoint.connect(alice).update(TOKEN_A, tooBig, EPH_X, EPH_Y, 0n)
      ).to.be.reverted;
      expect(await checkpoint.exists(alice.address, TOKEN_A)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Empty snapshot is valid
  // -------------------------------------------------------------------------
  describe("empty snapshot — valid", function () {
    it("update with empty bytes (0x) succeeds", async function () {
      await expect(
        checkpoint.connect(alice).update(TOKEN_A, "0x", EPH_X, EPH_Y, 0n)
      ).to.not.be.reverted;
    });

    it("exists is true after an empty snapshot update", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, "0x", EPH_X, EPH_Y, 0n);
      expect(await checkpoint.exists(alice.address, TOKEN_A)).to.equal(true);
    });

    it("read(token) returns empty bytes after empty snapshot update", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, "0x", EPH_X, EPH_Y, 0n);
      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.encryptedSnapshot).to.equal("0x");
      expect(cp.version).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // 11. Cursor monotonicity NOT enforced — apps may rewind for rescans
  // -------------------------------------------------------------------------
  describe("cursor monotonicity — not enforced", function () {
    it("cursor can decrease between updates (rewind for rescan)", async function () {
      // NOTE: The contract intentionally allows cursor to go backward.
      // This enables applications to trigger re-processing of inbox notes
      // without redeploying or resetting state.
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 100n);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 10n); // rewind
      const [idx, , version] = await checkpoint.metadata(alice.address, TOKEN_A);
      expect(idx).to.equal(10n);
      expect(version).to.equal(2n); // version still incremented
    });

    it("cursor can go to zero from any positive value", async function () {
      const snap = makeSnapshot(32);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 999n);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 0n);
      const [idx] = await checkpoint.metadata(alice.address, TOKEN_A);
      expect(idx).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // 12. Event emission — CheckpointUpdated now includes indexed token field
  // -------------------------------------------------------------------------
  describe("event emission", function () {
    it("update emits CheckpointUpdated with correct args including token", async function () {
      const snap = makeSnapshot(64);
      const tx = await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 7n);
      const receipt = await tx.wait();
      await expect(tx)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, TOKEN_A, 1n, 7n, BigInt(receipt.blockNumber));
    });

    it("CheckpointUpdated emitted on every update, version increments in event", async function () {
      const snap = makeSnapshot(32);

      const tx1 = await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 0n);
      const rec1 = await tx1.wait();
      await expect(tx1)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, TOKEN_A, 1n, 0n, BigInt(rec1.blockNumber));

      const tx2 = await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 5n);
      const rec2 = await tx2.wait();
      await expect(tx2)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, TOKEN_A, 2n, 5n, BigInt(rec2.blockNumber));
    });

    it("events from different users are independent", async function () {
      const snap = makeSnapshot(32);
      const txA = await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 0n);
      const txB = await checkpoint.connect(bob).update(TOKEN_A, snap, EPH_X, EPH_Y, 0n);
      const recA = await txA.wait();
      const recB = await txB.wait();

      await expect(txA)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, TOKEN_A, 1n, 0n, BigInt(recA.blockNumber));
      await expect(txB)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(bob.address, TOKEN_A, 1n, 0n, BigInt(recB.blockNumber));
    });

    it("event carries correct token arg when writing to TOKEN_B", async function () {
      const snap = makeSnapshot(32);
      const tx = await checkpoint.connect(alice).update(TOKEN_B, snap, EPH_X, EPH_Y, 3n);
      const rec = await tx.wait();
      await expect(tx)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, TOKEN_B, 1n, 3n, BigInt(rec.blockNumber));
    });

    it("SnapshotTooLarge update does NOT emit CheckpointUpdated", async function () {
      const tooBig = makeSnapshot(16385);
      const tx = checkpoint.connect(alice).update(TOKEN_A, tooBig, EPH_X, EPH_Y, 0n);
      await expect(tx).to.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // 13. Gas benchmarks
  // -------------------------------------------------------------------------
  describe("gas benchmarks", function () {
    it("update(small snapshot — 64 bytes) uses < 300k gas", async function () {
      const tx = await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(64), EPH_X, EPH_Y, 0n);
      const receipt = await tx.wait();
      console.log(`      update(64B):     ${receipt.gasUsed.toString()} gas`);
      expect(receipt.gasUsed).to.be.lt(300_000n);
    });

    it("update(large snapshot — 16384 bytes) uses < 15M gas", async function () {
      // 16384B = 512 × 32-byte words; each cold SSTORE ≈ 20k gas → ~10.24M base.
      // Gas limit is set conservatively at 15M to account for EVM overhead.
      const tx = await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(16384), EPH_X, EPH_Y, 0n);
      const receipt = await tx.wait();
      console.log(`      update(16384B):  ${receipt.gasUsed.toString()} gas`);
      expect(receipt.gasUsed).to.be.lt(15_000_000n);
    });

    it("metadata(user, token) view call gas estimate is < 30k gas", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(64), EPH_X, EPH_Y, 5n);
      const gas = await checkpoint.metadata.estimateGas(alice.address, TOKEN_A);
      console.log(`      metadata(alice, TOKEN_A): ${gas.toString()} gas (estimate)`);
      expect(gas).to.be.lt(30_000n);
    });

    it("exists(user, token) view call gas estimate is < 30k gas", async function () {
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(64), EPH_X, EPH_Y, 0n);
      const gas = await checkpoint.exists.estimateGas(alice.address, TOKEN_A);
      console.log(`      exists(alice, TOKEN_A):   ${gas.toString()} gas (estimate)`);
      expect(gas).to.be.lt(30_000n);
    });
  });

  // -------------------------------------------------------------------------
  // 14. Per-token slot isolation — the core A.1 invariant
  // -------------------------------------------------------------------------
  describe("per-token slot isolation", function () {

    it("update writes to the correct [user][token] slot", async function () {
      // Write to TOKEN_A only
      const snap = makeSnapshot(64, 0xAA);
      await checkpoint.connect(alice).update(TOKEN_A, snap, EPH_X, EPH_Y, 5n);

      // TOKEN_A slot is populated
      const [, , vA, hasA] = await checkpoint.metadata(alice.address, TOKEN_A);
      expect(vA).to.equal(1n);
      expect(hasA).to.equal(true);

      // TOKEN_B slot is untouched
      const [, , vB, hasB] = await checkpoint.metadata(alice.address, TOKEN_B);
      expect(vB).to.equal(0n);
      expect(hasB).to.equal(false);
    });

    it("writing to (user, TOKEN_A) does NOT affect (user, TOKEN_B)", async function () {
      const snapA = makeSnapshot(64, 0xAA);
      await checkpoint.connect(alice).update(TOKEN_A, snapA, EPH_X, EPH_Y, 10n);

      // TOKEN_B remains empty — read reverts
      await expect(checkpoint.connect(alice).read(TOKEN_B))
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint")
        .withArgs(alice.address, TOKEN_B);

      // TOKEN_A readable correctly
      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.encryptedSnapshot).to.equal(snapA);
    });

    it("writing to (user, TOKEN_B) does NOT affect (user, TOKEN_A)", async function () {
      const snapB = makeSnapshot(64, 0xBB);
      await checkpoint.connect(alice).update(TOKEN_B, snapB, EPH_X, EPH_Y, 20n);

      // TOKEN_A slot is untouched
      expect(await checkpoint.exists(alice.address, TOKEN_A)).to.equal(false);
      await expect(checkpoint.connect(alice).read(TOKEN_A))
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint")
        .withArgs(alice.address, TOKEN_A);
    });

    it("two different users writing to the same token are isolated", async function () {
      const snapA = makeSnapshot(64, 0xAA);
      const snapB = makeSnapshot(64, 0xBB);

      await checkpoint.connect(alice).update(TOKEN_B, snapA, EPH_X, EPH_Y, 1n);
      await checkpoint.connect(bob).update(TOKEN_B, snapB, EPH_X, EPH_Y, 2n);

      // Alice reads her own TOKEN_B slot
      const cpA = await checkpoint.connect(alice).read(TOKEN_B);
      expect(cpA.encryptedSnapshot).to.equal(snapA);
      expect(cpA.lastConsumedNoteIndex).to.equal(1n);

      // Bob reads his own TOKEN_B slot
      const cpB = await checkpoint.connect(bob).read(TOKEN_B);
      expect(cpB.encryptedSnapshot).to.equal(snapB);
      expect(cpB.lastConsumedNoteIndex).to.equal(2n);
    });

    it("read(TOKEN_A) returns snapshot just written to that slot", async function () {
      const snapA = makeSnapshot(96, 0xCA);
      await checkpoint.connect(alice).update(TOKEN_A, snapA, EPH_X, EPH_Y, 7n);

      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.encryptedSnapshot).to.equal(snapA);
      expect(cp.lastConsumedNoteIndex).to.equal(7n);
      expect(cp.version).to.equal(1n);
    });

    it("read(token) reverts NoCheckpoint on a slot that was never written", async function () {
      // Alice updates TOKEN_A but never TOKEN_B
      await checkpoint.connect(alice).update(TOKEN_A, makeSnapshot(32), EPH_X, EPH_Y, 0n);

      await expect(checkpoint.connect(alice).read(TOKEN_B))
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint")
        .withArgs(alice.address, TOKEN_B);
    });

    it("metadata(user, token) reflects hasCheckpoint per-token correctly", async function () {
      // Write TOKEN_B only
      await checkpoint.connect(alice).update(TOKEN_B, makeSnapshot(32), EPH_X, EPH_Y, 0n);

      const [, , , hasA] = await checkpoint.metadata(alice.address, TOKEN_A);
      const [, , , hasB] = await checkpoint.metadata(alice.address, TOKEN_B);

      expect(hasA).to.equal(false);  // TOKEN_A never written
      expect(hasB).to.equal(true);   // TOKEN_B written
    });

    it("updating same (user, token) twice overwrites — version increments, lastUpdatedBlock updates", async function () {
      const snap1 = makeSnapshot(64, 0x11);
      const snap2 = makeSnapshot(64, 0x22);

      const tx1 = await checkpoint.connect(alice).update(TOKEN_A, snap1, EPH_X, EPH_Y, 3n);
      const rec1 = await tx1.wait();

      const tx2 = await checkpoint.connect(alice).update(TOKEN_A, snap2, EPH_X, EPH_Y, 9n);
      const rec2 = await tx2.wait();

      const cp = await checkpoint.connect(alice).read(TOKEN_A);
      expect(cp.encryptedSnapshot).to.equal(snap2);        // overwritten
      expect(cp.lastConsumedNoteIndex).to.equal(9n);
      expect(cp.version).to.equal(2n);                    // incremented
      expect(cp.lastUpdatedBlock).to.equal(BigInt(rec2.blockNumber)); // updated

      // Confirm the second update overwrote and the block number moved forward
      expect(BigInt(rec2.blockNumber)).to.be.gte(BigInt(rec1.blockNumber));
    });

    it("CheckpointUpdated event carries correct indexed token field", async function () {
      const snap = makeSnapshot(32);
      const tx = await checkpoint.connect(alice).update(TOKEN_B, snap, EPH_X, EPH_Y, 0n);
      const rec = await tx.wait();
      await expect(tx)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, TOKEN_B, 1n, 0n, BigInt(rec.blockNumber));
    });

    it("ethers.ZeroAddress (TOKEN_A) is a valid and independent slot key", async function () {
      // This confirms address(0) works as a plain key — a design requirement.
      const snapZero = makeSnapshot(32, 0x00);
      await checkpoint.connect(alice).update(ethers.ZeroAddress, snapZero, EPH_X, EPH_Y, 0n);

      expect(await checkpoint.exists(alice.address, ethers.ZeroAddress)).to.equal(true);
      const cp = await checkpoint.connect(alice).read(ethers.ZeroAddress);
      expect(cp.version).to.equal(1n);

      // A non-zero token slot is still empty
      expect(await checkpoint.exists(alice.address, TOKEN_B)).to.equal(false);
    });

    it("all three tokens (TOKEN_A, TOKEN_B, TOKEN_C) maintain independent state for same user", async function () {
      const TOKEN_C = "0x2222222222222222222222222222222222222222";
      const snapA = makeSnapshot(32, 0xAA);
      const snapB = makeSnapshot(32, 0xBB);
      const snapC = makeSnapshot(32, 0xCC);

      await checkpoint.connect(alice).update(TOKEN_A, snapA, EPH_X, EPH_Y, 1n);
      await checkpoint.connect(alice).update(TOKEN_B, snapB, EPH_X, EPH_Y, 2n);
      await checkpoint.connect(alice).update(TOKEN_C, snapC, EPH_X, EPH_Y, 3n);

      const cpA = await checkpoint.connect(alice).read(TOKEN_A);
      const cpB = await checkpoint.connect(alice).read(TOKEN_B);
      const cpC = await checkpoint.connect(alice).read(TOKEN_C);

      expect(cpA.encryptedSnapshot).to.equal(snapA);
      expect(cpA.lastConsumedNoteIndex).to.equal(1n);

      expect(cpB.encryptedSnapshot).to.equal(snapB);
      expect(cpB.lastConsumedNoteIndex).to.equal(2n);

      expect(cpC.encryptedSnapshot).to.equal(snapC);
      expect(cpC.lastConsumedNoteIndex).to.equal(3n);

      // Each has version 1 — they're independent
      expect(cpA.version).to.equal(1n);
      expect(cpB.version).to.equal(1n);
      expect(cpC.version).to.equal(1n);
    });
  });
});
