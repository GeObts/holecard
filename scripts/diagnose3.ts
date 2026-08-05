/**
 * Read-only. Why did getUnpackedTicket revert straight after the buy?
 * Run: npx hardhat run scripts/diagnose3.ts --network base
 */
import { ethers } from "hardhat";

const JACKPOT = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2";
const TICKET_NFT = "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4";
const TICKET_ID =
  77657553156602458125714478255993289153901569831186306335971610667421976962987n;
const BUY_BLOCK = 49550177;

const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function getTicketInfo(uint256) view returns (tuple(uint256 drawingId, uint256 packedTicket, bytes32 referralScheme))",
];
const JACKPOT_ABI = [
  "function getUnpackedTicket(uint256 _drawingId, uint256 _packedTicket) view returns (uint8[], uint8)",
];

function line() {
  console.log("-".repeat(72));
}

async function main() {
  const nft = new ethers.Contract(TICKET_NFT, NFT_ABI, ethers.provider);
  const jackpot = new ethers.Contract(JACKPOT, JACKPOT_ABI, ethers.provider);

  line();
  console.log("head block:", await ethers.provider.getBlockNumber(), " buy block:", BUY_BLOCK);

  line();
  console.log("getTicketInfo now (latest)");
  line();
  const now = await nft.getTicketInfo(TICKET_ID);
  console.log("  drawingId     :", now.drawingId.toString());
  console.log("  packedTicket  :", now.packedTicket.toString());
  console.log("  referralScheme:", now.referralScheme);
  console.log("  ownerOf       :", await nft.ownerOf(TICKET_ID));

  line();
  console.log("getTicketInfo pinned to the buy block");
  line();
  const raw = await ethers.provider.call({
    to: TICKET_NFT,
    data: nft.interface.encodeFunctionData("getTicketInfo", [TICKET_ID]),
    blockTag: BUY_BLOCK,
  });
  const atBlock = nft.interface.decodeFunctionResult("getTicketInfo", raw)[0];
  console.log("  drawingId     :", atBlock[0].toString());
  console.log("  packedTicket  :", atBlock[1].toString());

  line();
  console.log("getUnpackedTicket with the values read now");
  line();
  try {
    const [normals, bonus] = await jackpot.getUnpackedTicket(now.drawingId, now.packedTicket);
    console.log("  normals  :", (normals as bigint[]).map(Number).join(", "));
    console.log("  bonusball:", Number(bonus));
    console.log("  RESULT   : works. The earlier revert was stale input, not a bad call.");
  } catch (e) {
    console.log("  REVERT   :", (e as Error).message.split("\n")[0]);
  }

  line();
  console.log("Control: getUnpackedTicket(0, 0), the stale-read case");
  line();
  try {
    await jackpot.getUnpackedTicket(0n, 0n);
    console.log("  did not revert");
  } catch (e) {
    console.log("  REVERT   :", (e as Error).message.split("\n")[0]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
