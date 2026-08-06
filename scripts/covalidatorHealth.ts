/**
 * Covalidator health gate.
 *
 * Checks BOTH halves, because they fail independently and only one of them
 * matters for playing a hand:
 *
 *   SERVING   can it return a ciphertext it already processed?
 *   INGESTION can it process a ciphertext created just now?
 *
 * On 2026-08-05 serving worked (4.8s on a two-day-old handle) while ingestion
 * was dead (fresh draw+reveal never resolved across 20 attempts in 60s). Testing
 * serving alone would have reported "healthy" for a service that cannot resolve
 * a single hand. Ingestion is the one that gates play, and gates recording the
 * demo video.
 *
 * Exit code 0 only if BOTH pass.
 *
 * Run: npx hardhat run scripts/covalidatorHealth.ts --network base
 */
import { appendFileSync } from "fs";
import { ethers } from "hardhat";
import { Lightning } from "@inco/lightning-js/lite";

/**
 * Append-only health log. Serving and ingestion are recorded separately so their
 * recovery can be seen independently, which is exactly how they failed.
 */
const HEALTH_LOG = process.env.HEALTH_LOG ?? "";

function logLine(fields: string) {
  const stamp = new Date().toISOString();
  const row = `${stamp} ${fields}\n`;
  process.stdout.write(row);
  if (HEALTH_LOG) {
    try {
      appendFileSync(HEALTH_LOG, row);
    } catch (e) {
      process.stderr.write(`could not append to ${HEALTH_LOG}: ${(e as Error).message}\n`);
    }
  }
}

/** Revealed and read successfully as 31 on 2026-08-04. */
const KNOWN_GOOD = "0x8deb8171633631303b67894d9507052237ca1b26efd7aa88a63b514e8f940800";
const INCO_SMOKE = "0xC45A67fECb56Ff9F6fC199cb17f551C1e681DD01";

const RPC_URLS: string[] = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
];

const INGESTION_TIMEOUT_MS = Number(process.env.INGESTION_TIMEOUT ?? 90) * 1000;

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

async function poll(lightning: any, handle: string, ms: number) {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < ms) {
    n++;
    const v = await tryOnce(lightning, handle);
    if (v !== null) return { value: v, seconds: (Date.now() - t0) / 1000, attempts: n };
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { value: null, seconds: ms / 1000, attempts: n };
}

async function main() {
  const lightning = await Lightning.baseMainnet({ hostChainRpcUrls: RPC_URLS });

  line();
  console.log("Inco covalidator health gate,", new Date().toISOString());
  line();

  // ------------------------------------------------------------- 1. SERVING
  console.log("1. SERVING: read a ciphertext processed on 2026-08-04");
  const serving = await poll(lightning, KNOWN_GOOD, 30_000);
  const servingOk = serving.value !== null;
  console.log(
    servingOk
      ? `   PASS  value ${serving.value} in ${serving.seconds.toFixed(1)}s`
      : `   FAIL  no response in ${serving.seconds}s across ${serving.attempts} attempts`
  );

  // ----------------------------------------------------------- 2. INGESTION
  console.log();
  console.log("2. INGESTION: draw and reveal a NEW card, then read it");
  const smoke = await ethers.getContractAt("IncoSmoke", INCO_SMOKE);

  const bal = await ethers.provider.getBalance(INCO_SMOKE);
  const fee: bigint = await smoke.incoFee();
  if (bal < fee * 2n) {
    const [signer] = await ethers.getSigners();
    await (await signer.sendTransaction({ to: INCO_SMOKE, value: fee * 20n })).wait();
    console.log("   (topped up the probe contract)");
  }

  const rcpt = await (await smoke.drawAndReveal()).wait();
  let handle = "";
  for (const log of rcpt.logs) {
    try {
      const p = smoke.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === "Drawn") handle = p.args[0] as string;
    } catch {
      /* executor logs */
    }
  }
  console.log("   fresh handle:", handle);

  const ingestion = await poll(lightning, handle, INGESTION_TIMEOUT_MS);
  const ingestionOk = ingestion.value !== null;
  console.log(
    ingestionOk
      ? `   PASS  value ${ingestion.value} in ${ingestion.seconds.toFixed(1)}s`
      : `   FAIL  no response in ${ingestion.seconds}s across ${ingestion.attempts} attempts`
  );

  // -------------------------------------------------------------- 3. VERDICT
  line();
  const verdict = servingOk && ingestionOk ? "HEALTHY" : servingOk ? "INGESTION_DOWN" : "DOWN";

  logLine(
    `verdict=${verdict} ` +
      `serving=${servingOk ? "PASS" : "FAIL"}/${serving.seconds.toFixed(1)}s/${serving.attempts} ` +
      `ingestion=${ingestionOk ? "PASS" : "FAIL"}/${ingestion.seconds.toFixed(1)}s/${ingestion.attempts} ` +
      `handle=${handle}`
  );

  if (verdict === "HEALTHY") {
    console.log("VERDICT: HEALTHY. Hands can resolve. Safe to record the demo.");
    return;
  }
  if (verdict === "INGESTION_DOWN") {
    console.log("VERDICT: INGESTION DOWN, serving fine.");
    console.log("No hand can resolve. Do NOT record. This is the 2026-08-05 failure mode.");
  } else {
    console.log("VERDICT: covalidator unreachable or fully down.");
  }
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
