// Prepares a local demo: gives Hardhat's test accounts names, mints each a test Agent ID,
// and mints test USDC to Yassine. Run after `npx hardhat node` and the local deploy.
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { provider, erc20, agentIdNft } from "./chain.js";
import { deployment } from "./config.js";
import { config } from "./config.js";

if (!config.isLocal) {
  console.error("demo-setup only runs against the local Hardhat chain.");
  process.exit(1);
}

const NAMES = ["yassine.ai", "karim.ai", "salma.ai", "omar.ai", "mama.ai", "ilyas.ai"];
const accounts = await provider.send("eth_accounts", []);
const people = {};
NAMES.forEach((n, i) => (people[n] = ethers.getAddress(accounts[i])));
fs.mkdirSync(config.dataDir, { recursive: true });
fs.writeFileSync(path.join(config.dataDir, "demo-people.json"), JSON.stringify(people, null, 2));

const minter = await provider.getSigner(accounts[0]);
for (const a of Object.values(people)) {
  if ((await agentIdNft.balanceOf(a)) === 0n) await (await agentIdNft.connect(minter).mint(a)).wait();
}
await (await erc20(deployment.tokens[0].address).connect(minter).mint(people["yassine.ai"], ethers.parseUnits("5000", 18))).wait();

console.log("Demo people (each holds a test Agent ID):");
for (const [n, a] of Object.entries(people)) console.log(`  ${n.padEnd(11)} ${a}`);
console.log("Minted 5,000 test USDC to yassine.ai.");
