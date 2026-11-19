const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400;
const usdc = (n) => ethers.parseUnits(String(n), 18);
const S = { Active: 0, Reminder: 1, Alert: 2, Pending: 3, Released: 4 };
const V = { None: 0, Okay: 1, Passed: 2 };
const coder = ethers.AbiCoder.defaultAbiCoder();
const CODE = ethers.id("AMANA-TEST-CODE");
const KEY = (n) => ethers.id("pubkey:" + n);

// The sealed will: mama 50%, salma 30%, ilyas 20% locked 400 days.
async function willFor(id) {
  const now = await time.latest();
  const shares = [5000, 3000, 2000];
  const unlocks = [0, 0, now + 400 * DAY];
  const salt = ethers.id("salt");
  const hash = ethers.keccak256(coder.encode(["uint256", "uint16[]", "uint64[]", "bytes32"], [id, shares, unlocks, salt]));
  return { shares, unlocks, salt, hash };
}

async function setup({ seal = true, fund = true } = {}) {
  const [yassine, karim, salma, omar, mama, ilyas, stranger, noId] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const aid = await (await ethers.getContractFactory("MockAgentID")).deploy();
  const amana = await (await ethers.getContractFactory("Amana")).deploy(await aid.getAddress());
  const token2 = await (await ethers.getContractFactory("MockUSDC")).deploy();
  for (const s of [yassine, karim, salma, omar, mama, ilyas, stranger]) await aid.mint(s.address);

  const plan = { checkInInterval: 90 * DAY, gracePeriod: 21 * DAY, threshold: 2, cancelWindow: 30 * DAY };
  await amana.connect(yassine).createVault(CODE, plan, [await token.getAddress(), await token2.getAddress()]);
  const id = 1;
  for (const g of [karim, salma, omar]) await amana.connect(g).requestJoin(id, KEY(g.address));
  await amana.connect(yassine).approveGuardians(id, [karim.address, salma.address, omar.address]);

  const will = await willFor(id);
  if (seal) await amana.connect(yassine).sealWill(id, will.hash, "0x1234", ["0x01", "0x02", "0x03"]);
  // The money stays in Yassine's wallet. He approves Amana up to a limit.
  await token.mint(yassine.address, usdc(5000));
  await token2.mint(yassine.address, usdc(100));
  if (fund) {
    await token.connect(yassine).approve(await amana.getAddress(), usdc(4000));
    await token2.connect(yassine).approve(await amana.getAddress(), usdc(1000));
  }
  return { token, token2, aid, amana, id, plan, will, yassine, karim, salma, omar, mama, ilyas, stranger, noId };
}

const toAlert = async (ctx) => { await time.increase(111 * DAY); return ctx; };

async function toReleased(ctx) {
  await toAlert(ctx);
  await ctx.amana.connect(ctx.karim).vote(1, V.Passed);
  await ctx.amana.connect(ctx.omar).vote(1, V.Passed);
  await time.increase(30 * DAY);
  await ctx.amana.finalize(1);
  return ctx;
}

async function bindHeir(ctx, heir, signer) {
  await ctx.amana.connect(signer).requestClaim(1, heir);
  await ctx.amana.connect(ctx.karim).approveClaim(1, heir, signer.address);
  await ctx.amana.connect(ctx.omar).approveClaim(1, heir, signer.address);
}

