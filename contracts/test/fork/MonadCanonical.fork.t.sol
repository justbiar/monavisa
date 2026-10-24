// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MonadAddresses} from "../../src/libraries/MonadAddresses.sol";

interface IFiatToken {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
}

/// @notice Checks that the canonical contracts Mona Visa relies on exist and behave as expected.
/// @dev Skipped unless MONAD_TESTNET_RPC_URL / MONAD_RPC_URL are set.
contract MonadCanonicalForkTest is Test {
    bytes32 internal constant EIP3009_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function test_fork_testnet() public {
        _checkNetwork("MONAD_TESTNET_RPC_URL", MonadAddresses.TESTNET_CHAIN_ID);
    }

    function test_fork_mainnet() public {
        _checkNetwork("MONAD_RPC_URL", MonadAddresses.MAINNET_CHAIN_ID);
    }

    function _checkNetwork(string memory rpcEnv, uint256 expectedChainId) internal {
        string memory rpc = vm.envOr(rpcEnv, string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, expectedChainId, "chain id");

        IFiatToken usdc = IFiatToken(MonadAddresses.usdc(block.chainid));
        assertEq(usdc.decimals(), 6, "usdc decimals");
        assertEq(usdc.symbol(), "USDC", "usdc symbol");
        assertEq(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), EIP3009_TYPEHASH, "eip-3009");

        assertGt(MonadAddresses.PERMIT2.code.length, 0, "permit2");
        assertGt(MonadAddresses.ENTRYPOINT_V07.code.length, 0, "entrypoint v0.7");
        assertGt(MonadAddresses.MULTICALL3.code.length, 0, "multicall3");
    }
}
