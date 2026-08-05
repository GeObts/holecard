// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IJackpot, IJackpotTicketNFT} from "./interfaces/IMegapot.sol";
import {TicketMath} from "./lib/TicketMath.sol";

/// @title TicketVault
/// @notice Owns the house bankroll and every ticket in play.
///
/// @dev Design decisions this contract encodes, all settled before it was written:
///
///   1. The vault holds ALL tickets during a hand, including the player's cards.
///      Nothing mints to a player mid-hand. This removes the seize problem
///      entirely: if player cards minted to the player, seizing on a loss would
///      need an NFT approval the player could revoke after seeing they busted.
///      Card faces still render because ball numbers are public NFT state,
///      readable regardless of holder.
///
///   2. Referrer is the treasury, set once in the constructor, zero-guarded.
///      It is never a parameter any caller can influence. Referral is the
///      dominant revenue term (10% of every ticket, live-read), so letting it
///      drift to a player or test address would quietly zero the business model.
///
///   3. Purchases may be deferred but funding never is. Every dollar the house
///      owes an open hand is reserved at the moment the obligation is created.
///      reservedUsdc can never exceed the balance, so a run of hits cannot leave
///      the vault insolvent with players holding winning hands.
///
///   4. One canBuy() predicate covers the drawing cutoff, jackpotLock,
///      allowTicketPurchases and prizePool == 0. They collapse because they share
///      one consequence: the vault cannot acquire tickets. The RESPONSE differs
///      by caller, which is the table's job, not this contract's.
contract TicketVault is Ownable2Step, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;
    using TicketMath for uint256[12];

    // ---------------------------------------------------------------- immutables

    IERC20 public immutable usdc;
    IJackpot public immutable jackpot;
    IJackpotTicketNFT public immutable ticketNFT;

    /// @notice Referral beneficiary on every purchase. Immutable by design.
    address public immutable treasury;

    /// @notice Telemetry tag on every purchase, how Megapot measures volume we drove.
    bytes32 public immutable sourceTag;

    /// @dev Megapot referral weights are 1e18 scaled and must sum to 1e18.
    uint256 private constant PRECISE_UNIT = 1e18;

    // ------------------------------------------------------------------- config

    /// @notice Standing bid to buy a ticket back from a player, USDC 6dp.
    /// @dev Must sit below holder value or the vault loses money on every sellback.
    ///      Holder value on drawing 134 measured 0.695365, hence the 0.65 default.
    uint256 public sellbackPriceUsdc = 650_000;

    /// @notice Price used when the vault owes tickets it cannot buy, USDC 6dp.
    /// @dev Defaults to the sellback price so stalling into a locked drawing is
    ///      never better than acting. Paying face here would pay a stalling player
    ///      ~44% more than the tickets were worth, which is an incentive, not a
    ///      safety margin.
    uint256 public settlementPriceUsdc = 650_000;

    /// @notice Buying and selling both stop this many seconds before the drawing.
    /// @dev Sized to the longest plausible hand so no hand opens that cannot finish.
    uint256 public closeBufferSeconds = 900;

    /// @notice The BlackjackTable. Only it may move house funds or tickets.
    address public table;

    // -------------------------------------------------------------------- state

    /// @notice USDC committed to open hands. Never spendable as free bankroll.
    uint256 public reservedUsdc;

    /// @notice Tickets currently held by the vault, for auditability.
    uint256 public heldTicketCount;

    // ------------------------------------------------------------------- events

    event TableSet(address indexed previous, address indexed current);
    event SellbackPriceSet(uint256 previous, uint256 current);
    event SettlementPriceSet(uint256 previous, uint256 current);
    event CloseBufferSet(uint256 previous, uint256 current);

    event TicketsBought(uint256 count, uint256 costUsdc, uint256[] ticketIds);
    event TicketsReleased(address indexed to, uint256 count);
    event Reserved(uint256 amount, uint256 totalReserved);
    event Unreserved(uint256 amount, uint256 totalReserved);
    event SettledInUsdc(address indexed to, uint256 ticketsOwed, uint256 amountUsdc);
    event SoldBack(address indexed from, uint256 count, uint256 amountUsdc);
    event BankrollDeposited(address indexed from, uint256 amount);
    event BankrollWithdrawn(address indexed to, uint256 amount);

    // ------------------------------------------------------------------- errors

    error ZeroAddress();
    error NotTable();
    error BuyingClosed();
    error InsufficientFreeBalance(uint256 requested, uint256 available);
    error InsufficientReserve(uint256 requested, uint256 reserved);
    error NothingProvided();
    error PriceAboveHolderValue(uint256 price, uint256 holderValue);
    error TreasuryIsVault();

    // -------------------------------------------------------------- construction

    constructor(
        address _usdc,
        address _jackpot,
        address _ticketNFT,
        address _treasury,
        bytes32 _sourceTag,
        address _owner
    ) Ownable(_owner) {
        if (
            _usdc == address(0) ||
            _jackpot == address(0) ||
            _ticketNFT == address(0) ||
            _treasury == address(0) ||
            _owner == address(0)
        ) revert ZeroAddress();
        // The treasury must be distinct from the vault, otherwise referral income
        // lands in pot inventory and the reserve accounting stops being verifiable.
        if (_treasury == address(this)) revert TreasuryIsVault();

        usdc = IERC20(_usdc);
        jackpot = IJackpot(_jackpot);
        ticketNFT = IJackpotTicketNFT(_ticketNFT);
        treasury = _treasury;
        sourceTag = _sourceTag;
    }

    modifier onlyTable() {
        if (msg.sender != table) revert NotTable();
        _;
    }

    // ------------------------------------------------------------ live protocol

    /// @notice The single guard. True when the vault can acquire tickets.
    /// @dev Read live every time. ballMax, bonusballMax, drawingTime, referralFee
    ///      and referralWinShare are all per-drawing and owner-settable upstream.
    function canBuy() public view returns (bool) {
        if (!jackpot.allowTicketPurchases()) return false;
        IJackpot.DrawingState memory st = jackpot.getDrawingState(jackpot.currentDrawingId());
        if (st.jackpotLock) return false;
        if (st.prizePool == 0) return false;
        if (block.timestamp + closeBufferSeconds >= st.drawingTime) return false;
        return true;
    }

    /// @notice Seconds until buying closes. Zero once closed. Drives the UI countdown.
    function secondsUntilClose() external view returns (uint256) {
        IJackpot.DrawingState memory st = jackpot.getDrawingState(jackpot.currentDrawingId());
        uint256 closeAt = st.drawingTime - closeBufferSeconds;
        if (block.timestamp >= closeAt) return 0;
        return closeAt - block.timestamp;
    }

    /// @notice Current ticket price in USDC 6dp, read live. Never hardcode this.
    function ticketPriceUsdc() public view returns (uint256) {
        return jackpot.getDrawingState(jackpot.currentDrawingId()).ticketPrice;
    }

    /// @notice Gross expected payout of one ticket, USDC 6dp, from live drawing state.
    function ticketGrossEv() public view returns (uint256) {
        uint256 drawingId = jackpot.currentDrawingId();
        IJackpot.DrawingState memory st = jackpot.getDrawingState(drawingId);
        return TicketMath.grossEv(jackpot.getDrawingTierPayouts(drawingId), st.ballMax, st.bonusballMax);
    }

    /// @notice What a ticket is worth to whoever holds it, USDC 6dp.
    /// @dev Surfaced next to the sellback offer in the UI so the bid reads as a
    ///      transparent market rather than a haircut.
    function ticketHolderValue() public view returns (uint256) {
        uint256 drawingId = jackpot.currentDrawingId();
        IJackpot.DrawingState memory st = jackpot.getDrawingState(drawingId);
        return
            TicketMath.holderValue(
                jackpot.getDrawingTierPayouts(drawingId),
                st.ballMax,
                st.bonusballMax,
                st.referralWinShare
            );
    }

    // ---------------------------------------------------------------- accounting

    /// @notice Bankroll not committed to any open hand.
    function freeUsdc() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        return bal > reservedUsdc ? bal - reservedUsdc : 0;
    }

    /// @notice Commit USDC against an obligation the house has just taken on.
    /// @dev Called when a hand opens and on every hit. Deferring the PURCHASE is
    ///      safe only because the FUNDING is never deferred.
    function reserve(uint256 amount) external onlyTable {
        uint256 free = freeUsdc();
        if (amount > free) revert InsufficientFreeBalance(amount, free);
        reservedUsdc += amount;
        emit Reserved(amount, reservedUsdc);
    }

    function _unreserve(uint256 amount) private {
        if (amount > reservedUsdc) revert InsufficientReserve(amount, reservedUsdc);
        reservedUsdc -= amount;
        emit Unreserved(amount, reservedUsdc);
    }

    /// @notice Release a reservation without spending it, when a hand ends and the
    ///         house keeps its own stake.
    function unreserve(uint256 amount) external onlyTable {
        _unreserve(amount);
    }

    // ------------------------------------------------------------------ purchase

    /// @notice Buy tickets from Megapot into the vault.
    /// @param tickets     ball picks, validated upstream against live ballMax bounds
    /// @param fromReserve how much of the cost is already reserved against open hands
    /// @dev recipient is always this vault, referrer is always the treasury, and
    ///      every purchase carries the source tag.
    function buyTickets(IJackpot.Ticket[] calldata tickets, uint256 fromReserve)
        external
        onlyTable
        nonReentrant
        returns (uint256[] memory ticketIds)
    {
        if (tickets.length == 0) revert NothingProvided();
        if (!canBuy()) revert BuyingClosed();

        uint256 cost = tickets.length * ticketPriceUsdc();

        if (fromReserve > 0) {
            if (fromReserve > cost) fromReserve = cost;
            _unreserve(fromReserve);
        }
        uint256 fromFree = cost - fromReserve;
        uint256 free = freeUsdc();
        if (fromFree > free) revert InsufficientFreeBalance(fromFree, free);

        address[] memory referrers = new address[](1);
        referrers[0] = treasury;
        uint256[] memory split = new uint256[](1);
        split[0] = PRECISE_UNIT;

        usdc.forceApprove(address(jackpot), cost);
        ticketIds = jackpot.buyTickets(tickets, address(this), referrers, split, sourceTag);
        usdc.forceApprove(address(jackpot), 0);

        heldTicketCount += ticketIds.length;
        emit TicketsBought(ticketIds.length, cost, ticketIds);
    }

    // ------------------------------------------------------------------- payouts

    /// @notice Hand tickets to the winner of a pot.
    function releaseTickets(address to, uint256[] calldata ticketIds) external onlyTable nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (ticketIds.length == 0) revert NothingProvided();
        for (uint256 i = 0; i < ticketIds.length; i++) {
            ticketNFT.transferFrom(address(this), to, ticketIds[i]);
        }
        heldTicketCount -= ticketIds.length;
        emit TicketsReleased(to, ticketIds.length);
    }

    /// @notice Settle an obligation the vault cannot deliver in tickets.
    /// @dev Only reachable when canBuy() is false, which is exactly when the
    ///      force-resolve sweep runs, so this is the sweep's main path rather than
    ///      an edge case. Priced at settlementPriceUsdc, not at face.
    function settleInUsdc(address to, uint256 ticketsOwed) external onlyTable nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (ticketsOwed == 0) revert NothingProvided();
        uint256 amount = ticketsOwed * settlementPriceUsdc;
        _unreserve(amount > reservedUsdc ? reservedUsdc : amount);
        usdc.safeTransfer(to, amount);
        emit SettledInUsdc(to, ticketsOwed, amount);
    }

    // ------------------------------------------------------------------ sellback

    /// @notice Sell won tickets back to the vault at the standing bid.
    /// @dev Player-facing, not table-gated. Requires prior NFT approval, which is
    ///      safe here because the player already owns the tickets outright.
    ///      Closed whenever buying is closed: paying cash for tickets the vault
    ///      cannot replace would drain the bankroll into a locked drawing.
    function sellback(uint256[] calldata ticketIds) external nonReentrant returns (uint256 amount) {
        if (ticketIds.length == 0) revert NothingProvided();
        if (!canBuy()) revert BuyingClosed();

        amount = ticketIds.length * sellbackPriceUsdc;
        uint256 free = freeUsdc();
        if (amount > free) revert InsufficientFreeBalance(amount, free);

        for (uint256 i = 0; i < ticketIds.length; i++) {
            ticketNFT.transferFrom(msg.sender, address(this), ticketIds[i]);
        }
        heldTicketCount += ticketIds.length;

        usdc.safeTransfer(msg.sender, amount);
        emit SoldBack(msg.sender, ticketIds.length, amount);
    }

    // -------------------------------------------------------------------- admin

    function setTable(address _table) external onlyOwner {
        if (_table == address(0)) revert ZeroAddress();
        emit TableSet(table, _table);
        table = _table;
    }

    /// @dev Guarded against being set at or above holder value, which would make
    ///      every sellback a loss. Checked against live drawing state.
    function setSellbackPrice(uint256 price) external onlyOwner {
        uint256 hv = ticketHolderValue();
        if (price >= hv) revert PriceAboveHolderValue(price, hv);
        emit SellbackPriceSet(sellbackPriceUsdc, price);
        sellbackPriceUsdc = price;
    }

    function setSettlementPrice(uint256 price) external onlyOwner {
        emit SettlementPriceSet(settlementPriceUsdc, price);
        settlementPriceUsdc = price;
    }

    function setCloseBuffer(uint256 seconds_) external onlyOwner {
        emit CloseBufferSet(closeBufferSeconds, seconds_);
        closeBufferSeconds = seconds_;
    }

    function depositBankroll(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BankrollDeposited(msg.sender, amount);
    }

    /// @dev Cannot touch USDC committed to open hands.
    function withdrawBankroll(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = freeUsdc();
        if (amount > free) revert InsufficientFreeBalance(amount, free);
        usdc.safeTransfer(to, amount);
        emit BankrollWithdrawn(to, amount);
    }

    /// @notice Claim winnings on tickets the vault still holds after a drawing.
    function claimWinnings(uint256[] calldata ticketIds) external onlyOwner nonReentrant {
        if (ticketIds.length == 0) revert NothingProvided();
        jackpot.claimWinnings(ticketIds);
        heldTicketCount -= ticketIds.length;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
