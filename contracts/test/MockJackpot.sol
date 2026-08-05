// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IJackpot} from "../interfaces/IMegapot.sol";

/// @dev Test-only. Lets each canBuy() cause be driven independently.
///      jackpotLock and prizePool cannot be toggled on a real fork without
///      guessing storage slots, so the predicate is branch-tested here and the
///      integration is fork-tested against the real contract.
contract MockJackpot {
    bool public allowTicketPurchases = true;
    uint256 public currentDrawingId = 1;

    uint256 public prizePool = 1_000_000e6;
    uint256 public ticketPrice = 1e6;
    uint256 public referralWinShare = 1e17;
    uint256 public referralFee = 1e17;
    uint256 public drawingTime;
    uint8 public ballMax = 30;
    uint8 public bonusballMax = 10;
    bool public jackpotLock;

    uint256[12] private tierPayouts;

    constructor() {
        drawingTime = block.timestamp + 30 days;
        tierPayouts = [
            uint256(0),
            1_111_112,
            0,
            3_265_881,
            1_111_112,
            5_851_605,
            5_149_310,
            10_197_057,
            25_340_300,
            219_173_810,
            2_272_597_557,
            224_878_269_196
        ];
    }

    function setAllowTicketPurchases(bool v) external {
        allowTicketPurchases = v;
    }

    function setJackpotLock(bool v) external {
        jackpotLock = v;
    }

    function setPrizePool(uint256 v) external {
        prizePool = v;
    }

    function setDrawingTime(uint256 v) external {
        drawingTime = v;
    }

    function getDrawingState(uint256) external view returns (IJackpot.DrawingState memory) {
        return
            IJackpot.DrawingState({
                prizePool: prizePool,
                ticketPrice: ticketPrice,
                edgePerTicket: 175_000,
                referralWinShare: referralWinShare,
                referralFee: referralFee,
                globalTicketsBought: 0,
                lpEarnings: 0,
                drawingTime: drawingTime,
                winningTicket: 0,
                ballMax: ballMax,
                bonusballMax: bonusballMax,
                payoutCalculator: address(0),
                jackpotLock: jackpotLock
            });
    }

    function getDrawingTierPayouts(uint256) external view returns (uint256[12] memory) {
        return tierPayouts;
    }
}
