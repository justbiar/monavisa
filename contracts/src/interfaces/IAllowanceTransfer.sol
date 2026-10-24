// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The subset of Uniswap Permit2's AllowanceTransfer that MonCart uses.
/// @dev Permit2 is deployed at the canonical address on both Monad networks (see MonadAddresses).
interface IAllowanceTransfer {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature)
        external;

    function transferFrom(address from, address to, uint160 amount, address token) external;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}
