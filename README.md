# Hole Card

Blackjack where every card is a live Megapot lottery ticket, and the dealer's hole card is genuinely unreadable because it lives in Inco encrypted state.

Built for the Megapot x Inco buildathon. Base mainnet, real USDC, real tickets.

## The idea

A card is not a representation of a ticket. It is the same on-chain object.

Each card costs $1 and is a real Megapot ticket NFT carrying five normal numbers and a bonus ball. Rank and suit come from Inco's encrypted randomness and are layered on at render time. Whatever tickets you hold when the drawing fires are live entries in that night's jackpot.

Because every card costs a dollar, hitting is never free. **This is blackjack where every card you take raises the bet.**

The dealer's hole card is drawn as an Inco encrypted handle with no access grant issued to anyone. Its ticket numbers are public, because NFT state is public. Its face is not. You can see the dealer's lucky numbers all game. You just cannot see what card it is.

## House rules

The rules the contract actually enforces. Nothing here is aspirational.

| Rule | Setting |
|---|---|
| Deck | Infinite shoe, drawn with replacement from Inco encrypted randomness |
| Natural blackjack | Pays 6:5, two cards only. A three-card 21 is a plain win |
| Dealer on soft 17 | Stands (S17). `hitSoft17` exists and is off |
| Doubling | Any two cards. No total restriction |
| Double after hit | Not allowed |
| Splitting | Not offered |
| Insurance | Not offered |
| Late surrender | Not offered |
| Push | Each side keeps its own |
| Busting | Permitted after a bust. It only costs the player more on a hand they have already lost |
| Abandoned hands | Force-stood, then resolved on merits. The house never seizes a pot |

On doubling: the original spec restricted it to hard 9, 10 and 11 as a house-edge lever. That was dropped. Enforcing it would mean reading the player's total at settle, long after they acted, and then either voiding the hand or reclassifying the double as a hit, which produces a hand the player never played. The edge is already carried by 6:5, S17 and the infinite shoe. Doubling on a soft 13 is simply a bad bet, and the house does not need protecting from that.

## Status

Foundations are proven against live Base mainnet. Game logic and frontend are in progress.

| Piece | State |
|---|---|
| Inco randomness and reveal on Base mainnet | Verified live |
| Megapot purchase, tagging, transfer | Verified live |
| `TicketVault` | Built, 17 fork tests passing |
| `TicketMath` live EV | Built, unit tested |
| `BlackjackTable` | Built, compiling. Hand lifecycle, timeouts, payouts |
| `BlackjackMath` | Built, 34 plaintext rule tests |
| Hole card proof | Written, blocked on the Inco covalidator |
| Frontend | Not started |

**58 tests pass with no covalidator, no fork and no Docker.** Every game rule is provable on plaintext cards, so the rules can be demonstrated even while the attestation service is unavailable.

## Verified on-chain facts

Everything here was read off live contracts or compiled artifacts, never from documentation. The documentation was wrong seven times during this build.

- **Inco Lightning is on Base mainnet**, chain 8453, deployment `incoLightning_12_0_3__473307884`, executor `0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624`. Megapot and Inco run on one chain, so there is no bridge and no testnet fallback.
- **`claimWinnings` is gated on the current NFT holder**, not the original purchaser. `ownerOf(ticketId) != msg.sender` is the only ownership check in the function, and the USDC goes to `msg.sender`. Winnings follow the token.
- **Ticket transfers are unrestricted.** No pause, whitelist, soulbound flag or operator filter anywhere in the NFT contract.
- **`referralScheme` is baked into a ticket at mint and survives transfer**, so the referrer keeps earning on a ticket after it changes hands.
- **`_source` is emit-only.** It is the third indexed field on `TicketPurchased` and is never written to state, so it is readable from logs and not from any view function.

## Live ticket expected value

`TicketMath` computes a ticket's expected value on-chain from live per-drawing tier payouts and ball bounds. Nothing is hardcoded, because both are owner-settable and change between drawings.

For drawing 134:

```
gross EV      0.772628 USDC
holder value  0.695365 USDC   (EV net of the 10% referrer win share)
face          1.000000 USDC
```

This is what prices the sellback offer, and it is surfaced in the UI next to the bid so the offer reads as a transparent market rather than a haircut.

## Repo layout

```
contracts/
  TicketVault.sol          bankroll, ticket custody, reserve accounting, sellback
  lib/TicketMath.sol       live expected value from drawing state
  interfaces/IMegapot.sol  verified Megapot surface
  IncoSmoke.sol            day 1 gate: randBounded, reveal, ungranted handle probe
scripts/
  precheck.ts              read-only Inco and Megapot liveness
  smokeInco.ts             paid Inco gate on mainnet
  megapotGate.ts           paid Megapot gate: buy, tag, read back, transfer
  ticketEV.ts              off-chain EV, cross-checked against the on-chain library
test/
  ticketMath.test.ts       EV maths against real drawing data
  ticketVault.fork.test.ts vault against a pinned Base mainnet fork
```

## Running it

Requires a Base mainnet RPC. There is deliberately no public-endpoint fallback: `mainnet.base.org` throttles silently and caches failures for 24 hours, which is a worse failure mode than a clean error.

```bash
npm install
cp .env.example .env      # fill in by hand
npx hardhat compile
npx hardhat test
```

Toolchain pins that are not optional:

- `typescript` 5.8.3. npm otherwise installs TypeScript 7, which `ts-node` 10.x cannot read.
- `@openzeppelin/contracts` 5.4.0 exactly, matching `@inco/lightning`. Any other version hoists over Inco's nested copy and breaks the build.
- solc 0.8.30 with `evmVersion: "cancun"`. Inco's access control uses `tstore`/`tload`.

## Licence

MIT.
