// Tiny JSON-file database. Fine for a hackathon; swap for a real database before real users.
import fs from "fs";
import path from "path";
import { config } from "./config.js";

const file = path.join(config.dataDir, "store.json");
const empty = () => ({
  contacts: {},   // address(lowercase) -> { name, telegramChatId }
  seen: {},       // vault id -> { status, round, once: {} }
  inbox: {},      // address(lowercase) -> [{ at, text, link }]
  linkCodes: {},  // one-time Telegram link codes -> address
  meta: {},       // vault id -> private details only members see: { ownerName, code, names, requests, claims, will }
  pieces: {},     // vault id -> { guardianAddress: key piece encrypted for the agent } (only accepted after a release)
  log: [],        // [{ at, vault, text }]
});

let db = empty();
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(file)) db = { ...empty(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
} catch (e) {
  console.error("Could not read store, starting empty:", e.message);
}

export const store = db;
export function save() {
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}
export function agentLog(vault, text) {
  db.log.unshift({ at: Date.now(), vault: vault ?? null, text });
  db.log = db.log.slice(0, 500);
  console.log(`[agent] ${vault ? "vault " + vault + " · " : ""}${text}`);
  save();
}
