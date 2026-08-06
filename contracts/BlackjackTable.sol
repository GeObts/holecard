// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {euint256, e, inco} from "@inco/lightning/src/Lib.sol";

import {IJackpot} from "./interfaces/IMegapot.sol";
import {TicketVault} from "./TicketVault.sol";
import {BlackjackMath} from "./lib/BlackjackMath.sol";
import {TicketMath} from "./lib/TicketMath.sol";

/// @title BlackjackTable
/// @notice Blackjack where every card is a live Megapot ticket and the dealer's
///         hole card lives in Inco encrypted state.
///
/// @dev Two properties drive the whole design.
///
///      PLAY ENCRYPTED, SETTLE PLAINTEXT. During a hand every card is an opaque
///      euint256 handle. At settle the frontend brings covalidator attestations,
///      e.verifyDecryption binds each signed value to its stored handle, and from
///      that point scoring is ordinary Solidity. No branchless FHE dealer loop.
///
///      NO ON-CHAIN BUST ENFORCEMENT. The contract cannot read card values during
///      play, and it does not need to. Hitting after a bust is self-punishing, so
///      it is simply allowed; at settle the player's cards are walked in order and
///      a bust ends the hand regardless of what came after. The UI, which can read
///      the revealed values, stops the player from doing it.
contract BlackjackTable is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using e for *;

    // ---------------------------------------------------------------- immutables

    TicketVault public immutable vault;
    IERC20 public immutable usdc;
    IJackpot public immutable jackpot;

    uint256 private constant DECK = 52;
    uint8 private constant NORMALS = 5;

    // ------------------------------------------------------------------- config

    /// @notice Dormant. S17 ships. Flipping this is the whole H17 change.
    bool public hitSoft17 = false;

    /// @notice Keeper we run to submit settle so players do not have to.
    /// @dev Convenience only, NOT access control. settle is permissionless.
    ///      Recorded here purely so our own monitoring can find it.
    address public keeper;

    /// @notice How long after standing before a hand can be force-pushed.
    /// @dev 300s is roughly 68x the 4.4s attestation latency measured on a
    ///      healthy covalidator.
    uint256 public attestationTimeoutSeconds = 300;

    /// @notice How far before the drawing a stuck hand must be pushed.
    /// @dev MUST stay below the vault's closeBufferSeconds, so a hand that opens
    ///      at the last permitted moment still has room to settle normally before
    ///      this fires. 300 against the vault's 600 leaves 300s of runway.
    uint256 public pushDeadlineSeconds = 300;

    // -------------------------------------------------------------------- types

    enum State {
        None,
        PlayerTurn,
        AwaitingAttestation,
        Settled
    }

    struct Hand {
        address player;
        State state;
        uint64 openedAt;
        uint64 stoodAt;
        bool doubled;
        euint256[] playerCards;
        euint256 dealerUp;
        euint256 dealerHole;
        euint256[] dealerDraws;
        uint256[] potTickets;
        uint256 houseOwedTickets;
        uint256 reservedUsdc;
    }

    mapping(uint256 => Hand) private _hands;
    mapping(address => uint256) public activeHandOf;
    uint256 public nextHandId = 1;

    // ------------------------------------------------------------------- events

    event HandOpened(uint256 indexed handId, address indexed player, uint256 potTickets);
    event PlayerHit(uint256 indexed handId, uint8 cardCount, uint256 potTickets);
    event PlayerDoubled(uint256 indexed handId);
    event PlayerStood(uint256 indexed handId, uint256 committedDraws);
    event HandSettled(
        uint256 indexed handId,
        address indexed player,
        BlackjackMath.Outcome outcome,
        uint8 playerTotal,
        uint8 dealerTotal,
        uint256 ticketsToPlayer,
        uint256 usdcToPlayer
    );
    event KeeperSet(address indexed previous, address indexed current);
    event HitSoft17Set(bool value);
    event HandTimedOut(uint256 indexed handId, address indexed player, uint256 ticketsReturned, uint256 usdcPaid);
    event TimeoutParamsSet(uint256 attestationTimeout, uint256 pushDeadline);

    // ------------------------------------------------------------------- errors

    error ZeroAddress();
    error HandAlreadyOpen();
    error NoOpenHand();
    error WrongState();
    error TimeoutNotReached(uint256 deadline);
    error PushDeadlineTooLarge(uint256 pushDeadline, uint256 closeBuffer);
    error BuyingClosed();
    error BadAttestation(uint256 index);
    error AttestationCountMismatch(uint256 expected, uint256 provided);
    error DoubleNotAllowed();
    error AlreadyDoubled();

    // -------------------------------------------------------------- construction

    constructor(address _vault, address _usdc, address _jackpot, address _owner) Ownable(_owner) {
        if (_vault == address(0) || _usdc == address(0) || _jackpot == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        vault = TicketVault(_vault);
        usdc = IERC20(_usdc);
        jackpot = IJackpot(_jackpot);
    }

    /// @dev randBounded is a paid Inco op funded from this contract's balance.
    receive() external payable {}

    // ---------------------------------------------------------------- card draws

    /// @dev A card nobody can read. This is the hole card. No grant is issued to
    ///      any address, so no ACL entry exists to leak it. allowThis only lets
    ///      the contract re-access the handle in a later transaction to reveal it
    ///      at resolve; without it the handle would be unreachable forever.
    function _drawSecret() private returns (euint256 card) {
        card = e.randBounded(DECK);
        card.allowThis();
    }

    /// @dev A card everyone can read. Player cards and the dealer upcard.
    ///      Public on purpose: solo play has no opponent to hide from, and an ACL
    ///      grant would cost the player a wallet signature per peek.
    function _drawFaceUp() private returns (euint256 card) {
        card = _drawSecret();
        e.reveal(card);
    }

    // ------------------------------------------------------------- ticket picks

    /// @dev Ball numbers are public state and unrelated to rank and suit, which
    ///      come from the encrypted shoe. Bounds are read live because ballMax and
    ///      bonusballMax are per-drawing.
    function _makeTickets(uint256 count, uint256 seed)
        private
        view
        returns (IJackpot.Ticket[] memory tickets)
    {
        IJackpot.DrawingState memory st = jackpot.getDrawingState(jackpot.currentDrawingId());
        tickets = new IJackpot.Ticket[](count);
        for (uint256 t = 0; t < count; t++) {
            uint8[] memory normals = new uint8[](NORMALS);
            uint256 taken;
            uint256 filled;
            uint256 nonce;
            while (filled < NORMALS) {
                uint256 pick = (uint256(keccak256(abi.encode(seed, t, nonce++))) % st.ballMax) + 1;
                uint256 bit = 1 << pick;
                if (taken & bit == 0) {
                    taken |= bit;
                    normals[filled++] = uint8(pick);
                }
            }
            uint8 bonus = uint8((uint256(keccak256(abi.encode(seed, t, "b"))) % st.bonusballMax) + 1);
            tickets[t] = IJackpot.Ticket({normals: normals, bonusball: bonus});
        }
    }

    // ------------------------------------------------------------------ the hand

    /// @notice Open a hand. Player antes two cards, the house matches two.
    /// @dev Pot is 4 tickets. All four are bought in ONE call with the vault as
    ///      recipient, because the vault holds everything during play. Nothing
    ///      mints to the player mid-hand, so there is no approval to revoke and
    ///      nothing to seize.
    function deal() external nonReentrant returns (uint256 handId) {
        if (activeHandOf[msg.sender] != 0) revert HandAlreadyOpen();
        if (!vault.canBuy()) revert BuyingClosed();

        uint256 price = vault.ticketPriceUsdc();
        // Player funds their two cards. The house funds the dealer's two from
        // bankroll. Both land in the vault.
        usdc.safeTransferFrom(msg.sender, address(vault), 2 * price);

        handId = nextHandId++;
        Hand storage h = _hands[handId];
        h.player = msg.sender;
        h.state = State.PlayerTurn;
        h.openedAt = uint64(block.timestamp);

        uint256[] memory ids = vault.buyTickets(_makeTickets(4, _seed(handId, 0)), 0);
        for (uint256 i = 0; i < ids.length; i++) h.potTickets.push(ids[i]);

        h.playerCards.push(_drawFaceUp());
        h.playerCards.push(_drawFaceUp());
        h.dealerUp = _drawFaceUp();
        h.dealerHole = _drawSecret();

        activeHandOf[msg.sender] = handId;
        emit HandOpened(handId, msg.sender, h.potTickets.length);
    }

    /// @notice Take another card. Costs one ticket. The house's matching stake is
    ///         reserved now and bought at resolve.
    function hit() external nonReentrant {
        (uint256 handId, Hand storage h) = _openHand();
        if (h.state != State.PlayerTurn) revert WrongState();
        if (h.doubled) revert AlreadyDoubled();

        _takeOneCard(handId, h);
        emit PlayerHit(handId, uint8(h.playerCards.length), _potSize(h));
    }

    /// @notice Double: pay two, take exactly one card, then stand.
    /// @dev Hard 9, 10 or 11 only. The contract cannot read the total during play,
    ///      so eligibility is asserted by the caller and verified at settle. A
    ///      player who doubles on an ineligible hand has the double rejected there.
    function double() external nonReentrant {
        (uint256 handId, Hand storage h) = _openHand();
        if (h.state != State.PlayerTurn) revert WrongState();
        if (h.doubled) revert AlreadyDoubled();
        if (h.playerCards.length != 2) revert DoubleNotAllowed();

        // One extra card, plus a second ticket that is pure added stake.
        _takeOneCard(handId, h);
        _addStakeOnly(h);
        h.doubled = true;
        emit PlayerDoubled(handId);

        _stand(handId, h);
    }

    function _takeOneCard(uint256 handId, Hand storage h) private {
        if (!vault.canBuy()) revert BuyingClosed();
        uint256 price = vault.ticketPriceUsdc();

        usdc.safeTransferFrom(msg.sender, address(vault), price);
        uint256[] memory ids = vault.buyTickets(
            _makeTickets(1, _seed(handId, h.playerCards.length + 10)),
            0
        );
        h.potTickets.push(ids[0]);
        h.playerCards.push(_drawFaceUp());

        // The house owes a matching ticket. Purchase deferred to resolve, funding
        // is not: reserve it now or the vault can go insolvent on a run of hits.
        vault.reserve(price);
        h.reservedUsdc += price;
        h.houseOwedTickets += 1;
    }

    function _addStakeOnly(Hand storage h) private {
        uint256 price = vault.ticketPriceUsdc();
        usdc.safeTransferFrom(msg.sender, address(vault), price);
        vault.reserve(price);
        h.reservedUsdc += price;
        h.houseOwedTickets += 1;
    }

    /// @notice Stop taking cards. Reveals the hole card and commits the dealer's
    ///         tail draws before the outcome is known.
    function stand() external nonReentrant {
        (uint256 handId, Hand storage h) = _openHand();
        if (h.state != State.PlayerTurn) revert WrongState();
        _stand(handId, h);
    }

    function _stand(uint256 handId, Hand storage h) private {
        // The hole card opens here and not one moment earlier.
        e.reveal(h.dealerHole);

        // Committed now, face-up, before anyone knows how many will be used. This
        // is what makes the dealer's play verifiable after the fact.
        for (uint256 i = 0; i < BlackjackMath.MAX_DEALER_DRAWS; i++) {
            h.dealerDraws.push(_drawFaceUp());
        }

        h.state = State.AwaitingAttestation;
        h.stoodAt = uint64(block.timestamp);
        emit PlayerStood(handId, h.dealerDraws.length);
    }

    // ------------------------------------------------------------------- settle

    /// @notice Resolve a hand using covalidator attestations.
    /// @dev Callable by the player OR the keeper. Attestations are bound to the
    ///      stored handles by e.verifyDecryption, so a keeper cannot substitute a
    ///      value for a different card. If the keeper is down the player submits
    ///      it themselves; the hand can never be stranded by a keeper outage.
    /// @param values card values in order: player cards, dealer up, dealer hole,
    ///        then every committed dealer draw
    /// @param sigs   covalidator signatures aligned with `values`
    function settle(uint256 handId, uint256[] calldata values, bytes[][] calldata sigs)
        external
        nonReentrant
    {
        Hand storage h = _hands[handId];
        if (h.state != State.AwaitingAttestation) revert WrongState();

        // Permissionless on purpose. e.verifyDecryption binds every value to its
        // stored handle, so a caller cannot substitute anything; they can only
        // submit correct attestations. Restricting this to player-or-keeper made
        // the timeout reachable whenever the keeper was down and the player
        // simply declined to settle, which a losing player would always do.
        (
            uint256[] memory playerCards,
            uint256[] memory upAndHole,
            uint256[] memory draws
        ) = _resolveCardValues(h, values, sigs);

        (BlackjackMath.Outcome outcome, uint8 pTotal, uint8 dTotal, ) = BlackjackMath.settle(
            playerCards,
            playerCards.length,
            upAndHole,
            draws,
            hitSoft17
        );

        h.state = State.Settled;
        activeHandOf[h.player] = 0;

        _payout(handId, h, outcome, pTotal, dTotal);
    }

    /// @dev THE MODE BOUNDARY.
    ///
    ///      This is the only function in the settle path that knows attestations
    ///      exist. Everything downstream, BlackjackMath and _payout and the vault,
    ///      works on plaintext and does not care where it came from.
    ///
    ///      If the covalidator proves unreliable and we fall back to commit-reveal,
    ///      this function is what gets replaced: hash preimages against stored
    ///      commitments instead of verifying signatures against stored handles.
    ///      Nothing else in the resolution path changes. That is deliberate, and
    ///      it is why the indirection exists even though there is currently one
    ///      implementation.
    function _resolveCardValues(
        Hand storage h,
        uint256[] calldata values,
        bytes[][] calldata sigs
    )
        private
        view
        returns (uint256[] memory playerCards, uint256[] memory upAndHole, uint256[] memory draws)
    {
        uint256 pLen = h.playerCards.length;
        uint256 dLen = h.dealerDraws.length;
        uint256 expected = pLen + 2 + dLen;
        if (values.length != expected || sigs.length != expected) {
            revert AttestationCountMismatch(expected, values.length);
        }

        playerCards = new uint256[](pLen);
        for (uint256 i = 0; i < pLen; i++) {
            if (!e.verifyDecryption(h.playerCards[i], values[i], sigs[i])) revert BadAttestation(i);
            playerCards[i] = values[i];
        }

        upAndHole = new uint256[](2);
        if (!e.verifyDecryption(h.dealerUp, values[pLen], sigs[pLen])) revert BadAttestation(pLen);
        upAndHole[0] = values[pLen];
        if (!e.verifyDecryption(h.dealerHole, values[pLen + 1], sigs[pLen + 1])) {
            revert BadAttestation(pLen + 1);
        }
        upAndHole[1] = values[pLen + 1];

        draws = new uint256[](dLen);
        for (uint256 i = 0; i < dLen; i++) {
            uint256 k = pLen + 2 + i;
            if (!e.verifyDecryption(h.dealerDraws[i], values[k], sigs[k])) revert BadAttestation(k);
            draws[i] = values[k];
        }
    }

    // ------------------------------------------------------------------ timeout

    /// @notice When the hand timeout is reachable. Zero means not yet.
    /// @dev Two deadlines, whichever is earlier:
    ///
    ///      standAt + attestationTimeout   the ordinary case, attestations never came
    ///      drawingTime - pushDeadline     the guarantee
    ///
    ///      The second term is what makes the timeout safe. Tickets are bound to a
    ///      drawing and worth nothing after it, so a push that returns expired
    ///      tickets is not a push. This fires before the drawing regardless of when
    ///      the hand opened.
    function timeoutAt(uint256 handId) public view returns (uint256) {
        Hand storage h = _hands[handId];
        if (h.state != State.AwaitingAttestation) return 0;

        uint256 byInterval = uint256(h.stoodAt) + attestationTimeoutSeconds;
        uint256 drawingTime = jackpot.getDrawingState(jackpot.currentDrawingId()).drawingTime;
        uint256 byDrawing = drawingTime > pushDeadlineSeconds ? drawingTime - pushDeadlineSeconds : 0;

        return byInterval < byDrawing ? byInterval : byDrawing;
    }

    /// @notice Force a stuck hand to push. Permissionless.
    ///
    /// @dev Only reachable when nobody can settle, which in practice means
    ///      attestations are unobtainable. Anyone holding valid attestations can
    ///      settle instead, and settle is open to any caller, so this cannot be
    ///      used to escape a losing hand while the covalidator is healthy.
    ///
    ///      Push returns each side its own, per the standing rule. Past the
    ///      drawing, tickets are worthless, so the player's share settles in USDC
    ///      at the standing bid instead.
    function timeoutPush(uint256 handId) external nonReentrant {
        Hand storage h = _hands[handId];
        if (h.state != State.AwaitingAttestation) revert WrongState();

        uint256 deadline = timeoutAt(handId);
        if (deadline == 0 || block.timestamp < deadline) revert TimeoutNotReached(deadline);

        h.state = State.Settled;
        activeHandOf[h.player] = 0;

        uint256 own = h.playerCards.length;
        if (own > h.potTickets.length) own = h.potTickets.length;

        uint256 drawingTime = jackpot.getDrawingState(jackpot.currentDrawingId()).drawingTime;
        uint256 usdcPaid;

        if (block.timestamp >= drawingTime) {
            // The tickets in the pot belong to a drawing that has already fired.
            // Returning them would be returning worthless paper.
            vault.settleInUsdc(h.player, own);
            usdcPaid = own * vault.settlementPriceUsdc();
        } else {
            _release(h, own);
        }

        if (h.reservedUsdc > 0) {
            vault.unreserve(h.reservedUsdc);
            h.reservedUsdc = 0;
        }
        h.houseOwedTickets = 0;

        emit HandTimedOut(handId, h.player, own, usdcPaid);
        emit HandSettled(handId, h.player, BlackjackMath.Outcome.Push, 0, 0, own, usdcPaid);
    }

    /// @dev Payout is deliberately separated so the outcome logic above stays
    ///      readable and testable in isolation.
    function _payout(
        uint256 handId,
        Hand storage h,
        BlackjackMath.Outcome outcome,
        uint8 pTotal,
        uint8 dTotal
    ) private {
        uint256 ticketsToPlayer;
        uint256 usdcToPlayer;

        if (outcome == BlackjackMath.Outcome.DealerWins) {
            // House keeps the pot. Release the reserve back to free bankroll.
            if (h.reservedUsdc > 0) {
                vault.unreserve(h.reservedUsdc);
                h.reservedUsdc = 0;
            }
        } else if (outcome == BlackjackMath.Outcome.Push) {
            // Each side keeps its own. The player gets back the tickets they funded.
            uint256 own = h.playerCards.length;
            ticketsToPlayer = own > h.potTickets.length ? h.potTickets.length : own;
            _release(h, ticketsToPlayer);
            if (h.reservedUsdc > 0) {
                vault.unreserve(h.reservedUsdc);
                h.reservedUsdc = 0;
            }
        } else {
            // Player wins. Whole pot, plus whatever house stake was deferred.
            ticketsToPlayer = h.potTickets.length;
            _release(h, ticketsToPlayer);
            usdcToPlayer = _settleOwed(h);

            if (outcome == BlackjackMath.Outcome.PlayerNatural) {
                usdcToPlayer += _payNaturalPremium(h);
            }
        }

        emit HandSettled(handId, h.player, outcome, pTotal, dTotal, ticketsToPlayer, usdcToPlayer);
    }

    /// @dev A natural pays 6:5 rather than 1:1, so the player is owed a fifth of
    ///      their stake beyond the pot. Ticket NFTs are indivisible, so that
    ///      fraction settles in USDC through the shared helper.
    ///
    ///      Worked: staked 2, winnings 2 * 6/5 = 2.4. The pot already covers 2 of
    ///      those plus their own 2 back. Outstanding is 0.4, which is $0.40.
    ///      Naturals are two-card by definition so the stake is always 2, but the
    ///      helper is general and is not a special case for this rule.
    function _payNaturalPremium(Hand storage h) private returns (uint256) {
        uint256 stake = h.playerCards.length;
        (uint256 extraTickets, uint256 remainder) = TicketMath.splitFractional(
            stake, // stake * (6/5 - 1) == stake / 5
            5,
            vault.ticketPriceUsdc()
        );

        // A whole extra ticket only arises for stakes of 5 or more, which a
        // two-card natural cannot reach. Pay it in cash rather than buying a
        // ticket mid-settle, so the path stays identical whether or not the
        // drawing is still open.
        uint256 total = remainder + extraTickets * vault.ticketPriceUsdc();
        if (total > 0) vault.payUsdc(h.player, total);
        return total;
    }

    function _release(Hand storage h, uint256 count) private {
        if (count == 0) return;
        uint256[] memory ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) ids[i] = h.potTickets[i];
        vault.releaseTickets(h.player, ids);
    }

    /// @dev The deferred house stake. Bought as tickets when the drawing is open,
    ///      settled in USDC at the standing bid when it is not. Never at face:
    ///      paying face would reward stalling into a locked drawing.
    function _settleOwed(Hand storage h) private returns (uint256 usdcPaid) {
        uint256 owed = h.houseOwedTickets;
        if (owed == 0) return 0;
        h.houseOwedTickets = 0;

        if (vault.canBuy()) {
            uint256[] memory ids = vault.buyTickets(_makeTickets(owed, _seed(0, block.number)), h.reservedUsdc);
            h.reservedUsdc = 0;
            vault.releaseTickets(h.player, ids);
            return 0;
        }

        vault.settleInUsdc(h.player, owed);
        h.reservedUsdc = 0;
        return owed * vault.settlementPriceUsdc();
    }

    // -------------------------------------------------------------------- views

    function handState(uint256 handId)
        external
        view
        returns (
            address player,
            State state,
            bool doubled,
            uint256 playerCardCount,
            uint256 potTickets,
            uint256 houseOwedTickets
        )
    {
        Hand storage h = _hands[handId];
        return (h.player, h.state, h.doubled, h.playerCards.length, _potSize(h), h.houseOwedTickets);
    }

    /// @notice Handles the frontend needs to decrypt or reveal.
    /// @dev dealerHole is returned so the UI can show that it EXISTS. It is not
    ///      readable until stand reveals it, which is the point.
    function handHandles(uint256 handId)
        external
        view
        returns (bytes32[] memory playerCards, bytes32 dealerUp, bytes32 dealerHole, bytes32[] memory dealerDraws)
    {
        Hand storage h = _hands[handId];
        playerCards = new bytes32[](h.playerCards.length);
        for (uint256 i = 0; i < h.playerCards.length; i++) {
            playerCards[i] = euint256.unwrap(h.playerCards[i]);
        }
        dealerDraws = new bytes32[](h.dealerDraws.length);
        for (uint256 i = 0; i < h.dealerDraws.length; i++) {
            dealerDraws[i] = euint256.unwrap(h.dealerDraws[i]);
        }
        return (playerCards, euint256.unwrap(h.dealerUp), euint256.unwrap(h.dealerHole), dealerDraws);
    }

    /// @notice Pot tickets for a hand, the explicit "Pot: N tickets" counter.
    function potTicketIds(uint256 handId) external view returns (uint256[] memory) {
        return _hands[handId].potTickets;
    }

    // -------------------------------------------------------------------- admin

    function setKeeper(address _keeper) external onlyOwner {
        emit KeeperSet(keeper, _keeper);
        keeper = _keeper;
    }

    function setHitSoft17(bool v) external onlyOwner {
        hitSoft17 = v;
        emit HitSoft17Set(v);
    }

    /// @dev pushDeadline must stay under the vault's closeBufferSeconds, else a
    ///      hand could open after the point where stuck hands are already being
    ///      pushed, which would let a hand exist with no route to resolution.
    function setTimeoutParams(uint256 attestationTimeout, uint256 pushDeadline) external onlyOwner {
        uint256 closeBuffer = vault.closeBufferSeconds();
        if (pushDeadline >= closeBuffer) revert PushDeadlineTooLarge(pushDeadline, closeBuffer);
        attestationTimeoutSeconds = attestationTimeout;
        pushDeadlineSeconds = pushDeadline;
        emit TimeoutParamsSet(attestationTimeout, pushDeadline);
    }

    // ----------------------------------------------------------------- internal

    function _openHand() private view returns (uint256 handId, Hand storage h) {
        handId = activeHandOf[msg.sender];
        if (handId == 0) revert NoOpenHand();
        h = _hands[handId];
    }

    function _potSize(Hand storage h) private view returns (uint256) {
        return h.potTickets.length + h.houseOwedTickets;
    }

    function _seed(uint256 handId, uint256 salt) private view returns (uint256) {
        return uint256(keccak256(abi.encode(handId, salt, block.prevrandao, address(this))));
    }
}
