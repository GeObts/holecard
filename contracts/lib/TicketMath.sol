// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title TicketMath
/// @notice Expected value of a Megapot ticket, computed from live drawing state.
/// @dev Pure maths, no external calls, so it unit-tests without a fork.
///
///      The spec requires the buyback window be derived from live state rather
///      than assumed. This is that derivation. It is also the deepest read of the
///      protocol in the build: tier payouts and ball bounds are per-drawing and
///      owner-settable, so EV moves between drawings and any constant is wrong.
library TicketMath {
    /// @dev Megapot fixes the normal ball count at 5. Verified in Jackpot.sol as
    ///      `uint8 constant NORMAL_BALL_COUNT = 5` and enforced on every purchase.
    uint256 internal constant NORMALS = 5;

    error InvalidBallBounds();

    /// @notice Binomial coefficient. Safe for the small n Megapot uses (ballMax <= 128).
    function choose(uint256 n, uint256 k) internal pure returns (uint256 r) {
        if (k > n) return 0;
        if (k > n - k) k = n - k;
        r = 1;
        for (uint256 i = 0; i < k; i++) {
            // Multiply before divide, and the divisor always divides exactly at
            // each step because r holds a partial binomial coefficient.
            r = (r * (n - i)) / (i + 1);
        }
    }

    /// @notice Number of distinct tickets in a drawing: C(ballMax, 5) * bonusballMax.
    function totalCombos(uint8 ballMax, uint8 bonusballMax) internal pure returns (uint256) {
        if (ballMax < 2 * NORMALS || bonusballMax == 0) revert InvalidBallBounds();
        return choose(ballMax, NORMALS) * bonusballMax;
    }

    /// @notice Gross expected payout of one ticket, in USDC 6dp.
    /// @dev This is the full expected payout before referralWinShare is deducted.
    ///      A holder receives EV * (1 - referralWinShare); the remainder goes to the
    ///      referrer baked into the ticket at mint.
    /// @param tierPayouts index = normalMatches * 2 + (bonusballMatch ? 1 : 0)
    function grossEv(
        uint256[12] memory tierPayouts,
        uint8 ballMax,
        uint8 bonusballMax
    ) internal pure returns (uint256) {
        uint256 total = totalCombos(ballMax, bonusballMax);
        uint256 acc;
        for (uint256 j = 0; j <= NORMALS; j++) {
            // Ways to pick exactly j of the 5 drawn normals and 5-j of the rest.
            uint256 waysNormals = choose(NORMALS, j) * choose(ballMax - NORMALS, NORMALS - j);
            if (waysNormals == 0) continue;
            // b = 1 matches the bonusball (1 way), b = 0 does not (bonusballMax - 1 ways).
            acc += tierPayouts[j * 2 + 1] * waysNormals;
            acc += tierPayouts[j * 2] * waysNormals * (uint256(bonusballMax) - 1);
        }
        return acc / total;
    }

    /// @notice What a ticket is worth to whoever holds it, in USDC 6dp.
    /// @dev The referrer's win share is taken out of winnings at claim time, so the
    ///      holder never sees it. This is the number that matters when pricing a
    ///      buyback: acquiring a ticket only gains the holder's portion, because the
    ///      referral share accrues to the treasury either way.
    /// @param referralWinShare 1e18 scaled fraction, read live from getDrawingState
    function holderValue(
        uint256[12] memory tierPayouts,
        uint8 ballMax,
        uint8 bonusballMax,
        uint256 referralWinShare
    ) internal pure returns (uint256) {
        uint256 ev = grossEv(tierPayouts, ballMax, bonusballMax);
        if (referralWinShare >= 1e18) return 0;
        return (ev * (1e18 - referralWinShare)) / 1e18;
    }
}
