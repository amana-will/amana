// Amana agent server: serves the web app, a small API, and runs the watcher loop.
// Private details (names, the join code, letters) live here, not on-chain, and are only shown to
// people the chain says are members of that vault.
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ethers } from "ethers";
import { config, deployment, ROOT } from "./config.js";
import { store, save, agentLog } from "./store.js";
import { provider, amana, readVault, readSeal, chainNow, keeper, codeHash, normalizeCode } from "./chain.js";
import { parseWishes } from "./wishes.js";
import { tick, emojiText, nameIn, vaultLink } from "./watcher.js";
import { tryOpen, agentPublicKey } from "./opener.js";
import { pollTelegram, telegram, notify } from "./notify.js";

const app = express();
app.use(express.json({ limit: "400kb" }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 400).json({ error: e.shortMessage || e.message }));
const fail = (status, message) => Object.assign(new Error(message), { status });
const lower = (a) => String(a || "").toLowerCase();
const vaultId = (x) => {
  const n = Number(x);
  if (!Number.isInteger(n) || n < 1) throw fail(400, "Bad vault number.");
  return n;
};
const cleanName = (n) => {
  const s = String(n || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,63}\.ai$/.test(s)) throw fail(400, "Write your Agent ID, like karim.ai.");
  return s;
};

// One signature per session proves the caller controls their wallet: "Sign in to Amana\n<address>\n<timestamp>".
export const SIGN_IN = "Sign in to Amana";
function who(auth) {
  const { address, ts, sig } = auth || {};
  if (!address || !ts || !sig) throw fail(401, "Please sign in with your wallet.");
  if (Math.abs(Date.now() - Number(ts)) > 7 * 86400000) throw fail(401, "Your sign-in expired. Reload the page.");
  const signer = ethers.verifyMessage(`${SIGN_IN}\n${ethers.getAddress(address)}\n${ts}`, sig);
  if (lower(signer) !== lower(address)) throw fail(401, "Signature doesn't match this wallet.");
  return lower(address);
}
const authFrom = (req) => (req.method === "GET" ? { address: req.query.address, ts: req.query.ts, sig: req.query.sig } : req.body?.auth);

async function roleIn(id, addr) {
  const v = await readVault(id);
  const isOwner = lower(v.owner) === addr;
  const isGuardian = v.guardians.some((g) => lower(g.wallet) === addr);
  const heir = v.heirs.find((h) => lower(h.wallet) === addr);
  return { v, isOwner, isGuardian, heir, member: isOwner || isGuardian || !!heir };
}

let botName = null;

app.get("/api/config", wrap(async (req, res) => {
  res.json({
    chainId: deployment.chainId,
    network: deployment.network,
    amana: deployment.amana,
    tokens: deployment.tokens,
    agentId: deployment.agentId,
    agentIdIsMock: deployment.agentIdIsMock,
    abi: deployment.abi,
    isLocal: config.isLocal,
    rpcUrl: config.isLocal ? null : config.rpcUrl,
    aiEnabled: !!config.anthropicKey,
    telegramBot: botName,
    keeper: keeper ? keeper.address : null,
    agentPublicKey,
    signIn: SIGN_IN,
  });
}));

app.post("/api/wishes", wrap(async (req, res) => {
  const { text, people, today } = req.body || {};
  if (!text || !Array.isArray(people) || !people.length) throw fail(400, "Write your wishes and add at least one person first.");
  res.json(await parseWishes({ text: String(text).slice(0, 4000), people, today: today || new Date().toISOString().slice(0, 10) }));
}));

// The owner saves their own name and the join code (so guardians can pass it on to heirs later).
app.post("/api/vault-meta", wrap(async (req, res) => {
  const addr = who(req.body.auth);
  const id = vaultId(req.body.id);
  const { isOwner } = await roleIn(id, addr);
  if (!isOwner) throw fail(403, "Only the owner can do this.");
  const code = normalizeCode(req.body.code);
  if (Number(await amana.vaultByCode(codeHash(code))) !== id) throw fail(400, "That join code doesn't belong to this vault.");
  const meta = (store.meta[id] ||= {});
  meta.ownerName = cleanName(req.body.ownerName);
  meta.code = code;
  meta.names = { ...(meta.names || {}), [addr]: meta.ownerName };
  save();
  res.json({ ok: true });
}));

