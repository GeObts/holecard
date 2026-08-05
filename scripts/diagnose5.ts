/**
 * Decisive check: is the covalidator degraded right now, or is our code wrong?
 *
 * 0x8deb...0800 was revealed and successfully read yesterday, resolving to 31
 * (6 of hearts) in 4406 ms. If that same handle cannot be read now, the problem
 * is Inco-side availability, not anything we wrote.
 *
 * Run: npx hardhat run scripts/diagnose5.ts --network base
 */
import { Lightning } from "@inco/lightning-js/lite";

const KNOWN_GOOD = "0x8deb8171633631303b67894d9507052237ca1b26efd7aa88a63b514e8f940800";

const RPC_URLS: string[] = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
];

async function main() {
  const lightning = await Lightning.baseMainnet({ hostChainRpcUrls: RPC_URLS });
  console.log("-".repeat(72));
  console.log("Re-reading a handle that was SUCCESSFULLY read yesterday (value 31)");
  console.log("handle:", KNOWN_GOOD);
  console.log("-".repeat(72));

  const t0 = Date.now();
  let lastErr = "";
  for (let i = 0; i < 10; i++) {
    try {
      const att = await lightning.attestedReveal([KNOWN_GOOD as `0x${string}`], {
        backoffConfig: { maxRetries: 0 },
      });
      const v = att[0]?.plaintext?.value;
      if (v !== undefined && v !== null) {
        console.log(`RESOLVED: ${v} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        console.log();
        console.log("VERDICT: covalidator is healthy. A failure elsewhere is our bug.");
        return;
      }
    } catch (err) {
      lastErr = (err as Error).message.split("\n")[0];
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(`never resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("last error:", lastErr);
  console.log();
  console.log("VERDICT: a handle proven readable yesterday is unreadable now.");
  console.log("The covalidator is degraded. Today's hole card result is INCONCLUSIVE,");
  console.log("not a failure of our contracts.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
