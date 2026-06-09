require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": { "*": ["storageLayout"] }
      }
    },
  },
  paths: {
    sources: "./contracts/solidity",
    cache: "/tmp/janus-token-cache-layout",
    artifacts: "/tmp/janus-token-artifacts-layout",
  },
};