// What someone holding a join code may see: who invited them and, after a will is opened, the heirs' names.
app.get("/api/invite-info", wrap(async (req, res) => {
  const code = normalizeCode(req.query.code);
  const id = Number(await amana.vaultByCode(codeHash(code)));
  if (!id) throw fail(404, "No Amana uses this code. Check it with the person who gave it to you.");
  const v = await readVault(id);
  const meta = store.meta[id] || {};
  res.json({
    id,
    ownerName: meta.ownerName || "Someone",
    status: v.status,
    opened: v.opened,
    heirs: v.opened && meta.will ? meta.will.heirs.map((h, i) => ({ index: i, name: h.name, claimed: !!v.heirs[i]?.wallet })) : [],
  });
}));

// After their requestJoin transaction, a guardian tells the agent their name. The owner is told what emojis to expect.
app.post("/api/join", wrap(async (req, res) => {
  const addr = who(req.body.auth);
  const id = vaultId(req.body.id);
  if (Number(await amana.vaultByCode(codeHash(req.body.code))) !== id) throw fail(400, "Wrong join code.");
  if ((await amana.joinRequest(id, addr)) === ethers.ZeroHash) throw fail(400, "Your request isn't on-chain yet. Try again in a moment.");
  const meta = (store.meta[id] ||= {});
  const name = cleanName(req.body.name);
  meta.requests = { ...(meta.requests || {}), [addr]: { name, at: Date.now() } };
  meta.names = { ...(meta.names || {}), [addr]: name };
  save();
  const v = await readVault(id);
  agentLog(id, `${name} asked to join as a guardian.`);
  await notify(v.owner, `${name} asked to be your guardian. Before approving, call them and check their screen shows: ${emojiText(addr)}.`, vaultLink(id));
  res.json({ ok: true });
}));

// After their requestClaim transaction, an heir tells the agent. Guardians are asked to confirm with emojis.
app.post("/api/claim", wrap(async (req, res) => {
  const addr = who(req.body.auth);
  const id = vaultId(req.body.id);
  const heir = Number(req.body.heir);
  if (!(await amana.claimRequested(id, heir, addr))) throw fail(400, "Your claim isn't on-chain yet. Try again in a moment.");
  const meta = (store.meta[id] ||= {});
  const name = meta.will?.heirs?.[heir]?.name || "an heir";
  meta.claims = meta.claims || {};
  meta.claims[heir] = { ...(meta.claims[heir] || {}), [addr]: { at: Date.now() } };
  save();
  const v = await readVault(id);
  agentLog(id, `Someone asked to receive ${name}'s share.`);
  for (const g of v.guardians) {
    await notify(g.wallet, `Someone asked to receive ${name}'s share. Only approve after checking with ${name} that their screen shows: ${emojiText(addr)}.`, vaultLink(id));
  }
  res.json({ ok: true });
}));

// Members' view of a vault: names, pending requests and claims, the opened will.
app.get("/api/vault/:id", wrap(async (req, res) => {
  const addr = who(authFrom(req));
  const id = vaultId(req.params.id);
  const { v, isOwner, isGuardian, heir, member } = await roleIn(id, addr);
  if (!member) throw fail(403, "Only people in this Amana can see its details.");
  const meta = store.meta[id] || {};
  const pendingRequests = [];
  if (isOwner) {
    for (const [a, r] of Object.entries(meta.requests || {})) {
      if ((await amana.joinRequest(id, a)) !== ethers.ZeroHash) pendingRequests.push({ wallet: ethers.getAddress(a), name: r.name });
    }
  }
  const claims = [];
  if (isGuardian && v.opened) {
    for (const [h, wallets] of Object.entries(meta.claims || {})) {
      if (v.heirs[h]?.wallet) continue;
      for (const w of Object.keys(wallets)) {
        claims.push({ heir: Number(h), name: meta.will?.heirs?.[h]?.name, wallet: ethers.getAddress(w), approvedByMe: await amana.claimApprovedBy(id, h, w, addr) });
      }
    }
  }
  res.json({
    ownerName: meta.ownerName || null,
    code: isOwner || isGuardian ? meta.code || null : null,
    names: meta.names || {},
    pendingRequests,
    claims,
    will: v.opened && meta.will && (isOwner || isGuardian) ? meta.will.heirs.map((h) => ({ name: h.name, relation: h.relation, shareBps: h.shareBps, unlockAt: h.unlockAt })) : null,
    piecesSent: Object.keys(store.pieces[id] || {}).length,
    sentMyPiece: !!store.pieces[id]?.[addr],
    log: store.log.filter((l) => l.vault === id).slice(0, 40),
    heirIndex: heir ? heir.index : null,
  });
}));

