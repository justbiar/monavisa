// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAllowanceTransfer} from "../../src/interfaces/IAllowanceTransfer.sol";

/// @notice Mirrors Permit2 AllowanceTransfer semantics (amount cap, expiry, max = unlimited)
///         without signature checks. Real signatures are covered by the Monad fork test.
contract MockPermit2 is IAllowanceTransfer {
    using SafeERC20 for IERC20;

    error AllowanceExpired(uint256 deadline);
    error InsufficientAllowance(uint256 amount);

    struct Packed {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Packed))) public allowances;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        Packed storage a = allowances[msg.sender][token][spender];
        a.amount = amount;
        a.expiration = expiration == 0 ? uint48(block.timestamp) : expiration;
    }

    function permit(address owner, PermitSingle memory permitSingle, bytes calldata) external {
        Packed storage a = allowances[owner][permitSingle.details.token][permitSingle.spender];
        a.amount = permitSingle.details.amount;
        a.expiration = permitSingle.details.expiration;
        a.nonce = permitSingle.details.nonce + 1;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Packed storage a = allowances[from][token][msg.sender];
        if (block.timestamp > a.expiration) revert AllowanceExpired(a.expiration);
        if (a.amount != type(uint160).max) {
            if (amount > a.amount) revert InsufficientAllowance(a.amount);
            a.amount -= amount;
        }
        IERC20(token).safeTransferFrom(from, to, amount);
    }

    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160, uint48, uint48)
    {
        Packed memory a = allowances[user][token][spender];
        return (a.amount, a.expiration, a.nonce);
    }
}
