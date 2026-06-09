"use strict";

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Representative BN254 field element values for ephemeral pubkeys. */
const EPH_X = 12345678901234567890123456789012345678901234567890123456789012345n;
const EPH_Y = 98765432109876543219876543210987654321098765432109876543210987654n;

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
    it("exists(user) returns false for user with no checkpoint", async function () {
      expect(await checkpoint.exists(alice.address)).to.equal(false);
      expect(await checkpoint.exists(bob.address)).to.equal(false);
    });

    it("metadata returns all-zero values and exists=false for unknown user", async function () {
      const [idx, block, version, ex] = await checkpoint.metadata(alice.address);
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
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 5n);
      expect(await checkpoint.exists(alice.address)).to.equal(true);
    });

    it("metadata reflects cursor and version=1 after first update", async function () {
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 5n);
      const [idx, blk, version, ex] = await checkpoint.metadata(alice.address);
      expect(idx).to.equal(5n);
      expect(version).to.equal(1n);
      expect(ex).to.equal(true);
      // lastUpdatedBlock should be a non-zero block number
      expect(blk).to.be.gt(0n);
    });

    it("exists is still false for other users after one user updates", async function () {
      await checkpoint.connect(alice).update(makeSnapshot(64), EPH_X, EPH_Y, 0n);
      expect(await checkpoint.exists(bob.address)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Version increments on subsequent updates
  // -------------------------------------------------------------------------
  describe("version increment", function () {
    it("version goes 1 → 2 on second update", async function () {
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 0n);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 1n);
      const [, , version] = await checkpoint.metadata(alice.address);
      expect(version).to.equal(2n);
    });

    it("version increments independently for each user", async function () {
      const snap = makeSnapshot(32);
      // Alice updates 3 times, Bob updates once
      for (let i = 0; i < 3; i++) {
        await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, BigInt(i));
      }
      await checkpoint.connect(bob).update(snap, EPH_X, EPH_Y, 0n);

      const [, , aliceVersion] = await checkpoint.metadata(alice.address);
      const [, , bobVersion]   = await checkpoint.metadata(bob.address);
      expect(aliceVersion).to.equal(3n);
      expect(bobVersion).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple users — checkpoint isolation
  // -------------------------------------------------------------------------
  describe("user isolation", function () {
    it("alice and bob have independent checkpoints", async function () {
      const snapA = makeSnapshot(64, 0xAA);
      const snapB = makeSnapshot(64, 0xBB);

      await checkpoint.connect(alice).update(snapA, EPH_X, EPH_Y, 10n);
      await checkpoint.connect(bob).update(snapB, EPH_X, EPH_Y, 20n);

      const [idxA, , vA] = await checkpoint.metadata(alice.address);
      const [idxB, , vB] = await checkpoint.metadata(bob.address);

      expect(idxA).to.equal(10n);
      expect(idxB).to.equal(20n);
      expect(vA).to.equal(1n);
      expect(vB).to.equal(1n);
    });

    it("carol's checkpoint is unaffected by alice and bob updates", async function () {
      await checkpoint.connect(alice).update(makeSnapshot(32), EPH_X, EPH_Y, 0n);
      await checkpoint.connect(bob).update(makeSnapshot(32), EPH_X, EPH_Y, 0n);
      expect(await checkpoint.exists(carol.address)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. read() returns caller's own full checkpoint data
  // -------------------------------------------------------------------------
  describe("read() — owner read", function () {
    it("read() returns correct encryptedSnapshot after update", async function () {
      const snap = makeSnapshot(128, 0xDE);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 7n);
      const cp = await checkpoint.connect(alice).read();
      expect(cp.encryptedSnapshot).to.equal(snap);
    });

    it("read() returns correct ephemeral pubkey coordinates", async function () {
      const px = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
      const py = 0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210n;
      await checkpoint.connect(alice).update(makeSnapshot(32), px, py, 0n);
      const cp = await checkpoint.connect(alice).read();
      expect(cp.ephPubkeyX).to.equal(px);
      expect(cp.ephPubkeyY).to.equal(py);
    });

    it("read() returns correct cursor and version", async function () {
      const snap = makeSnapshot(64);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 42n);
      const cp = await checkpoint.connect(alice).read();
      expect(cp.lastConsumedNoteIndex).to.equal(42n);
      expect(cp.version).to.equal(1n);
      expect(cp.lastUpdatedBlock).to.be.gt(0n);
    });

    it("read() reflects latest update after multiple writes", async function () {
      const snap1 = makeSnapshot(64, 0x11);
      const snap2 = makeSnapshot(64, 0x22);
      await checkpoint.connect(alice).update(snap1, EPH_X, EPH_Y, 3n);
      await checkpoint.connect(alice).update(snap2, EPH_X, EPH_Y, 9n);
      const cp = await checkpoint.connect(alice).read();
      expect(cp.encryptedSnapshot).to.equal(snap2);
      expect(cp.lastConsumedNoteIndex).to.equal(9n);
      expect(cp.version).to.equal(2n);
    });
  });

  // -------------------------------------------------------------------------
  // 6. read() reverts NoCheckpoint if no checkpoint
  // -------------------------------------------------------------------------
  describe("read() — NoCheckpoint revert", function () {
    it("read() reverts with NoCheckpoint if caller has never updated", async function () {
      await expect(checkpoint.connect(alice).read())
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint");
    });

    it("read() for alice does not revert after alice updates, even if bob has no checkpoint", async function () {
      await checkpoint.connect(alice).update(makeSnapshot(32), EPH_X, EPH_Y, 0n);
      // alice can read her own checkpoint
      await expect(checkpoint.connect(alice).read()).to.not.be.reverted;
      // bob still has no checkpoint
      await expect(checkpoint.connect(bob).read())
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint");
    });
  });

  // -------------------------------------------------------------------------
  // 7. read() is msg.sender scoped — no read(address) function
  // -------------------------------------------------------------------------
  describe("read() — msg.sender scoped (privacy design)", function () {
    it("contract ABI has no read(address) function", async function () {
      // Verify the design invariant: there is no function that allows fetching
      // another user's encrypted blob by address.
      const fns = checkpoint.interface.fragments
        .filter(f => f.type === "function" && f.name === "read");
      expect(fns.length).to.equal(1);
      expect(fns[0].inputs.length).to.equal(0); // read() takes no args
    });

    it("alice cannot read bob's encrypted blob (she only gets her own via read())", async function () {
      const snapB = makeSnapshot(64, 0xBB);
      await checkpoint.connect(bob).update(snapB, EPH_X, EPH_Y, 10n);

      // Alice has no checkpoint — her read() reverts
      await expect(checkpoint.connect(alice).read())
        .to.be.revertedWithCustomError(checkpoint, "NoCheckpoint");

      // Alice updates with her own different payload
      const snapA = makeSnapshot(64, 0xAA);
      await checkpoint.connect(alice).update(snapA, EPH_X, EPH_Y, 0n);

      // Alice's read() returns her own data, not bob's
      const cp = await checkpoint.connect(alice).read();
      expect(cp.encryptedSnapshot).to.equal(snapA);
      expect(cp.encryptedSnapshot).to.not.equal(snapB);
    });
  });

  // -------------------------------------------------------------------------
  // 8. metadata is public — anyone can read non-sensitive fields
  // -------------------------------------------------------------------------
  describe("metadata — public access", function () {
    it("bob can read alice's metadata after alice updates", async function () {
      await checkpoint.connect(alice).update(makeSnapshot(64), EPH_X, EPH_Y, 15n);
      // Bob reads Alice's metadata
      const [idx, blk, version, ex] = await checkpoint.connect(bob).metadata(alice.address);
      expect(idx).to.equal(15n);
      expect(version).to.equal(1n);
      expect(ex).to.equal(true);
      expect(blk).to.be.gt(0n);
    });

    it("metadata does not expose the encrypted blob", async function () {
      const snap = makeSnapshot(64, 0xFF);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 5n);

      // metadata() returns a 4-tuple: (cursor, block, version, exists)
      const result = await checkpoint.metadata(alice.address);
      // There should be exactly 4 values — no blob in the tuple
      expect(result.length).to.equal(4);
      // None of the returned values should be the blob
      for (const v of result) {
        expect(typeof v).to.not.equal("object"); // no bytes object
      }
    });

    it("carol can read bob's metadata without credentials", async function () {
      await checkpoint.connect(bob).update(makeSnapshot(32), EPH_X, EPH_Y, 99n);
      const [idx, , version, ex] = await checkpoint.connect(carol).metadata(bob.address);
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
        checkpoint.connect(alice).update(maxSnap, EPH_X, EPH_Y, 0n)
      ).to.not.be.reverted;
      expect(await checkpoint.exists(alice.address)).to.equal(true);
    });

    it("update with MAX_SNAPSHOT_BYTES + 1 reverts SnapshotTooLarge", async function () {
      const tooBig = makeSnapshot(16385);
      await expect(
        checkpoint.connect(alice).update(tooBig, EPH_X, EPH_Y, 0n)
      ).to.be.revertedWithCustomError(checkpoint, "SnapshotTooLarge");
    });

    it("update with very large snapshot (65536 bytes) reverts SnapshotTooLarge", async function () {
      const huge = makeSnapshot(65536);
      await expect(
        checkpoint.connect(alice).update(huge, EPH_X, EPH_Y, 0n)
      ).to.be.revertedWithCustomError(checkpoint, "SnapshotTooLarge");
    });

    it("rejected update does not create a checkpoint", async function () {
      const tooBig = makeSnapshot(16385);
      await expect(
        checkpoint.connect(alice).update(tooBig, EPH_X, EPH_Y, 0n)
      ).to.be.reverted;
      expect(await checkpoint.exists(alice.address)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Empty snapshot is valid
  // -------------------------------------------------------------------------
  describe("empty snapshot — valid", function () {
    it("update with empty bytes (0x) succeeds", async function () {
      await expect(
        checkpoint.connect(alice).update("0x", EPH_X, EPH_Y, 0n)
      ).to.not.be.reverted;
    });

    it("exists is true after an empty snapshot update", async function () {
      await checkpoint.connect(alice).update("0x", EPH_X, EPH_Y, 0n);
      expect(await checkpoint.exists(alice.address)).to.equal(true);
    });

    it("read() returns empty bytes after empty snapshot update", async function () {
      await checkpoint.connect(alice).update("0x", EPH_X, EPH_Y, 0n);
      const cp = await checkpoint.connect(alice).read();
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
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 100n);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 10n); // rewind
      const [idx, , version] = await checkpoint.metadata(alice.address);
      expect(idx).to.equal(10n);
      expect(version).to.equal(2n); // version still incremented
    });

    it("cursor can go to zero from any positive value", async function () {
      const snap = makeSnapshot(32);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 999n);
      await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 0n);
      const [idx] = await checkpoint.metadata(alice.address);
      expect(idx).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // 12. Event emission
  // -------------------------------------------------------------------------
  describe("event emission", function () {
    it("update emits CheckpointUpdated with correct args", async function () {
      const snap = makeSnapshot(64);
      const tx = await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 7n);
      const receipt = await tx.wait();
      await expect(tx)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, 1n, 7n, BigInt(receipt.blockNumber));
    });

    it("CheckpointUpdated emitted on every update, version increments in event", async function () {
      const snap = makeSnapshot(32);

      const tx1 = await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 0n);
      const rec1 = await tx1.wait();
      await expect(tx1)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, 1n, 0n, BigInt(rec1.blockNumber));

      const tx2 = await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 5n);
      const rec2 = await tx2.wait();
      await expect(tx2)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, 2n, 5n, BigInt(rec2.blockNumber));
    });

    it("events from different users are independent", async function () {
      const snap = makeSnapshot(32);
      const txA = await checkpoint.connect(alice).update(snap, EPH_X, EPH_Y, 0n);
      const txB = await checkpoint.connect(bob).update(snap, EPH_X, EPH_Y, 0n);
      const recA = await txA.wait();
      const recB = await txB.wait();

      await expect(txA)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(alice.address, 1n, 0n, BigInt(recA.blockNumber));
      await expect(txB)
        .to.emit(checkpoint, "CheckpointUpdated")
        .withArgs(bob.address, 1n, 0n, BigInt(recB.blockNumber));
    });

    it("SnapshotTooLarge update does NOT emit CheckpointUpdated", async function () {
      const tooBig = makeSnapshot(16385);
      const tx = checkpoint.connect(alice).update(tooBig, EPH_X, EPH_Y, 0n);
      await expect(tx).to.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // 13. Gas benchmarks
  // -------------------------------------------------------------------------
  describe("gas benchmarks", function () {
    it("update(small snapshot — 64 bytes) uses < 300k gas", async function () {
      const tx = await checkpoint.connect(alice).update(makeSnapshot(64), EPH_X, EPH_Y, 0n);
      const receipt = await tx.wait();
      console.log(`      update(64B):     ${receipt.gasUsed.toString()} gas`);
      expect(receipt.gasUsed).to.be.lt(300_000n);
    });

    it("update(large snapshot — 16384 bytes) uses < 15M gas", async function () {
      // 16384B = 512 × 32-byte words; each cold SSTORE ≈ 20k gas → ~10.24M base.
      // Gas limit is set conservatively at 15M to account for EVM overhead.
      const tx = await checkpoint.connect(alice).update(makeSnapshot(16384), EPH_X, EPH_Y, 0n);
      const receipt = await tx.wait();
      console.log(`      update(16384B):  ${receipt.gasUsed.toString()} gas`);
      expect(receipt.gasUsed).to.be.lt(15_000_000n);
    });

    it("metadata() view call gas estimate is < 30k gas", async function () {
      // estimateGas for view calls includes the ~21k base tx overhead; the actual
      // on-chain cost for an eth_call is ~3-4k.  Limit set to 30k to cover estimate overhead.
      await checkpoint.connect(alice).update(makeSnapshot(64), EPH_X, EPH_Y, 5n);
      const gas = await checkpoint.metadata.estimateGas(alice.address);
      console.log(`      metadata(alice): ${gas.toString()} gas (estimate)`);
      expect(gas).to.be.lt(30_000n);
    });

    it("exists() view call gas estimate is < 30k gas", async function () {
      // estimateGas includes ~21k base tx overhead for view calls.
      await checkpoint.connect(alice).update(makeSnapshot(64), EPH_X, EPH_Y, 0n);
      const gas = await checkpoint.exists.estimateGas(alice.address);
      console.log(`      exists(alice):   ${gas.toString()} gas (estimate)`);
      expect(gas).to.be.lt(30_000n);
    });
  });
});
