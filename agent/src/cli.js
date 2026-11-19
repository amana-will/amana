// Command-line helper, used by people and by AI agents (see skill/SKILL.md).
//   node src/cli.js status <vaultId>
//   node src/cli.js calldata checkin <vaultId>
//   node src/cli.js calldata vote <vaultId> okay|passed
//   node src/cli.js calldata limit <tokenSymbol> <amount>   (sets how much of a token the will can collect)
import { ethers } from "ethers";
import { deployment } from "./config.js";
import { readVault, iface, VOTE, fmtTokens, chainNow } from "./chain.js";

const [cmd, a, b, c] = process.argv.slice(2);
const out = (x) => console.log(JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const call = (to, data) => ({ binanceChainId: String(deployment.chainId), to, value: "0", inputData: data });
const A = deployment.amana;

async function main() {
  if (cmd === "status") {
    const v = await readVault(Number(a));
    const now = await chainNow();
    return out({
      status: v.status,
      coveredToday: fmtTokens(v.tokens, (t) => t.coverage),
      nextCheckInDue: new Date((v.lastCheckIn + v.plan.checkInInterval) * 1000).toISOString(),
      guardiansAskedAt: new Date((v.lastCheckIn + v.plan.checkInInterval + v.plan.gracePeriod) * 1000).toISOString(),
      overdueDays: Math.max(0, Math.floor((now - v.lastCheckIn - v.plan.checkInInterval) / 86400)),
      guardians: v.guardians.length,
      willSealed: v.sealed,
      releaseAt: v.releaseAt ? new Date(v.releaseAt * 1000).toISOString() : null,
    });
  }
  if (cmd === "calldata") {
    if (a === "checkin") return out(call(A, iface.encodeFunctionData("checkIn", [Number(b)])));
    if (a === "vote") {
      if (!VOTE[c]) throw new Error("Vote must be okay or passed.");
      return out(call(A, iface.encodeFunctionData("vote", [Number(b), VOTE[c]])));
    }
    if (a === "limit") {
      const t = (deployment.tokens || []).find((x) => x.symbol.toLowerCase() === String(b).toLowerCase());
      if (!t) throw new Error(`Unknown token. Choose one of: ${(deployment.tokens || []).map((x) => x.symbol).join(", ")}`);
      const erc20 = new ethers.Interface(["function approve(address,uint256)"]);
      return out(call(t.address, erc20.encodeFunctionData("approve", [A, ethers.parseUnits(String(c), 18)])));
    }
  }
  console.log("Usage: status <vaultId> | calldata checkin <vaultId> | calldata vote <vaultId> okay|passed | calldata limit <token> <amount>");
  process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
