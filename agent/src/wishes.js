// Turns the owner's wishes, written in their own words, into rules the vault can enforce.
// Uses Claude when ANTHROPIC_API_KEY is set, otherwise a simple built-in reader.
// Either way the owner reviews and edits the rules before anything goes on-chain.
import { config } from "./config.js";

const SYSTEM = `You turn a person's inheritance wishes into strict JSON for a smart contract.
People are identified by Agent IDs such as "mom.ai". Use only the Agent IDs given in the list.
Reply with JSON only, no prose, in this exact shape:
{"heirs":[{"name":"mom.ai","percent":50,"unlockDate":null,"why":"short reason"}],
 "questions":["..."],
 "summary":"one plain sentence"}
Rules:
- percent values are whole numbers that add up to exactly 100. "Half" is 50, "a third" is 33 (put the rounding on the largest share).
- unlockDate is YYYY-MM-DD or null. For "when he turns 25" use the person's birth date if given; if it isn't, set unlockDate null and add a question asking for it.
- If a wish can't be enforced by a contract (for example "use it for trip to Italy"), keep it out of the rules and mention in summary that it belongs in the letter.
- Never invent people, amounts or dates.`;

export async function parseWishes({ text, people, today }) {
  const peopleList = people.map((p) => `- ${p.name}${p.relation ? ` (${p.relation})` : ""}${p.birthDate ? `, born ${p.birthDate}` : ""}`).join("\n");
  let result, engine;
  if (config.anthropicKey) {
    result = await askClaude(`Today is ${today}.\nPeople:\n${peopleList}\n\nWishes:\n"""${text}"""`);
    engine = "claude";
  } else {
    result = basicReader(text, people, today);
    engine = "basic";
  }
  return { ...validate(result, people), engine };
}

async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.anthropicKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: 1200, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const textOut = body.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const json = textOut.slice(textOut.indexOf("{"), textOut.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

// Handles the common patterns: "50% to mom", "half to my mother (mom)", "when he turns 25", "up to 400 a month".
function basicReader(text, people, today) {
  const sentences = text.split(/(?<=[.!?;\n])\s+/);
  const heirs = [];
  const questions = [];
  // Each sentence is about the person it names; failing that, the one whose relation matches best
  // ("little brother" beats "brother").
  const has = (s, w) => new RegExp(`\\b${escape(w.toLowerCase())}\\b`, "i").test(s);
  for (const s of sentences) {
    let p = null, best = 0;
    for (const cand of people) {
      const score = has(s, cand.name.replace(/\.ai$/, "")) ? 1000 : cand.relation && has(s, cand.relation) ? cand.relation.length : 0;
      if (score > best) { best = score; p = cand; }
    }
    if (!p) continue;
    const pct = s.match(/(\d{1,3})\s*(%|percent)/i);
    const percent = pct ? Number(pct[1]) : /\bhalf\b/i.test(s) ? 50 : /\ba third\b/i.test(s) ? 33 : null;
    if (percent == null || heirs.some((h) => h.name === p.name)) continue;
    let unlockDate = null;
    const age = s.match(/turns?\s+(\d{1,3})/i);
    if (age) {
      if (p.birthDate) {
        const b = new Date(p.birthDate + "T00:00:00Z");
        b.setUTCFullYear(b.getUTCFullYear() + Number(age[1]));
        unlockDate = b.toISOString().slice(0, 10);
      } else questions.push(`What is ${p.name}'s birth date? It's needed to know when they turn ${age[1]}.`);
    }
    heirs.push({ name: p.name, percent, unlockDate, why: s.trim() });
  }
  return { heirs, questions, summary: "Read with Amana's basic reader. Please check every rule." };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function validate(r, people) {
  const known = new Set(people.map((p) => p.name));
  const problems = [];
  const heirs = (r.heirs || []).filter((h) => {
    if (!known.has(h.name)) { problems.push(`Ignored ${h.name}: not in your list of people.`); return false; }
    return true;
  }).map((h) => ({ name: h.name, percent: Math.round(Number(h.percent)), unlockDate: h.unlockDate || null, why: h.why || "" }));
  const total = heirs.reduce((a, h) => a + h.percent, 0);
  if (heirs.length && total !== 100) problems.push(`Shares add up to ${total}%, not 100%. Adjust them below.`);
  if (!heirs.length) problems.push("No heirs found. Name who gets what, for example “50% to mom”.");
  return { heirs, questions: [...(r.questions || []), ...problems], summary: r.summary || "" };
}
