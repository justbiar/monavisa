// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MonadAddresses
/// @notice Canonical third-party contracts on Monad that MonCart depends on.
/// @dev Kept in sync with `packages/core/src/networks.ts` by a test in that package.
///      Every address was checked on-chain on 2026-10-24.
library MonadAddresses {
    uint256 internal constant MAINNET_CHAIN_ID = 143;
    uint256 internal constant TESTNET_CHAIN_ID = 10_143;

    // Circle USDC (FiatTokenV2_2, supports EIP-2612 and EIP-3009).
    address internal constant MAINNET_USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant TESTNET_USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    // Deployed at the same address on both networks.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    error UnsupportedChain(uint256 chainId);

    /// @notice USDC address for the given Monad chain.
    function usdc(uint256 chainId) internal pure returns (address) {
        if (chainId == MAINNET_CHAIN_ID) return MAINNET_USDC;
        if (chainId == TESTNET_CHAIN_ID) return TESTNET_USDC;
        revert UnsupportedChain(chainId);
    }
}
