// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MonaVisaBase} from "../MonaVisaBase.t.sol";
import {SessionVaultHandler} from "./SessionVaultHandler.sol";

contract SessionVaultInvariantTest is MonaVisaBase {
    SessionVaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new SessionVaultHandler(vault, usdc);
        targetContract(address(handler));
    }

    /// @dev The vault holds exactly the sum of session balances: nothing is stranded or double-counted.
    function invariant_vaultBalanceEqualsSessionBalances() public view {
        uint256 total;
        uint256 n = handler.sessionCount();
        for (uint256 i; i < n; ++i) {
            total += vault.getSession(handler.sessionIds(i)).balance;
        }
        assertEq(usdc.balanceOf(address(vault)), total);
    }

    /// @dev Every deposited unit is either still in the vault, paid out (payee + fee) or refunded.
    function invariant_conservation() public view {
        assertEq(
            handler.ghostDeposited(),
            usdc.balanceOf(address(vault)) + handler.ghostPaidOut() + handler.ghostWithdrawn()
        );
    }
}
