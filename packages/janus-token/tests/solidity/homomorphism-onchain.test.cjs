/**
 * homomorphism-onchain.test.js
 *
 * Confirms the on-chain homomorphism property:
 *   Pedersen2Gen.commit(a,b) + Pedersen2Gen.commit(c,d) == Pedersen2Gen.commit(a+c, b+d)
 *
 * This is the mathematical invariant that makes the aggregate accumulator correct.
 * Tests multiple value combinations including accumulation of N deposits.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { commit, addCommits, SUBORDER } = require("./helpers/proofGen.cjs");

describe("Homomorphism on-chain: Pedersen2Gen.addCommits", function () {
  let pedersen;

  before(async function () {
    const PF = await ethers.getContractFactory("Pedersen2Gen");
    pedersen = await PF.deploy();
    await pedersen.waitForDeployment();
  });

  async function onChainAdd(p1, p2) {
    const [rx, ry] = await pedersen.addCommits(p1.x, p1.y, p2.x, p2.y);
    return { x: rx, y: ry };
  }

  it("Commit(1e18, 100) + Commit(2e18, 200) == Commit(3e18, 300)", async function () {
    const a = 1_000_000_000_000_000_000n;
    const b = 100n;
    const c = 2_000_000_000_000_000_000n;
    const d = 200n;

    const ca = commit(a, b);
    const cb = commit(c, d);
    const sum = await onChainAdd(ca, cb);
    const direct = commit(a + c, b + d);

    expect(sum.x).to.equal(direct.x, "x mismatch");
    expect(sum.y).to.equal(direct.y, "y mismatch");
  });

  it("Accumulation of 5 deposits matches single commit of sum", async function () {
    const deposits = [
      { v: 1_000_000_000_000_000_000n, r: 111n },
      { v: 500_000_000_000_000_000n,   r: 222n },
      { v: 250_000_000_000_000_000n,   r: 333n },
      { v: 750_000_000_000_000_000n,   r: 444n },
      { v: 100_000_000_000_000_000n,   r: 555n },
    ];

    // Accumulate on-chain
    let acc = { x: 0n, y: 1n }; // identity
    for (const { v, r } of deposits) {
      const c = commit(v, r);
      acc = await onChainAdd(acc, c);
    }

    // Single direct commit of summed values
    const totalV = deposits.reduce((s, d) => s + d.v, 0n) % SUBORDER;
    const totalR = deposits.reduce((s, d) => s + d.r, 0n) % SUBORDER;
    const direct = commit(totalV, totalR);

    expect(acc.x).to.equal(direct.x, "accumulated x should match direct commit of sum");
    expect(acc.y).to.equal(direct.y, "accumulated y should match direct commit of sum");
  });

  it("Accumulation is commutative (order does not matter)", async function () {
    const c1 = commit(1_000_000n, 101n);
    const c2 = commit(2_000_000n, 202n);
    const c3 = commit(3_000_000n, 303n);

    const ordABC = await onChainAdd(await onChainAdd(c1, c2), c3);
    const ordCBA = await onChainAdd(await onChainAdd(c3, c2), c1);
    const ordACB = await onChainAdd(await onChainAdd(c1, c3), c2);

    expect(ordABC.x).to.equal(ordCBA.x, "commutative x: ABC vs CBA");
    expect(ordABC.y).to.equal(ordCBA.y, "commutative y: ABC vs CBA");
    expect(ordABC.x).to.equal(ordACB.x, "commutative x: ABC vs ACB");
    expect(ordABC.y).to.equal(ordACB.y, "commutative y: ABC vs ACB");
  });

  it("Large-value accumulation (10 deposits of 1e18 each)", async function () {
    const v = 1_000_000_000_000_000_000n;
    const r = 123456789n;
    const n = 10n;

    let acc = { x: 0n, y: 1n };
    for (let i = 0n; i < n; i++) {
      const c = commit(v, r);
      acc = await onChainAdd(acc, c);
    }

    const totalV = (v * n) % SUBORDER;
    const totalR = (r * n) % SUBORDER;
    const direct = commit(totalV, totalR);

    expect(acc.x).to.equal(direct.x, "bulk accumulation x");
    expect(acc.y).to.equal(direct.y, "bulk accumulation y");
  });

  it("Off-chain addCommits matches on-chain addCommits", async function () {
    const p1 = commit(999_000_000_000_000_000n, 77777n);
    const p2 = commit(888_000_000_000_000_000n, 88888n);

    const offChain = addCommits(p1, p2);
    const [onChainX, onChainY] = await pedersen.addCommits(p1.x, p1.y, p2.x, p2.y);

    expect(onChainX).to.equal(offChain.x, "off-chain vs on-chain x");
    expect(onChainY).to.equal(offChain.y, "off-chain vs on-chain y");
  });
});
