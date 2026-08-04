/**
 * Read-only. Why did lastHandle() read back as zero after a successful draw?
 * Run: npx hardhat run scripts/diagnose2.ts --network base
 */
import { ethers } from "hardhat";
import artifact from "../artifacts/contracts/IncoSmoke.sol/IncoSmoke.json";

const SMOKE = "0xC45A67fECb56Ff9F6fC199cb17f551C1e681DD01";
const DRAW_TX = "0x2ac269ba1ae058e95a0763810d1ec579bf2453885ed93703c903c1bc990ddc08";

function line() {
  console.log("-".repeat(72));
}

async function main() {
  const iface = new ethers.Interface(artifact.abi as any);

  line();
  console.log("1. Current state read, via the configured provider");
  line();
  const c = await ethers.getContractAt("IncoSmoke", SMOKE);
  console.log("  block      :", await ethers.provider.getBlockNumber());
  console.log("  lastHandle :", await c.lastHandle());
  console.log("  drawCount  :", (await c.drawCount()).toString());

  line();
  console.log("2. The draw transaction receipt, which is authoritative");
  line();
  const rcpt = await ethers.provider.getTransactionReceipt(DRAW_TX);
  if (!rcpt) throw new Error("receipt not found");
  console.log("  status     :", rcpt.status === 1 ? "success" : "FAILED");
  console.log("  block      :", rcpt.blockNumber);
  console.log("  gasUsed    :", rcpt.gasUsed.toString());
  console.log("  logs       :", rcpt.logs.length);

  for (const log of rcpt.logs) {
    let parsed = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      /* not one of ours */
    }
    if (parsed) {
      console.log(`  OUR EVENT  : ${parsed.name}`);
      parsed.fragment.inputs.forEach((inp, i) => {
        console.log(`      ${inp.name} = ${String(parsed!.args[i])}`);
      });
    } else {
      console.log(`  other log  : from ${log.address} topic0 ${log.topics[0]}`);
    }
  }

  line();
  console.log("3. State read pinned to the block right after the draw");
  line();
  const raw = await ethers.provider.call({
    to: SMOKE,
    data: iface.getFunction("lastHandle")!.selector,
    blockTag: rcpt.blockNumber,
  });
  console.log("  lastHandle at draw block:", raw);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
