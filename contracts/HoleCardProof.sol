// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {euint256, e, inco} from "@inco/lightning/src/Lib.sol";

/// @title HoleCardProof
/// @notice The demo's central claim, made falsifiable.
///
/// @dev The claim is that the dealer's hole card is genuinely unreadable, not
///      merely undisplayed. A naive test draws an ungranted handle and shows the
///      covalidator refuses it. That is weak evidence: the refusal is
///      `NotFound`, which is also what a valid handle returns while it is still
///      being processed. The two are indistinguishable from a single failure.
///
///      This contract makes the test rigorous. Draw a card and grant nothing.
///      Wait well past the observed attestation latency. Confirm it is still
///      refused. THEN reveal that same handle and confirm it becomes readable.
///
///      The second half is what closes the argument: it proves the handle was
///      valid and processable the whole time, so the earlier refusal was the
///      access control working rather than a timing artefact.
contract HoleCardProof {
    using e for *;

    event Drawn(bytes32 indexed handle, uint256 index);
    event Revealed(bytes32 indexed handle);

    bytes32 public lastSecret;
    uint256 public drawCount;

    receive() external payable {}

    function incoFee() external pure returns (uint256) {
        return inco.getFee();
    }

    /// @notice Draw a hole card. No ACL grant to anyone, no reveal.
    /// @dev allowThis is load bearing and is NOT a leak: it lets the contract
    ///      re-access the handle in a later transaction so it can be revealed at
    ///      resolve. Without it the handle would be unreachable forever.
    function drawHoleCard() external returns (bytes32) {
        euint256 card = e.randBounded(uint256(52));
        card.allowThis();
        bytes32 handle = euint256.unwrap(card);
        lastSecret = handle;
        drawCount += 1;
        emit Drawn(handle, drawCount);
        return handle;
    }

    /// @notice Reveal the most recently drawn card. This is the resolve step.
    function revealHoleCard() external {
        euint256 card = euint256.wrap(lastSecret);
        e.reveal(card);
        emit Revealed(lastSecret);
    }

    /// @notice Reveal a specific handle this contract drew earlier.
    /// @dev Needed by the proof script: the control draw moves lastSecret, so the
    ///      original hole card must be revealed by handle. Only works for handles
    ///      this contract has access to, which is exactly the ones it drew.
    function revealHandle(bytes32 handle) external {
        e.reveal(euint256.wrap(handle));
        emit Revealed(handle);
    }
}
