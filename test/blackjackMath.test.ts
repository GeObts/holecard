import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Every game rule, proven on plaintext cards.
 *
 * No covalidator, no fork, no Docker. This is the suite that keeps the game
 * demonstrable while the Inco attestation service is unavailable: if the demo
 * cannot show a live hand, it can show these.
 *
 * Card encoding: 0..51. rank = card % 13 with 0 = ace and 12 = king.
 * suit = card / 13 and does not affect scoring.
 */

const ACE = 0;
const TWO = 1;
const THREE = 2;
const FOUR = 3;
const FIVE = 4;
const SIX = 5;
const SEVEN = 6;
const EIGHT = 7;
const NINE = 8;
const TEN = 9;
const JACK = 10;
const QUEEN = 11;
const KING = 12;

/** Build a card id from rank and suit. Suit defaults vary so cards stay distinct. */
const c = (rank: number, suit = 0) => suit * 13 + rank;

// Outcome enum, mirroring BlackjackMath.Outcome
const PLAYER_WINS = 0n;
const DEALER_WINS = 1n;
const PUSH = 2n;
const PLAYER_NATURAL = 3n;

describe("BlackjackMath", () => {
  async function deploy() {
    const f = await ethers.getContractFactory("BlackjackMathHarness");
    const h = await f.deploy();
    await h.waitForDeployment();
    return h;
  }

  // ------------------------------------------------------------- card decoding

  describe("card values", () => {
    it("decodes ranks to blackjack values", async () => {
      const h = await deploy();
      const cases: [number, number, boolean][] = [
        [ACE, 1, true],
        [TWO, 2, false],
        [NINE, 9, false],
        [TEN, 10, false],
        [JACK, 10, false],
        [QUEEN, 10, false],
        [KING, 10, false],
      ];
      for (const [rank, value, isAce] of cases) {
        const [v, a] = await h.cardValue(c(rank));
        expect(v, `rank ${rank} value`).to.equal(value);
        expect(a, `rank ${rank} isAce`).to.equal(isAce);
      }
    });

    it("ignores suit", async () => {
      const h = await deploy();
      for (let suit = 0; suit < 4; suit++) {
        const [v, a] = await h.cardValue(c(KING, suit));
        expect(v).to.equal(10);
        expect(a).to.equal(false);
      }
      // All four aces are aces.
      for (let suit = 0; suit < 4; suit++) {
        const [, a] = await h.cardValue(c(ACE, suit));
        expect(a).to.equal(true);
      }
    });
  });

  // ------------------------------------------------------------- hand totals

  describe("evaluate", () => {
    it("totals hard hands", async () => {
      const h = await deploy();
      const [t, soft] = await h.evaluate([c(TEN), c(SEVEN)]);
      expect(t).to.equal(17);
      expect(soft).to.equal(false);
    });

    it("counts an ace as 11 when it does not bust", async () => {
      const h = await deploy();
      const [t, soft] = await h.evaluate([c(ACE), c(SIX)]);
      expect(t).to.equal(17); // soft 17
      expect(soft).to.equal(true);
    });

    it("counts an ace as 1 when 11 would bust", async () => {
      const h = await deploy();
      const [t, soft] = await h.evaluate([c(ACE), c(SIX), c(KING)]);
      expect(t).to.equal(17); // 1 + 6 + 10, hard
      expect(soft).to.equal(false);
    });

    it("counts only one ace as 11 with multiple aces", async () => {
      const h = await deploy();
      const [t, soft] = await h.evaluate([c(ACE), c(ACE, 1)]);
      expect(t).to.equal(12); // 11 + 1
      expect(soft).to.equal(true);
    });

    it("handles four aces", async () => {
      const h = await deploy();
      const [t, soft] = await h.evaluate([c(ACE), c(ACE, 1), c(ACE, 2), c(ACE, 3)]);
      expect(t).to.equal(14); // 11 + 1 + 1 + 1
      expect(soft).to.equal(true);
    });

    it("reports a bust total above 21", async () => {
      const h = await deploy();
      const [t] = await h.evaluate([c(KING), c(QUEEN), c(FIVE)]);
      expect(t).to.equal(25);
    });

    it("gives exactly 21 on a three card 21", async () => {
      const h = await deploy();
      const [t] = await h.evaluate([c(SEVEN), c(SEVEN, 1), c(SEVEN, 2)]);
      expect(t).to.equal(21);
    });
  });

  // ---------------------------------------------------------------- naturals

  describe("naturals", () => {
    it("recognises a two card 21", async () => {
      const h = await deploy();
      expect(await h.isNatural([c(ACE), c(KING)])).to.equal(true);
      expect(await h.isNatural([c(JACK), c(ACE, 1)])).to.equal(true);
    });

    it("rejects a three card 21", async () => {
      const h = await deploy();
      // A three card 21 is a plain win, not a natural. It does not pay 6:5.
      expect(await h.isNatural([c(SEVEN), c(SEVEN, 1), c(SEVEN, 2)])).to.equal(false);
    });

    it("rejects two cards that are not 21", async () => {
      const h = await deploy();
      expect(await h.isNatural([c(ACE), c(NINE)])).to.equal(false);
    });
  });

  // ------------------------------------------------------------ dealer rules

  describe("dealer draw rule, S17", () => {
    it("hits everything below 17", async () => {
      const h = await deploy();
      for (let t = 4; t < 17; t++) {
        expect(await h.dealerMustHit(t, false, false), `hard ${t}`).to.equal(true);
      }
    });

    it("stands on hard 17 and above", async () => {
      const h = await deploy();
      for (let t = 17; t <= 21; t++) {
        expect(await h.dealerMustHit(t, false, false), `hard ${t}`).to.equal(false);
      }
    });

    it("stands on soft 17 under S17", async () => {
      const h = await deploy();
      expect(await h.dealerMustHit(17, true, false)).to.equal(false);
    });

    it("hits soft 17 when the dormant flag is enabled", async () => {
      const h = await deploy();
      // The entire H17 change. Off in v1.
      expect(await h.dealerMustHit(17, true, true)).to.equal(true);
      // and still stands on hard 17
      expect(await h.dealerMustHit(17, false, true)).to.equal(false);
    });
  });

  describe("playDealer", () => {
    it("stands immediately on a pat hand and uses no draws", async () => {
      const h = await deploy();
      const [total, used, bust] = await h.playDealer([c(KING), c(SEVEN)], [c(FIVE), c(FIVE, 1)], false);
      expect(total).to.equal(17);
      expect(used).to.equal(0n);
      expect(bust).to.equal(false);
    });

    it("draws until it reaches 17", async () => {
      const h = await deploy();
      // 5 + 5 = 10, draw 4 -> 14, draw 3 -> 17, stop.
      const [total, used, bust] = await h.playDealer(
        [c(FIVE), c(FIVE, 1)],
        [c(FOUR), c(THREE), c(KING)],
        false
      );
      expect(total).to.equal(17);
      expect(used).to.equal(2n);
      expect(bust).to.equal(false);
    });

    it("busts when it must draw and overshoots", async () => {
      const h = await deploy();
      // 10 + 6 = 16, must hit, draw king -> 26.
      const [total, used, bust] = await h.playDealer([c(KING), c(SIX)], [c(KING, 1)], false);
      expect(total).to.equal(26);
      expect(used).to.equal(1n);
      expect(bust).to.equal(true);
    });

    it("uses a soft ace to avoid busting", async () => {
      const h = await deploy();
      // 10 + 6 = 16, draw ace -> 17 hard (11 would bust).
      const [total, , bust] = await h.playDealer([c(KING), c(SIX)], [c(ACE)], false);
      expect(total).to.equal(17);
      expect(bust).to.equal(false);
    });

    it("covers the documented worst case within MAX_DEALER_DRAWS", async () => {
      const h = await deploy();
      const max = Number(await h.maxDealerDraws());
      // The stated worst case: 2,2 then nothing but twos.
      // 4 -> 6 -> 8 -> 10 -> 12 -> 14 -> 16 -> 18, seven draws.
      const draws = [c(TWO, 1), c(TWO, 2), c(TWO, 3), c(TWO), c(TWO, 1), c(TWO, 2), c(TWO, 3)];
      expect(draws.length).to.be.lessThanOrEqual(max);
      const [total, used, bust] = await h.playDealer([c(TWO), c(TWO, 1)], draws, false);
      expect(used).to.equal(7n);
      expect(total).to.equal(18);
      expect(bust).to.equal(false);
    });
  });

  // -------------------------------------------------------------- bust index

  describe("bustIndex", () => {
    it("returns the card count when the hand never busts", async () => {
      const h = await deploy();
      expect(await h.bustIndex([c(TEN), c(FIVE), c(FOUR)])).to.equal(3n);
    });

    it("finds the card that busted the hand", async () => {
      const h = await deploy();
      // 10, 9 = 19, then 5 busts on the third card.
      expect(await h.bustIndex([c(TEN), c(NINE), c(FIVE)])).to.equal(3n);
    });

    it("ignores cards taken after the bust", async () => {
      const h = await deploy();
      // Busts on card 3. Cards 4 and 5 are the player hitting a dead hand,
      // which the contract permits because it is self-punishing.
      expect(await h.bustIndex([c(TEN), c(NINE), c(FIVE), c(TWO), c(THREE)])).to.equal(3n);
    });
  });

  // ---------------------------------------------------------------- outcomes

  describe("settle", () => {
    const noDraws: number[] = [];

    it("player bust loses even if the dealer would also bust", async () => {
      const h = await deploy();
      const [outcome] = await h.settle(
        [c(TEN), c(NINE), c(FIVE)], // 24
        [c(KING), c(SIX)], // would bust on a king
        [c(KING, 1)],
        false
      );
      expect(outcome).to.equal(DEALER_WINS);
    });

    it("player natural beats a non-natural dealer 21", async () => {
      const h = await deploy();
      const [outcome, pTotal] = await h.settle(
        [c(ACE), c(KING)],
        [c(SEVEN), c(SEVEN, 1)], // 14, would draw to 21
        [c(SEVEN, 2)],
        false
      );
      expect(outcome).to.equal(PLAYER_NATURAL);
      expect(pTotal).to.equal(21);
    });

    it("pushes when both have naturals", async () => {
      const h = await deploy();
      const [outcome] = await h.settle([c(ACE), c(KING)], [c(ACE, 1), c(QUEEN)], noDraws, false);
      expect(outcome).to.equal(PUSH);
    });

    it("dealer natural beats a player 21 made from three cards", async () => {
      const h = await deploy();
      const [outcome] = await h.settle(
        [c(SEVEN), c(SEVEN, 1), c(SEVEN, 2)], // 21, not a natural
        [c(ACE), c(KING)],
        noDraws,
        false
      );
      expect(outcome).to.equal(DEALER_WINS);
    });

    it("player wins when the dealer busts", async () => {
      const h = await deploy();
      const [outcome, pTotal, dTotal] = await h.settle(
        [c(TEN), c(EIGHT)], // 18
        [c(KING), c(SIX)], // 16, must draw
        [c(KING, 1)], // busts to 26
        false
      );
      expect(outcome).to.equal(PLAYER_WINS);
      expect(pTotal).to.equal(18);
      expect(dTotal).to.equal(26);
    });

    it("player wins on the higher total", async () => {
      const h = await deploy();
      const [outcome] = await h.settle([c(TEN), c(NINE)], [c(TEN, 1), c(SEVEN)], noDraws, false);
      expect(outcome).to.equal(PLAYER_WINS);
    });

    it("dealer wins on the higher total", async () => {
      const h = await deploy();
      const [outcome] = await h.settle([c(TEN), c(SEVEN)], [c(TEN, 1), c(NINE)], noDraws, false);
      expect(outcome).to.equal(DEALER_WINS);
    });

    it("pushes on equal totals", async () => {
      const h = await deploy();
      const [outcome, p, d] = await h.settle([c(TEN), c(NINE)], [c(TEN, 1), c(NINE, 1)], noDraws, false);
      expect(outcome).to.equal(PUSH);
      expect(p).to.equal(19);
      expect(d).to.equal(19);
    });

    it("reports how many committed draws the dealer actually used", async () => {
      const h = await deploy();
      // Dealer 5+5=10, draws 4 -> 14, 3 -> 17. Two of five committed draws used.
      const [, , dTotal, used] = await h.settle(
        [c(TEN), c(EIGHT)],
        [c(FIVE), c(FIVE, 1)],
        [c(FOUR), c(THREE), c(KING), c(KING, 1), c(KING, 2)],
        false
      );
      expect(dTotal).to.equal(17);
      expect(used).to.equal(2n);
    });

    it("S17 and H17 can produce different outcomes on the same cards", async () => {
      const h = await deploy();
      const player = [c(TEN), c(EIGHT)]; // 18
      const dealer = [c(ACE), c(SIX)]; // soft 17
      const draws = [c(FOUR)]; // would make 21 if drawn

      const [s17] = await h.settle(player, dealer, draws, false);
      expect(s17, "S17: dealer stands on soft 17 and loses to 18").to.equal(PLAYER_WINS);

      const [h17] = await h.settle(player, dealer, draws, true);
      expect(h17, "H17: dealer hits soft 17 to 21 and wins").to.equal(DEALER_WINS);
    });
  });
});
