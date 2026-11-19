import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, "..", "..");

// Optional .env file in the agent folder: KEY=value per line.
const envFile = path.join(here, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const deploymentPath = path.join(ROOT, "shared", "deployment.json");
if (!fs.existsSync(deploymentPath)) {
  console.error("No shared/deployment.json yet. Deploy the contracts first (see README).");
  process.exit(1);
}

export const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

export const config = {
  rpcUrl: process.env.RPC_URL || ({ 31337: "http://127.0.0.1:8545", 97: "https://bsc-testnet-rpc.publicnode.com", 56: "https://bsc-dataseed.bnbchain.org" })[deployment.chainId],
  // Hot wallet that only pays gas to finalize releases and pay heirs. It never holds anyone's money.
  // Locally it defaults to Hardhat's public test account #9.
  keeperKey: process.env.KEEPER_PRIVATE_KEY ||
    (deployment.chainId === 31337 ? "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" : ""),
  port: Number(process.env.PORT || 3000),
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ""),
  pollSeconds: Number(process.env.POLL_SECONDS || 15),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  dataDir: process.env.DATA_DIR || path.join(here, "..", "data"),
  isLocal: deployment.chainId === 31337,
  // The agent's own sealing key: guardians send it their key pieces after a release. Generated on first run.
  agentSealKey: process.env.AGENT_SEAL_KEY || "",
};
