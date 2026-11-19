// Deploys the Amana contract.
//   Local:    npx hardhat run scripts/deploy.js --network localhost
//   Testnet:  PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network bscTestnet
//   Mainnet:  PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network bsc
// On mainnet it uses the real Binance Agent ID contract and offers real tokens (USDT, USDC, WBNB, BTCB, ETH).
// Elsewhere it deploys a test Agent ID and a test stablecoin. Writes ../shared/deployment.json for the agent and the web app.
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

const MAINNET = {
  agentId: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f", // Binance Agent ID (from the hackathon announcement)
  // Tokens the app offers to cover. Owners pick which ones and set a limit for each. All use 18 decimals on BNB Chain.
  tokens: [
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
    { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
    { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
    { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
    { symbol: "ETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
  ],
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const isMainnet = network.name === "bsc";
  console.log(`Deploying to ${network.name} from ${deployer.address}`);

  let agentId = process.env.AGENT_ID || (isMainnet ? MAINNET.agentId : "");
  let tokens = isMainnet ? MAINNET.tokens : [];
  if (!isMainnet) {
    const c = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await c.waitForDeployment();
    tokens = [{ symbol: "tUSDC", address: await c.getAddress(), mock: true }];
    console.log(`Test stablecoin (tUSDC): ${tokens[0].address}`);
  }
  if (!agentId) {
    const c = await (await ethers.getContractFactory("MockAgentID")).deploy();
    await c.waitForDeployment();
    agentId = await c.getAddress();
    console.log(`Test Agent ID: ${agentId}`);
  }

  const amana = await (await ethers.getContractFactory("Amana")).deploy(agentId);
  await amana.waitForDeployment();
  const address = await amana.getAddress();
  const deployBlock = (await amana.deploymentTransaction().wait()).blockNumber;
  console.log(`Amana: ${address} (block ${deployBlock})`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    amana: address,
    deployBlock,
    tokens,
    agentId,
    agentIdIsMock: agentId.toLowerCase() !== MAINNET.agentId && !process.env.AGENT_ID,
    abi: {
      amana: (await artifacts.readArtifact("Amana")).abi,
      token: (await artifacts.readArtifact("MockUSDC")).abi,
      agentId: (await artifacts.readArtifact("MockAgentID")).abi,
    },
  };
  const dir = path.join(__dirname, "..", "..", "shared");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify(out, null, 2));
  console.log("Saved shared/deployment.json");
  if (network.name !== "localhost" && network.name !== "hardhat") {
    console.log(`\nVerify on BscScan:\n  BSCSCAN_API_KEY=... npx hardhat verify --network ${network.name} ${address} ${agentId}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
