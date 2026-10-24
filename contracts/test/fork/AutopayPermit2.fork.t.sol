// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMonaVisa} from "../../script/DeployMonaVisa.s.sol";
import {AutopayModule} from "../../src/AutopayModule.sol";
import {IAllowanceTransfer} from "../../src/interfaces/IAllowanceTransfer.sol";
import {MonadAddresses} from "../../src/libraries/MonadAddresses.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Subscribe and renew through the real Permit2 on Monad testnet, with a real signature.
/// @dev Skipped unless MONAD_TESTNET_RPC_URL is set. Uses a mock token so no faucet is needed.
contract AutopayPermit2ForkTest is Test {
    bytes32 internal constant PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 internal constant PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    MockUSDC internal token;
    IAllowanceTransfer internal permit2 = IAllowanceTransfer(MonadAddresses.PERMIT2);
    DeployMonaVisa.Deployment internal d;
    address internal merchantTreasury = makeAddr("merchantTreasury");
    uint256 internal planId;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        token = new MockUSDC();
        DeployMonaVisa script = new DeployMonaVisa();
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        d = script.deployWith(
            address(script),
            makeAddr("admin"),
            makeAddr("protocolTreasury"),
            100,
            100,
            tokens,
            permit2
        );

        vm.prank(makeAddr("merchant"));
        planId =
            d.planFactory.createPlan(address(token), 49e6, 30 days, 0, 3 days, merchantTreasury);
    }

    function test_fork_subscribeWithSignedPermitThenRenew() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        (address alice, uint256 aliceKey) = makeAddrAndKey("alice");
        token.mint(alice, 1000e6);
        vm.prank(alice);
        token.approve(address(permit2), type(uint256).max);

        IAllowanceTransfer.PermitSingle memory permit = _permit();
        bytes memory signature = _sign(aliceKey, permit);

        vm.prank(alice);
        uint256 subId = d.autopay.subscribeWithPermit(planId, permit, signature);
        assertTrue(d.registry.isEntitled(alice, planId));
        assertEq(token.balanceOf(merchantTreasury), 49e6);

        vm.warp(block.timestamp + 30 days);
        assertEq(uint8(d.autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Renewed));
        assertEq(token.balanceOf(merchantTreasury), 98e6);
        assertEq(token.balanceOf(address(d.autopay)), 0);

        (uint160 remaining,,) = permit2.allowance(alice, address(token), address(d.autopay));
        assertEq(remaining, 600e6 - 2 * (49e6 + 49e4), "permit2 cap decremented");
    }

    function _permit() internal view returns (IAllowanceTransfer.PermitSingle memory) {
        return IAllowanceTransfer.PermitSingle({
            details: IAllowanceTransfer.PermitDetails({
                token: address(token),
                amount: 600e6,
                expiration: uint48(block.timestamp + 365 days),
                nonce: 0
            }),
            spender: address(d.autopay),
            sigDeadline: block.timestamp + 1 hours
        });
    }

    function _sign(uint256 key, IAllowanceTransfer.PermitSingle memory p)
        internal
        view
        returns (bytes memory)
    {
        bytes32 detailsHash = keccak256(
            abi.encode(
                PERMIT_DETAILS_TYPEHASH,
                p.details.token,
                p.details.amount,
                p.details.expiration,
                p.details.nonce
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_SINGLE_TYPEHASH, detailsHash, p.spender, p.sigDeadline));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", IPermit2Domain(address(permit2)).DOMAIN_SEPARATOR(), structHash
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
