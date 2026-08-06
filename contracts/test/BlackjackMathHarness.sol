// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {BlackjackMath} from "../lib/BlackjackMath.sol";

/// @dev Test-only. Exposes the scoring library so every rule can be proven with
///      plaintext cards, no covalidator, no fork, no Docker.
contract BlackjackMathHarness {
    function cardValue(uint256 card) external pure returns (uint8 value, bool isAce) {
        return BlackjackMath.cardValue(card);
    }

    function evaluate(uint256[] memory cards) external pure returns (uint8 total, bool soft) {
        return BlackjackMath.evaluate(cards, cards.length);
    }

    function isNatural(uint256[] memory cards) external pure returns (bool) {
        return BlackjackMath.isNatural(cards, cards.length);
    }

    function dealerMustHit(uint8 total, bool soft, bool hitSoft17) external pure returns (bool) {
        return BlackjackMath.dealerMustHit(total, soft, hitSoft17);
    }

    function playDealer(
        uint256[] memory upAndHole,
        uint256[] memory draws,
        bool hitSoft17
    ) external pure returns (uint8 total, uint256 used, bool bust) {
        return BlackjackMath.playDealer(upAndHole, draws, hitSoft17);
    }

    function bustIndex(uint256[] memory cards) external pure returns (uint256) {
        return BlackjackMath.bustIndex(cards, cards.length);
    }

    function settle(
        uint256[] memory playerCards,
        uint256[] memory upAndHole,
        uint256[] memory dealerDraws,
        bool hitSoft17
    )
        external
        pure
        returns (BlackjackMath.Outcome outcome, uint8 playerTotal, uint8 dealerTotal, uint256 drawsUsed)
    {
        return
            BlackjackMath.settle(playerCards, playerCards.length, upAndHole, dealerDraws, hitSoft17);
    }

    function maxDealerDraws() external pure returns (uint8) {
        return BlackjackMath.MAX_DEALER_DRAWS;
    }
}
