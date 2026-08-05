import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * TicketVault against a pinned fork of Base mainnet.
 *
 * Real Megapot, real USDC, real ticket NFT. The vault is where the money lives,
 * so it gets proven before any game logic is built on it.
 */
const JACKPOT = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2";
const TICKET_NFT = "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const SOURCE_TAG = ethers.encodeBytes32String("holecard");
const ONE_USDC = 1_000_000n;

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];
const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function setApprovalForAll(address,bool)",
];

/** A valid 5-pick within the live ballMax of 30. */
function ticket(offset: number) {
  return { normals: [1, 2, 3, 4, 5 + offset].map(Number), bonusball: 1 + (offset % 10) };
}

describe("TicketVault (fork)", () => {
  async function fixture() {
    const [owner, treasury, table, player] = await ethers.getSigners();

    const f = await ethers.getContractFactory("TicketVault");
    const vault = await f.deploy(USDC, JACKPOT, TICKET_NFT, treasury.address, SOURCE_TAG, owner.address);
    await vault.waitForDeployment();
    await (await vault.setTable(table.address)).wait();

    // Fund from the Jackpot's own USDC balance. prizePool is a state variable,
    // not balance-derived, so moving a little USDC out does not perturb it.
    await network.provider.send("hardhat_impersonateAccount", [JACKPOT]);
    await network.provider.send("hardhat_setBalance", [JACKPOT, "0x56BC75E2D63100000"]);
    const whale = await ethers.getSigner(JACKPOT);
    const usdc = new ethers.Contract(USDC, USDC_ABI, whale);
    await (await usdc.transfer(await vault.getAddress(), 500n * ONE_USDC)).wait();
    await (await usdc.transfer(player.address, 50n * ONE_USDC)).wait();

    return {
      vault,
      owner,
      treasury,
      table,
      player,
      usdc: new ethers.Contract(USDC, USDC_ABI, ethers.provider),
      nft: new ethers.Contract(TICKET_NFT, NFT_ABI, ethers.provider),
    };
  }

  // ------------------------------------------------------------------ live reads

  it("reads live drawing state and computes EV on chain", async () => {
    const { vault } = await loadFixture(fixture);
    expect(await vault.canBuy()).to.equal(true);
    expect(await vault.ticketPriceUsdc()).to.equal(ONE_USDC);

    const gross = await vault.ticketGrossEv();
    const holder = await vault.ticketHolderValue();
    expect(gross).to.be.closeTo(772_628n, 200n);
    expect(holder).to.be.closeTo(695_365n, 200n);
    // The whole basis of the sellback price.
    expect(await vault.sellbackPriceUsdc()).to.be.lessThan(holder);
  });

  // -------------------------------------------------------- reserve invariants

  it("holds the reserve invariant under a run of hits that outpaces deposits", async () => {
    const { vault, table } = await loadFixture(fixture);
    const start = await vault.freeUsdc();
    expect(start).to.equal(500n * ONE_USDC);

    // Simulate 500 hits, each reserving the house's matching dollar.
    for (let i = 0; i < 5; i++) {
      await (await vault.connect(table).reserve(100n * ONE_USDC)).wait();
    }
    expect(await vault.reservedUsdc()).to.equal(500n * ONE_USDC);
    expect(await vault.freeUsdc()).to.equal(0n);

    // The 501st hit must be refused, not silently allowed.
    await expect(vault.connect(table).reserve(ONE_USDC))
      .to.be.revertedWithCustomError(vault, "InsufficientFreeBalance")
      .withArgs(ONE_USDC, 0n);
  });

  it("refuses reserve from anyone but the table", async () => {
    const { vault, owner, player } = await loadFixture(fixture);
    await expect(vault.connect(player).reserve(ONE_USDC)).to.be.revertedWithCustomError(vault, "NotTable");
    await expect(vault.connect(owner).reserve(ONE_USDC)).to.be.revertedWithCustomError(vault, "NotTable");
  });

  it("will not let withdrawBankroll touch reserved USDC", async () => {
    const { vault, owner, table } = await loadFixture(fixture);
    await (await vault.connect(table).reserve(400n * ONE_USDC)).wait();

    await expect(vault.connect(owner).withdrawBankroll(owner.address, 200n * ONE_USDC))
      .to.be.revertedWithCustomError(vault, "InsufficientFreeBalance")
      .withArgs(200n * ONE_USDC, 100n * ONE_USDC);

    // The free remainder is still withdrawable.
    await expect(vault.connect(owner).withdrawBankroll(owner.address, 100n * ONE_USDC)).to.not.be.reverted;
    expect(await vault.reservedUsdc()).to.equal(400n * ONE_USDC);
  });

  // ------------------------------------------------------------- sellback price

  it("guards the sellback price at the holder-value boundary", async () => {
    const { vault, owner } = await loadFixture(fixture);
    const hv: bigint = await vault.ticketHolderValue();

    // Exactly at holder value: rejected.
    await expect(vault.connect(owner).setSellbackPrice(hv)).to.be.revertedWithCustomError(
      vault,
      "PriceAboveHolderValue"
    );
    // One wei above: rejected.
    await expect(vault.connect(owner).setSellbackPrice(hv + 1n)).to.be.revertedWithCustomError(
      vault,
      "PriceAboveHolderValue"
    );
    // One wei below: accepted.
    await expect(vault.connect(owner).setSellbackPrice(hv - 1n)).to.not.be.reverted;
    expect(await vault.sellbackPriceUsdc()).to.equal(hv - 1n);

    // The rejected 0.80 price cannot be configured back in.
    await expect(vault.connect(owner).setSellbackPrice(800_000n)).to.be.revertedWithCustomError(
      vault,
      "PriceAboveHolderValue"
    );
  });

  // ------------------------------------------------------------------- purchase

  it("buys a full opening hand in one batched call and reports gas", async () => {
    const { vault, table, nft } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();

    // A full opening hand: 2 player cards + 2 dealer cards, one call, vault recipient.
    const hand = [ticket(0), ticket(1), ticket(2), ticket(3)];
    const tx = await vault.connect(table).buyTickets(hand, 0);
    const rcpt = await tx.wait();
    console.log(`        opening hand, 4 tickets, one call: ${rcpt!.gasUsed} gas`);
    console.log(`        per ticket: ${rcpt!.gasUsed / 4n} gas`);

    expect(await vault.heldTicketCount()).to.equal(4n);

    // Every ticket landed in the vault, not with any player.
    const ids: bigint[] = [];
    for (const log of rcpt!.logs) {
      try {
        const p = vault.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (p?.name === "TicketsBought") ids.push(...(p.args[2] as bigint[]));
      } catch {
        /* Megapot events */
      }
    }
    expect(ids.length).to.equal(4);
    for (const id of ids) expect(await nft.ownerOf(id)).to.equal(vaultAddr);
  });

  it("measures a single-ticket buy for comparison", async () => {
    const { vault, table } = await loadFixture(fixture);
    const tx = await vault.connect(table).buyTickets([ticket(7)], 0);
    const rcpt = await tx.wait();
    console.log(`        single ticket via vault: ${rcpt!.gasUsed} gas`);
    expect(await vault.heldTicketCount()).to.equal(1n);
  });

  it("spends the reserve when buying deferred house stake", async () => {
    const { vault, table } = await loadFixture(fixture);
    await (await vault.connect(table).reserve(2n * ONE_USDC)).wait();
    expect(await vault.reservedUsdc()).to.equal(2n * ONE_USDC);

    await (await vault.connect(table).buyTickets([ticket(1), ticket(2)], 2n * ONE_USDC)).wait();
    // Reserve consumed, not double counted.
    expect(await vault.reservedUsdc()).to.equal(0n);
    expect(await vault.heldTicketCount()).to.equal(2n);
  });

  // -------------------------------------------------------------------- payouts

  it("releases tickets and ownerOf reflects the move", async () => {
    const { vault, table, player, nft } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();

    const rcpt = await (await vault.connect(table).buyTickets([ticket(4), ticket(5)], 0)).wait();
    const ids: bigint[] = [];
    for (const log of rcpt!.logs) {
      try {
        const p = vault.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (p?.name === "TicketsBought") ids.push(...(p.args[2] as bigint[]));
      } catch {
        /* ignore */
      }
    }
    for (const id of ids) expect(await nft.ownerOf(id)).to.equal(vaultAddr);

    await (await vault.connect(table).releaseTickets(player.address, ids)).wait();
    for (const id of ids) expect(await nft.ownerOf(id)).to.equal(player.address);
    expect(await vault.heldTicketCount()).to.equal(0n);
  });

  // ---------------------------------------------------- closed-drawing behaviour

  it("closes buying at the cutoff and settles at the standing bid", async () => {
    const { vault, table, player, usdc } = await loadFixture(fixture);
    expect(await vault.canBuy()).to.equal(true);

    // Travel past drawingTime - closeBufferSeconds.
    const secs: bigint = await vault.secondsUntilClose();
    await time.increase(secs + 1n);

    expect(await vault.canBuy()).to.equal(false);
    expect(await vault.secondsUntilClose()).to.equal(0n);
    await expect(vault.connect(table).buyTickets([ticket(1)], 0)).to.be.revertedWithCustomError(
      vault,
      "BuyingClosed"
    );
    // Selling closes with buying, or the vault pays cash for tickets it cannot replace.
    await expect(vault.connect(player).sellback([1n])).to.be.revertedWithCustomError(vault, "BuyingClosed");

    // The hand still settles. Owed 3 tickets, paid at the standing bid, not face.
    await (await vault.connect(table).reserve(3n * ONE_USDC)).wait();
    const before: bigint = await usdc.balanceOf(player.address);
    await (await vault.connect(table).settleInUsdc(player.address, 3n)).wait();
    const paid: bigint = (await usdc.balanceOf(player.address)) - before;

    const bid: bigint = await vault.sellbackPriceUsdc();
    expect(paid).to.equal(3n * bid);
    // Explicitly NOT face value. Paying face would reward stalling into the lock.
    expect(paid).to.be.lessThan(3n * ONE_USDC);
  });

  it("sells tickets back to the vault at the standing bid", async () => {
    const { vault, table, player, nft, usdc } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();

    const rcpt = await (await vault.connect(table).buyTickets([ticket(8)], 0)).wait();
    let id = 0n;
    for (const log of rcpt!.logs) {
      try {
        const p = vault.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (p?.name === "TicketsBought") id = (p.args[2] as bigint[])[0];
      } catch {
        /* ignore */
      }
    }
    await (await vault.connect(table).releaseTickets(player.address, [id])).wait();

    await (await new ethers.Contract(TICKET_NFT, NFT_ABI, player).setApprovalForAll(vaultAddr, true)).wait();
    const before: bigint = await usdc.balanceOf(player.address);
    await (await vault.connect(player).sellback([id])).wait();

    const bid: bigint = await vault.sellbackPriceUsdc();
    expect((await usdc.balanceOf(player.address)) - before).to.equal(bid);
    expect(await nft.ownerOf(id)).to.equal(vaultAddr);
  });
});

