// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MonadAddresses} from "../src/libraries/MonadAddresses.sol";

/// @dev Exposes the internal library so reverts can be asserted.
contract MonadAddressesHarness {
    function usdc(uint256 chainId) external pure returns (address) {
        return MonadAddresses.usdc(chainId);
    }
}

contract MonadAddressesTest is Test {
    MonadAddressesHarness internal harness;

    function setUp() public {
        harness = new MonadAddressesHarness();
    }

    function test_usdc_resolvesKnownChains() public view {
        assertEq(harness.usdc(143), MonadAddresses.MAINNET_USDC);
        assertEq(harness.usdc(10_143), MonadAddresses.TESTNET_USDC);
    }

    function testFuzz_usdc_revertsOnUnknownChain(uint256 chainId) public {
        vm.assume(chainId != 143 && chainId != 10_143);
        vm.expectRevert(abi.encodeWithSelector(MonadAddresses.UnsupportedChain.selector, chainId));
        harness.usdc(chainId);
    }
}
