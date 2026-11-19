// Opens a sealed will after a release, once enough guardians have sent their key piece.
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { config } from "./config.js";
import { store, save, agentLog } from "./store.js";
import { amana, keeper, readVault, readSeal, willHash } from "./chain.js";
import { keypairFromSignature, openSealed, combine, decryptWill, toHex } from "./seal.js";
import { x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "crypto";

// The agent's own key, which guardians encrypt their pieces for. Kept in data/agent-key.json unless AGENT_SEAL_KEY is set.
function loadAgentKey() {
  if (config.agentSealKey) return ethers.getBytes(config.agentSealKey);
  const file = path.join(config.dataDir, "agent-key.json");
  if (fs.existsSync(file)) return ethers.getBytes(JSON.parse(fs.readFileSync(file, "utf8")).privateKey);
  const key = new Uint8Array(randomBytes(32));
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ privateKey: toHex(key) }), { mode: 0o600 });
  return key;
}
const agentPrivate = loadAgentKey();
export const agentPublicKey = toHex(x25519.getPublicKey(agentPrivate));

function* subsets(items, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i < items.length; i++) yield* subsets(items, k, i + 1, [...acc, items[i]]);
}

const inFlight = new Map();
/**
 * Unlocks vault `id`'s will once enough guardians have sent their key piece, and checks it against the
 * on-chain fingerprint. Returns true when the will is unlocked (stored in the agent's private records).
 * Recording it on-chain (openWill) is then done by a guardian from their own wallet, or by the agent if it pays fees.
 */
export function tryOpen(id) {
  if (!inFlight.has(id)) inFlight.set(id, attemptOpen(id).finally(() => inFlight.delete(id)));
  return inFlight.get(id);
}

/** The arguments a guardian's wallet passes to openWill. */
export function openArgs(id) {
  const w = store.meta[id]?.will;
  if (!w) return null;
  return { shares: w.heirs.map((h) => h.shareBps), unlocks: w.heirs.map((h) => h.unlockAt || 0), salt: w.salt };
}

async function attemptOpen(id) {
  const v = await readVault(id);
  if (!v.released) return false;
  const meta = (store.meta[id] ||= {});
  if (meta.will) {
    if (!v.opened && keeper) await recordOnChain(id);
    return true;
  }

  const sealed = await readSeal(id, v.sealedAtBlock);
  const raw = [];
  for (const [addr, piece] of Object.entries(store.pieces[id] || {})) {
    if (!sealed.guardians.some((g) => g.toLowerCase() === addr)) continue;
    try { raw.push(openSealed(agentPrivate, piece)); } catch { /* ignore a broken piece */ }
  }
  if (raw.length < v.plan.threshold) return false;

  let will = null;
  for (const set of subsets(raw, v.plan.threshold)) {
    try { will = decryptWill(combine(set), sealed.ciphertext); break; } catch { /* wrong combination, try another */ }
  }
  if (!will) { agentLog(id, "The key pieces received so far don't open the will. Waiting for another guardian."); return false; }

  const shares = will.heirs.map((h) => h.shareBps);
  const unlocks = will.heirs.map((h) => h.unlockAt || 0);
  if (willHash(id, shares, unlocks, will.salt) !== v.willHash) {
    agentLog(id, "The unlocked will doesn't match its on-chain fingerprint. Not opening it.");
    return false;
  }
  meta.will = { heirs: will.heirs.map((h, i) => ({ index: i, name: h.name, relation: h.relation || "", shareBps: h.shareBps, unlockAt: h.unlockAt || 0, letter: h.letter || "" })), salt: will.salt };
  save();
  agentLog(id, `Guardians unlocked the will and it matched its fingerprint exactly. It names ${will.heirs.length} heir(s).`);
  if (!v.opened && keeper) await recordOnChain(id);
  return true;
}

async function recordOnChain(id) {
  const a = openArgs(id);
  const tx = await amana.openWill(id, a.shares, a.unlocks, a.salt);
  await tx.wait();
}
