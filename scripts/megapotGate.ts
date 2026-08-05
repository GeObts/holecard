/**
 * Megapot hard gate. Spends 1 real USDC on live Base mainnet.
 *
 * Proves the five things TicketVault depends on:
 *   1. buyTickets mints a real NFT and returns ticket IDs
 *   2. the ticket numbers are readable back off the NFT
 *   3. the bytes32 _source tag is readable on-chain and filterable
 *   4. the ticket transfers to a second address
 *   5. ownerOf confirms the move
 *
 * Run: npx hardhat run scripts/megapotGate.ts --network base
 */
import { ethers } from "hardhat";

const JACKPOT = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2";
const TICKET_NFT = "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Referral weights are PRECISE_UNIT scaled and must sum to PRECISE_UNIT.
const PRECISE_UNIT = 10n ** 18n;

// Telemetry tag on every purchase. This is how Megapot measures volume we drove.
const SOURCE_TAG = ethers.encodeBytes32String("holecard");

const JACKPOT_ABI = [
  "function buyTickets((uint8[] normals, uint8 bonusball)[] _tickets, address _recipient, address[] _referrers, uint256[] _referralSplit, bytes32 _source) returns (uint256[] ticketIds)",
  "function currentDrawingId() view returns (uint256)",
  "function getDrawingState(uint256) view returns (tuple(uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
  "function getUnpackedTicket(uint256 _drawingId, uint256 _packedTicket) view returns (uint8[], uint8)",
  "event TicketPurchased(address indexed recipient, uint256 indexed currentDrawingId, bytes32 indexed source, uint256 userTicketId, uint8[] normals, uint8 bonusball, bytes32 referralScheme)",
];
const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function getTicketInfo(uint256) view returns (tuple(uint256 drawingId, uint256 packedTicket, bytes32 referralScheme))",
  "function transferFrom(address,address,uint256) payable",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

function line() {
  console.log("-".repeat(72));
}

const results: Record<string, string> = {};

