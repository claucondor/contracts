/**
 * janus-flow-aggregate.test.js
 *
 * Integration test: JanusFlow with 2-gen Pedersen aggregate commitment.
 *
 * Scenario (the v0.6 "C_old mismatch" operator scenario, now fixed):
 *   1. Alice wrapWithProof 10 FLOW (gets commitment Commit(10e18, r1))
 *   2. Bob shieldedTransfers 0.5 FLOW to Alice via _testReceive sim
 *   3. Carol shieldedTransfers 0.5 FLOW to Alice via _testReceive sim
 *   4. Alice's accumulator = Commit(11e18, r1+r2+r3) — 3 accumulated events
 *   5. Alice shieldedTransfers 5 FLOW to Dave — MUST succeed (not C_old mismatch)
 *   6. Alice's new commitment = Commit(6e18, new_r)
 *   7. Dave's commitment += Commit(5e18, tx_r)
 *
 * The AmountDiscloseVerifier is mocked (returns true) so wrapWithProof succeeds
 * without generating an amount-disclose proof. The transfer proof is real.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { commit, addCommits, generateProof, SUBORDER } = require("./helpers/proofGen.cjs");

describe("JanusFlow aggregate commitment: wrap → receive × 2 → shieldedTransfer", function () {
  this.timeout(300_000); // proof generation is slow

  let janusFlow;
  let pedersen;
  let memoRegistry;
  let babyJub;
  let owner;
  let alice;
  let bob;
  let carol;
  let dave;

  // Test constants (fixed for determinism)
  const WRAP_V      = 10n * 10n**18n; // 10 FLOW
  const WRAP_R      = 111111111n;
  const BOB_TX_R    = 222222222n;
  const CAROL_TX_R  = 333333333n;
  const HALF_FLOW   = 5n * 10n**17n;  // 0.5 FLOW
  const TX_V        = 5n * 10n**18n;  // 5 FLOW
  const TX_R        = 555555555n;
  const NEW_R       = 666666666n;

  let aliceAccV;
  let aliceAccR;

  before(async function () {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();

    // Deploy support contracts
    const BabyJubF = await ethers.getContractFactory("BabyJub");
    babyJub = await BabyJubF.deploy();
    await babyJub.waitForDeployment();

    const PF = await ethers.getContractFactory("Pedersen2Gen");
    pedersen = await PF.deploy();
    await pedersen.waitForDeployment();

    // Real aggregate verifier (test zkey)
    const VF = await ethers.getContractFactory("ConfidentialTransferAggregateVerifier");
    const verifier = await VF.deploy();
    await verifier.waitForDeployment();

    // Mock AmountDiscloseVerifier (always returns true — tests proof path, not amount proof)
    const ADV = await ethers.getContractFactory("MockAmountDiscloseVerifier");
    const amountDiscloseVerifier = await ADV.deploy();
    await amountDiscloseVerifier.waitForDeployment();

    // Mock MemoKeyRegistry
    const MKR = await ethers.getContractFactory("MockMemoKeyRegistry");
    memoRegistry = await MKR.deploy();
    await memoRegistry.waitForDeployment();

    // Deploy JanusFlow impl + proxy
    const implF = await ethers.getContractFactory("JanusFlow");
    const impl = await implF.deploy();
    await impl.waitForDeployment();

    const proxyF = await ethers.getContractFactory("JanusFlow_Proxy");
    const initData = impl.interface.encodeFunctionData("initialize", [
      await babyJub.getAddress(),
      await verifier.getAddress(),
      await amountDiscloseVerifier.getAddress(),
      owner.address,
      await memoRegistry.getAddress(),
      await pedersen.getAddress(),
    ]);
    const proxy = await proxyF.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    janusFlow = await ethers.getContractAt("JanusFlow", await proxy.getAddress());
  });

  it("Step 0: initial commitment for Alice is identity (0,1)", async function () {
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(cx).to.equal(0n, "initial x should be 0");
    expect(cy).to.equal(1n, "initial y should be 1 (identity)");
  });

  it("Step 1: Alice wrapWithProof 10 FLOW — commitment accumulates correctly", async function () {
    const wrapCommit = commit(WRAP_V, WRAP_R);

    // mock proof (all zeros — MockAmountDiscloseVerifier accepts any proof)
    const fakePa  = [0n, 0n];
    const fakePb  = [[0n, 0n], [0n, 0n]];
    const fakePc  = [0n, 0n];
    const nonce1  = 1n;

    await janusFlow.connect(alice).wrapWithProof(
      nonce1,
      [wrapCommit.x, wrapCommit.y],
      fakePa,
      fakePb,
      fakePc,
      "0x" + "aa".repeat(32),
      1234567n,
      8901234n,
      { value: WRAP_V }
    );

    aliceAccV = WRAP_V;
    aliceAccR = WRAP_R;

    const expected = commit(aliceAccV, aliceAccR);
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(cx).to.equal(expected.x, "Alice commit.x after wrap");
    expect(cy).to.equal(expected.y, "Alice commit.y after wrap");
  });

  it("Step 2: simulate receiving 0.5 FLOW (Bob's contribution, accumulated via wrapWithProof)", async function () {
    // Simulate "receive" by doing a second wrapWithProof from Alice for 0.5 FLOW with Bob's blinding.
    // In production, receives arrive via shieldedTransfer from Bob; here we use wrapWithProof
    // to accumulate the same commitment point into Alice's slot, which exercises the same
    // on-chain accumulator path (addCommits) without requiring a real transfer proof from Bob.
    const bobTxCommit = commit(HALF_FLOW, BOB_TX_R);
    const fakePa  = [0n, 0n];
    const fakePb  = [[0n, 0n], [0n, 0n]];
    const fakePc  = [0n, 0n];
    const nonce2  = 2n;
    await janusFlow.connect(alice).wrapWithProof(
      nonce2,
      [bobTxCommit.x, bobTxCommit.y],
      fakePa, fakePb, fakePc,
      "0x" + "bb".repeat(32),
      2345678n,
      9012345n,
      { value: HALF_FLOW }
    );

    aliceAccV = (aliceAccV + HALF_FLOW) % SUBORDER;
    aliceAccR = (aliceAccR + BOB_TX_R) % SUBORDER;

    const expected = commit(aliceAccV, aliceAccR);
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(cx).to.equal(expected.x, "Alice commit.x after Bob receive");
    expect(cy).to.equal(expected.y, "Alice commit.y after Bob receive");
  });

  it("Step 3: simulate receiving 0.5 FLOW (Carol's contribution, accumulated via wrapWithProof)", async function () {
    const carolTxCommit = commit(HALF_FLOW, CAROL_TX_R);
    const fakePa  = [0n, 0n];
    const fakePb  = [[0n, 0n], [0n, 0n]];
    const fakePc  = [0n, 0n];
    const nonce3  = 3n;
    await janusFlow.connect(alice).wrapWithProof(
      nonce3,
      [carolTxCommit.x, carolTxCommit.y],
      fakePa, fakePb, fakePc,
      "0x" + "cc".repeat(32),
      3456789n,
      1234567n,
      { value: HALF_FLOW }
    );

    aliceAccV = (aliceAccV + HALF_FLOW) % SUBORDER;
    aliceAccR = (aliceAccR + CAROL_TX_R) % SUBORDER;

    const expected = commit(aliceAccV, aliceAccR);
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    expect(cx).to.equal(expected.x, "Alice commit.x after Carol receive");
    expect(cy).to.equal(expected.y, "Alice commit.y after Carol receive");
    console.log(`    Alice accumulated: value=${aliceAccV}, blinding=${aliceAccR}`);
  });

  it("Step 4: Alice shieldedTransfers 5 FLOW to Dave — MUST NOT revert with C_old mismatch", async function () {
    // This is the key test — with 3 accumulated events, Alice can still prove
    // ownership using the aggregate scalar pair (aliceAccV, aliceAccR).
    // In windowed-hash Pedersen this would fail.

    const [onChainCX, onChainCY] = await janusFlow.balanceOfCommitmentXY(alice.address);
    const expectedOld = commit(aliceAccV, aliceAccR);

    // Verify off-chain matches on-chain
    expect(onChainCX).to.equal(expectedOld.x, "pre-transfer: on-chain commitment.x should match off-chain");
    expect(onChainCY).to.equal(expectedOld.y, "pre-transfer: on-chain commitment.y should match off-chain");

    // Generate real Groth16 proof
    const proof = await generateProof({
      old_value:         aliceAccV,
      old_blinding:      aliceAccR,
      transfer_value:    TX_V,
      transfer_blinding: TX_R,
      new_blinding:      NEW_R,
    });

    const pubSignals = proof.pubSignals;

    // C_old in proof must match on-chain state
    expect(pubSignals[0]).to.equal(onChainCX, "pubSignals C_old.x must match on-chain");
    expect(pubSignals[1]).to.equal(onChainCY, "pubSignals C_old.y must match on-chain");

    // Execute shieldedTransfer — must NOT revert with "C_old mismatch"
    const tx = await janusFlow.connect(alice).shieldedTransfer(
      dave.address,
      [pubSignals[0], pubSignals[1], pubSignals[2], pubSignals[3], pubSignals[4], pubSignals[5]],
      [proof.pA[0], proof.pA[1], proof.pB[0][0], proof.pB[0][1], proof.pB[1][0], proof.pB[1][1], proof.pC[0], proof.pC[1]],
      "0x", 0n, 0n, // encryptedSnapshot, ephPubkeyX, ephPubkeyY
      "0x", 0n, 0n  // encryptedNoteTo, ephPubkeyToX, ephPubkeyToY
    );
    await tx.wait();
  });

  it("Step 5: Alice's new balance commitment is correct after transfer", async function () {
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(alice.address);
    const newValue = aliceAccV - TX_V;
    const expectedNew = commit(newValue, NEW_R);
    expect(cx).to.equal(expectedNew.x, "Alice new commit.x");
    expect(cy).to.equal(expectedNew.y, "Alice new commit.y");
  });

  it("Step 5: Dave's commitment increased by transfer amount", async function () {
    const [cx, cy] = await janusFlow.balanceOfCommitmentXY(dave.address);
    // Dave started from identity (0,1)
    const txCommit = commit(TX_V, TX_R);
    const expected = addCommits({ x: 0n, y: 1n }, txCommit);
    expect(cx).to.equal(expected.x, "Dave commit.x after receiving");
    expect(cy).to.equal(expected.y, "Dave commit.y after receiving");
  });

  it("Accumulated totalLocked equals sum of all wraps", async function () {
    const totalLocked = await janusFlow.totalLocked();
    const expectedTotal = WRAP_V + HALF_FLOW + HALF_FLOW; // 10 + 0.5 + 0.5 = 11 FLOW
    expect(totalLocked).to.equal(expectedTotal, "totalLocked should equal sum of wraps");
  });
});
