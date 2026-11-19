require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the solc compiler installed from npm instead of downloading one.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: "0.8.24+commit.e11b9ed9",
    };
  }
  return runSuper();
});

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    bscTestnet: { url: process.env.BSC_TESTNET_RPC || "https://bsc-testnet-rpc.publicnode.com", chainId: 97, accounts },
    bsc: { url: process.env.BSC_RPC || "https://bsc-rpc.publicnode.com", chainId: 56, accounts },
  },
  // BscScan verification. Get a free key at https://etherscan.io/myapikey (works for BscScan too).
  etherscan: { apiKey: process.env.BSCSCAN_API_KEY || "" },
  sourcify: { enabled: false },
};
