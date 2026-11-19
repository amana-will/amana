import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { config, deployment } from "./config.js";

export const provider = new ethers.JsonRpcProvider(config.rpcUrl, deployment.chainId, { staticNetwork: true });

// The agent's gas wallet. It only pays fees to release vaults, open verified wills and pay confirmed heirs;
// it never holds anyone's money. Unless KEEPER_PRIVATE_KEY is set, it is created on first run and kept in
// DATA_DIR/keeper-key.json. Send it a little BNB (0.005 is plenty to start).
function keeperKey() {
  if (config.keeperKey) return config.keeperKey;
  const file = path.join(config.dataDir, "keeper-key.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).privateKey;
  const w = ethers.Wallet.createRandom();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ address: w.address, privateKey: w.privateKey }), { mode: 0o600 });
  return w.privateKey;
}
export const keeper = config.agentPaysFees ? new ethers.Wallet(keeperKey(), provider) : null;

export const amana = new ethers.Contract(deployment.amana, deployment.abi.amana, keeper || provider);
export const erc20 = (addr) => new ethers.Contract(addr, deployment.abi.token, provider);
const symbols = Object.fromEntries((deployment.tokens || []).map((t) => [t.address.toLowerCase(), t.symbol]));
export const symbolOf = (addr) => symbols[addr.toLowerCase()] || addr.slice(0, 6) + "…";
export const agentIdNft = new ethers.Contract(deployment.agentId, deployment.abi.agentId, provider);
export const iface = new ethers.Interface(deployment.abi.amana);

export const STATUS = ["Active", "Reminder", "Alert", "Pending", "Released"];
export const VOTE = { okay: 1, passed: 2 };
const ZERO = ethers.ZeroAddress;

export async function readVault(id) {
  const [v, guardians, heirs, status, cov] = await Promise.all([
    amana.getVault(id), amana.guardians(id), amana.heirs(id), amana.status(id), amana.coverage(id),
  ]);
  const tokenList = [...cov[0]];
  const collected = v.released ? await Promise.all(tokenList.map((t) => amana.collected(id, t))) : tokenList.map(() => 0n);
  const votes = await Promise.all(guardians.map((g) => amana.voteOf(id, v.round, g)));
  return {
    id: Number(id),
    status: STATUS[Number(status)],
    round: Number(v.round),
    owner: v.owner,
    plan: {
      checkInInterval: Number(v.plan.checkInInterval),
      gracePeriod: Number(v.plan.gracePeriod),
      threshold: Number(v.plan.threshold),
      cancelWindow: Number(v.plan.cancelWindow),
    },
    tokens: tokenList.map((t, i) => ({ address: t, symbol: symbolOf(t), coverage: cov[1][i], collected: collected[i] })),
    guardians: guardians.map((g, i) => ({ wallet: g, vote: Number(votes[i]) })),
    heirs: heirs.map((h, i) => ({ index: i, shareBps: Number(h.shareBps), unlockAt: Number(h.unlockAt), wallet: h.wallet === ZERO ? null : h.wallet, paid: h.paid })),
    willHash: v.willHash,
    sealed: v.willHash !== ethers.ZeroHash,
    sealedAtBlock: Number(v.sealedAtBlock),
    sealCurrent: v.sealCurrent,
    lastCheckIn: Number(v.lastCheckIn),
    releaseAt: Number(v.releaseAt),
    released: v.released,
    opened: v.opened,
  };
}

/** The encrypted will and key pieces, read back from the WillSealed event. */
export async function readSeal(id, block) {
  const topic = iface.getEvent("WillSealed").topicHash;
  const logs = await provider.getLogs({ address: deployment.amana, fromBlock: block, toBlock: block, topics: [topic, ethers.zeroPadValue(ethers.toBeHex(id), 32)] });
  if (!logs.length) throw new Error("Sealed will not found on-chain.");
  const ev = iface.parseLog(logs[logs.length - 1]);
  return { willHash: ev.args.willHash, ciphertext: ev.args.ciphertext, guardians: [...ev.args.guardians], keyPieces: [...ev.args.keyPieces] };
}

/** Must match web/app.js and the contract's openWill. */
export function willHash(id, shares, unlocks, salt) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint16[]", "uint64[]", "bytes32"], [id, shares, unlocks, salt]));
}

export const codeHash = (code) => ethers.keccak256(ethers.toUtf8Bytes(normalizeCode(code)));
export const normalizeCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function allVaultIds() {
  const n = Number(await amana.vaultCount());
  return Array.from({ length: n }, (_, i) => i + 1);
}

export async function chainNow() {
  const b = await provider.getBlock("latest");
  return Number(b.timestamp);
}

export const fmtAmount = (wei, symbol) => Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 }) + " " + symbol;
/** "4,000 USDT and 0.5 BTCB" */
export const fmtTokens = (list, pick = (t) => t.collected) =>
  list.filter((t) => pick(t) > 0n).map((t) => fmtAmount(pick(t), t.symbol)).join(" and ") || "nothing";
