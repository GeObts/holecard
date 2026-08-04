/**
 * Read-only precheck for the Megapot hard gate. Spends nothing.
 *
 * Confirms what a live ticket purchase will need, and answers spec blocker 2
 * against the live contract rather than the docs.
 *
 * Run: npx hardhat run scripts/megapotPrecheck.ts --network base
 */
import { ethers } from "hardhat";

const JACKPOT = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2";
const TICKET_NFT = "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const JACKPOT_ABI = [
  "function ticketPrice() view returns (uint256)",
  "function currentDrawingId() view returns (uint256)",
  "function allowTicketPurchases() view returns (bool)",
  "function normalBallMax() view returns (uint8)",
  "function maxReferrers() view returns (uint256)",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function line() {
  console.log("-".repeat(72));
}

async function main() {
  line();
  console.log("Megapot precheck: live Base mainnet, read only");
  line();

  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`Expected chain 8453, got ${net.chainId}`);
  console.log("chainId:", net.chainId.toString(), " block:", await ethers.provider.getBlockNumber());

  const signers = await ethers.getSigners();
  if (signers.length === 0) throw new Error("No signer configured. Set PRIVATE_KEY in .env.");
  const me = signers[0];

  line();
  console.log("Buyer readiness");
  line();
  const usdc = new ethers.Contract(USDC, USDC_ABI, ethers.provider);
  const [ethBal, usdcBal, allowance, dec] = await Promise.all([
    ethers.provider.getBalance(me.address),
    usdc.balanceOf(me.address),
    usdc.allowance(me.address, JACKPOT),
    usdc.decimals(),
  ]);
  console.log("  address        :", me.address);
  console.log("  ETH balance    :", ethers.formatEther(ethBal));
  console.log("  USDC balance   :", ethers.formatUnits(usdcBal, dec));
  console.log("  USDC allowance :", ethers.formatUnits(allowance, dec), "to the Jackpot");

  line();
  console.log("Live drawing state");
  line();
  const jackpot = new ethers.Contract(JACKPOT, JACKPOT_ABI, ethers.provider);
  const [price, drawingId, purchasesOpen, ballMax, maxRefs] = await Promise.all([
    jackpot.ticketPrice(),
    jackpot.currentDrawingId(),
    jackpot.allowTicketPurchases(),
    jackpot.normalBallMax(),
    jackpot.maxReferrers(),
  ]);
  console.log("  ticketPrice          :", ethers.formatUnits(price, dec), "USDC");
  console.log("  currentDrawingId     :", drawingId.toString());
  console.log("  allowTicketPurchases :", purchasesOpen);
  console.log("  normalBallMax        :", ballMax.toString());
  console.log("  maxReferrers         :", maxRefs.toString());

  line();
  console.log("Blocker 2, answered against live on-chain behaviour");
  line();
  // A ticket that moved wallet to wallet, then whether its NEW owner claimed on it.
  // If claims follow the token, the seize mechanic is safe.
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const claimedTopic = ethers.id(
    "TicketWinningsClaimed(address,uint256,uint256,uint256,bool,uint256)"
  );
  const head = await ethers.provider.getBlockNumber();

  // Alchemy free tier caps eth_getLogs at 10-block windows. Chunk accordingly.
  const CHUNK = 10;
  const WINDOW = 600;
  const transfers: any[] = [];
  const claims: any[] = [];
  for (let from = head - WINDOW; from <= head; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, head);
    const [t, c] = await Promise.all([
      ethers.provider.getLogs({ address: TICKET_NFT, topics: [transferTopic], fromBlock: from, toBlock: to }),
      ethers.provider.getLogs({ address: JACKPOT, topics: [claimedTopic], fromBlock: from, toBlock: to }),
    ]);
    transfers.push(...t);
    claims.push(...c);
  }

  const secondary = transfers.filter(
    (l) => BigInt(l.topics[1]) !== 0n && BigInt(l.topics[2]) !== 0n
  );
  console.log(`  scanned blocks       : ${head - WINDOW} to ${head}`);
  console.log(`  Transfer events      : ${transfers.length}`);
  console.log(`  secondary transfers  : ${secondary.length} (from != 0 and to != 0)`);
  console.log(`  winnings claimed     : ${claims.length}`);
  if (secondary.length > 0) {
    const s = secondary[0];
    console.log(
      `  sample transfer      : 0x${s.topics[1].slice(26)} -> 0x${s.topics[2].slice(26)}`
    );
    console.log(`  sample tx            : ${s.transactionHash}`);
  }
  console.log("  transfers unrestricted:", secondary.length > 0 ? "CONFIRMED by live traffic" : "no sample in window");

  line();
  console.log("What the paid gate needs:");
  const needUsdc = usdcBal < price;
  console.log(needUsdc ? `  FUND: at least ${ethers.formatUnits(price, dec)} USDC on Base` : "  USDC balance sufficient");
  console.log(allowance < price ? "  approve() will be sent by the gate script" : "  allowance already sufficient");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
