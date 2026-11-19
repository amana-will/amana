// The agent's main loop. Every few seconds it reads every vault and acts on what changed.
// It uses chain time, so local "skip days" demos work. Names come from the agent's private
// records (never from the chain), so messages say "yassine.ai" while the chain only sees wallets.
import { config } from "./config.js";
import { store, save, agentLog } from "./store.js";
import { notify } from "./notify.js";
import { allVaultIds, readVault, amana, chainNow, keeper, fmtTokens } from "./chain.js";
import { tryOpen } from "./opener.js";
import { emojisFor } from "./seal.js";

const DAY = 86400;
const date = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
export const vaultLink = (id) => `${config.appUrl}/#/vault/${id}`;
export const emojiText = (addr) => emojisFor(addr).map((e) => `${e.emoji} ${e.name}`).join(", ");
export const nameIn = (id, addr) => store.meta[id]?.names?.[addr?.toLowerCase()] || (addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "someone");

let running = false;
export async function tick() {
  if (running) return;
  running = true;
  try {
    const now = await chainNow();
    for (const id of await allVaultIds()) {
      try { await handle(id, now); } catch (e) { console.error(`Vault ${id}:`, e.shortMessage || e.message); }
    }
  } catch (e) {
    console.error("Tick failed:", e.shortMessage || e.message);
  } finally {
    running = false;
  }
}

async function handle(id, now) {
  const v = await readVault(id);
  const seen = (store.seen[id] ||= { status: null, round: null, once: {} });
  const meta = (store.meta[id] ||= {});
  const who = meta.ownerName || "Your loved one";
  const once = (key) => (seen.once[key] ? false : (seen.once[key] = true));
  const link = vaultLink(id);
  const guardians = v.guardians.map((g) => g.wallet);

  if (seen.status === null) agentLog(id, `Now watching vault #${id}.`);

  for (const g of guardians) {
    if (once(`guardian:${g}`)) {
      agentLog(id, `${nameIn(id, g)} is now a guardian.`);
      await notify(g, `You're now ${who}'s guardian. Amana will only contact you if ${who} stops checking in.`, link);
    }
  }

  if (v.sealed && !v.sealCurrent && guardians.length >= v.plan.threshold && once(`reseal:${v.round}`)) {
    await notify(v.owner, "Your guardians changed. Please re-seal your will so every guardian holds a piece of its key.", link);
  }

  if (seen.status !== null && (seen.status !== v.status || seen.round !== v.round)) {
    const prev = seen.status;
    switch (v.status) {
      case "Active":
        if (["Alert", "Pending"].includes(prev)) {
          agentLog(id, `${who} is okay again. Told the guardians.`);
          for (const g of guardians) await notify(g, `Good news: ${who} is okay. Nothing more is needed from you.`, link);
        }
        if (prev === "Pending") await notify(v.owner, "Your check-in cancelled the release. Everything is back to normal.", link);
        break;
      case "Alert": {
        const days = Math.floor((now - v.lastCheckIn) / DAY);
        agentLog(id, `${who} hasn't answered 3 reminders. Asked the guardians.`);
        await notify(v.owner, "You didn't answer your reminders, so your guardians are being asked about you. Tap “I'm fine” to stop this.", link);
        for (const g of guardians) {
          await notify(g, `${who} hasn't checked in for ${days} days and didn't answer 3 reminders. Do you know if they're okay? ${v.plan.threshold} guardians must agree before anything happens.`, link);
        }
        break;
      }
      case "Pending":
        agentLog(id, `Guardians reported ${who}'s passing. Release on ${date(v.releaseAt)} unless they check in.`);
        await notify(v.owner, `URGENT: your guardians reported that you passed away. If you're alive, tap “I'm fine” before ${date(v.releaseAt)} to cancel.`, link);
        for (const g of guardians) await notify(g, `We're so sorry. ${who}'s will can be opened on ${date(v.releaseAt)}. Until then ${who} can still cancel.`, link);
        seen.lastPing = now;
        break;
      case "Released":
        agentLog(id, `The waiting period is over. Collected ${fmtTokens(v.tokens)} from ${who}'s wallet for the heirs.`);
        for (const g of guardians) await notify(g, `It's time to open ${who}'s will. Please open Amana and tap “Unlock the will”. ${v.plan.threshold} guardians are needed.`, link);
        break;
    }
  }

  // Three reminders, one week apart, before the guardians are asked.
  if (v.status === "Reminder") {
    const stage = Math.min(2, Math.floor((now - v.lastCheckIn - v.plan.checkInInterval) / (7 * DAY)));
    for (let s = 0; s <= stage; s++) {
      if (once(`remind:${v.round}:${s}`)) {
        const askAt = v.lastCheckIn + v.plan.checkInInterval + v.plan.gracePeriod;
        const text = ["It's time for your Amana check-in. Are you okay? Tap “I'm fine”.",
          "Second reminder: please tap “I'm fine” in Amana.",
          `Last reminder: if you don't tap “I'm fine” by ${date(askAt)}, your guardians will be asked about you.`][s];
        agentLog(id, `Sent reminder ${s + 1} of 3.`);
        await notify(v.owner, text, link);
      }
    }
  }

  // While Pending, remind the owner in case it's a mistake: daily for the first week, then weekly.
  const pingEvery = now - (v.releaseAt - v.plan.cancelWindow) < 7 * DAY ? DAY : 7 * DAY;
  if (v.status === "Pending" && now - (seen.lastPing || 0) >= pingEvery) {
    seen.lastPing = now;
    await notify(v.owner, `Reminder: your will can be opened on ${date(v.releaseAt)}. If you're alive, tap “I'm fine”.`, link);
  }

  if (v.status === "Pending" && now >= v.releaseAt && keeper) {
    const tx = await amana.finalize(id);
    await tx.wait();
    agentLog(id, `The waiting period ended with no check-in. Released the vault (tx ${tx.hash.slice(0, 10)}…).`);
  }

  if (v.released && !(v.opened && meta.will)) {
    if (await tryOpen(id)) {
      const list = meta.will.heirs.map((h) => `${h.name} (${h.shareBps / 100}%)`).join(", ");
      for (const g of guardians) {
        await notify(g, `${who}'s will is open. It names: ${list}. Please tell each of them gently, and ask them to open Amana with the join code ${meta.code || "you received"} and tap “I'm an heir”. You'll then confirm their wallet with matching emojis.`, link);
      }
    }
  }

  if (v.opened) {
    for (const h of v.heirs) {
      const w = meta.will?.heirs?.[h.index];
      if (h.wallet && once(`bound:${h.index}`)) {
        meta.names = { ...(meta.names || {}), [h.wallet.toLowerCase()]: w?.name || "heir" };
        const locked = h.unlockAt > now ? ` It's kept safe until ${date(h.unlockAt)}, as ${who} wished.` : "";
        await notify(h.wallet, `${who} left you something, and a letter.${locked}`, `${config.appUrl}/#/letter/${id}/${h.index}`);
      }
      if (h.wallet && !h.paid && h.unlockAt <= now && keeper) {
        const tx = await amana.payout(id, h.index);
        await tx.wait();
        agentLog(id, `Sent ${w?.name || "an heir"} their share (tx ${tx.hash.slice(0, 10)}…).`);
      }
      if (h.paid && once(`paid:${h.index}`)) {
        await notify(h.wallet, `What ${who} left you has arrived in your wallet.`, `${config.appUrl}/#/letter/${id}/${h.index}`);
      }
    }
  }

  seen.status = v.status;
  seen.round = v.round;
  save();
}