describe("Amana", function () {
  describe("join codes and Agent ID", function () {
    it("finds a vault only by its code, and a code can't be reused", async function () {
      const { amana, karim, plan } = await setup();
      expect(await amana.vaultByCode(CODE)).to.equal(1n);
      expect(await amana.vaultByCode(ethers.id("other"))).to.equal(0n);
      await expect(amana.connect(karim).createVault(CODE, plan, [await amana.getAddress()])).to.be.revertedWithCustomError(amana, "CodeTaken");
    });

    it("requires an Agent ID to create, join or claim", async function () {
      const { amana, noId, plan } = await setup();
      await expect(amana.connect(noId).createVault(ethers.id("x"), plan, [])).to.be.revertedWithCustomError(amana, "NoAgentId");
      await expect(amana.connect(noId).requestJoin(1, KEY("x"))).to.be.revertedWithCustomError(amana, "NoAgentId");
    });

    it("stores no names on-chain", async function () {
      const { amana } = await setup();
      const fragments = amana.interface.fragments.filter((f) => f.type !== "error").map((f) => f.format("full")).join("\n");
      expect(fragments).to.not.match(/string/);
    });
  });

  describe("guardian handshake", function () {
    it("owner approves only people who asked, and the owner can't be a guardian", async function () {
      const { amana, yassine, mama, stranger } = await setup();
      await expect(amana.connect(yassine).approveGuardians(1, [mama.address])).to.be.revertedWithCustomError(amana, "NoRequest");
      await expect(amana.connect(yassine).requestJoin(1, KEY("me"))).to.be.revertedWithCustomError(amana, "NotAllowed");
      await amana.connect(stranger).requestJoin(1, KEY("s"));
      await expect(amana.connect(stranger).approveGuardians(1, [stranger.address])).to.be.revertedWithCustomError(amana, "NotOwner");
    });

    it("records each guardian's public key, and changes mark the seal as out of date", async function () {
      const { amana, yassine, karim, mama } = await setup();
      expect(await amana.guardianKey(1, karim.address)).to.equal(KEY(karim.address));
      expect((await amana.getVault(1)).sealCurrent).to.equal(true);
      await amana.connect(mama).requestJoin(1, KEY("m"));
      await amana.connect(yassine).approveGuardians(1, [mama.address]);
      expect((await amana.getVault(1)).sealCurrent).to.equal(false);
      await amana.connect(yassine).removeGuardian(1, mama.address);
      expect(await amana.guardians(1)).to.have.length(3);
      expect(await amana.isGuardian(1, mama.address)).to.equal(false);
    });


    it("caps guardians at 7", async function () {
      const { amana, yassine } = await setup();
      const signers = (await ethers.getSigners()).slice(10, 15);
      for (const s of signers) {
        await (await ethers.getContractAt("MockAgentID", await amana.agentId())).mint(s.address);
        await amana.connect(s).requestJoin(1, KEY(s.address));
      }
      await expect(amana.connect(yassine).approveGuardians(1, signers.map((s) => s.address))).to.be.revertedWithCustomError(amana, "BadPlan");
    });
  });

  describe("sealed will", function () {
    it("needs one key piece per guardian", async function () {
      const { amana, yassine, will } = await setup({ seal: false });
      await expect(amana.connect(yassine).sealWill(1, will.hash, "0x", ["0x01"])).to.be.revertedWithCustomError(amana, "BadPlan");
    });

    it("publishes the encrypted will and key pieces in an event", async function () {
      const { amana, yassine, will, karim, salma, omar } = await setup({ seal: false });
      await expect(amana.connect(yassine).sealWill(1, will.hash, "0xabcdef", ["0x01", "0x02", "0x03"]))
        .to.emit(amana, "WillSealed")
        .withArgs(1, will.hash, "0xabcdef", [karim.address, salma.address, omar.address], ["0x01", "0x02", "0x03"]);
    });

    it("opens only with the exact sealed will, only after release", async function () {
      const ctx = await setup();
      const { amana, will } = ctx;
      await expect(amana.openWill(1, will.shares, will.unlocks, will.salt)).to.be.revertedWithCustomError(amana, "WrongStatus");
      await toReleased(ctx);
      await expect(amana.openWill(1, [6000, 2000, 2000], will.unlocks, will.salt)).to.be.revertedWithCustomError(amana, "WillMismatch");
      await expect(amana.openWill(1, will.shares, will.unlocks, ethers.id("wrong"))).to.be.revertedWithCustomError(amana, "WillMismatch");
      await amana.openWill(1, will.shares, will.unlocks, will.salt);
      await expect(amana.openWill(1, will.shares, will.unlocks, will.salt)).to.be.revertedWithCustomError(amana, "WrongStatus");
      expect(await amana.heirs(1)).to.have.length(3);
    });
  });

  describe("check-ins every 3 months", function () {
    it("Reminder at 90 days, guardians asked after 3 weeks more", async function () {
      const { amana } = await setup();
      await time.increase(89 * DAY);
      expect(await amana.status(1)).to.equal(S.Active);
      await time.increase(1 * DAY);
      expect(await amana.status(1)).to.equal(S.Reminder);
      await time.increase(20 * DAY);
      expect(await amana.status(1)).to.equal(S.Reminder);
      await time.increase(1 * DAY);
      expect(await amana.status(1)).to.equal(S.Alert);
    });

    it("only the owner can check in, and any owner action resets the timer", async function () {
      const { amana, stranger, yassine } = await setup();
      await expect(amana.connect(stranger).checkIn(1)).to.be.revertedWithCustomError(amana, "NotOwner");
      await toAlert({});
      await amana.connect(yassine).checkIn(1);
      expect(await amana.status(1)).to.equal(S.Active);
    });
  });

  describe("guardian votes", function () {
    it("nobody votes before the Alert; strangers never", async function () {
      const { amana, karim, stranger } = await setup();
      await expect(amana.connect(karim).vote(1, V.Passed)).to.be.revertedWithCustomError(amana, "WrongStatus");
      await toAlert({});
      await expect(amana.connect(stranger).vote(1, V.Passed)).to.be.revertedWithCustomError(amana, "NotAllowed");
    });

    it("one vote isn't enough; changing a vote doesn't double count; two okays reset", async function () {
      const { amana, karim, omar } = await toAlert(await setup());
      await amana.connect(karim).vote(1, V.Passed);
      await amana.connect(karim).vote(1, V.Okay);
      await amana.connect(omar).vote(1, V.Passed);
      expect(await amana.status(1)).to.equal(S.Alert);
      await amana.connect(karim).vote(1, V.Okay);
      await amana.connect(omar).vote(1, V.Okay);
      expect(await amana.status(1)).to.equal(S.Active);
    });

    it("can't schedule a release when no will is sealed", async function () {
      const { amana, karim, omar } = await toAlert(await setup({ seal: false }));
      await amana.connect(karim).vote(1, V.Passed);
      await expect(amana.connect(omar).vote(1, V.Passed)).to.be.revertedWithCustomError(amana, "BadPlan");
    });
  });


  describe("release, heirs and payouts", function () {
    it("waits for the cancel window, which the owner can use to cancel", async function () {
      const ctx = await toAlert(await setup());
      await ctx.amana.connect(ctx.karim).vote(1, V.Passed);
      await ctx.amana.connect(ctx.omar).vote(1, V.Passed);
      await time.increase(29 * DAY);
      await expect(ctx.amana.finalize(1)).to.be.revertedWithCustomError(ctx.amana, "WrongStatus");
      await ctx.amana.connect(ctx.yassine).checkIn(1);
      expect(await ctx.amana.status(1)).to.equal(S.Active);
    });

    it("heirs claim with guardian approvals and get their exact share", async function () {
      const ctx = await toReleased(await setup());
      const { amana, will, mama, salma, ilyas, karim, stranger, token } = ctx;
      await expect(amana.connect(mama).requestClaim(1, 0)).to.be.revertedWithCustomError(amana, "NotAllowed"); // not opened yet
      await amana.connect(stranger).openWill(1, will.shares, will.unlocks, will.salt);

      await amana.connect(mama).requestClaim(1, 0);
      await amana.connect(karim).approveClaim(1, 0, mama.address);
      await expect(amana.connect(karim).approveClaim(1, 0, mama.address)).to.be.revertedWithCustomError(amana, "NotAllowed");
      await expect(amana.payout(1, 0)).to.be.revertedWithCustomError(amana, "NoRequest"); // one approval isn't enough
      await amana.connect(ctx.omar).approveClaim(1, 0, mama.address);
      await amana.connect(stranger).payout(1, 0);
      expect(await token.balanceOf(mama.address)).to.equal(usdc(2000));
      expect(await ctx.token2.balanceOf(mama.address)).to.equal(usdc(50));
      await expect(amana.payout(1, 0)).to.be.revertedWithCustomError(amana, "AlreadyPaid");

      await bindHeir(ctx, 1, salma);
      await amana.payout(1, 1);
      expect(await token.balanceOf(salma.address)).to.equal(usdc(1200));

      await bindHeir(ctx, 2, ilyas);
      await expect(amana.payout(1, 2)).to.be.revertedWithCustomError(amana, "StillLocked");
      await time.increase(400 * DAY);
      await amana.payout(1, 2);
      expect(await token.balanceOf(ilyas.address)).to.equal(usdc(800));
      expect(await ctx.token2.balanceOf(ilyas.address)).to.equal(usdc(20));
      expect(await token.balanceOf(await amana.getAddress())).to.equal(0);
      expect(await ctx.token2.balanceOf(await amana.getAddress())).to.equal(0);
    });

    it("a stranger's claim isn't approved unless guardians approve that wallet", async function () {
      const ctx = await toReleased(await setup());
      const { amana, will, stranger, karim } = ctx;
      await amana.openWill(1, will.shares, will.unlocks, will.salt);
      await expect(amana.connect(karim).approveClaim(1, 0, stranger.address)).to.be.revertedWithCustomError(amana, "NoRequest");
      await expect(amana.connect(stranger).approveClaim(1, 0, stranger.address)).to.be.revertedWithCustomError(amana, "NotAllowed");
    });
  });

});

