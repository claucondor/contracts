/**
 * wrapWithProof.test.cjs
 *
 * Unit and integration tests for the wrapWithProof() path on JanusFlow.
 *
 * Uses the real AmountDiscloseAggregateVerifier (test zkey) for proof-verified tests.
 * All tests run on a local Hardhat node — no testnet required.
 *
 * Test plan:
 *   a) wrapWithProof with real proof — commitment accumulates correctly
 *   b) wrapWithProof rejects wrong amount — proof bound to different amount
 *   c) wrapWithProof rejects replay — same nonce reverts with "nonce used"
 *   d) wrapWithProof rejects wrong commit — proof bound to different point
 *   e) Multiple wraps accumulate correctly (homomorphism)
 *   f) wrapWithProof → shieldedTransfer full scenario
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { commit, addCommits, generateProof, generateAmountDiscloseProof, SUBORDER } =
  require("./helpers/proofGen.cjs");

describe("wrapWithProof: real amount-disclose verifier", function () {
  this.timeout(300_000); // proof generation is ~5-15s per proof

  let janusFlow;
  let pedersen;
  let memoRegistry;
  let babyJub;
  let owner;
  let alice;
  let bob;

  async function deployFresh() {
    const signers = await ethers.getSigners();
    [owner, alice, bob] = signers;

    const BabyJubF = await ethers.getContractFactory("BabyJub");
    babyJub = await BabyJubF.deploy();
    await babyJub.waitForDeployment();

    const PF = await ethers.getContractFactory("Pedersen2Gen");
    pedersen = await PF.deploy();
    await pedersen.waitForDeployment();

    // Real aggregate transfer verifier
    const TVF = await ethers.getContractFactory("ConfidentialTransferAggregateVerifier");
    const transferVerifier = await TVF.deploy();
    await transferVerifier.waitForDeployment();

    // Real AmountDiscloseAggregateVerifier (test zkey)
    const ADVF = await ethers.getContractFactory("AmountDiscloseAggregateVerifier");
    const amountDiscloseVerifier = await ADVF.deploy();
    await amountDiscloseVerifier.waitForDeployment();

    const MKR = await ethers.getContractFactory("MockMemoKeyRegistry");
    memoRegistry = await MKR.deploy();
    await memoRegistry.waitForDeployment();

    // Deploy ShieldedInbox for v0.8.0 initialize
    const InboxF = await ethers.getContractFactory("ShieldedInbox");
    const inbox = await InboxF.deploy();
    await inbox.waitForDeployment();

    const implF = await ethers.getContractFactory("JanusFlow");
    const impl = await implF.deploy();
    await impl.waitForDeployment();

    const proxyF = await ethers.getContractFactory("JanusFlow_Proxy");
    const initData = impl.interface.encodeFunctionData("initialize", [
      await babyJub.getAddress(),
      await transferVerifier.getAddress(),
      await amountDiscloseVerifier.getAddress(),
      owner.address,
      await memoRegistry.getAddress(),
      await pedersen.getAddress(),
      await inbox.getAddress(),
    ]);
    const proxy = await proxyF.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    janusFlow = await ethers.getContractAt("JanusFlow", await proxy.getAddress());
  }

  before(async function () {
    await deployFresh();
  });

  // ── (a) Valid proof — accumulator updates ─────────────────────────────────

  it("(a) wrapWithProof with real proof — commitment accumulates correctly", async function () {
    const amount   = 1n * 10n**18n;  // 1 ETH/FLOW
    const blinding = 12345678901234567890n;
    const nonce    = 1n;

    const proof = await generateAmountDiscloseProof({ amount, blinding, nonce });

    // pubSignals: [amount, commitX, commitY, nonce]
    const commitX = proof.pubSignals[1];
    const commitY = proof.pubSignals[2];

    // Verify off-chain commitment matches
    const expectedC = commit(amount, blinding);
    expect(commitX).to.equal(expectedC.x, "proof commitX matches local commitment");
    expect(commitY).to.equal(expectedC.y, "proof commitY matches local commitment");

    // dummy non-empty encryptedSnapshot + ephemeral pubkey (contract emits but does not validate)
    const dummySnapshot = "0x" + "ab".repeat(32);
    const dummyEphX = 12345678901234567890n;
    const dummyEphY = 98765432109876543210n;

    const tx = await janusFlow.connect(alice).wrapWithProof(
      nonce,
      [commitX, commitY],
      [proof.pA[0], proof.pA[1]],
      [[proof.pB[0][0], proof.pB[0][1]], [proof.pB[1][0], proof.pB[1][1]]],
      [proof.pC[0], proof.pC[1]],
      dummySnapshot,
      dummyEphX,
      dummyEphY,
      { value: amount }
    );
    await tx.wait();

    // Verify event emits real (non-empty) snapshot data
    const receipt = await tx.wait();
    const wrapEvent = receipt.logs
      .map(log => { try { return janusFlow.interface.parseLog(log); } catch { return null; } })
      .find(e => e && e.name === "WrapWithSnapshot");
    expect(wrapEvent).to.not.be.null;
    expect(wrapEvent.args.encryptedSnapshot).to.equal(dummySnapshot, "event encryptedSnapshot non-empty");
    expect(wrapEvent.args.ephPubkeyX).to.equal(dummyEphX, "event ephPubkeyX correct");
    expect(wrapEvent.args.ephPubkeyY).to.equal(dummyEphY, "event ephPubkeyY correct");

    // Commitment should be [amount]G + [blinding]H from identity
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(cx).to.equal(expectedC.x, "on-chain commitX after wrap");
    expect(cy).to.equal(expectedC.y, "on-chain commitY after wrap");

    // totalLocked should be amount
    const locked = await janusFlow.totalLocked();
    expect(locked).to.equal(amount, "totalLocked equals wrap amount");
  });

  // ── (b) Wrong amount rejects ──────────────────────────────────────────────

  it("(b) wrapWithProof rejects wrong amount — msg.value differs from proof amount", async function () {
    const amount   = 1n * 10n**18n;
    const blinding = 99999n;
    const nonce    = 10n;

    // Generate proof for amount = 1e18
    const proof = await generateAmountDiscloseProof({ amount, blinding, nonce });
    const commitX = proof.pubSignals[1];
    const commitY = proof.pubSignals[2];

    // Submit with msg.value = 2e18 (wrong — proof is for 1e18)
    const wrongAmount = 2n * 10n**18n;
    await expect(
      janusFlow.connect(alice).wrapWithProof(
        nonce,
        [commitX, commitY],
        [proof.pA[0], proof.pA[1]],
        [[proof.pB[0][0], proof.pB[0][1]], [proof.pB[1][0], proof.pB[1][1]]],
        [proof.pC[0], proof.pC[1]],
        "0x" + "cd".repeat(32),
        11111n,
        22222n,
        { value: wrongAmount }
      )
    ).to.be.revertedWith("JanusFlow: invalid amount_disclose proof");
  });

  // ── (c) Replay rejection ──────────────────────────────────────────────────

  it("(c) wrapWithProof rejects replay — same nonce twice reverts", async function () {
    const amount   = 1n * 10n**17n;  // 0.1 FLOW
    const blinding = 777888999n;
    const nonce    = 42n;

    const proof = await generateAmountDiscloseProof({ amount, blinding, nonce });
    const commitX = proof.pubSignals[1];
    const commitY = proof.pubSignals[2];

    // First call should succeed
    await janusFlow.connect(bob).wrapWithProof(
      nonce,
      [commitX, commitY],
      [proof.pA[0], proof.pA[1]],
      [[proof.pB[0][0], proof.pB[0][1]], [proof.pB[1][0], proof.pB[1][1]]],
      [proof.pC[0], proof.pC[1]],
      "0x" + "ef".repeat(32),
      33333n,
      44444n,
      { value: amount }
    );

    // Second call with same nonce should revert
    await expect(
      janusFlow.connect(bob).wrapWithProof(
        nonce,
        [commitX, commitY],
        [proof.pA[0], proof.pA[1]],
        [[proof.pB[0][0], proof.pB[0][1]], [proof.pB[1][0], proof.pB[1][1]]],
        [proof.pC[0], proof.pC[1]],
        "0x" + "ef".repeat(32),
        33333n,
        44444n,
        { value: amount }
      )
    ).to.be.revertedWith("JanusFlow: nonce used");
  });

  // ── (d) Wrong commit rejects ──────────────────────────────────────────────

  it("(d) wrapWithProof rejects wrong commit — submitted commit differs from proof", async function () {
    const amount   = 5n * 10n**17n;
    const blinding = 111222333n;
    const nonce    = 100n;

    const proof = await generateAmountDiscloseProof({ amount, blinding, nonce });

    // Use a different (wrong) commit point
    const wrongCommit = commit(amount, 999999n); // different blinding

    await expect(
      janusFlow.connect(alice).wrapWithProof(
        nonce,
        [wrongCommit.x, wrongCommit.y],
        [proof.pA[0], proof.pA[1]],
        [[proof.pB[0][0], proof.pB[0][1]], [proof.pB[1][0], proof.pB[1][1]]],
        [proof.pC[0], proof.pC[1]],
        "0x" + "12".repeat(32),
        55555n,
        66666n,
        { value: amount }
      )
    ).to.be.revertedWith("JanusFlow: invalid amount_disclose proof");
  });

  // ── (e) Multiple wraps accumulate correctly ───────────────────────────────

  it("(e) two sequential wrapWithProofs accumulate correctly", async function () {
    // Deploy fresh instance so state is clean
    await deployFresh();

    const amount1   = 3n * 10n**17n;  // 0.3 FLOW
    const blinding1 = 12121212n;
    const nonce1    = 1001n;

    const amount2   = 7n * 10n**17n;  // 0.7 FLOW
    const blinding2 = 34343434n;
    const nonce2    = 1002n;

    const proof1 = await generateAmountDiscloseProof({ amount: amount1, blinding: blinding1, nonce: nonce1 });
    const proof2 = await generateAmountDiscloseProof({ amount: amount2, blinding: blinding2, nonce: nonce2 });

    const c1 = commit(amount1, blinding1);
    const c2 = commit(amount2, blinding2);

    await janusFlow.connect(alice).wrapWithProof(
      nonce1,
      [c1.x, c1.y],
      [proof1.pA[0], proof1.pA[1]],
      [[proof1.pB[0][0], proof1.pB[0][1]], [proof1.pB[1][0], proof1.pB[1][1]]],
      [proof1.pC[0], proof1.pC[1]],
      "0x" + "a1".repeat(32),
      77777n,
      88888n,
      { value: amount1 }
    );

    await janusFlow.connect(alice).wrapWithProof(
      nonce2,
      [c2.x, c2.y],
      [proof2.pA[0], proof2.pA[1]],
      [[proof2.pB[0][0], proof2.pB[0][1]], [proof2.pB[1][0], proof2.pB[1][1]]],
      [proof2.pC[0], proof2.pC[1]],
      "0x" + "b2".repeat(32),
      99999n,
      11111n,
      { value: amount2 }
    );

    // Expected: identity + c1 + c2 = Commit(amount1+amount2, blinding1+blinding2)
    const expected = addCommits({ x: 0n, y: 1n }, addCommits(c1, c2));
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(cx).to.equal(expected.x, "accumulated commitX after two wraps");
    expect(cy).to.equal(expected.y, "accumulated commitY after two wraps");

    const locked = await janusFlow.totalLocked();
    expect(locked).to.equal(amount1 + amount2, "totalLocked equals sum of wraps");
  });

  // ── (f) Full scenario: wrapWithProof → shieldedTransfer ──────────────────

  it("(f) full scenario: wrapWithProof → shieldedTransfer succeeds", async function () {
    // Deploy fresh instance
    await deployFresh();

    const wrapAmount   = 5n * 10n**18n;  // 5 FLOW
    const wrapBlinding = 99887766n;
    const wrapNonce    = 2001n;
    const txValue      = 2n * 10n**18n;  // 2 FLOW
    const txBlinding   = 44332211n;
    const newBlinding  = 55443322n;

    // Generate amount-disclose proof for wrap
    const amtProof = await generateAmountDiscloseProof({
      amount:   wrapAmount,
      blinding: wrapBlinding,
      nonce:    wrapNonce,
    });

    const wrapCommit = commit(wrapAmount, wrapBlinding);

    await janusFlow.connect(alice).wrapWithProof(
      wrapNonce,
      [wrapCommit.x, wrapCommit.y],
      [amtProof.pA[0], amtProof.pA[1]],
      [[amtProof.pB[0][0], amtProof.pB[0][1]], [amtProof.pB[1][0], amtProof.pB[1][1]]],
      [amtProof.pC[0], amtProof.pC[1]],
      "0x" + "ff".repeat(32),
      111111n,
      222222n,
      { value: wrapAmount }
    );

    // Verify commitment matches
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(cx).to.equal(wrapCommit.x, "commitment after wrap matches");
    expect(cy).to.equal(wrapCommit.y, "commitment after wrap matches");

    // Generate transfer proof from Alice to Bob
    const transferProof = await generateProof({
      old_value:         wrapAmount,
      old_blinding:      wrapBlinding,
      transfer_value:    txValue,
      transfer_blinding: txBlinding,
      new_blinding:      newBlinding,
    });

    const pubSigs = transferProof.pubSignals;

    // C_old in proof must match Alice's on-chain commitment
    expect(pubSigs[0]).to.equal(cx, "proof C_old.x matches on-chain");
    expect(pubSigs[1]).to.equal(cy, "proof C_old.y matches on-chain");

    // Execute shieldedTransfer
    await janusFlow.connect(alice).shieldedTransfer(
      bob.address,
      [pubSigs[0], pubSigs[1], pubSigs[2], pubSigs[3], pubSigs[4], pubSigs[5]],
      [transferProof.pA[0], transferProof.pA[1],
       transferProof.pB[0][0], transferProof.pB[0][1],
       transferProof.pB[1][0], transferProof.pB[1][1],
       transferProof.pC[0], transferProof.pC[1]],
      "0x", 0n, 0n  // encryptedNoteTo, ephPubkeyToX, ephPubkeyToY
    );

    // Alice's new commitment = Commit(wrapAmount - txValue, newBlinding)
    const expectedAlice = commit(wrapAmount - txValue, newBlinding);
    const [aliceCx, aliceCy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(aliceCx).to.equal(expectedAlice.x, "Alice new commitX after transfer");
    expect(aliceCy).to.equal(expectedAlice.y, "Alice new commitY after transfer");

    // Bob received Commit(txValue, txBlinding)
    const bobTxCommit = commit(txValue, txBlinding);
    const expectedBob = addCommits({ x: 0n, y: 1n }, bobTxCommit);
    const [bobCx, bobCy] = await janusFlow.balanceOfCommitmentXY(bob.address);
    expect(bobCx).to.equal(expectedBob.x, "Bob commitX after receiving transfer");
    expect(bobCy).to.equal(expectedBob.y, "Bob commitY after receiving transfer");
  });
});
