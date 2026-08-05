import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Real tier payouts for Megapot drawing 134 on Base mainnet, captured
 * 2026-08-04 from Jackpot.getDrawingTierPayouts and cross-checked against
 * api.megapot.io/v1/rounds/active. USDC 6dp.
 *
 * Index = normalMatches * 2 + (bonusballMatch ? 1 : 0).
 */
const DRAWING_134_TIERS: bigint[] = [
  0n, // 0 matches, no bonus
  1_111_112n, // 0 matches, bonus
  0n, // 1 match,  no bonus
  3_265_881n, // 1 match,  bonus
  1_111_112n, // 2 matches, no bonus
  5_851_605n, // 2 matches, bonus
  5_149_310n, // 3 matches, no bonus
  10_197_057n, // 3 matches, bonus
  25_340_300n, // 4 matches, no bonus
  219_173_810n, // 4 matches, bonus
  2_272_597_557n, // 5 matches, no bonus
  224_878_269_196n, // 5 matches, bonus
];

const BALL_MAX = 30;
const BONUSBALL_MAX = 10;
const REFERRAL_WIN_SHARE = 10n ** 17n; // 1e17 = 10%, live value on drawing 134

describe("TicketMath", () => {
  async function deploy() {
    const f = await ethers.getContractFactory("TicketMathHarness");
    const h = await f.deploy();
    await h.waitForDeployment();
    return h;
  }

  it("computes binomial coefficients", async () => {
    const h = await deploy();
    expect(await h.choose(30, 5)).to.equal(142506n);
    expect(await h.choose(25, 5)).to.equal(53130n);
    expect(await h.choose(5, 0)).to.equal(1n);
    expect(await h.choose(5, 5)).to.equal(1n);
    expect(await h.choose(5, 6)).to.equal(0n);
    // Symmetry
    expect(await h.choose(30, 25)).to.equal(142506n);
  });

  it("counts the distinct ticket space", async () => {
    const h = await deploy();
    // C(30,5) * 10
    expect(await h.totalCombos(BALL_MAX, BONUSBALL_MAX)).to.equal(1_425_060n);
  });

  it("rejects ball bounds Megapot would reject", async () => {
    const h = await deploy();
    // Jackpot enforces normalBallMax >= 2 * NORMAL_BALL_COUNT
    await expect(h.totalCombos(9, 10)).to.be.reverted;
    await expect(h.totalCombos(30, 0)).to.be.reverted;
  });

  it("matches the independently computed gross EV for drawing 134", async () => {
    const h = await deploy();
    const ev: bigint = await h.grossEv(DRAWING_134_TIERS, BALL_MAX, BONUSBALL_MAX);
    // Off-chain computation over the same live data gave 0.772628 USDC.
    // Allow 100 wei of USDC (0.0001) for integer division ordering.
    expect(ev).to.be.closeTo(772_628n, 100n);
  });

  it("derives holder value as EV net of the referrer win share", async () => {
    const h = await deploy();
    const ev: bigint = await h.grossEv(DRAWING_134_TIERS, BALL_MAX, BONUSBALL_MAX);
    const hv: bigint = await h.holderValue(
      DRAWING_134_TIERS,
      BALL_MAX,
      BONUSBALL_MAX,
      REFERRAL_WIN_SHARE
    );
    // The referrer's 10% is taken out of winnings, so a holder sees 90%.
    expect(hv).to.equal((ev * 9n) / 10n);
    expect(hv).to.be.closeTo(695_365n, 100n);
  });

  it("keeps the sellback default below holder value", async () => {
    const h = await deploy();
    const hv: bigint = await h.holderValue(
      DRAWING_134_TIERS,
      BALL_MAX,
      BONUSBALL_MAX,
      REFERRAL_WIN_SHARE
    );
    const SELLBACK_DEFAULT = 650_000n;
    // This is the whole basis of decision 2. At 0.80 it would fail.
    expect(SELLBACK_DEFAULT).to.be.lessThan(hv);
    expect(800_000n).to.be.greaterThan(hv); // the rejected price, kept as a guard
  });

  it("returns zero holder value if the referrer took everything", async () => {
    const h = await deploy();
    expect(
      await h.holderValue(DRAWING_134_TIERS, BALL_MAX, BONUSBALL_MAX, 10n ** 18n)
    ).to.equal(0n);
  });
});
