// Delivers the agent's messages. Every message lands in the person's Amana inbox (shown in the web app).
// If the person linked Telegram, it is also sent there.
import { config } from "./config.js";
import { store, save } from "./store.js";

export async function notify(address, text, link) {
  const key = address.toLowerCase();
  (store.inbox[key] ||= []).unshift({ at: Date.now(), text, link: link || null });
  store.inbox[key] = store.inbox[key].slice(0, 100);
  save();

  const chatId = store.contacts[key]?.telegramChatId;
  if (config.telegramToken && chatId) {
    try {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: link ? `${text}\n\n${link}` : text,
        disable_web_page_preview: true,
      });
    } catch (e) {
      console.error("Telegram send failed:", e.message);
    }
  }
}

export async function telegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || "Telegram error");
  return json.result;
}

// Lets people link Telegram: the web app gives them a one-time code after they sign with their wallet,
// they send "/start CODE" to the bot, and the bot remembers their chat.
let offset = 0;
export async function pollTelegram() {
  if (!config.telegramToken) return;
  try {
    const updates = await telegram("getUpdates", { offset, timeout: 0 });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      const m = msg?.text?.match(/^\/start\s+([A-Z0-9]{6})$/i);
      if (!m) {
        if (msg?.chat?.id) await telegram("sendMessage", { chat_id: msg.chat.id, text: "Hi, I'm Amana. To get alerts here, open the Amana app, tap “Link Telegram” and send me the code it shows." });
        continue;
      }
      const entry = store.linkCodes[m[1].toUpperCase()];
      if (!entry || entry.expires < Date.now()) {
        await telegram("sendMessage", { chat_id: msg.chat.id, text: "That code has expired. Get a new one in the Amana app." });
        continue;
      }
      delete store.linkCodes[m[1].toUpperCase()];
      (store.contacts[entry.address] ||= {}).telegramChatId = msg.chat.id;
      save();
      await telegram("sendMessage", { chat_id: msg.chat.id, text: "Linked. Amana will message you here." });
    }
  } catch (e) {
    console.error("Telegram poll failed:", e.message);
  }
}
