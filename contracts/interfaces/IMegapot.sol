// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Minimal live-verified surface of the Megapot Jackpot contract on Base
///         mainnet, 0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2.
/// @dev Signatures taken from the published ABI and the verified source, not from
///      the docs. The docs have been wrong six times on this project.
interface IJackpot {
    struct Ticket {
        uint8[] normals;
        uint8 bonusball;
    }

    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 referralFee;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint256 drawingTime;
        uint256 winningTicket;
        uint8 ballMax;
        uint8 bonusballMax;
        address payoutCalculator;
        bool jackpotLock;
    }

    /// @dev _referralSplit entries are PRECISE_UNIT (1e18) scaled and must sum to 1e18.
    ///      _source is emitted as an indexed topic on TicketPurchased and is never
    ///      written to state, so it is readable only from logs.
    function buyTickets(
        Ticket[] memory _tickets,
        address _recipient,
        address[] memory _referrers,
        uint256[] memory _referralSplit,
        bytes32 _source
    ) external returns (uint256[] memory ticketIds);

    function claimWinnings(uint256[] memory _userTicketIds) external;

    function currentDrawingId() external view returns (uint256);

    function allowTicketPurchases() external view returns (bool);

    function getDrawingState(uint256 _drawingId) external view returns (DrawingState memory);

    /// @notice Per-tier payouts, index = normalMatches * 2 + (bonusballMatch ? 1 : 0).
    function getDrawingTierPayouts(uint256 _drawingId) external view returns (uint256[12] memory);
}

interface IJackpotTicketNFT {
    struct TrackedTicket {
        uint256 drawingId;
        uint256 packedTicket;
        bytes32 referralScheme;
    }

    function getTicketInfo(uint256 ticketId) external view returns (TrackedTicket memory);

    function ownerOf(uint256 tokenId) external view returns (address);

    function transferFrom(address from, address to, uint256 tokenId) external payable;
}
