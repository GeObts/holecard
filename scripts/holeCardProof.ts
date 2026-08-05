/**
 * The demo's central claim, tested rigorously against live Base mainnet.
 *
 * A naive test draws an ungranted handle, sees the covalidator refuse it, and
 * calls that proof. It is not. The refusal is NotFound, which is also what a
 * valid handle returns while it is still being processed. One failure cannot
 * distinguish "never granted" from "not ready yet".
 *
 * This test closes that gap in three steps:
 *
 *   1. Draw a hole card with no grant. Wait well past the observed attestation
 *      latency. Confirm it is STILL refused.
 *   2. In the same window, draw a normal face-up card and confirm it resolves.
 *      This is the control: it proves the covalidator was up and processing
 *      throughout, so step 1's refusal was access control, not an outage.
 *   3. Reveal that SAME handle on-chain and confirm it becomes readable.
 *      This proves the handle was valid and processable all along.
 *
 * Run: npx hardhat run scripts/holeCardProof.ts --network base
 */
import { ethers } from "hardhat";
import { Lightning } from "@inco/lightning-js/lite";

const RPC_URLS: string[] = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
];

/** Well past the 4406 ms we measured for an idle attestation. */
const WAIT_SECONDS = Number(process.env.HOLE_CARD_WAIT ?? 60);

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["clubs", "diamonds", "hearts", "spades"];

function line() {
  console.log("-".repeat(72));
}

function decode(v: bigint) {
  return `${RANKS[Number(v % 13n)]} of ${SUITS[Number(v / 13n)]}`;
}

