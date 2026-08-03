/**
 * Read-only precheck. Needs no private key and spends nothing.
 *
 * Confirms, against live Base mainnet:
 *   - the Inco executor and verifier have bytecode
 *   - the SDK binds to the mainnet deployment and agrees with the on-chain address
 *   - the live per-op fee, read from the chain rather than the source constant
 *   - the Megapot Jackpot and JackpotTicketNFT contracts are present
 *
 * Run: npx hardhat run scripts/precheck.ts --network base
 */
import { ethers } from "hardhat";
import { Lightning } from "@inco/lightning-js/lite";

const INCO_EXECUTOR = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624";
const INCO_VERIFIER = "0x867758FFe098fB0D74826A8DCf60127696440f09";
const MEGAPOT_JACKPOT = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2";
const MEGAPOT_TICKET_NFT = "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4";

// viem tries these in order on failure. Set BASE_RPC_URL to a dedicated provider
// to put it first. The public endpoints rate limit hard under any real load.
const RPC_URLS: string[] = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

function line() {
  console.log("-".repeat(72));
}

async function codeAt(addr: string, label: string) {
  const code = await ethers.provider.getCode(addr);
  const bytes = (code.length - 2) / 2;
  console.log(`${label.padEnd(22)} ${addr}  ${bytes > 0 ? `${bytes} bytes` : "NO CODE"}`);
  return bytes > 0;
}

async function main() {
  line();
  console.log("Hole Card precheck: live Base mainnet, read only");
  line();

  const net = await ethers.provider.getNetwork();
  console.log("chainId:", net.chainId.toString());
  console.log("block  :", await ethers.provider.getBlockNumber());
  if (net.chainId !== 8453n) throw new Error(`Expected chain 8453, got ${net.chainId}`);

  line();
  const ok = [
    await codeAt(INCO_EXECUTOR, "Inco executor"),
    await codeAt(INCO_VERIFIER, "Inco verifier"),
    await codeAt(MEGAPOT_JACKPOT, "Megapot Jackpot"),
    await codeAt(MEGAPOT_TICKET_NFT, "Megapot TicketNFT"),
  ];
  if (ok.some((x) => !x)) throw new Error("A required contract has no bytecode on 8453");

  // getFee() is `public pure` on the Inco Fee module, so a static call is safe and free.
  line();
  const feeAbi = ["function getFee() pure returns (uint256)"];
  const incoRead = new ethers.Contract(INCO_EXECUTOR, feeAbi, ethers.provider);
  const fee: bigint = await incoRead.getFee();
  console.log("live inco fee per op:", ethers.formatEther(fee), "ETH");

  line();
  console.log("Binding the SDK to Base mainnet...");
  // The SDK opens its own RPC connection. Left to itself it hits the public
  // endpoint and gets 429ed, so hand it the same fallback list the app uses.
  const lightning = await Lightning.baseMainnet({ hostChainRpcUrls: RPC_URLS });
  const d = lightning.deployment as Record<string, unknown>;
  console.log("deployment name :", d.name);
  console.log("chainId         :", String(d.chainId));
  console.log("chainName       :", d.chainName);
  console.log("executorAddress :", d.executorAddress);
  console.log("active          :", String(d.active));
  console.log("pepper          :", d.pepper);

  const sdkExecutor = String(d.executorAddress).toLowerCase();
  if (sdkExecutor !== INCO_EXECUTOR.toLowerCase()) {
    throw new Error(`SDK executor ${sdkExecutor} does not match expected ${INCO_EXECUTOR}`);
  }
  if (String(d.chainId) !== "8453") {
    throw new Error(`SDK bound to chain ${d.chainId}, expected 8453`);
  }

  line();
  console.log("PRECHECK PASSED. Everything the game needs is live on one chain.");
  console.log("Next: fund the deployer and run `npm run smoke:mainnet` for the paid gate.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
