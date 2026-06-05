/**
 * aggregate-pedersen.test.js
 *
 * Unit tests for Pedersen2Gen.sol:
 * - commit(v, r) correctness
 * - addCommits homomorphism
 * - isOnCurve validation
 * - identity element handling
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { commit, addCommits, SUBORDER, P } = require("./helpers/proofGen.cjs");

describe("Pedersen2Gen: unit tests", function () {
  let pedersen;

  before(async function () {
    const PF = await ethers.getContractFactory("Pedersen2Gen");
    pedersen = await PF.deploy();
    await pedersen.waitForDeployment();
  });

  it("generatorG returns the expected Base8 point", async function () {
    const [gx, gy] = await pedersen.generatorG();
    const GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
    const GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;
    expect(gx).to.equal(GX);
    expect(gy).to.equal(GY);
  });

  it("generatorH returns the expected NUMS point", async function () {
    const [hx, hy] = await pedersen.generatorH();
    const HX = 20176122646359037043957983780698997220241005801156909477756461731029015465513n;
    const HY = 12675495183377259114213499882541802147068931119123218019653136042509354750865n;
    expect(hx).to.equal(HX);
    expect(hy).to.equal(HY);
  });

  it("isOnCurve: identity (0,1) is on curve", async function () {
    const ok = await pedersen.isOnCurve(0n, 1n);
    expect(ok).to.be.true;
  });

  it("isOnCurve: generatorG is on curve", async function () {
    const [gx, gy] = await pedersen.generatorG();
    const ok = await pedersen.isOnCurve(gx, gy);
    expect(ok).to.be.true;
  });

  it("isOnCurve: generatorH is on curve", async function () {
    const [hx, hy] = await pedersen.generatorH();
    const ok = await pedersen.isOnCurve(hx, hy);
    expect(ok).to.be.true;
  });

  it("isOnCurve: (0,0) is NOT on curve", async function () {
    const ok = await pedersen.isOnCurve(0n, 0n);
    expect(ok).to.be.false;
  });

  it("isOnCurve: random invalid point is not on curve", async function () {
    const ok = await pedersen.isOnCurve(1n, 2n);
    expect(ok).to.be.false;
  });

  it("commit(0, 0) returns the identity point (0, 1)", async function () {
    // commit(0, 0) = [0]*G + [0]*H = identity
    const [cx, cy] = await pedersen.commit(0n, 0n);
    expect(cx).to.equal(0n, "commit(0,0).x should be 0");
    expect(cy).to.equal(1n, "commit(0,0).y should be 1 (identity)");
  });

  it("commit(1, 0) returns generatorG", async function () {
    const [cx, cy] = await pedersen.commit(1n, 0n);
    const [gx, gy] = await pedersen.generatorG();
    expect(cx).to.equal(gx, "commit(1,0).x should be G.x");
    expect(cy).to.equal(gy, "commit(1,0).y should be G.y");
  });

  it("commit(0, 1) returns generatorH", async function () {
    const [cx, cy] = await pedersen.commit(0n, 1n);
    const [hx, hy] = await pedersen.generatorH();
    expect(cx).to.equal(hx, "commit(0,1).x should be H.x");
    expect(cy).to.equal(hy, "commit(0,1).y should be H.y");
  });

  it("commit(v, r) matches off-chain computation for a test vector", async function () {
    const v = 1000000000000000000n; // 1 FLOW
    const r = 123456789n;
    const expected = commit(v, r);
    const [cx, cy] = await pedersen.commit(v, r);
    expect(cx).to.equal(expected.x, "commit x mismatch");
    expect(cy).to.equal(expected.y, "commit y mismatch");
  });

  it("addCommits: identity + point = point", async function () {
    const v = 500000000000000000n;
    const r = 987654321n;
    const c = commit(v, r);
    const [rx, ry] = await pedersen.addCommits(0n, 1n, c.x, c.y);
    expect(rx).to.equal(c.x, "identity + c should give c.x");
    expect(ry).to.equal(c.y, "identity + c should give c.y");
  });

  it("addCommits: point + identity = point", async function () {
    const v = 200000000000000000n;
    const r = 111222333n;
    const c = commit(v, r);
    const [rx, ry] = await pedersen.addCommits(c.x, c.y, 0n, 1n);
    expect(rx).to.equal(c.x, "c + identity should give c.x");
    expect(ry).to.equal(c.y, "c + identity should give c.y");
  });

  it("addCommits(commit(a,b), commit(c,d)) == commit(a+c, b+d)", async function () {
    const a = 300000000000000000n;
    const b = 111111111n;
    const c = 200000000000000000n;
    const d = 222222222n;

    const ca = commit(a, b);
    const cb = commit(c, d);
    const [sumX, sumY] = await pedersen.addCommits(ca.x, ca.y, cb.x, cb.y);

    const directSum = commit((a + c) % SUBORDER, (b + d) % SUBORDER);
    expect(sumX).to.equal(directSum.x, "homomorphism x");
    expect(sumY).to.equal(directSum.y, "homomorphism y");
  });
});