/** Wait until the provider has caught up to a block, so pinned reads resolve. */
async function waitForBlock(n: number, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if ((await ethers.provider.getBlockNumber()) >= n) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Provider still behind block ${n} after ${tries} tries`);
}

/**
 * Read a view function pinned to a specific block.
 *
 * Standing rule: never read state immediately after a write against the latest
 * tag. A load balanced RPC can route the read to a node one block behind and
 * return zero values, which then propagate into downstream calls as confusing
 * reverts rather than as an obvious staleness error.
 */
async function readAt<T>(
  contract: any,
  fn: string,
  args: any[],
  blockTag: number
): Promise<T> {
  const raw = await ethers.provider.call({
    to: contract.target as string,
    data: contract.interface.encodeFunctionData(fn, args),
    blockTag,
  });
  return contract.interface.decodeFunctionResult(fn, raw)[0] as T;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`Expected chain 8453, got ${net.chainId}`);

  const signers = await ethers.getSigners();
  if (signers.length === 0) throw new Error("No signer. Set PRIVATE_KEY in .env.");
  const buyer = signers[0];

  const second = process.env.SECOND_ADDRESS;
  if (!second || !ethers.isAddress(second)) {
    throw new Error("SECOND_ADDRESS is not set to a valid address in .env");
  }
  if (second.toLowerCase() === buyer.address.toLowerCase()) {
    throw new Error("SECOND_ADDRESS must differ from the buyer");
  }
  // A contract recipient could strand the ticket. Refuse.
  if ((await ethers.provider.getCode(second)) !== "0x") {
    throw new Error("SECOND_ADDRESS has bytecode. Use an EOA or the ticket may be stranded.");
  }

  line();
  console.log("Megapot hard gate: live Base mainnet, spends 1 USDC");
  line();
  console.log("buyer          :", buyer.address);
  console.log("second address :", second);
  console.log("source tag     :", SOURCE_TAG, `(${ethers.decodeBytes32String(SOURCE_TAG)})`);

  const usdc = new ethers.Contract(USDC, USDC_ABI, buyer);
  const jackpot = new ethers.Contract(JACKPOT, JACKPOT_ABI, buyer);
  const nft = new ethers.Contract(TICKET_NFT, NFT_ABI, buyer);

  const dec: bigint = await usdc.decimals();
  const drawingId: bigint = await jackpot.currentDrawingId();
  const st = await jackpot.getDrawingState(drawingId);

  line();
  console.log("Live drawing state, read fresh, nothing hardcoded");
  line();
  console.log("  drawingId        :", drawingId.toString());
  console.log("  ticketPrice      :", ethers.formatUnits(st.ticketPrice, dec), "USDC");
  console.log("  ballMax          :", st.ballMax.toString());
  console.log("  bonusballMax     :", st.bonusballMax.toString());
  console.log("  referralFee      :", st.referralFee.toString());
  console.log("  referralWinShare :", st.referralWinShare.toString());
  console.log("  prizePool        :", ethers.formatUnits(st.prizePool, dec), "USDC");
  console.log("  jackpotLock      :", st.jackpotLock);
  console.log("  drawingTime      :", new Date(Number(st.drawingTime) * 1000).toISOString());

  if (st.jackpotLock) throw new Error("Drawing is locked. Cannot buy right now.");

  // Build a valid ticket against the LIVE per-drawing bounds, not assumed ones.
  const ballMax = Number(st.ballMax);
  const bonusballMax = Number(st.bonusballMax);
  const normals: number[] = [];
  for (let n = 3; normals.length < 5 && n <= ballMax; n += 6) normals.push(n);
  if (normals.length < 5) throw new Error(`ballMax ${ballMax} too small to pick 5 unique normals`);
  const bonusball = Math.min(7, bonusballMax);
  console.log("  chosen normals   :", normals.join(", "), "bonusball", bonusball);

  const price: bigint = st.ticketPrice;
  const bal: bigint = await usdc.balanceOf(buyer.address);
  if (bal < price) {
    throw new Error(`Need ${ethers.formatUnits(price, dec)} USDC, have ${ethers.formatUnits(bal, dec)}`);
  }

  // 1. Buy, or resume from an already purchased ticket so a rerun costs nothing.
  line();
  let rcpt: any;
  const resumeTx = process.env.BUY_TX;
  if (resumeTx) {
    console.log("Resuming from existing purchase tx:", resumeTx);
    rcpt = await ethers.provider.getTransactionReceipt(resumeTx);
    if (!rcpt || rcpt.status !== 1) throw new Error(`No successful receipt for ${resumeTx}`);
  } else {
    // Only approve when we are actually going to buy. Approving on a resume run
    // just burns gas.
    const allowance: bigint = await usdc.allowance(buyer.address, JACKPOT);
    if (allowance < price) {
      console.log("Approving USDC...");
      const aTx = await usdc.approve(JACKPOT, price);
      await aTx.wait();
      console.log("approved:", aTx.hash);
    }
    console.log("Calling buyTickets()...");
    const buyTx = await jackpot.buyTickets(
      [{ normals, bonusball }],
      buyer.address,
      [second],
      [PRECISE_UNIT],
      SOURCE_TAG
    );
    rcpt = await buyTx.wait();
    if (!rcpt || rcpt.status !== 1) throw new Error("buyTickets failed");
  }
  console.log("tx        :", rcpt.hash);
  console.log("block     :", rcpt.blockNumber);
  console.log("gas used  :", rcpt.gasUsed.toString());
  await waitForBlock(rcpt.blockNumber);

  // Parse the ticket out of the receipt. Never read state straight after a write.
  let ticketId: bigint | null = null;
  let evNormals: number[] = [];
  let evBonusball = 0;
  let evSource = "";
  let evReferralScheme = "";
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== JACKPOT.toLowerCase()) continue;
    try {
      const p = jackpot.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === "TicketPurchased") {
        ticketId = p.args.userTicketId as bigint;
        evNormals = (p.args.normals as bigint[]).map(Number);
        evBonusball = Number(p.args.bonusball);
        evSource = p.args.source as string;
        evReferralScheme = p.args.referralScheme as string;
      }
    } catch {
      /* other Megapot events */
    }
  }
  if (ticketId === null) throw new Error("No TicketPurchased event found");

  results["1. ticket mints, IDs returned"] = `PASS  id ${ticketId.toString()}`;
  console.log("ticketId  :", ticketId.toString());

  // 2. Numbers readable back off the NFT, independently of the event
  line();
  console.log("Reading the ticket back off the NFT...");
  // Pinned to the buy block. Reading this at "latest" straight after the write
  // returned all zeros, which then made getUnpackedTicket revert with an
  // arithmetic panic rather than an obvious staleness error.
  const info = await readAt<any>(nft, "getTicketInfo", [ticketId], rcpt.blockNumber);
  const [nftNormals, nftBonus] = await jackpot.getUnpackedTicket(info[0], info[1]);
  const decoded = (nftNormals as bigint[]).map(Number);
  console.log("  from event : normals", evNormals.join(","), "bonusball", evBonusball);
  console.log("  from NFT   : normals", decoded.join(","), "bonusball", Number(nftBonus));
  console.log("  drawingId  :", info[0].toString());
  console.log("  packedTicket:", info[1].toString());
  console.log("  referralScheme:", info[2]);

  const sortedEq =
    [...decoded].sort((a, b) => a - b).join(",") === [...normals].sort((a, b) => a - b).join(",") &&
    Number(nftBonus) === bonusball;
  results["2. numbers readable off NFT"] = sortedEq
    ? `PASS  ${decoded.join(",")} + ${Number(nftBonus)}`
    : `FAIL  got ${decoded.join(",")} + ${Number(nftBonus)}`;

  // 3. Source tag on-chain and filterable
  line();
  console.log("Verifying the source tag on-chain...");
  console.log("  tag in receipt :", evSource);
  const topic0 = jackpot.interface.getEvent("TicketPurchased")!.topicHash;
  // source is the third indexed field, so topics[3]. One block, well inside the
  // Alchemy 10-block getLogs cap.
  const filtered = await ethers.provider.getLogs({
    address: JACKPOT,
    topics: [topic0, null, null, SOURCE_TAG],
    fromBlock: rcpt.blockNumber,
    toBlock: rcpt.blockNumber,
  });
  console.log("  logs matching the tag in that block:", filtered.length);
  const tagOk = evSource === SOURCE_TAG && filtered.length > 0;
  results["3. _source tag on-chain"] = tagOk
    ? `PASS  indexed topic, ${filtered.length} log matched by filter`
    : `FAIL  receipt ${evSource}, filter matched ${filtered.length}`;

  // 4 and 5. Transfer and ownership move
  line();
  const ownerBefore: string = await nft.ownerOf(ticketId);
  console.log("ownerOf before :", ownerBefore);

  let transferBlock: number;
  if (ownerBefore.toLowerCase() === second.toLowerCase()) {
    // Already moved on an earlier run. Do not try again, it would revert.
    console.log("Already owned by SECOND_ADDRESS, transfer step already done.");
    transferBlock = await ethers.provider.getBlockNumber();
    results["4. transfer to second address"] = "PASS  completed on an earlier run";
  } else {
    console.log("Transferring to SECOND_ADDRESS...");
    const tTx = await nft.transferFrom(buyer.address, second, ticketId);
    const tRcpt = await tTx.wait();
    if (!tRcpt || tRcpt.status !== 1) throw new Error("transferFrom failed");
    console.log("tx       :", tRcpt.hash);
    console.log("gas used :", tRcpt.gasUsed.toString());
    transferBlock = tRcpt.blockNumber;
    results["4. transfer to second address"] = `PASS  tx ${tRcpt.hash}`;
  }

  // Pinned to the transfer block. waitForBlock first, otherwise the provider can
  // reject the pinned read with "block not found" before it has caught up.
  await waitForBlock(transferBlock);
  const ownerAfter = await readAt<string>(nft, "ownerOf", [ticketId], transferBlock);
  console.log("ownerOf after  :", ownerAfter);
  results["5. ownerOf confirms move"] =
    ownerAfter.toLowerCase() === second.toLowerCase()
      ? `PASS  now ${ownerAfter}`
      : `FAIL  still ${ownerAfter}`;

  line();
  console.log("MEGAPOT GATE RESULTS");
  line();
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(32)} ${v}`);
  const spent = bal - (await usdc.balanceOf(buyer.address));
  console.log(`  USDC spent                       ${ethers.formatUnits(spent, dec)}`);
  line();
  if (Object.values(results).some((v) => v.startsWith("FAIL"))) {
    throw new Error("MEGAPOT GATE FAILED");
  }
  console.log("All five checks passed. Ticket is a live entry in drawing", drawingId.toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
