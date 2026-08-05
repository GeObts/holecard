/**
 * Isolate why a cross-transaction reveal does not become readable while a
 * same-transaction draw+reveal does.
 *
 * This matters beyond the test: BlackjackTable reveals the hole card at stand(),
 * which is necessarily a later transaction than deal(). If cross-tx reveal does
 * not work, the design has to change.
 *
 * Run: npx hardhat run scripts/diagnose4.ts --network base
 */
import { ethers } from "hardhat";
import { Lightning } from "@inco/lightning-js/lite";

const INCO_EXECUTOR = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624";
const INCO_SMOKE = "0xC45A67fECb56Ff9F6fC199cb17f551C1e681DD01";
const HOLE_PROOF = "0x8F018F022FfA28538a16e337338cDc37792704de";

const RPC_URLS: string[] = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
];

const INCO_ABI = ["function isAllowed(bytes32 handle, address account) view returns (bool)"];

function line() {
  console.log("-".repeat(72));
}

async function tryOnce(lightning: any, handle: string) {
  try {
    const att = await lightning.attestedReveal([handle], { backoffConfig: { maxRetries: 0 } });
    const v = att[0]?.plaintext?.value;
    return v === undefined || v === null ? null : BigInt(v);
  } catch {
    return null;
  }
}

async function poll(lightning: any, handle: string, ms: number, label: string) {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < ms) {
    n++;
    const v = await tryOnce(lightning, handle);
    if (v !== null) {
      console.log(`  ${label}: RESOLVED ${v} after ${((Date.now() - t0) / 1000).toFixed(1)}s (${n} tries)`);
      return v;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  ${label}: never resolved in ${ms / 1000}s (${n} tries)`);
  return null;
}

function handleFrom(c: any, rcpt: any, name: string): string {
  for (const log of rcpt.logs) {
    try {
      const p = c.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === name) return p.args[0] as string;
    } catch {
      /* executor logs */
    }
  }
  throw new Error(`no ${name} event`);
}

async function main() {
  const lightning = await Lightning.baseMainnet({ hostChainRpcUrls: RPC_URLS });
  const inco = new ethers.Contract(INCO_EXECUTOR, INCO_ABI, ethers.provider);

  const smoke = await ethers.getContractAt("IncoSmoke", INCO_SMOKE);
  const proof = await ethers.getContractAt("HoleCardProof", HOLE_PROOF);

  // ---------------------------------------------------------- A: same-tx path
  line();
  console.log("A. Same transaction: draw AND reveal in one call (known good)");
  line();
  const aRcpt = await (await smoke.drawAndReveal()).wait();
  const aHandle = handleFrom(smoke, aRcpt, "Drawn");
  console.log("  handle    :", aHandle);
  console.log("  isAllowed(smoke) :", await inco.isAllowed(aHandle, INCO_SMOKE));
  console.log("  executor logs in tx:", aRcpt.logs.filter((l: any) => l.address.toLowerCase() === INCO_EXECUTOR.toLowerCase()).length);
  await poll(lightning, aHandle, 60_000, "same-tx");

  // ------------------------------------------------------- B: cross-tx path
  line();
  console.log("B. Two transactions: draw, then reveal in a later call");
  line();
  const bDraw = await (await proof.drawHoleCard()).wait();
  const bHandle = handleFrom(proof, bDraw, "Drawn");
  console.log("  handle    :", bHandle);
  console.log("  isAllowed(proof) after draw :", await inco.isAllowed(bHandle, HOLE_PROOF));
  console.log("  executor logs in draw tx    :", bDraw.logs.filter((l: any) => l.address.toLowerCase() === INCO_EXECUTOR.toLowerCase()).length);

  const bReveal = await (await proof.revealHandle(bHandle)).wait();
  console.log("  reveal tx  :", bReveal.hash, "status", bReveal.status);
  const execLogs = bReveal.logs.filter((l: any) => l.address.toLowerCase() === INCO_EXECUTOR.toLowerCase());
  console.log("  executor logs in reveal tx  :", execLogs.length);
  for (const l of execLogs) console.log("      topic0", l.topics[0]);
  console.log("  isAllowed(proof) after reveal:", await inco.isAllowed(bHandle, HOLE_PROOF));

  await poll(lightning, bHandle, 90_000, "cross-tx");

  line();
  console.log("Compare the executor topic0 sets. A reveal that emits nothing, or emits");
  console.log("a different topic than the same-tx case, is the explanation.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