// A guardian's encrypted key piece, as published on-chain when the will was sealed.
app.get("/api/my-piece/:id", wrap(async (req, res) => {
  const addr = who(authFrom(req));
  const id = vaultId(req.params.id);
  const v = await readVault(id);
  if (!v.sealed) throw fail(404, "No will has been sealed yet.");
  const sealed = await readSeal(id, v.sealedAtBlock);
  const i = sealed.guardians.findIndex((g) => lower(g) === addr);
  if (i < 0) throw fail(403, "You weren't a guardian when this will was sealed.");
  res.json({ piece: sealed.keyPieces[i] });
}));

// After a release, guardians send their key piece (re-encrypted for the agent) so the will can be opened.
app.post("/api/key-piece", wrap(async (req, res) => {
  const addr = who(req.body.auth);
  const id = vaultId(req.body.id);
  const v = await readVault(id);
  if (!v.released) throw fail(403, "The will can only be unlocked after the waiting period.");
  const sealed = await readSeal(id, v.sealedAtBlock);
  if (!sealed.guardians.some((g) => lower(g) === addr)) throw fail(403, "You weren't a guardian when this will was sealed.");
  (store.pieces[id] ||= {})[addr] = String(req.body.piece);
  save();
  agentLog(id, `${nameIn(id, addr)} sent their piece of the key (${Object.keys(store.pieces[id]).length} of ${v.plan.threshold} needed).`);
  const opened = await tryOpen(id).catch((e) => { console.error(e); return false; });
  if (opened) tick();
  res.json({ ok: true, opened });
}));

// An heir's letter, once their wallet is approved.
app.get("/api/letter/:id/:heir", wrap(async (req, res) => {
  const addr = who(authFrom(req));
  const id = vaultId(req.params.id);
  const index = Number(req.params.heir);
  const v = await readVault(id);
  const h = v.heirs[index];
  if (!h || lower(h.wallet) !== addr) throw fail(403, "This letter is for someone else.");
  const meta = store.meta[id] || {};
  const w = meta.will?.heirs?.[index] || {};
  res.json({
    ownerName: meta.ownerName || "Your loved one",
    name: w.name, text: w.letter || "",
    shares: v.tokens.map((t) => ({ symbol: t.symbol, amount: ((t.collected * BigInt(h.shareBps)) / 10000n).toString() })),
    unlockAt: h.unlockAt, paid: h.paid, now: await chainNow(),
  });
}));

app.get("/api/inbox", wrap(async (req, res) => {
  const addr = who(authFrom(req));
  res.json({ messages: store.inbox[addr] || [], telegramLinked: !!store.contacts[addr]?.telegramChatId });
}));

app.post("/api/telegram-code", wrap(async (req, res) => {
  if (!config.telegramToken) throw fail(400, "Telegram isn't set up on this Amana server.");
  const addr = who(req.body.auth);
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  store.linkCodes[code] = { address: addr, expires: Date.now() + 15 * 60000 };
  save();
  res.json({ code, bot: botName });
}));

app.get("/api/now", wrap(async (req, res) => res.json({ now: await chainNow() })));

// ── Local demo only ──
if (config.isLocal) {
  app.post("/rpc", wrap(async (req, res) => {
    const r = await fetch(config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
    res.status(r.status).type("json").send(await r.text());
  }));
  app.get("/api/dev/people", wrap(async (req, res) => {
    const file = path.join(config.dataDir, "demo-people.json");
    res.json(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  }));
  app.post("/api/dev/skip", wrap(async (req, res) => {
    const days = Math.max(0, Math.min(400, Number(req.body?.days || 0)));
    await provider.send("evm_increaseTime", [Math.round(days * 86400)]);
    await provider.send("evm_mine", []);
    await tick();
    res.json({ now: await chainNow() });
  }));
}

app.use("/vendor/ethers.umd.min.js", express.static(path.join(ROOT, "agent", "node_modules", "ethers", "dist", "ethers.umd.min.js")));
app.use(express.static(path.join(ROOT, "web")));

app.listen(config.port, async () => {
  console.log(`Amana is running at ${config.appUrl}`);
  console.log(`Chain ${deployment.chainId} · Amana ${deployment.amana} · AI wishes: ${config.anthropicKey ? "Claude" : "basic reader"}`);
  const gas = await provider.getBalance(keeper.address).catch(() => null);
  console.log(`Agent gas wallet: ${keeper.address} (${gas === null ? "balance unknown" : ethers.formatEther(gas) + " BNB"}). Send it a little BNB so it can act.`);
  if (config.telegramToken) {
    try { botName = (await telegram("getMe", {})).username; console.log(`Telegram bot: @${botName}`); } catch (e) { console.error("Telegram:", e.message); }
  }
  await tick();
  setInterval(tick, config.pollSeconds * 1000);
  if (config.telegramToken) setInterval(pollTelegram, 5000);
});
