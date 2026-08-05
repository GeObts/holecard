// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {TicketMath} from "../lib/TicketMath.sol";

/// @dev Test-only. Exposes the internal library so it can be unit tested without
///      a fork or a covalidator.
contract TicketMathHarness {
    function choose(uint256 n, uint256 k) external pure returns (uint256) {
        return TicketMath.choose(n, k);
    }

    function totalCombos(uint8 ballMax, uint8 bonusballMax) external pure returns (uint256) {
        return TicketMath.totalCombos(ballMax, bonusballMax);
    }

    function grossEv(
        uint256[12] memory tierPayouts,
        uint8 ballMax,
        uint8 bonusballMax
    ) external pure returns (uint256) {
        return TicketMath.grossEv(tierPayouts, ballMax, bonusballMax);
    }

    function holderValue(
        uint256[12] memory tierPayouts,
        uint8 ballMax,
        uint8 bonusballMax,
        uint256 referralWinShare
    ) external pure returns (uint256) {
        return TicketMath.holderValue(tierPayouts, ballMax, bonusballMax, referralWinShare);
    }
}
