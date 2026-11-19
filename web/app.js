/* Amana web app: plain JavaScript + ethers v6 + Amana's sealing toolkit (lib/seal.js).
   Screens are routed on the URL hash:
   #/               home: my vaults and my messages
   #/create         set up a new Amana
   #/join           enter a join code: ask to be a guardian, or claim as an heir
   #/vault/<id>     one vault, with what the viewer is allowed to do
   #/will/<id>      the owner writes and seals their will
   #/letter/<id>/<heir>  an heir's letter and share
*/
const E = ethers;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const STATUS = ["Active", "Reminder", "Alert", "Pending", "Released"];
const VOTE_LABEL = ["no answer yet", "says okay", "says passed away"];
const DAY = 86400;
const ZERO = E.ZeroAddress;

let CFG, provider, signer = null, me = null;
let demoPeople = {};   // local demo only: Agent ID -> address
let auth = null;       // { address, ts, sig } — one sign-in per session
let routeSeq = 0;
let S = null;          // sealing toolkit, loaded on first use
const seal = async () => (S ||= await import("/lib/seal.js"));

// ───────── helpers ─────────
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let toastTimer;
function toast(msg, err) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = err ? "err" : "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.textContent = ""), err ? 9000 : 5000);
}
const amt = (wei, symbol) => Number(E.formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 }) + " " + symbol;
const symbolOf = (addr) => CFG.tokens.find((t) => same(t.address, addr))?.symbol || short(addr);
const amounts = (list, pick) => list.filter((t) => pick(t) > 0n).map((t) => amt(pick(t), t.symbol)).join(" + ") || "nothing yet";
const date = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const tag = (name) => `<span class="name">${esc(name)}</span>`;
const chainNow = async () => (await api("/api/now")).now;
const chainName = () => (CFG.chainId === 56 ? "BNB Chain" : CFG.chainId === 97 ? "BNB Chain Testnet" : "Local test chain");
const days = (secs) => Math.round(secs / DAY);

const amanaC = (w) => new E.Contract(CFG.amana, CFG.abi.amana, w ? signer : provider);
const erc20 = (addr, w) => new E.Contract(addr, CFG.abi.token, w ? signer : provider);
const aidC = (w) => new E.Contract(CFG.agentId, CFG.abi.agentId, w ? signer : provider);

const normalizeCode = (c) => {
  let s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s.startsWith("AMANA")) s = "AMANA" + s;
  return s;
};
const prettyCode = (c) => { const s = normalizeCode(c).slice(5); return "AMANA-" + s.match(/.{1,4}/g).join("-"); };
const codeHash = (c) => E.keccak256(E.toUtf8Bytes(normalizeCode(c)));
function newCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "AMANA" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
// Must match the contract's openWill and agent/src/chain.js.
const willHash = (id, shares, unlocks, salt) => E.keccak256(E.AbiCoder.defaultAbiCoder().encode(["uint256", "uint16[]", "uint64[]", "bytes32"], [id, shares, unlocks, salt]));

