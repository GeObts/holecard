/**
 * Read-only diagnosis of the incoFee() empty-return failure.
 * Spends nothing. Deploys nothing.
 *
 * Run: npx hardhat run scripts/diagnose.ts --network base
 */
import { ethers } from "hardhat";
import artifact from "../artifacts/contracts/IncoSmoke.sol/IncoSmoke.json";

const DEPLOYED = "0xC45A67fECb56Ff9F6fC199cb17f551C1e681DD01";
const INCO_EXECUTOR = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624";

const RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

function line() {
  console.log("-".repeat(72));
}

async function main() {
  line();
  console.log("1. IncoSmoke ABI from the compiled artifact");
  line();
  const iface = new ethers.Interface(artifact.abi as any);
  for (const f of artifact.abi as any[]) {
    if (f.type !== "function") continue;
    const frag = iface.getFunction(f.name);
    console.log(
      `  ${frag!.format("sighash").padEnd(24)} selector=${frag!.selector}  mutability=${f.stateMutability}`
    );
  }

  line();
  console.log("2. Bytecode presence, per RPC endpoint");
  line();
  for (const url of RPCS) {
    const p = new ethers.JsonRpcProvider(url, 8453);
    try {
      const [blk, codeSmoke, codeInco] = await Promise.all([
        p.getBlockNumber(),
        p.getCode(DEPLOYED),
        p.getCode(INCO_EXECUTOR),
      ]);
      console.log(
        `  ${url.padEnd(34)} block=${blk} IncoSmoke=${(codeSmoke.length - 2) / 2}B executor=${(codeInco.length - 2) / 2}B`
      );
    } catch (e) {
      console.log(`  ${url.padEnd(34)} ERROR ${(e as Error).message.split("\n")[0]}`);
    }
  }

  line();
  console.log("3. Raw eth_call of IncoSmoke.incoFee(), per RPC endpoint");
  line();
  const incoFeeData = iface.getFunction("incoFee")!.selector;
  for (const url of RPCS) {
    const p = new ethers.JsonRpcProvider(url, 8453);
    try {
      const raw = await p.call({ to: DEPLOYED, data: incoFeeData });
      console.log(`  ${url.padEnd(34)} returned "${raw}" (${(raw.length - 2) / 2} bytes)`);
    } catch (e) {
      console.log(`  ${url.padEnd(34)} REVERT ${(e as Error).message.split("\n")[0]}`);
    }
  }

  line();
  console.log("4. Raw eth_call of getFee() directly on the Inco executor");
  line();
  const getFeeSelector = ethers.id("getFee()").slice(0, 10);
  console.log("  getFee() selector:", getFeeSelector);
  for (const url of RPCS) {
    const p = new ethers.JsonRpcProvider(url, 8453);
    try {
      const raw = await p.call({ to: INCO_EXECUTOR, data: getFeeSelector });
      const decoded = raw === "0x" ? "EMPTY" : ethers.formatEther(BigInt(raw));
      console.log(`  ${url.padEnd(34)} "${raw}" -> ${decoded}`);
    } catch (e) {
      console.log(`  ${url.padEnd(34)} REVERT ${(e as Error).message.split("\n")[0]}`);
    }
  }

  line();
  console.log("5. Deployed runtime bytecode vs compiled artifact");
  line();
  const p = new ethers.JsonRpcProvider(RPCS[0], 8453);
  const onchain = await p.getCode(DEPLOYED);
  const compiled = (artifact as any).deployedBytecode as string;
  console.log("  on-chain length :", (onchain.length - 2) / 2, "bytes");
  console.log("  artifact length :", (compiled.length - 2) / 2, "bytes");
  console.log("  exact match     :", onchain.toLowerCase() === compiled.toLowerCase());
  console.log("  contains incoFee selector:", onchain.includes(incoFeeData.slice(2)));
  console.log("  contains getFee  selector:", onchain.includes(getFeeSelector.slice(2)));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
