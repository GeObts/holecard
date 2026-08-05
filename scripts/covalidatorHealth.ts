/**
 * Covalidator health probe. ONE call, default backoff, full error chain.
 *
 * Deliberately gentle: a single attestedReveal with the SDK's own defaults
 * (5 attempts, 1s base, 1.5x factor, ~10s total). If this succeeds, the earlier
 * failure was transient. If it fails the same way, the service is degraded.
 *
 * Run: npx hardhat run scripts/covalidatorHealth.ts --network base
 */
import { Lightning } from "@inco/lightning-js/lite";

const KNOWN_GOOD = "0x8deb8171633631303b67894d9507052237ca1b26efd7aa88a63b514e8f940800";

const RPC_URLS: string[] = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
];

function unwrap(err: any, depth = 0): void {
  if (!err || depth > 5) return;
  const msg = typeof err === "string" ? err : err.message;
  if (msg) console.log(`  ${"  ".repeat(depth)}${msg.split("\n")[0]}`);
  if (err.cause) unwrap(err.cause, depth + 1);
}

async function main() {
  const lightning = await Lightning.baseMainnet({ hostChainRpcUrls: RPC_URLS });
  const d = lightning.deployment as Record<string, unknown>;

  console.log("-".repeat(72));
  console.log("Covalidator health probe, single call, SDK default backoff");
  console.log("-".repeat(72));
  console.log("deployment :", d.name);
  console.log("handle     :", KNOWN_GOOD, "(read successfully as 31 on 2026-08-04)");
  console.log();

  const t0 = Date.now();
  try {
    const att = await lightning.attestedReveal([KNOWN_GOOD as `0x${string}`]);
    const v = att[0]?.plaintext?.value;
    console.log(`RESOLVED: ${v} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log();
    console.log("VERDICT: covalidator has RECOVERED. Rerun the hole card proof.");
  } catch (err) {
    console.log(`FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log();
    console.log("full error chain:");
    unwrap(err);
    console.log();
    const text = JSON.stringify(err, Object.getOwnPropertyNames(err)).toLowerCase();
    const throttle = ["429", "resource_exhausted", "rate limit", "too many requests", "quota"];
    const hits = throttle.filter((p) => text.includes(p));
    console.log("throttle indicators present:", hits.length ? hits.join(", ") : "NONE");
    console.log();
    if (hits.length === 0) {
      console.log("VERDICT: not a rate limit. The covalidator cannot serve this");
      console.log("ciphertext. Service-side, nothing for us to fix in code.");
    } else {
      console.log("VERDICT: throttled. Our polling was too aggressive.");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
