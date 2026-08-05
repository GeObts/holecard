/**
 * Read-only. Computes a Megapot ticket's expected value from LIVE drawing state.
 *
 * The spec requires the buyback window be derived from live state, never assumed.
 * The sellback price in decision 2 is only profitable if EV > sellback price.
 *
 * Run: npx hardhat run scripts/ticketEV.ts --network base
 */
import { ethers } from "hardhat";

const JACKPOT = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2";

const ABI = [
  "function currentDrawingId() view returns (uint256)",
  "function getDrawingState(uint256) view returns (tuple(uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
  "function getDrawingTierPayouts(uint256 _drawingId) view returns (uint256[12])",
];

const USDC_DEC = 6;

function line() {
  console.log("-".repeat(72));
}

/** n choose k, exact with BigInt. */
function choose(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0; i < k; i++) {
    r = (r * BigInt(n - i)) / BigInt(i + 1);
  }
  return r;
}

async function main() {
  const jackpot = new ethers.Contract(JACKPOT, ABI, ethers.provider);
  const drawingId: bigint = await jackpot.currentDrawingId();
  const st = await jackpot.getDrawingState(drawingId);
  const payouts: bigint[] = await jackpot.getDrawingTierPayouts(drawingId);

  const ballMax = Number(st.ballMax);
  const bonusballMax = Number(st.bonusballMax);
  const NORMALS = 5;

  line();
  console.log("Megapot ticket expected value, from live drawing state");
  line();
  console.log("  drawingId     :", drawingId.toString());
  console.log("  ticketPrice   :", ethers.formatUnits(st.ticketPrice, USDC_DEC), "USDC");
  console.log("  edgePerTicket :", ethers.formatUnits(st.edgePerTicket, USDC_DEC), "USDC");
  console.log("  prizePool     :", ethers.formatUnits(st.prizePool, USDC_DEC), "USDC");
  console.log("  ballMax       :", ballMax, " bonusballMax:", bonusballMax);

  // Total distinct tickets = C(ballMax, 5) * bonusballMax
  const totalNormalCombos = choose(ballMax, NORMALS);
  const totalCombos = totalNormalCombos * BigInt(bonusballMax);
  console.log("  C(ballMax,5)  :", totalNormalCombos.toString());
  console.log("  total combos  :", totalCombos.toString());

  line();
  console.log("Per-tier payouts and probabilities");
  line();
  console.log(
    "  matches  bonus     payout USDC        probability        contribution USDC"
  );

  // Work in a scaled rational space to keep precision.
  // P(exactly j normals) = C(5,j)*C(ballMax-5, 5-j) / C(ballMax,5)
  // P(bonus hit) = 1/bonusballMax
  const SCALE = 10n ** 18n;
  let evScaled = 0n; // USDC 6dp, scaled by SCALE

  for (let j = 0; j <= NORMALS; j++) {
    const waysNormals = choose(NORMALS, j) * choose(ballMax - NORMALS, NORMALS - j);
    for (let b = 0; b <= 1; b++) {
      const tierId = j * 2 + b;
      const payout = payouts[tierId];
      // ways for the bonusball: 1 matching, bonusballMax-1 not matching
      const waysBonus = b === 1 ? 1n : BigInt(bonusballMax - 1);
      const ways = waysNormals * waysBonus;
      // probability = ways / totalCombos
      const probScaled = (ways * SCALE) / totalCombos;
      const contribScaled = (payout * probScaled) / SCALE;
      evScaled += contribScaled * SCALE;

      if (payout > 0n || j >= 3) {
        const probPct = Number(probScaled) / Number(SCALE);
        console.log(
          `  ${String(j).padStart(7)}  ${String(b === 1 ? "yes" : "no").padStart(5)}` +
            `  ${ethers.formatUnits(payout, USDC_DEC).padStart(16)}` +
            `  ${probPct.toExponential(6).padStart(16)}` +
            `  ${ethers.formatUnits(contribScaled, USDC_DEC).padStart(16)}`
        );
      }
    }
  }

  const ev = evScaled / SCALE; // back to USDC 6dp
  const evNum = Number(ethers.formatUnits(ev, USDC_DEC));
  const priceNum = Number(ethers.formatUnits(st.ticketPrice, USDC_DEC));
  const referralFeeFrac = Number(st.referralFee) / 1e18;

  line();
  console.log("RESULT");
  line();
  console.log("  ticket EV                    :", evNum.toFixed(6), "USDC");
  console.log("  ticket face                  :", priceNum.toFixed(6), "USDC");
  console.log("  return to player             :", ((evNum / priceNum) * 100).toFixed(2), "%");
  console.log("  implied edge per ticket      :", (priceNum - evNum).toFixed(6), "USDC");
  console.log("  edgePerTicket reported live  :", ethers.formatUnits(st.edgePerTicket, USDC_DEC), "USDC");

  line();
  console.log("Sellback economics for decision 2");
  line();
  const netCost = priceNum * (1 - referralFeeFrac);
  console.log("  referral rebate              :", (referralFeeFrac * 100).toFixed(1), "%");
  console.log("  our net cost basis per ticket:", netCost.toFixed(4), "USDC");
  for (const p of [0.7, 0.75, 0.8, 0.85, 0.9]) {
    const marginVsEv = evNum - p;
    const verdict = marginVsEv > 0 ? "PROFIT" : "LOSS  ";
    console.log(
      `  buy back at ${p.toFixed(2)}  ->  vs EV ${marginVsEv >= 0 ? "+" : ""}${marginVsEv.toFixed(4)}  ${verdict}`
    );
  }

  line();
  console.log("Note: EV excludes referralWinShare, which is taken OUT of winnings.");
  const winShare = Number(st.referralWinShare) / 1e18;
  console.log("  referralWinShare             :", (winShare * 100).toFixed(1), "%");
  console.log("  EV net of win share to holder:", (evNum * (1 - winShare)).toFixed(6), "USDC");
  console.log("  ...but that share returns to the treasury, so to the HOUSE the");
  console.log("  full EV is retained when the house holds the ticket.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
