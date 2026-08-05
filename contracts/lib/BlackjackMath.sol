// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title BlackjackMath
/// @notice All hand scoring. Pure Solidity, zero Inco calls, so it unit tests
///         without a covalidator, Docker, or a fork.
///
/// @dev This library exists because of the settlement model. Cards are opaque
///      encrypted handles during play; at resolve the covalidator's attested
///      values are verified against those handles and from that point the
///      contract holds plaintext. So the dealer never needs branchless FHE
///      logic. It is ordinary Solidity running after the reveal.
library BlackjackMath {
    uint8 internal constant BLACKJACK = 21;
    uint8 internal constant DEALER_STANDS_ON = 17;

    /// @dev Worst case draws under S17 is 7: a dealer holding 2,2 (total 4)
    ///      drawing nothing but twos reaches 18 on the seventh card. Aces cannot
    ///      extend it because an ace counts 11 whenever that does not bust, which
    ///      climbs faster. 8 is that bound plus one card of margin.
    uint8 internal constant MAX_DEALER_DRAWS = 8;

    /// @notice Decode a 0..51 card into its blackjack value.
    /// @dev rank = card % 13 with 0 = ace, 12 = king. Suit = card / 13, unused in
    ///      scoring. Aces return 1 here and are promoted to 11 by evaluate().
    function cardValue(uint256 card) internal pure returns (uint8 value, bool isAce) {
        uint256 rank = card % 13;
        isAce = rank == 0;
        uint256 v = rank + 1;
        value = uint8(v > 10 ? 10 : v);
    }

    /// @notice Best total for the first `len` cards, and whether an ace is counting as 11.
    function evaluate(uint256[] memory cards, uint256 len)
        internal
        pure
        returns (uint8 total, bool soft)
    {
        uint256 raw;
        uint256 aces;
        for (uint256 i = 0; i < len; i++) {
            (uint8 v, bool isAce) = cardValue(cards[i]);
            raw += v;
            if (isAce) aces++;
        }
        // One ace may count as 11 instead of 1 when that does not bust.
        if (aces > 0 && raw + 10 <= BLACKJACK) {
            return (uint8(raw + 10), true);
        }
        return (uint8(raw > 255 ? 255 : raw), false);
    }

    function isBust(uint8 total) internal pure returns (bool) {
        return total > BLACKJACK;
    }

    /// @notice A natural is exactly two cards totalling 21. Pays 6:5.
    /// @dev Deliberately not "21 on any number of cards". A three-card 21 is a
    ///      plain win.
    function isNatural(uint256[] memory cards, uint256 len) internal pure returns (bool) {
        if (len != 2) return false;
        (uint8 total, ) = evaluate(cards, 2);
        return total == BLACKJACK;
    }

    /// @notice Dealer draw rule.
    /// @param hitSoft17 dormant in v1. S17 ships. Flipping this to true is the
    ///        entire H17 change, which is nearly free now that dealer logic runs
    ///        in plaintext rather than as an encrypted multiplexer.
    function dealerMustHit(uint8 total, bool soft, bool hitSoft17) internal pure returns (bool) {
        if (total < DEALER_STANDS_ON) return true;
        if (hitSoft17 && soft && total == DEALER_STANDS_ON) return true;
        return false;
    }

    /// @notice Play the dealer's hand out against a pre-committed list of draws.
    /// @param upAndHole the dealer's two starting cards
    /// @param draws     tail draws committed before the outcome was known
    /// @return total    dealer's final total
    /// @return used     how many of `draws` were consumed
    /// @return bust     whether the dealer went over 21
    function playDealer(
        uint256[] memory upAndHole,
        uint256[] memory draws,
        bool hitSoft17
    ) internal pure returns (uint8 total, uint256 used, bool bust) {
        uint256[] memory hand = new uint256[](upAndHole.length + draws.length);
        for (uint256 i = 0; i < upAndHole.length; i++) hand[i] = upAndHole[i];
        uint256 len = upAndHole.length;

        bool soft;
        (total, soft) = evaluate(hand, len);

        while (used < draws.length && dealerMustHit(total, soft, hitSoft17)) {
            hand[len++] = draws[used++];
            (total, soft) = evaluate(hand, len);
        }
        bust = isBust(total);
    }

    /// @notice Index of the card that busted the player, or len if they never did.
    /// @dev Busting is self-punishing, so the table does not block a hit after a
    ///      bust. Cards taken after the bust point are simply ignored here.
    function bustIndex(uint256[] memory cards, uint256 len) internal pure returns (uint256) {
        for (uint256 i = 1; i <= len; i++) {
            (uint8 t, ) = evaluate(cards, i);
            if (isBust(t)) return i;
        }
        return len;
    }

    enum Outcome {
        PlayerWins,
        DealerWins,
        Push,
        PlayerNatural
    }

    /// @notice Full hand comparison.
    function settle(
        uint256[] memory playerCards,
        uint256 playerLen,
        uint256[] memory upAndHole,
        uint256[] memory dealerDraws,
        bool hitSoft17
    ) internal pure returns (Outcome outcome, uint8 playerTotal, uint8 dealerTotal, uint256 drawsUsed) {
        // Player busts first, before the dealer plays at all.
        uint256 bustAt = bustIndex(playerCards, playerLen);
        if (bustAt < playerLen || (bustAt == playerLen && _bustedAt(playerCards, playerLen))) {
            (playerTotal, ) = evaluate(playerCards, playerLen);
            return (Outcome.DealerWins, playerTotal, 0, 0);
        }

        (playerTotal, ) = evaluate(playerCards, playerLen);
        bool playerNatural = isNatural(playerCards, playerLen);
        bool dealerNatural = isNatural(upAndHole, upAndHole.length);

        // Naturals resolve before the dealer draws.
        if (playerNatural && dealerNatural) return (Outcome.Push, playerTotal, BLACKJACK, 0);
        if (playerNatural) return (Outcome.PlayerNatural, playerTotal, 0, 0);
        if (dealerNatural) return (Outcome.DealerWins, playerTotal, BLACKJACK, 0);

        bool dealerBust;
        (dealerTotal, drawsUsed, dealerBust) = playDealer(upAndHole, dealerDraws, hitSoft17);
        if (dealerBust) return (Outcome.PlayerWins, playerTotal, dealerTotal, drawsUsed);

        if (playerTotal > dealerTotal) return (Outcome.PlayerWins, playerTotal, dealerTotal, drawsUsed);
        if (playerTotal < dealerTotal) return (Outcome.DealerWins, playerTotal, dealerTotal, drawsUsed);
        return (Outcome.Push, playerTotal, dealerTotal, drawsUsed);
    }

    function _bustedAt(uint256[] memory cards, uint256 len) private pure returns (bool) {
        (uint8 t, ) = evaluate(cards, len);
        return isBust(t);
    }
}
