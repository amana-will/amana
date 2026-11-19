# Amana

**A sealed will for your crypto, carried out by the people you trust.**

Your money stays in your own wallet. You check in once every 3 months. If you stop answering, Amana reminds you
three times, then asks your guardians. Only if enough of them confirm your passing, a 6-month waiting period
ends, and they unlock your sealed will together, does Amana collect what's left in your wallet (up to the limits
you chose) and share it between your heirs, each with a letter from you.

Built for the BNB Chain × Binance Wallet **Agent ID Hackathon**.

**Live on BNB Smart Chain:** [`0x2FCdb32701a33888BDeF82A7406cB59bC4A011a2`](https://bscscan.com/address/0x2FCdb32701a33888BDeF82A7406cB59bC4A011a2#code)
(source verified on BscScan, deployed at block 134507526)

---

## How it works

1. **Create.** The owner creates an Amana from their Agent ID wallet, chooses which coins the will covers
   (USDT, USDC, WBNB, BTCB, ETH) and gets a private join code like `AMANA-7K3Q-X9PD-M2TA`.
   Defaults: check in every 3 months, 3 weekly reminders, then guardians are asked; 2 guardians must agree;
   6 months to cancel.
2. **Handshake.** The owner tells each guardian the code by phone or in person. The guardian opens Amana,
   enters the code and taps "Ask to join". Both phones show the same three pictures (🐱 🐓 🐬): the owner
   checks them out loud, then approves. No links to click, nobody looked up by name.
3. **Sealed will.** The owner writes their wishes in plain words, the AI turns them into shares and lock dates,
   and they add a letter for each heir. The will is encrypted; its key is cut into pieces, one per guardian.
   Only a fingerprint goes into the contract.
4. **Limits.** For each coin, the owner approves Amana up to a limit. The money stays in their wallet and they
   can spend it freely. Nothing moves while they're alive.
5. **Check-ins.** Every 3 months the owner taps "I'm fine". Missed? 3 reminders over 3 weeks. Still nothing?
   Guardians are asked: "they're okay" or "they passed away".
6. **Release.** If enough guardians say "passed away", nothing happens for 6 months (the owner can still cancel).
   Then Amana collects what's left of each covered coin, up to the limits. The guardians unlock the will together;
   the contract checks it matches the fingerprint exactly, and only then is it opened.
7. **Heirs.** Guardians gently tell the heirs. Each heir opens Amana with the join code, taps their name,
   and reads three pictures to a guardian on the phone. Once enough guardians confirm, the agent sends their
   share to their Agent ID wallet with the owner's letter. Heirs don't need to know anything in advance.

## Privacy

| Who can see | What |
|---|---|
| Anyone, on the blockchain | That a wallet uses Amana and its approved limits, check-in times, status changes, guardian wallets (no names), guardian votes |
| Nobody until a release | Who inherits, how much, lock dates, letters. Only a fingerprint and an encrypted copy are on-chain |
| Members of the vault only | Names (yassine.ai, karim.ai), the join code, the agent's activity log |
| Everyone, after the will is opened | Heir shares and lock dates (the contract needs them to pay). Names and letters stay private |

## How Agent ID is used (core, not cosmetic)

- **Only Agent ID holders can create, join or claim.** The contract checks the official Agent ID NFT
  (`0x60b9262456de011f7d15a54cdd8c48baaa8b022f`, `balanceOf > 0`) in `createVault`, `requestJoin` and `requestClaim`.
- **Your Agent ID wallet is your identity in every role:** owners keep their money in it and check in with it,
  guardians hold their key piece and vote with it, heirs receive their inheritance in it.
- **No lookups by name.** People join by asking from their own wallet with a code they were told in person.
- **Your Binance agent can act for you.** With `skill/SKILL.md`, an AI agent using the Binance Agentic Wallet can
  check in, vote, or change a coin's limit for its user, always after the user confirms.

All vaults live in **one Amana contract**, so every action counts toward the project's on-chain activity.

## Admin powers: none

No contract owner, pause, upgrade, fee or freeze. Coins can only leave the owner's wallet after a release
(guardians' votes plus the waiting period), only up to the limits the owner approved, and only to heirs named in
the sealed will and confirmed by the guardians. The owner can lower a limit to 0 at any time. The agent's
wallet only pays gas to release vaults, open verified wills and pay confirmed heirs.

---

## What's inside

| Folder | What it is |
|---|---|
| `contracts/` | The `Amana` contract and 22 tests. `MockUSDC` and `MockAgentID` are test stand-ins, never used on mainnet. |
| `agent/` | The Amana agent: reminders, guardian requests, opening wills, heir claims, letters. Also serves the web app. `src/seal.js` is the encryption toolkit (also bundled for the browser). |
| `web/` | The web app |
| `skill/SKILL.md` | A skill for AI agents using the Binance Agentic Wallet |

---

## Try it on your computer (about 10 minutes)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd contracts && npm install --legacy-peer-deps && cd ..
cd agent && npm install && cd ..
```

Terminal 1 (leave it open):
```bash
cd contracts && npx hardhat node
```

Terminal 2:
```bash
cd contracts
npx hardhat test                                   # optional: 22 tests
npx hardhat run scripts/deploy.js --network localhost   # replaces shared/deployment.json with local addresses
cd ../agent
node src/demo-setup.js
npm start
```

Open http://localhost:3000. The dark bar is for demos only: **Act as** switches person, the buttons move time.

1. As `yassine.ai`: **Create my Amana**, then **Create my Amana** again. Copy the join code.
2. As `karim.ai`, `salma.ai` and `omar.ai`: **I have a join code**, paste it, **Continue**, **Ask to join**.
3. As `yassine.ai`: open the vault, tick the three people (the pictures match), **Approve**.
   **Write my will** > **Turn my wishes into rules** > **Seal my will**. Under "What your will covers",
   set a limit of 4000 tUSDC.
4. Tap **+90 days**, then **+7 days** three times: three reminders, then the guardians are asked.
5. As `karim.ai` and `omar.ai`: **Passed away**. Tap **+90 days** twice and **+7 days** (the 6-month wait). Amana collects
   4,000 tUSDC from Yassine's wallet (he had 5,000; the other 1,000 stays).
6. As `karim.ai` and `omar.ai`: **Unlock the will**. It opens.
7. As `mama.ai`: **I have a join code** > paste > **I'm mama.ai**. As `karim.ai` and `omar.ai`: approve her.
8. As `mama.ai`: open your messages and read Yassine's letter. Her 2,000 tUSDC (50%) has arrived.

## Go live on BNB Chain (what the hackathon requires)

The rules say projects must be deployed on BNB Chain, verified and open-sourced on BscScan, and actively use
Agent ID. Mainnet is where real Agent IDs exist, so that's where Amana must live.

**Costs:** deploying and verifying costs roughly a few dollars of BNB in gas. Each user action costs a few cents.

1. **Make two fresh wallets** (never your main one):
   - a *deployer* with about 0.02 BNB,
   - a *keeper* for the agent with about 0.01 BNB (it only pays gas to finalize releases and pay heirs).
2. **Get a free BscScan/Etherscan API key** at https://etherscan.io/myapikey.
3. **Deploy and verify:**
   ```bash
   cd contracts
   PRIVATE_KEY=0xDEPLOYER_KEY npx hardhat run scripts/deploy.js --network bsc
   BSCSCAN_API_KEY=YOUR_KEY npx hardhat verify --network bsc <Amana address> 0x60b9262456de011f7d15a54cdd8c48baaa8b022f
   ```
   On mainnet the script uses the real Agent ID contract and offers USDT, USDC, WBNB, BTCB and ETH.
4. **Run the app and agent online (Railway).** New project > Deploy from GitHub repo > `amana-will/amana`.
   Add a **volume** mounted at `/data`, then set the variables `DATA_DIR=/data`, `APP_URL=https://<your Railway domain>`
   and `POLL_SECONDS=60` (optional: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`). On first start the agent creates its
   own gas wallet and prints its address in the logs: send it about 0.005 BNB. Back up the volume's `agent-key.json`
   and `keeper-key.json`.
5. **Push this folder to a public GitHub repository.**

Want to rehearse first? Use `--network bscTestnet` with free test BNB from the
[BNB Chain faucet](https://www.bnbchain.org/en/testnet-faucet). The script then deploys a test coin and a test Agent ID,
and the app offers buttons to mint both.

## Reaching 30 Agent ID users (needed for the Innovation Award)

The judges' award requires at least 30 Agent ID addresses interacting with the contract during the submission
period (until 9 Dec 2026, 08:00 UTC). Each vault brings the owner plus each guardian who asks to join
(heirs only interact after a release): one owner with 3 guardians is 4 addresses. So about 8 families gets you there.

- Start with your own family and friends. Everyone needs a free Agent ID from the Binance App
  (Wallet > homepage banner > Agent ID).
- People can start with a tiny limit, even 1 USDT. Their money never leaves their wallet unless the will runs.
- Post your story on X: why you built Amana. Check the announcement for any community or social prize.
- Never pay people to interact or create fake accounts: the rules disqualify manipulation.

## Submission form, ready to paste

- **Project name:** Amana
- **Website:** your `APP_URL`
- **Contract address:** your Amana address (verified on BscScan)
- **Agent ID usage:** Amana is a sealed will for crypto where every participant is an Agent ID.
  The contract requires the owner and every guardian and heir to hold an Agent ID (checked on-chain against
  0x60b9…022f). Guardians join through an in-app handshake (a private
  join code plus matching emojis, no links, no lookups by name), hold a piece of the key to the owner's sealed will,
  and vote with their Agent ID wallet; heirs inherit into theirs. No names are stored on-chain and the will stays
  sealed until a release. The owner's money never leaves their wallet while they're alive: Amana collects
  what's left, up to approved limits, only after the guardians confirm a passing and a 6-month window ends. An AI
  agent turns plain-language wishes into rules, sends check-in reminders every 3 months, alerts guardians, and
  opens the will only when the guardians unlock it.

## Honest limits

- **Not audited.** Say so to users and suggest small limits. An approval lets the contract move up to that limit,
  so a bug could put that amount at risk. That's why limits matter.
- **Approvals look like a scam pattern** to experienced users ("approve this app to spend your coins"). The app
  explains it on screen; always suggest a limit rather than "unlimited".
- **Heirs get what's left.** If the owner spent the money, moved it, or lowered a limit, there's less to share.
  Plain BNB isn't covered (wrap it as WBNB) and money on the Binance exchange isn't in the wallet.
- **Guardians must keep their wallet.** A guardian's key piece comes from a signature of their Agent ID wallet.
  If too many guardians lose their wallets, the will can't be opened and the money stays locked. Pick at least 3
  guardians with 2 needed, and re-seal when guardians change (the app reminds you).
- **Guardians who conspire could read the will early** (if enough of them combine their pieces), the same trust
  you already give them to declare a death. Choose people who don't all inherit.
- **The agent reads the will after a release** to open it and deliver letters. Before a release it can't: it
  never has the pieces.
- **Wallets must sign the same way every time** to hold a key piece. The app checks this when a guardian joins.
- The agent stores names and letters in a JSON file. Use a real database (and encryption at rest) for many users.