describe("Amana keeps money in the owner's wallet", function () {
  it("nothing moves before a release, and the owner can spend freely", async function () {
    const { amana, token, yassine, stranger } = await setup();
    expect(await token.balanceOf(await amana.getAddress())).to.equal(0);
    await token.connect(yassine).transfer(stranger.address, usdc(4500));
    const [, amounts] = await amana.coverage(1);
    expect(amounts[0]).to.equal(usdc(500)); // balance is now below the limit
  });

  it("collects what's left at release, up to the approved limit", async function () {
    const ctx = await toReleased(await setup());
    expect(await ctx.amana.collected(1, await ctx.token.getAddress())).to.equal(usdc(4000));
    expect(await ctx.token.balanceOf(ctx.yassine.address)).to.equal(usdc(1000));
    expect(await ctx.amana.collected(1, await ctx.token2.getAddress())).to.equal(usdc(100));
  });

  it("a token with no approval is skipped without blocking the others", async function () {
    const ctx = await setup();
    await ctx.token2.connect(ctx.yassine).approve(await ctx.amana.getAddress(), 0);
    await toReleased(ctx);
    expect(await ctx.amana.collected(1, await ctx.token2.getAddress())).to.equal(0);
    expect(await ctx.amana.collected(1, await ctx.token.getAddress())).to.equal(usdc(4000));
  });

  it("rejects bad token lists", async function () {
    const { amana, yassine, token } = await setup();
    const t = await token.getAddress();
    await expect(amana.connect(yassine).updateTokens(1, [])).to.be.revertedWithCustomError(amana, "BadPlan");
    await expect(amana.connect(yassine).updateTokens(1, [t, t])).to.be.revertedWithCustomError(amana, "BadPlan");
    await expect(amana.connect(yassine).updateTokens(1, [yassine.address])).to.be.revertedWithCustomError(amana, "BadPlan");
  });
});

describe("Amana plan settings", function () {
  it("owner can change check-in settings within limits", async function () {
    const { amana, yassine, plan } = await setup();
    await amana.connect(yassine).updatePlan(1, { ...plan, checkInInterval: 30 * DAY });
    expect((await amana.getVault(1)).plan.checkInInterval).to.equal(30 * DAY);
    await expect(amana.connect(yassine).updatePlan(1, { ...plan, threshold: 8 })).to.be.revertedWithCustomError(amana, "BadPlan");
    await expect(amana.connect(yassine).updatePlan(1, { ...plan, checkInInterval: 60 })).to.be.revertedWithCustomError(amana, "BadPlan");
  });
});