const ERRORS = {
  NoAgentId: "This wallet doesn't hold an Agent ID yet. Claim one in the Binance App: Wallet > homepage banner > Agent ID.",
  NotOwner: "Only the vault's owner can do this.",
  NotAllowed: "This wallet isn't allowed to do that.",
  NoSuchVault: "That vault doesn't exist.",
  CodeTaken: "That join code is already used. Try again.",
  AlreadyReleased: "This will has already been carried out.",
  WrongStatus: "That isn't possible at this stage.",
  NoRequest: "There's no request from that wallet.",
  WillMismatch: "That isn't the will that was sealed.",
  StillLocked: "This share is still locked.",
  AlreadyPaid: "This share was already paid.",
};
function explain(e) {
  const r = e?.revert || e?.info?.error?.revert;
  if (r?.name === "BadPlan") return r.args[0][0].toUpperCase() + r.args[0].slice(1) + ".";
  if (r?.name && ERRORS[r.name]) return ERRORS[r.name];
  if (e?.code === "ACTION_REJECTED") return "You cancelled in your wallet.";
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

async function send(fn, done) {
  if (!signer) { toast("Connect your wallet first.", true); throw new Error("not connected"); }
  try {
    toast(CFG.isLocal ? "Sending…" : "Confirm in your wallet…");
    const tx = await fn();
    toast("Waiting for the network…");
    const rc = await tx.wait();
    if (done) toast(done);
    return rc;
  } catch (e) {
    toast(explain(e), true);
    throw e;
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied."); }
  catch { toast("Couldn't copy. Press and hold the code to copy it.", true); }
}

function emojiRow(list) {
  return `<div class="emojis">${list.map((e) => `<span><b>${e.emoji}</b><small>${esc(e.name)}</small></span>`).join("")}</div>`;
}

// ───────── wallet & sign-in ─────────
async function boot() {
  CFG = await api("/api/config");
  if (CFG.isLocal) {
    provider = new E.JsonRpcProvider(location.origin + "/rpc", CFG.chainId, { staticNetwork: true });
    demoPeople = await api("/api/dev/people");
    let pick = "yassine.ai";
    try { pick = localStorage.getItem("amana-demo-as") || pick; } catch {}
    await actAs(demoPeople[pick] ? pick : Object.keys(demoPeople)[0]);
  } else {
    // Read the chain through a public node; the wallet is only used to sign. Never wait on the wallet to show the page.
    provider = new E.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
  }
  renderAccount();
  await renderDemoBar();
  window.addEventListener("hashchange", route);
  route();
  if (!CFG.isLocal && window.ethereum) {
    const accts = await withTimeout(window.ethereum.request({ method: "eth_accounts" }), 4000).catch(() => []);
    if (accts?.length) await connect(true);
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Your wallet didn't answer. Open it, unlock it, and try again.")), ms))]);

async function actAs(name) {
  if (!demoPeople[name]) return;
  me = E.getAddress(demoPeople[name]);
  signer = await provider.getSigner(me);
  auth = null;
  try { localStorage.setItem("amana-demo-as", name); } catch {}
}

async function connect(silent) {
  if (!window.ethereum) return toast("No wallet found. Open Amana in the Binance Wallet app's browser.", true);
  try {
    const bp = new E.BrowserProvider(window.ethereum);
    if (!silent) await withTimeout(bp.send("eth_requestAccounts", []), 120000);
    const chainId = Number(await withTimeout(window.ethereum.request({ method: "eth_chainId" }), 8000));
    if (chainId !== CFG.chainId) {
      try { await withTimeout(bp.send("wallet_switchEthereumChain", [{ chainId: "0x" + CFG.chainId.toString(16) }]), 60000); }
      catch { toast(`Switch your wallet to ${chainName()} and reload.`, true); return; }
    }
    signer = await new E.BrowserProvider(window.ethereum).getSigner();
    me = await signer.getAddress();
    renderAccount();
    route();
  } catch (e) {
    if (!silent) toast(explain(e), true);
  }
}

/** One signature per session lets the agent show this wallet its private details. */
async function signIn() {
  if (auth && same(auth.address, me)) return auth;
  const key = `amana-auth-${me}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (saved && Date.now() - saved.ts < 6 * 86400000) return (auth = saved);
  } catch {}
  const ts = Date.now();
  const sig = await signer.signMessage(`${CFG.signIn}\n${E.getAddress(me)}\n${ts}`);
  auth = { address: me, ts, sig };
  try { sessionStorage.setItem(key, JSON.stringify(auth)); } catch {}
  return auth;
}
const authQuery = async () => new URLSearchParams(await signIn()).toString();

/** The guardian's private key, derived from a wallet signature. Same wallet, same key. */
async function guardianKeypair(checkStable) {
  const lib = await seal();
  const sig1 = await signer.signMessage(lib.KEY_MESSAGE);
  if (checkStable) {
    const sig2 = await signer.signMessage(lib.KEY_MESSAGE);
    if (sig1 !== sig2) throw new Error("This wallet signs differently each time, so it can't hold a piece of a sealed will. Try the Binance Wallet app.");
  }
  return lib.keypairFromSignature(sig1);
}

function renderAccount() {
  const el = $("#account");
  if (!me) {
    el.innerHTML = CFG.isLocal ? "" : `<button class="primary" id="connect" type="button">Connect wallet</button>`;
    $("#connect")?.addEventListener("click", () => connect(false));
    return;
  }
  const name = Object.entries(demoPeople).find(([, a]) => same(a, me))?.[0];
  el.innerHTML = `<span class="small muted">You are</span> ${tag(name || short(me))}`;
}

async function renderDemoBar() {
  if (!CFG.isLocal) return;
  const bar = $("#demobar");
  bar.hidden = false;
  const now = await chainNow();
  bar.innerHTML = `
    <span class="small">Demo chain · <strong>${date(now)}</strong></span>
    <span class="row">
      <label class="row" style="font-weight:500" for="actas">Act as
        <select id="actas">${Object.keys(demoPeople).map((n) => `<option ${same(demoPeople[n], me) ? "selected" : ""}>${n}</option>`).join("")}</select>
      </label>
      <button type="button" id="skip7">+7 days</button>
      <button type="button" id="skip30">+30 days</button>
      <button type="button" id="skip90">+90 days</button>
    </span>`;
  $("#actas").onchange = async (e) => { await actAs(e.target.value); renderAccount(); route(); };
  const skip = async (d) => {
    await post("/api/dev/skip", { days: d });
    toast(`Skipped ${d} days. The agent has checked every vault.`);
    await renderDemoBar();
    route();
  };
  $("#skip7").onclick = () => skip(7);
  $("#skip30").onclick = () => skip(30);
  $("#skip90").onclick = () => skip(90);
}

const hasAgentId = async (addr) => (await aidC().balanceOf(addr)) > 0n;

// ───────── data ─────────
async function readVault(id) {
  const a = amanaC();
  const [v, guardians, heirs, status, cov] = await Promise.all([a.getVault(id), a.guardians(id), a.heirs(id), a.status(id), a.coverage(id)]);
  const tokenList = [...cov[0]];
  const collected = v.released ? await Promise.all(tokenList.map((t) => a.collected(id, t))) : tokenList.map(() => 0n);
  const votes = await Promise.all(guardians.map((g) => a.voteOf(id, v.round, g)));
  return {
    id, status: STATUS[Number(status)], round: v.round, owner: v.owner,
    plan: {
      interval: Number(v.plan.checkInInterval), grace: Number(v.plan.gracePeriod), threshold: Number(v.plan.threshold),
      window: Number(v.plan.cancelWindow),
    },
    tokens: tokenList.map((t, i) => ({ address: t, symbol: symbolOf(t), coverage: cov[1][i], collected: collected[i] })),
    guardians: guardians.map((g, i) => ({ wallet: g, vote: Number(votes[i]) })),
    heirs: heirs.map((h, i) => ({ index: i, shareBps: Number(h.shareBps), unlockAt: Number(h.unlockAt), wallet: h.wallet === ZERO ? null : h.wallet, paid: h.paid })),
    sealed: v.willHash !== E.ZeroHash, sealCurrent: v.sealCurrent, released: v.released, opened: v.opened,
    lastCheckIn: Number(v.lastCheckIn), releaseAt: Number(v.releaseAt),
  };
}

function statusInfo(v, isOwner, ownerName) {
  const n = ownerName || "The owner";
  const nextDue = v.lastCheckIn + v.plan.interval;
  const askedAt = nextDue + v.plan.grace;
  return {
    Active: { tone: "good", label: "All good", text: `Next check-in by ${date(nextDue)}.` },
    Reminder: { tone: "warn", label: "Check-in due", text: isOwner ? `It's time to check in. If you don't by ${date(askedAt)}, your guardians will be asked about you.` : `${n}'s check-in is due. Guardians are asked on ${date(askedAt)} if there's no answer.` },
    Alert: { tone: "warn", label: "Guardians asked", text: isOwner ? "Your guardians are checking on you. Tap “I'm fine” to stop this." : `${n} didn't answer 3 reminders. The guardians are asked if they're okay.` },
    Pending: { tone: "bad", label: "Release scheduled", text: isOwner ? `Your guardians reported your passing. Your will can be opened on ${date(v.releaseAt)} unless you check in.` : `${n}'s will can be opened on ${date(v.releaseAt)}. Until then ${n} can still cancel.` },
    Released: { tone: "neutral", label: v.opened ? "Will opened" : "Waiting to open the will", text: `Amana collected ${amounts(v.tokens, (t) => t.collected)} from ${n}'s wallet. ` + (v.opened ? "The will was opened and checked. Heirs receive their share once guardians confirm them." : `The guardians are unlocking the will (${v.plan.threshold} needed).`) },
  }[v.status];
}
const toneClass = (t) => ({ good: "t-good", warn: "t-warn", bad: "t-bad", neutral: "t-neutral" })[t];

// ───────── router ─────────
async function route() {
  const seq = ++routeSeq;
  const view = new Proxy($("#view"), {
    set(target, prop, value) { if (seq === routeSeq) target[prop] = value; return true; },
    get(target, prop) { const v = target[prop]; return typeof v === "function" ? v.bind(target) : v; },
  });
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (parts[0] === "create") return await createView(view);
    if (parts[0] === "join") return await joinView(view);
    if (parts[0] === "vault") return await vaultView(view, Number(parts[1]));
    if (parts[0] === "will") return await willView(view, Number(parts[1]));
    if (parts[0] === "letter") return await letterView(view, Number(parts[1]), Number(parts[2]));
    return await homeView(view);
  } catch (e) {
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(explain(e))}</p><a class="btn" href="#/">Back home</a></div>`;
  }
}

function needAgentIdCard() {
  return `<div class="card">
    <h2>You need an Agent ID</h2>
    <p>Amana works with Binance Agent IDs. Your .ai name is how your family knows it's really you.</p>
    <p class="small muted">Claim yours for free in the Binance App: Wallet > homepage banner > Agent ID. Then open Amana from that same Agentic Wallet.</p>
    ${CFG.agentIdIsMock ? `<button type="button" id="mintAid">Get a test Agent ID (${chainName()} only)</button>` : ""}
  </div>`;
}
const bindMintAid = () => $("#mintAid")?.addEventListener("click", () => send(() => aidC(true).mint(me), "Test Agent ID added.").then(route));

function connectCard(text) {
  return `<div class="card"><p>${text}</p>${window.ethereum ? `<button class="primary big" type="button" id="connect2">Connect wallet</button>` : `<p class="warnbox">Open this page in the Binance Wallet app's browser to continue.</p>`}</div>`;
}

// ───────── home ─────────
async function homeView(view) {
  if (!me) {
    view.innerHTML = `
      <div class="card">
        <h1>If something happens to you, Amana keeps your promises.</h1>
        <p>Your money stays in your wallet. You check in once every 3 months. If you stop answering, the people you trust are asked first. Only when they agree is your sealed will opened, and each person receives their share of what's left, with a letter from you.</p>
        <ul class="list small">
          <li><span>Your money never moves while you're alive</span></li>
          <li><span>Private: no names on the blockchain, and your will stays sealed</span></li>
          <li><span>A false alarm? You have 6 months to cancel</span></li>
        </ul>
      </div>
      ${connectCard("Connect the Agentic Wallet that holds your Agent ID.")}`;
    $("#connect2")?.addEventListener("click", () => connect(false));
    return;
  }
  view.innerHTML = `<p class="muted">Loading…</p>`;
  const [ids, aid] = await Promise.all([amanaC().vaultsOf(me), hasAgentId(me)]);
  const unique = [...new Set(ids.map(Number))];
  const vaults = await Promise.all(unique.map(readVault));
  const owned = vaults.some((v) => same(v.owner, me));
  const metas = await Promise.all(vaults.map((v) => authQuery().then((q) => api(`/api/vault/${v.id}?${q}`)).catch(() => ({}))));

  view.innerHTML = `
    ${!aid ? needAgentIdCard() : `
    <div class="card">
      <div class="grid2">
        ${owned ? "" : `<a class="btn primary big" href="#/create" style="text-align:center">Create my Amana</a>`}
        <a class="btn big" href="#/join" style="text-align:center">I have a join code</a>
      </div>
    </div>`}
    <div class="card">
      <div class="row between"><h2>Your Amanas</h2></div>
      ${vaults.length ? `<ul class="list">${vaults.map((v, i) => {
        const s = statusInfo(v, same(v.owner, me), metas[i].ownerName);
        const role = same(v.owner, me) ? "Yours" : v.guardians.some((g) => same(g.wallet, me)) ? "Guardian" : "Heir";
        return `<li><a href="#/vault/${v.id}"><strong>${esc(metas[i].ownerName || "Vault #" + v.id)}</strong></a><span class="small muted">${role}</span><span class="pill ${toneClass(s.tone)}">${s.label}</span></li>`;
      }).join("")}</ul>` : `<p class="muted">None yet.</p>`}
      ${CFG.tokens.some((t) => t.mock) ? `<button type="button" id="mint">Get 5,000 test ${esc(CFG.tokens[0].symbol)}</button>` : ""}
    </div>
    <div class="card" id="inbox">
      <div class="row between"><h2>Messages from Amana</h2><button type="button" id="openInbox">Show messages</button></div>
      <p class="small muted">Reminders, guardian requests and letters arrive here${CFG.telegramBot ? " and on Telegram" : ""}.</p>
    </div>`;
  bindMintAid();
  $("#mint")?.addEventListener("click", () => send(() => erc20(CFG.tokens[0].address, true).mint(me, E.parseUnits("5000", 18)), "Test coins added.").then(route));
  $("#openInbox").onclick = () => loadInbox();
  if (CFG.isLocal || auth) loadInbox();
}

async function loadInbox() {
  const box = $("#inbox");
  try {
    const forWhom = me;
    const { messages, telegramLinked } = await api("/api/inbox?" + (await authQuery()));
    if (!same(forWhom, me) || !document.contains(box)) return;
    box.innerHTML = `
      <div class="row between"><h2>Messages from Amana</h2>
      ${CFG.telegramBot && !telegramLinked ? `<button type="button" id="tg">Get these on Telegram</button>` : telegramLinked ? `<span class="small muted">Telegram linked</span>` : ""}</div>
      ${messages.length ? `<ul class="log">${messages.map((m) => `<li><time>${new Date(m.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</time><span>${esc(m.text)}${m.link ? ` <a href="${esc(m.link.replace(/^https?:\/\/[^/]+\/?/, "/"))}">Open</a>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">No messages yet.</p>`}`;
    $("#tg")?.addEventListener("click", async () => {
      try {
        const r = await post("/api/telegram-code", { auth: await signIn() });
        box.insertAdjacentHTML("beforeend", `<p class="okbox">Open Telegram, find <strong>@${esc(r.bot)}</strong> and send: <strong>/start ${esc(r.code)}</strong> (valid 15 minutes).</p>`);
      } catch (e) { toast(explain(e), true); }
    });
  } catch (e) {
    toast(explain(e), true);
  }
}

// ───────── create ─────────
async function createView(view) {
  if (!me) { location.hash = "#/"; return; }
  if (!(await hasAgentId(me))) { view.innerHTML = needAgentIdCard(); bindMintAid(); return; }
  const myDemoName = Object.entries(demoPeople).find(([, a]) => same(a, me))?.[0] || "";
  view.innerHTML = `
    <div class="card">
      <h1>Create your Amana</h1>
      <p class="small muted">Nothing here is written on the blockchain with your name. Your name stays private, shown only to the people you approve.</p>
      <label for="myName">Your Agent ID<input id="myName" value="${esc(myDemoName)}" placeholder="yourname.ai"></label>
    </div>
    <div class="card">
      <h2>Your safety settings</h2>
      <div class="grid2">
        <label>Check in every (days)<input id="interval" type="number" min="1" value="90"></label>
        <label>Reminder time before guardians are asked (days)<input id="grace" type="number" min="1" value="21"></label>
        <label>Guardians who must agree<input id="threshold" type="number" min="1" max="7" value="2"></label>
        <label>Days to cancel after a reported passing<input id="window" type="number" min="1" value="180"></label>
      </div>
      <p class="small muted">With these settings: you check in every 3 months. If you miss it, Amana reminds you 3 times over 3 weeks. Then your guardians are asked. If 2 of them agree you've passed away, you still have 6 months to cancel before anything happens.</p>
    </div>
    <div class="card">
      <h2>What your will covers</h2>
      <p class="small muted">Your money stays in your wallet. Choose which coins your will covers. Next, you'll confirm each one.</p>
      <div class="stack">${CFG.tokens.map((t, i) => `<label class="row" style="font-weight:500"><input type="checkbox" data-token="${t.address}" ${i < 2 ? "checked" : ""} style="width:auto"> ${esc(t.symbol)}</label>`).join("")}</div>
      ${CFG.chainId === 56 ? `<p class="small muted">Plain BNB can't be covered: wrap it as WBNB first. Money on the Binance exchange isn't in your wallet, so it isn't covered.</p>` : ""}
    </div>
    <div class="card">
      <button type="button" id="create" class="primary big">Create my Amana</button>
      <p class="small muted">Next, you'll invite your guardians, write your will, seal it and set your limits.</p>
    </div>`;
  $("#create").onclick = async () => {
    const name = $("#myName").value.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,63}\.ai$/.test(name)) return toast("Write your Agent ID, like yassine.ai.", true);
    const plan = {
      checkInInterval: Math.round(Number($("#interval").value) * DAY),
      gracePeriod: Math.round(Number($("#grace").value) * DAY),
      threshold: Number($("#threshold").value),
      cancelWindow: Math.round(Number($("#window").value) * DAY),
    };
    const covered = $$("[data-token]").filter((c) => c.checked).map((c) => c.dataset.token);
    if (!covered.length) return toast("Choose at least one coin.", true);
    const code = newCode();
    try {
      const rc = await send(() => amanaC(true).createVault(codeHash(code), plan, covered), "Your Amana is created.");
      const iface = new E.Interface(CFG.abi.amana);
      const id = Number(rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "VaultCreated").args.id);
      try { localStorage.setItem(`amana-code-${CFG.amana}-${id}`, code); } catch {}
      await post("/api/vault-meta", { id, ownerName: name, code, auth: await signIn() });
      location.hash = "#/vault/" + id;
    } catch (e) {
      if (!$("#toast").textContent) toast(explain(e), true);
    }
  };
}

// ───────── join with a code ─────────
async function joinView(view) {
  if (!me) { view.innerHTML = connectCard("Connect the Agentic Wallet that holds your Agent ID."); $("#connect2")?.addEventListener("click", () => connect(false)); return; }
  if (!(await hasAgentId(me))) { view.innerHTML = needAgentIdCard(); bindMintAid(); return; }
  view.innerHTML = `
    <div class="card">
      <h1>Enter your join code</h1>
      <p class="small muted">Someone who trusts you gave you a code like AMANA-7K3Q-X9PD-M2TA, in person or by phone.</p>
      <label for="code">Join code<input id="code" placeholder="AMANA-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters"></label>
      <button type="button" id="look" class="primary">Continue</button>
    </div>
    <div id="joinStep"></div>`;
  $("#look").onclick = async () => {
    const code = normalizeCode($("#code").value);
    if (code.length < 17) return toast("That code looks too short. Check it with the person who gave it to you.", true);
    try {
      const info = await api("/api/invite-info?code=" + code);
      const box = $("#joinStep");
      const emojis = (await seal()).emojisFor(me);
      if (info.opened) {
        box.innerHTML = `
          <div class="card">
            <h2>${esc(info.ownerName)}'s will has been opened</h2>
            <p>If you're named in it, choose your name. The guardians will confirm it's you.</p>
            <div class="stack">${info.heirs.map((h) => `<button type="button" data-heir="${h.index}" ${h.claimed ? "disabled" : ""}>I'm ${esc(h.name)}${h.claimed ? " (already confirmed)" : ""}</button>`).join("")}</div>
          </div>`;
        $$("[data-heir]").forEach((b) => b.addEventListener("click", async () => {
          const heir = Number(b.dataset.heir);
          await send(() => amanaC(true).requestClaim(info.id, heir), "Request sent.");
          await post("/api/claim", { id: info.id, heir, auth: await signIn() });
          box.innerHTML = `<div class="card"><h2>Almost there</h2><p>The guardians have been told. When one of them calls you, read them these three pictures from your screen:</p>${emojiRow(emojis)}<p class="small muted">Once they confirm, Amana sends you what ${esc(info.ownerName)} left you, with their letter.</p></div>`;
        }));
        return;
      }
      if (info.status === "Released") { box.innerHTML = `<div class="card"><p>${esc(info.ownerName)}'s will is being unlocked by the guardians. Come back soon.</p></div>`; return; }
      box.innerHTML = `
        <div class="card">
          <span class="step">Invitation</span>
          <h2>${esc(info.ownerName)} trusts you</h2>
          <p>${esc(info.ownerName)} wants you as a guardian. Amana will only ask you about them if they stop checking in. You'd answer one question: are they okay, in hospital, or gone? Nothing happens unless enough guardians agree.</p>
          <p class="small">You'll also hold one piece of the key to their sealed will. Nobody can open it alone.</p>
          <label for="myName">Your Agent ID<input id="myName" placeholder="yourname.ai" value="${esc(Object.entries(demoPeople).find(([, a]) => same(a, me))?.[0] || "")}"></label>
          <p class="small muted">Your wallet will ask you to sign twice. That creates your private guardian key on this device. It doesn't move any money.</p>
          <button type="button" id="ask" class="primary big">Ask to join</button>
        </div>`;
      $("#ask").onclick = async () => {
        const name = $("#myName").value.trim().toLowerCase();
        if (!/^[a-z0-9-]{1,63}\.ai$/.test(name)) return toast("Write your Agent ID, like karim.ai.", true);
        try {
          const kp = await guardianKeypair(true);
          await send(() => amanaC(true).requestJoin(info.id, kp.publicKey), "Request sent.");
          await post("/api/join", { id: info.id, code, name, auth: await signIn() });
          box.innerHTML = `<div class="card"><h2>Now tell ${esc(info.ownerName)}</h2><p>${esc(info.ownerName)} will check it's really you. Read them these three pictures from your screen:</p>${emojiRow(emojis)}<p class="small muted">When they approve you, you'll get a message from Amana.</p></div>`;
        } catch (e) { if (!$("#toast").textContent) toast(explain(e), true); }
      };
    } catch (e) { toast(explain(e), true); }
  };
}

// ───────── vault ─────────
async function vaultView(view, id) {
  const v = await readVault(id);
  const now = await chainNow();
  const isOwner = same(v.owner, me);
  const mine = v.guardians.find((g) => same(g.wallet, me));
  const myHeir = v.heirs.find((h) => same(h.wallet, me));
  let meta = {};
  try { meta = await api(`/api/vault/${id}?${await authQuery()}`); } catch (e) { if (isOwner || mine) toast(explain(e), true); }
  const nameOf = (a) => meta.names?.[a.toLowerCase()] || short(a);
  const ownerName = meta.ownerName;
  const s = statusInfo(v, isOwner, ownerName);
  const votingOpen = v.status === "Alert";
  const lib = await seal();
  const covered = v.tokens.some((t) => t.coverage > 0n);
  const mine$ = isOwner && !v.released ? await Promise.all(v.tokens.map(async (t) => {
    const c = erc20(t.address);
    const [bal, allowed] = await Promise.all([c.balanceOf(me), c.allowance(me, CFG.amana)]);
    return { ...t, bal, allowed };
  })) : [];
  const enoughGuardians = v.guardians.length >= v.plan.threshold;
  const code = meta.code || (() => { try { return localStorage.getItem(`amana-code-${CFG.amana}-${id}`); } catch { return null; } })();

  const setup = isOwner && !v.released ? `
    <div class="card">
      <h2>Set up</h2>
      <ol class="steps">
        <li class="${enoughGuardians ? "done" : ""}"><strong>Invite your guardians.</strong> Tell each one, by phone or in person: open Amana, tap “I have a join code” and enter
          ${code ? `<span class="code" id="codeBox">${esc(prettyCode(code))}</span> <button type="button" id="copyCode" class="small">Copy</button>` : "your join code"}.
          Keep this code private. ${v.guardians.length} of 1 to 7 guardians so far, ${v.plan.threshold} must agree.</li>
        <li class="${v.sealed && v.sealCurrent ? "done" : ""}"><strong>Write and seal your will.</strong> ${!enoughGuardians ? `You need at least ${v.plan.threshold} guardians first.` : v.sealed && !v.sealCurrent ? "Your guardians changed: please re-seal it." : v.sealed ? "Sealed." : ""}
          ${enoughGuardians ? `<a class="btn" href="#/will/${id}">${v.sealed ? "Change my will" : "Write my will"}</a>` : ""}</li>
        <li class="${covered ? "done" : ""}"><strong>Choose what your heirs receive.</strong> Your money stays in your wallet. Below, tap “Everything” for each coin.</li>
      </ol>
    </div>` : "";

  const requests = isOwner && meta.pendingRequests?.length ? `
    <div class="card">
      <h2>Asking to be your guardian</h2>
      <p class="small muted">Call each person. Approve only if their screen shows the same three pictures as here.</p>
      ${meta.pendingRequests.map((r) => `
        <div class="person">
          <div class="row between">${tag(r.name)}<span class="addr">${short(r.wallet)}</span></div>
          ${emojiRow(lib.emojisFor(r.wallet))}
          <label class="row" style="font-weight:500"><input type="checkbox" data-approve="${r.wallet}" style="width:auto"> ${esc(r.name)} sees the same pictures</label>
        </div>`).join("")}
      <button type="button" id="approve" class="primary">Approve the ones I checked</button>
    </div>` : "";

  const claims = mine && meta.claims?.length ? `
    <div class="card">
      <h2>Heirs asking for their share</h2>
      <p class="small muted">Call each heir. Approve only if their screen shows the same three pictures. ${v.plan.threshold} guardians must approve.</p>
      ${meta.claims.map((c) => `
        <div class="person">
          <div class="row between">${tag(c.name || "heir")}<span class="addr">${short(c.wallet)}</span></div>
          ${emojiRow(lib.emojisFor(c.wallet))}
          ${c.approvedByMe ? `<p class="okbox">You approved. Waiting for another guardian.</p>` : `<button type="button" data-claim="${c.heir}" data-wallet="${c.wallet}">${esc(c.name || "This heir")} sees the same pictures: approve</button>`}
        </div>`).join("")}
    </div>` : "";

  const unlock = mine && v.released && !v.opened ? `
    <div class="card">
      <h2>Unlock ${esc(ownerName || "the")} will</h2>
      <p>You hold one piece of the key. ${v.plan.threshold} pieces are needed to open it. ${meta.piecesSent ? `${meta.piecesSent} received so far.` : ""}</p>
      ${meta.sentMyPiece ? `<p class="okbox">You've sent your piece. Thank you.</p>` : `<button type="button" id="unlock" class="primary big">Unlock the will</button>
      <p class="small muted">Your wallet will ask for a signature to unlock your piece. It doesn't move any money.</p>`}
    </div>` : "";

  view.innerHTML = `
    <div class="card status ${s.tone === "good" ? "" : s.tone}">
      <div class="row between"><span class="pill ${toneClass(s.tone)}">${s.label}</span>${ownerName ? tag(ownerName) : `<span class="small muted">Vault #${id}</span>`}</div>
      <p>${esc(s.text)}</p>
      ${isOwner && !v.released ? `<button class="primary big" type="button" id="checkin">I'm fine</button>` : ""}
    </div>

    ${requests}${setup}

    ${mine && votingOpen ? `
    <div class="card">
      <h2>Is ${esc(ownerName || "the owner")} okay?</h2>
      <p class="small muted">Answer only what you know. If they're alive, even if unwell, answer “They're okay”. ${v.plan.threshold} guardians must agree. Even then, there are ${days(v.plan.window)} days to cancel.</p>
      <div class="votes" style="grid-template-columns:1fr 1fr">
        <button type="button" data-vote="1">They're okay</button>
        <button type="button" data-vote="2" class="danger">Passed away</button>
      </div>
      ${mine.vote ? `<p class="small">Your answer: ${VOTE_LABEL[mine.vote].replace("says ", "")}. You can change it.</p>` : ""}
    </div>` : ""}


    ${v.status === "Pending" && now >= v.releaseAt ? `
    <div class="card"><h2>The waiting period is over</h2><p>The agent normally does this. Anyone can if it's offline.</p><button type="button" id="finalize" class="primary">Release the vault</button></div>` : ""}

    ${unlock}${claims}

    ${myHeir ? `<div class="card"><h2>What ${esc(ownerName || "they")} left you</h2><a class="btn primary" href="#/letter/${id}/${myHeir.index}">Read your letter</a></div>` : ""}

    ${isOwner || mine ? `
    ${isOwner && !v.released ? `
    <div class="card">
      <div class="row between"><h2>What your will covers</h2><span class="small muted">${chainName()}</span></div>
      <p class="small">If you pass away, your heirs receive what's left in these coins. <strong>Until then, Amana can't touch anything:</strong> the contract refuses any transfer until your guardians confirm your passing and the waiting period ends.</p>
      <p class="small muted">Your wallet will ask you to “approve” Amana for each coin. That's the only way a will can work: after a death nobody can sign for you. You can spend your money freely and change this any time.</p>
      <ul class="list">${mine$.map((t) => {
        const everything = t.allowed > 10n ** 60n;
        return `<li><span><strong>${esc(t.symbol)}</strong><br><span class="small muted">In your wallet: ${amt(t.bal, t.symbol)}<br>Your heirs receive: ${everything ? "everything left" : t.allowed > 0n ? "up to " + amt(t.allowed, t.symbol) : "nothing yet"}</span></span>
        <span class="stack" style="justify-items:end">${everything ? `<span class="pill t-good">Everything</span>` : `<button type="button" class="primary" data-everything="${t.address}">Everything</button>`}
          <details><summary class="small muted">Set a cap instead</summary><span class="row" style="margin-top:6px"><input type="number" min="0" step="any" placeholder="Max" data-limit="${t.address}" style="width:100px"><button type="button" data-setlimit="${t.address}">Set</button></span></details></span></li>`;
      }).join("")}</ul>
      <p class="addr">Vault #${id} · contract ${CFG.amana}</p>
    </div>` : ""}
    ${v.released ? `
    <div class="card">
      <h2>Collected for the heirs</h2>
      <div class="balance" style="font-size:24px">${esc(amounts(v.tokens, (t) => t.collected))}</div>
      <p class="addr">Vault #${id} · contract ${CFG.amana}</p>
    </div>` : ""}

    <div class="card">
      <h2>Guardians</h2>
      <p class="small muted">Check-in every ${days(v.plan.interval)} days, then ${days(v.plan.grace)} days of reminders. ${v.plan.threshold} of ${v.guardians.length} must agree.</p>
      ${v.guardians.length ? `<ul class="list">${v.guardians.map((g) => `<li><span>${tag(nameOf(g.wallet))}</span>
        <span class="row"><span class="small muted">${votingOpen || v.status === "Pending" ? VOTE_LABEL[g.vote] : ""}</span>${isOwner && !v.released ? `<button type="button" class="small" data-remove="${g.wallet}">Remove</button>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted small">No guardians yet.</p>`}
    </div>

    ${meta.will ? `
    <div class="card">
      <h2>The will</h2>
      <ul class="list">${meta.will.map((h, i) => {
        const hh = v.heirs[i] || {};
        const st = hh.paid ? `<span class="pill t-good">Received</span>` : hh.wallet ? (hh.unlockAt > now ? `<span class="pill t-neutral">Locked until ${date(hh.unlockAt)}</span>` : `<button type="button" data-pay="${i}">Send now</button>`) : `<span class="small muted">Not claimed yet</span>`;
        return `<li><span>${tag(h.name)}${h.relation ? ` <span class="small muted">${esc(h.relation)}</span>` : ""}<br><span class="small muted">${h.shareBps / 100}% · ${esc(amounts(v.tokens, (t) => (t.collected * BigInt(h.shareBps)) / 10000n))}</span></span>${st}</li>`;
      }).join("")}</ul>
      ${meta.code ? `<p class="small muted">Heirs claim by opening Amana with the join code ${esc(prettyCode(meta.code))} and tapping their name.</p>` : ""}
    </div>` : ""}

    <div class="card">
      <h2>What the agent did</h2>
      ${meta.log?.length ? `<ul class="log">${meta.log.map((l) => `<li><time>${new Date(l.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time><span>${esc(l.text)}</span></li>`).join("")}</ul>` : `<p class="muted small">Nothing yet.</p>`}
    </div>` : ""}`;

  const refresh = () => setTimeout(route, 400);
  const A = () => amanaC(true);
  $("#checkin")?.addEventListener("click", () => send(() => A().checkIn(id), "Checked in. Glad you're okay.").then(refresh));
  $("#copyCode")?.addEventListener("click", () => copy(prettyCode(code)));
  $("#approve")?.addEventListener("click", () => {
    const wallets = $$("[data-approve]").filter((c) => c.checked).map((c) => c.dataset.approve);
    if (!wallets.length) return toast("Tick the people whose pictures matched.", true);
    send(() => A().approveGuardians(id, wallets), wallets.length === 1 ? "Guardian approved." : `${wallets.length} guardians approved.`).then(refresh);
  });
  $$("[data-remove]").forEach((b) => b.addEventListener("click", () => send(() => A().removeGuardian(id, b.dataset.remove), "Guardian removed. Please re-seal your will.").then(refresh)));
  $$("[data-vote]").forEach((b) => b.addEventListener("click", () => send(() => A().vote(id, Number(b.dataset.vote)), "Thank you. Your answer is recorded.").then(refresh)));
  $("#finalize")?.addEventListener("click", () => send(() => A().finalize(id), "Released.").then(refresh));
  $("#unlock")?.addEventListener("click", async () => {
    try {
      const kp = await guardianKeypair(false);
      const { piece } = await api(`/api/my-piece/${id}?${await authQuery()}`);
      const raw = lib.openSealed(kp.privateKey, piece);
      const r = await post("/api/key-piece", { id, piece: lib.sealFor(CFG.agentPublicKey, raw), auth: await signIn() });
      toast(r.opened ? "The will is open." : "Thank you. Waiting for another guardian.");
      refresh();
    } catch (e) { toast(explain(e), true); }
  });
  $$("[data-claim]").forEach((b) => b.addEventListener("click", () => send(() => A().approveClaim(id, Number(b.dataset.claim), b.dataset.wallet), "Approved.").then(refresh)));
  $$("[data-pay]").forEach((b) => b.addEventListener("click", () => send(() => A().payout(id, Number(b.dataset.pay)), "Sent.").then(refresh)));
  $$("[data-everything]").forEach((b) => b.addEventListener("click", () =>
    send(() => erc20(b.dataset.everything, true).approve(CFG.amana, E.MaxUint256), `Done: your heirs will receive all your ${symbolOf(b.dataset.everything)}.`).then(refresh)));
  $$("[data-setlimit]").forEach((b) => b.addEventListener("click", () => {
    const input = $(`[data-limit="${b.dataset.setlimit}"]`);
    const a = input.value;
    if (a === "" || Number(a) < 0) return toast("Enter a maximum (0 removes this coin from your will).", true);
    send(() => erc20(b.dataset.setlimit, true).approve(CFG.amana, E.parseUnits(String(a), 18)), `Cap set to ${a} ${symbolOf(b.dataset.setlimit)}.`).then(refresh);
  }));
}

// ───────── will (owner) ─────────
const willKey = (id) => `amana-will-${CFG.chainId}-${CFG.amana}-${id}`;
let draft = null;

async function willView(view, id) {
  const v = await readVault(id);
  if (!same(v.owner, me)) throw new Error("Only the owner can write this will.");
  const meta = await api(`/api/vault/${id}?${await authQuery()}`);
  if (!draft || draft.id !== id) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(willKey(id)) || "null"); } catch {}
    draft = saved ? { id, ...saved } : {
      id,
      people: CFG.isLocal
        ? [{ name: "mama.ai", relation: "mother", birthDate: "" }, { name: "salma.ai", relation: "wife", birthDate: "" }, { name: "ilyas.ai", relation: "little brother", birthDate: "2006-03-14" }]
        : [{ name: "", relation: "", birthDate: "" }],
      wishes: CFG.isLocal ? "Give half to my mother. 30% to Salma. My little brother Ilyas gets his 20% only when he turns 25." : "",
      heirs: null,
      letters: CFG.isLocal ? {
        "mama.ai": "Mama, if you're reading this, I didn't get to say goodbye properly. Thank you for every sacrifice you made for us. Please use this for the Hajj you always talked about. I love you. Yassine",
        "salma.ai": "Salma, you were my home. Look after yourself first. Yassine",
        "ilyas.ai": "Ilyas, finish your studies. This is waiting for you when you're 25. Make me proud. Yassine",
      } : {},
    };
  }
  const d = draft;
  const total = (d.heirs || []).reduce((a, h) => a + Number(h.percent || 0), 0);
  const options = (sel) => d.people.filter((p) => p.name.trim()).map((p) => `<option ${p.name.trim().toLowerCase() === sel ? "selected" : ""}>${esc(p.name.trim().toLowerCase())}</option>`).join("");

  view.innerHTML = `
    <div class="card">
      <span class="step">Your sealed will</span>
      <h1>Who should receive what?</h1>
      <p class="small muted">This stays sealed. Only a fingerprint goes on the blockchain. It can only be opened by ${v.plan.threshold} of your guardians together, after a release, and the contract checks nothing was changed.</p>
    </div>
    <div class="card">
      <h2>The people</h2>
      <p class="small muted">Heirs don't need to know anything yet. When the time comes, your guardians will tell them.</p>
      ${d.people.map((p, i) => `
        <div class="person" data-p="${i}">
          <div class="grid2">
            <label>Their Agent ID<input data-f="name" value="${esc(p.name)}" placeholder="mama.ai"></label>
            <label>Who they are<input data-f="relation" value="${esc(p.relation)}" placeholder="mother"></label>
          </div>
          <label>Birth date (only if your wishes mention their age)<input type="date" data-f="birthDate" value="${esc(p.birthDate)}"></label>
        </div>`).join("")}
      <button type="button" id="addPerson">Add a person</button>
    </div>
    <div class="card">
      <h2>Your wishes, in your words</h2>
      <textarea id="wishes" placeholder="Give half to my mother…">${esc(d.wishes)}</textarea>
      <button type="button" id="read" class="primary">Turn my wishes into rules</button>
      ${d.heirs ? `
        ${d.questions?.length ? `<div class="warnbox">${d.questions.map(esc).join("<br>")}</div>` : ""}
        ${d.heirs.map((h, i) => `
          <div class="grid2" data-h="${i}">
            <label>Person<select data-k="name">${options(h.name)}</select></label>
            <div class="grid2">
              <label>Share %<input type="number" min="1" max="100" data-k="percent" value="${esc(h.percent)}"></label>
              <label>Locked until<input type="date" data-k="unlockDate" value="${esc(h.unlockDate || "")}"></label>
            </div>
          </div>`).join("")}
        <div class="row between"><button type="button" id="addHeir">Add an heir</button><span class="${total === 100 ? "small muted" : "small danger"}">Total ${total}%</span></div>` : ""}
    </div>
    ${d.heirs ? `
    <div class="card">
      <h2>A letter for each heir</h2>
      ${d.heirs.map((h) => `<label>To ${esc(h.name)}<textarea data-letter="${esc(h.name)}" style="min-height:80px">${esc(d.letters[h.name] || "")}</textarea></label>`).join("")}
    </div>
    <div class="card">
      <p class="small muted">Sealing splits the key between your ${v.guardians.length} guardians: ${v.guardians.map((g) => esc(meta.names?.[g.wallet.toLowerCase()] || short(g.wallet))).join(", ")}. A copy stays on this device so you can change your will later.</p>
      <button type="button" id="sealIt" class="primary big">Seal my will</button>
    </div>` : ""}`;

  $$("[data-p]").forEach((el) => {
    const p = d.people[Number(el.dataset.p)];
    $$("[data-f]", el).forEach((inp) => inp.addEventListener("input", () => (p[inp.dataset.f] = inp.value)));
    $("[data-f=name]", el).addEventListener("change", () => willView(view, id));
  });
  $("#addPerson").onclick = () => { d.people.push({ name: "", relation: "", birthDate: "" }); willView(view, id); };
  $("#wishes").oninput = (e) => (d.wishes = e.target.value);
  $("#read").onclick = async () => {
    try {
      const people = d.people.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim().toLowerCase(), relation: p.relation, birthDate: p.birthDate || null }));
      const today = new Date((await chainNow()) * 1000).toISOString().slice(0, 10);
      const r = await post("/api/wishes", { text: d.wishes, people, today });
      d.heirs = r.heirs;
      d.questions = r.questions;
      toast(r.engine === "claude" ? "Claude turned your wishes into rules. Check them." : "Done. Check the rules.");
      willView(view, id);
    } catch (e) { toast(explain(e), true); }
  };
  $$("[data-h]").forEach((row) => {
    const h = d.heirs[Number(row.dataset.h)];
    $$("[data-k]", row).forEach((inp) => inp.addEventListener("change", () => { h[inp.dataset.k] = inp.dataset.k === "percent" ? Number(inp.value) : inp.value; willView(view, id); }));
  });
  $("#addHeir")?.addEventListener("click", () => { d.heirs.push({ name: d.people[0]?.name || "", percent: 0, unlockDate: null }); willView(view, id); });
  $$("[data-letter]").forEach((t) => t.addEventListener("input", () => (d.letters[t.dataset.letter] = t.value)));
  $("#sealIt")?.addEventListener("click", () => sealWill(v, d));
}

async function sealWill(v, d) {
  const heirs = d.heirs;
  const total = heirs.reduce((a, h) => a + Number(h.percent || 0), 0);
  if (total !== 100) return toast(`Shares add up to ${total}%. They must add up to 100%.`, true);
  if (new Set(heirs.map((h) => h.name)).size !== heirs.length) return toast("Each heir can only appear once.", true);
  if (v.guardians.length < v.plan.threshold) return toast(`You need at least ${v.plan.threshold} guardians first.`, true);
  try {
    const lib = await seal();
    const rel = Object.fromEntries(d.people.map((p) => [p.name.trim().toLowerCase(), p.relation]));
    const will = {
      heirs: heirs.map((h) => ({
        name: h.name, relation: rel[h.name] || "", shareBps: Math.round(Number(h.percent) * 100),
        unlockAt: h.unlockDate ? Math.floor(Date.parse(h.unlockDate + "T00:00:00Z") / 1000) : 0, letter: (d.letters[h.name] || "").trim(),
      })),
      salt: lib.randomSalt(),
    };
    const hash = willHash(v.id, will.heirs.map((h) => h.shareBps), will.heirs.map((h) => h.unlockAt), will.salt);
    const { key, ciphertext } = lib.encryptWill(will);
    const keys = await Promise.all(v.guardians.map((g) => amanaC().guardianKey(v.id, g.wallet)));
    const pieces = lib.split(key, keys.length, v.plan.threshold).map((p, i) => lib.sealFor(keys[i], p));
    await send(() => amanaC(true).sealWill(v.id, hash, ciphertext, pieces), "Your will is sealed.");
    try { localStorage.setItem(willKey(v.id), JSON.stringify({ people: d.people, wishes: d.wishes, heirs: d.heirs, letters: d.letters })); } catch {}
    draft = null;
    location.hash = "#/vault/" + v.id;
  } catch (e) {
    if (!$("#toast").textContent) toast(explain(e), true);
  }
}

// ───────── letter (heir) ─────────
async function letterView(view, id, heir) {
  if (!me) { view.innerHTML = connectCard("Connect your Agent ID wallet to read your letter."); $("#connect2")?.addEventListener("click", () => connect(false)); return; }
  const d = await api(`/api/letter/${id}/${heir}?${await authQuery()}`);
  const locked = d.unlockAt > d.now;
  view.innerHTML = `
    ${d.text ? `<div class="card">
      <div class="row between"><h2>A letter from ${esc(d.ownerName)}</h2>${tag(d.name || "")}</div>
      <p class="letter">${esc(d.text)}</p>
    </div>` : ""}
    <div class="card">
      <h2>What ${esc(d.ownerName)} left you</h2>
      <div class="balance" style="font-size:24px">${esc(d.shares.filter((x) => BigInt(x.amount) > 0n).map((x) => amt(BigInt(x.amount), x.symbol)).join(" + ") || "nothing")}</div>
      ${d.paid ? `<p class="okbox">It has arrived in your wallet. You don't need to do anything.</p>`
        : locked ? `<p>Kept safe until <strong>${date(d.unlockAt)}</strong>, as ${esc(d.ownerName)} wished. Amana will send it to you on that day.</p>`
        : `<p>Amana is sending it to you now.</p><button type="button" id="payNow">Send it now</button>`}
    </div>`;
  $("#payNow")?.addEventListener("click", () => send(() => amanaC(true).payout(id, heir), "Sent.").then(() => setTimeout(route, 400)));
}

boot().catch((e) => { $("#view").innerHTML = `<div class="card"><h2>Amana couldn't start</h2><p>${esc(e.message)}</p></div>`; });
