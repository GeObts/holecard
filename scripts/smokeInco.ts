/**
 * Day 1 hard gate for Hole Card.
 *
 * Proves against the LIVE Base mainnet deployment (chain 8453) that:
 *   1. e.randBounded(52) works, which is the infinite shoe primitive
 *   2. e.reveal + covalidator attestedReveal returns a readable plaintext card
 *   3. a handle with NO grant is genuinely unreadable, which is the hole card claim
 *
 * Also measures the real per-op Inco fee and the gas cost of a draw.
 *
 * Run: npm run smoke:mainnet
 */
import { ethers } from "hardhat";
import { Lightning } from "@inco/lightning-js/lite";

const EXPECTED_CHAIN_ID = 8453n;
const INCO_EXECUTOR = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624";

// The SDK opens its own RPC connection. Set BASE_RPC_URL to the Alchemy endpoint.
// publicnode is the single fallback. mainnet.base.org is deliberately absent: it
// throttles silently and caches failures for 24 hours. llamarpc was returning 521.
const RPC_URLS: string[] = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
];

function line() {
  console.log("-".repeat(72));
}

/**
 * Public RPC endpoints are load balanced. waitForDeployment can be satisfied by
 * one node while the next eth_call is routed to another that has not caught up,
 * which returns 0x and decodes as BAD_DATA. Poll until the code is visible.
 */
async function waitForCode(addr: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if ((await ethers.provider.getCode(addr)) !== "0x") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`No code at ${addr} after ${tries} tries. RPC may be lagging.`);
}

/**
 * Pull the card handle out of the Drawn event in the transaction receipt.
 *
 * Do NOT read it back from contract state. The receipt is authoritative and needs
 * no extra round trip, whereas a state read straight after the write can be routed
 * to a node one block behind and silently return the zero value.
 */
function handleFromReceipt(contract: any, rcpt: any): `0x${string}` {
  for (const log of rcpt.logs) {
    try {
      const parsed = contract.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed?.name === "Drawn") return parsed.args[0] as `0x${string}`;
    } catch {
      // Logs from the Inco executor are in the same receipt and will not parse.
    }
  }
  throw new Error("No Drawn event in receipt");
}