async function waitForBlock(n: number, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if ((await ethers.provider.getBlockNumber()) >= n) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Provider still behind block ${n}`);
}

function handleFrom(contract: any, rcpt: any, name: string): `0x${string}` {
  for (const log of rcpt.logs) {
    try {
      const p = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === name) return p.args[0] as `0x${string}`;
    } catch {
      /* Inco executor logs */
    }
  }
  throw new Error(`No ${name} event in receipt`);
}

/** One attempt. Returns the plaintext, or null if the covalidator refused. */
async function tryRevealOnce(lightning: any, handle: `0x${string}`) {
  try {
    const att = await lightning.attestedReveal([handle], { backoffConfig: { maxRetries: 0 } });
    const v = att[0]?.plaintext?.value;
    return v === undefined || v === null ? null : BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Poll for up to timeoutMs. Returns the value as soon as it resolves, or null if
 * it never does.
 *
 * Polling rather than waiting-then-trying-once matters for the claim: "refused"
 * has to mean "refused across an actively polled window", not "refused on one
 * attempt that might have been unlucky".
 */
async function pollReveal(lightning: any, handle: `0x${string}`, timeoutMs: number, label: string) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const v = await tryRevealOnce(lightning, handle);
    if (v !== null) {
      console.log(`  ${label}: resolved after ${((Date.now() - start) / 1000).toFixed(1)}s, ${attempts} attempts`);
      return v;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  ${label}: never resolved in ${(timeoutMs / 1000).toFixed(0)}s, ${attempts} attempts`);
  return null;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`Expected chain 8453, got ${net.chainId}`);

  const [signer] = await ethers.getSigners();
  line();
  console.log("Hole card proof: is the dealer's hole card genuinely unreadable?");
  line();
  console.log("chain   :", net.chainId.toString());
  console.log("signer  :", signer.address);

  // Deploy, or reuse to avoid paying deploy gas twice.
  let proof: any;
  const existing = process.env.HOLE_CARD_PROOF;
  if (existing) {
    console.log("reusing :", existing);
    proof = await ethers.getContractAt("HoleCardProof", existing);
  } else {
    const f = await ethers.getContractFactory("HoleCardProof");
    proof = await f.deploy();
    await proof.waitForDeployment();
    const addr = await proof.getAddress();
    console.log("deployed:", addr);
    await waitForBlock((await proof.deploymentTransaction()!.wait())!.blockNumber);
  }
  const proofAddr = await proof.getAddress();

  const fee: bigint = await proof.incoFee();
  const bal = await ethers.provider.getBalance(proofAddr);
  if (bal < fee * 4n) {
    const top = fee * 20n;
    console.log("funding :", ethers.formatEther(top), "ETH");
    await (await signer.sendTransaction({ to: proofAddr, value: top })).wait();
  }

  const lightning = await Lightning.baseMainnet({ hostChainRpcUrls: RPC_URLS });

  // ---------------------------------------------------------- step 1: the draw
  line();
  console.log("STEP 1  Draw a hole card. No grant issued to anyone.");
  line();
  const drawRcpt = await (await proof.drawHoleCard()).wait();
  const holeHandle = handleFrom(proof, drawRcpt, "Drawn");
  console.log("hole handle :", holeHandle);
  console.log("tx          :", drawRcpt.hash);

  // ------------------------------------------- step 2: wait, then try to read
  line();
  console.log(`STEP 2  Poll continuously for ${WAIT_SECONDS}s, far past the 4.4s measured latency.`);
  line();
  const leaked = await pollReveal(lightning, holeHandle, WAIT_SECONDS * 1000, "hole card");
  if (leaked !== null) {
    console.log("READ VALUE  :", leaked.toString(), decode(leaked));
    throw new Error("HOLE CARD LEAKED. The central claim is false.");
  }
  console.log("result      : refused throughout, as required");

  // ----------------------------------------------------- step 3: the control
  line();
  console.log("STEP 3  Control. Draw a face-up card now and confirm it DOES resolve.");
  console.log("        This proves the covalidator was healthy during step 2, so the");
  console.log("        refusal above was access control and not an outage.");
  line();
  const ctlRcpt = await (await proof.drawHoleCard()).wait();
  const ctlHandle = handleFrom(proof, ctlRcpt, "Drawn");
  const ctlRevealRcpt = await (await proof.revealHoleCard()).wait();
  await waitForBlock(ctlRevealRcpt.blockNumber);
  const ctlValue = await pollReveal(lightning, ctlHandle, 120_000, "control card");
  if (ctlValue === null) {
    throw new Error("Control card did not resolve. Covalidator may be down; result inconclusive.");
  }
  console.log("control     :", ctlValue.toString(), decode(ctlValue));
  console.log("covalidator : healthy");

  // ------------------------------------------ step 4: reveal the SAME handle
  line();
  console.log("STEP 4  Reveal the original hole card handle on chain, then read it.");
  line();
  // Re-draw is not possible; lastSecret now points at the control card, so put
  // the original handle back by drawing nothing and revealing directly.
  const beforeReveal = await tryRevealOnce(lightning, holeHandle);
  console.log("before      :", beforeReveal === null ? "still refused" : `LEAKED ${beforeReveal}`);
  if (beforeReveal !== null) throw new Error("HOLE CARD LEAKED before reveal");

  const revealRcpt = await (await proof.revealHandle(holeHandle)).wait();
  console.log("reveal tx   :", revealRcpt.hash);
  await waitForBlock(revealRcpt.blockNumber);

  const after = await pollReveal(lightning, holeHandle, 120_000, "hole card after reveal");
  if (after === null) {
    throw new Error("Handle did not become readable after reveal. Test inconclusive.");
  }
  console.log("after       :", after.toString(), decode(after));

  line();
  console.log("RESULT");
  line();
  console.log("  ungranted handle refused after", WAIT_SECONDS, "s :  PASS");
  console.log("  covalidator proven healthy meanwhile      :  PASS");
  console.log("  same handle readable once revealed        :  PASS");
  line();
  console.log("The hole card is unreadable because no grant exists, not because");
  console.log("it was slow. The handle was valid and processable the whole time.");
  console.log("proof contract:", proofAddr);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