describe("TicketVault canBuy branches (mock)", () => {
  async function fixture() {
    const [owner, treasury, table] = await ethers.getSigners();
    const mockF = await ethers.getContractFactory("MockJackpot");
    const mock = await mockF.deploy();
    await mock.waitForDeployment();

    const f = await ethers.getContractFactory("TicketVault");
    const vault = await f.deploy(
      USDC,
      await mock.getAddress(),
      TICKET_NFT,
      treasury.address,
      SOURCE_TAG,
      owner.address
    );
    await vault.waitForDeployment();
    await (await vault.setTable(table.address)).wait();
    return { vault, mock, owner };
  }

  it("is true when all four conditions hold", async () => {
    const { vault } = await loadFixture(fixture);
    expect(await vault.canBuy()).to.equal(true);
  });

  it("is false when allowTicketPurchases is off", async () => {
    const { vault, mock } = await loadFixture(fixture);
    await (await mock.setAllowTicketPurchases(false)).wait();
    expect(await vault.canBuy()).to.equal(false);
  });

  it("is false when jackpotLock is set", async () => {
    const { vault, mock } = await loadFixture(fixture);
    await (await mock.setJackpotLock(true)).wait();
    expect(await vault.canBuy()).to.equal(false);
  });

  it("is false when prizePool is zero", async () => {
    const { vault, mock } = await loadFixture(fixture);
    await (await mock.setPrizePool(0)).wait();
    expect(await vault.canBuy()).to.equal(false);
  });

  it("is false inside the drawing cutoff window", async () => {
    const { vault, mock } = await loadFixture(fixture);
    const now = await time.latest();
    const buffer: bigint = await vault.closeBufferSeconds();
    // drawingTime exactly one second inside the buffer.
    await (await mock.setDrawingTime(BigInt(now) + buffer - 1n)).wait();
    expect(await vault.canBuy()).to.equal(false);

    // One second outside it, open again.
    await (await mock.setDrawingTime(BigInt(now) + buffer + 60n)).wait();
    expect(await vault.canBuy()).to.equal(true);
  });

  it("defaults the close buffer to 10 minutes", async () => {
    const { vault } = await loadFixture(fixture);
    expect(await vault.closeBufferSeconds()).to.equal(600n);
  });
});