async function main() {
  line();
  console.log("Hole Card day 1 smoke test: Inco Lightning on Base mainnet");
  line();

  const net = await ethers.provider.getNetwork();
  console.log("chainId:", net.chainId.toString());
  if (net.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain. Expected ${EXPECTED_CHAIN_ID}, got ${net.chainId}`);
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signer configured. Copy .env.example to .env and set PRIVATE_KEY by hand."
    );
  }
  const deployer = signers[0];
  const startBalance = await ethers.provider.getBalance(deployer.address);
  console.log("deployer:", deployer.address);
  console.log("balance :", ethers.formatEther(startBalance), "ETH");
  if (startBalance === 0n) {
    throw new Error("Deployer has no ETH. Fund it before running the gate.");
  }

  // 1. Deploy, or reuse an existing deployment to avoid paying gas twice
  line();
  const existing = process.env.SMOKE_ADDRESS;
  let smoke;
  let smokeAddress: string;

  if (existing) {
    console.log("Reusing existing IncoSmoke at:", existing);
    await waitForCode(existing);
    smoke = await ethers.getContractAt("IncoSmoke", existing);
    smokeAddress = existing;
    const bal = await ethers.provider.getBalance(smokeAddress);
    console.log("contract balance    :", ethers.formatEther(bal), "ETH");
  } else {
    console.log("Deploying IncoSmoke...");
    const factory = await ethers.getContractFactory("IncoSmoke");
    smoke = await factory.deploy();
    await smoke.waitForDeployment();
    smokeAddress = await smoke.getAddress();
    const deployTx = smoke.deploymentTransaction();
    const deployRcpt = deployTx ? await deployTx.wait() : null;
    console.log("IncoSmoke deployed at:", smokeAddress);
    console.log("deploy gas used     :", deployRcpt?.gasUsed?.toString() ?? "unknown");
    await waitForCode(smokeAddress);
  }

  // 2. Read the live fee from the Inco executor directly. The fee belongs to Inco,
  //    so routing the read through our own contract only adds a dependency.
  const incoRead = new ethers.Contract(
    INCO_EXECUTOR,
    ["function getFee() pure returns (uint256)"],
    ethers.provider
  );
  const fee: bigint = await incoRead.getFee();
  console.log("live inco fee per op:", ethers.formatEther(fee), "ETH");

  // 3. Fund the contract. randBounded pays the fee from contract balance.
  //    Only top up if it cannot already cover the draws this run makes.
  const needed = fee * 10n;
  const current = await ethers.provider.getBalance(smokeAddress);
  if (current < needed) {
    const funding = fee * 100n;
    console.log("funding contract    :", ethers.formatEther(funding), "ETH (100 ops)");
    const fundTx = await deployer.sendTransaction({ to: smokeAddress, value: funding });
    await fundTx.wait();
  } else {
    console.log("funding contract    : already funded, skipping");
  }

  // 4. Draw a card and reveal it
  line();
  console.log("Calling drawAndReveal()...");
  const drawTx = await smoke.drawAndReveal();
  const drawRcpt = await drawTx.wait();
  if (!drawRcpt) throw new Error("No receipt for drawAndReveal");
  console.log("draw gas used       :", drawRcpt.gasUsed.toString());
  console.log("tx hash             :", drawRcpt.hash);

  const revealedHandle = handleFromReceipt(smoke, drawRcpt);
  console.log("revealed handle     :", revealedHandle);

  // 5. Ask the covalidator for the plaintext
  line();
  console.log("Binding to Inco Lightning on Base mainnet via the SDK...");
  const lightning = await Lightning.baseMainnet({ hostChainRpcUrls: RPC_URLS });
  const deployment = lightning.deployment as Record<string, unknown>;
  console.log("sdk deployment name :", deployment.name);
  console.log("sdk chainId         :", String(deployment.chainId));
  console.log("sdk executor        :", deployment.executorAddress);

  console.log("Requesting attestedReveal (covalidator is async, this retries)...");
  const t0 = Date.now();
  const attestations = await lightning.attestedReveal([revealedHandle]);
  const elapsed = Date.now() - t0;

  const value = attestations[0]?.plaintext?.value;
  console.log("attestation latency :", elapsed, "ms");
  console.log("plaintext value     :", String(value));

  const card = BigInt(value as bigint | number | string);
  if (card < 0n || card > 51n) {
    throw new Error(`randBounded(52) returned ${card}, outside 0..51`);
  }
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const SUITS = ["clubs", "diamonds", "hearts", "spades"];
  console.log(
    "decoded card        :",
    `${RANKS[Number(card % 13n)]} of ${SUITS[Number(card / 13n)]}`
  );

  // 6. The hole card claim: a handle with no grant must NOT be readable
  line();
  console.log("Calling drawSecret() (no grant, no reveal)...");
  const secretTx = await smoke.drawSecret();
  const secretRcpt = await secretTx.wait();
  if (!secretRcpt) throw new Error("No receipt for drawSecret");
  const secretHandle = handleFromReceipt(smoke, secretRcpt);
  console.log("secret handle       :", secretHandle);
  console.log("Attempting attestedReveal on the ungranted handle...");

  let secretLeaked = false;
  let secretValue: unknown = undefined;
  try {
    const secretAtt = await lightning.attestedReveal([secretHandle], {
      backoffConfig: { maxRetries: 2 },
    });
    secretValue = secretAtt[0]?.plaintext?.value;
    if (secretValue !== undefined && secretValue !== null) secretLeaked = true;
  } catch (err) {
    console.log("refused as expected :", (err as Error).message.split("\n")[0]);
  }

  line();
  console.log("RESULT");
  line();
  console.log("randBounded on 8453     :", "PASS");
  console.log("reveal + attestation    :", "PASS");
  console.log("ungranted handle hidden :", secretLeaked ? "FAIL, LEAKED " + String(secretValue) : "PASS");
  console.log("fee per encrypted draw  :", ethers.formatEther(fee), "ETH");
  console.log("gas per draw            :", drawRcpt.gasUsed.toString());

  const endBalance = await ethers.provider.getBalance(deployer.address);
  console.log("total ETH spent         :", ethers.formatEther(startBalance - endBalance));
  console.log("smoke contract address  :", smokeAddress);

  if (secretLeaked) {
    throw new Error("HARD GATE FAILED: ungranted handle was readable");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
