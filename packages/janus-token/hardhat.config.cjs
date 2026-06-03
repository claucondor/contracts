require("@nomicfoundation/hardhat-toolbox");

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {},
    "flow-evm-testnet": {
      url: "https://testnet.evm.nodes.onflow.org",
      chainId: 545,
      // Deployment goes via COA (Cadence), not EOA — no private key needed here.
      // Use scripts/deploy_evm.mjs for actual deployment.
      accounts: [],
    },
  },
  paths: {
    sources: "./contracts/solidity",
    tests: "./tests/solidity",
    cache: "./cache-hh",
    artifacts: "./artifacts",
  },
};
