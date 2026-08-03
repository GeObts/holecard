// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {euint256, e, inco} from "@inco/lightning/src/Lib.sol";

/// @title IncoSmoke
/// @notice Day 1 hard gate for Hole Card. Proves e.randBounded and e.reveal work
///         against the live Inco Lightning deployment on Base mainnet, chain 8453.
/// @dev Not part of the game. Throwaway. Deleted once the gate passes.
///      randBounded is a paid op, funded from this contract's balance.
///      reveal is free.
contract IncoSmoke {
    // The docs show this at file level. Solidity only allows `using X for *` inside
    // a contract, so it lives here.
    using e for *;

    event Drawn(bytes32 indexed handle, uint256 feePaid, uint256 drawIndex);

    bytes32 public lastHandle;
    uint256 public drawCount;

    receive() external payable {}

    /// @notice The live per-op Inco fee, read from the executor rather than hardcoded.
    function incoFee() external pure returns (uint256) {
        return inco.getFee();
    }

    /// @notice Draws one encrypted card in 0..51 and makes it publicly revealable.
    /// @dev This is the exact primitive the infinite shoe uses. If this works on
    ///      mainnet, the shoe design holds and no EList deck is needed.
    function drawAndReveal() external payable returns (bytes32) {
        uint256 balanceBefore = address(this).balance;

        euint256 card = e.randBounded(uint256(52));

        // Load bearing. Without it the handle is only accessible in this tx and a
        // card stored now but revealed in a later tx would be unreachable forever.
        card.allowThis();

        e.reveal(card);

        bytes32 handle = euint256.unwrap(card);
        lastHandle = handle;
        drawCount += 1;

        emit Drawn(handle, balanceBefore - address(this).balance, drawCount);
        return handle;
    }

    /// @notice Draws one encrypted card and grants it to nobody.
    /// @dev This is the hole card shape. No allow, no reveal. Used to confirm that a
    ///      handle with no ACL grant is genuinely unreadable by an arbitrary caller.
    function drawSecret() external payable returns (bytes32) {
        euint256 card = e.randBounded(uint256(52));
        card.allowThis();
        bytes32 handle = euint256.unwrap(card);
        lastHandle = handle;
        drawCount += 1;
        emit Drawn(handle, 0, drawCount);
        return handle;
    }
}
