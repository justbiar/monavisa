// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAllowanceTransfer} from "../src/interfaces/IAllowanceTransfer.sol";
import {AutopayModule} from "../src/AutopayModule.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {IFeeCollector} from "../src/interfaces/IFeeCollector.sol";
import {IPlanFactory} from "../src/interfaces/IPlanFactory.sol";
import {ISubscriptionRegistry} from "../src/interfaces/ISubscriptionRegistry.sol";
import {MonaVisaBase} from "./MonaVisaBase.t.sol";

contract PlanFactoryTest is MonaVisaBase {
    function test_createPlan_storesTerms() public {
        uint256 planId = _createPlan(7 days);
        IPlanFactory.Plan memory p = plans.getPlan(planId);
        assertEq(planId, 1);
        assertEq(p.merchant, merchant);
        assertEq(p.price, PRICE);
        assertEq(p.period, PERIOD);
        assertEq(p.trialPeriod, 7 days);
        assertEq(p.gracePeriod, GRACE);
        assertEq(p.treasury, merchantTreasury);
        assertTrue(p.active);
    }

    function test_createPlan_rejectsBadInput() public {
        vm.startPrank(merchant);
        vm.expectRevert(abi.encodeWithSelector(IPlanFactory.TokenNotAllowed.selector, address(1)));
        plans.createPlan(address(1), PRICE, PERIOD, 0, 0, merchantTreasury);
        vm.expectRevert(IPlanFactory.InvalidPrice.selector);
        plans.createPlan(address(usdc), 0, PERIOD, 0, 0, merchantTreasury);
        vm.expectRevert(IPlanFactory.InvalidPeriod.selector);
        plans.createPlan(address(usdc), PRICE, 59 minutes, 0, 0, merchantTreasury);
        vm.expectRevert(IPlanFactory.InvalidPeriod.selector);
        plans.createPlan(address(usdc), PRICE, PERIOD, 91 days, 0, merchantTreasury);
        vm.expectRevert(IPlanFactory.InvalidTreasury.selector);
        plans.createPlan(address(usdc), PRICE, PERIOD, 0, 0, address(0));
        vm.stopPrank();
    }

    function test_onlyMerchantManagesPlan() public {
        uint256 planId = _createPlan(0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IPlanFactory.NotPlanMerchant.selector, planId, alice)
        );
        plans.setPlanActive(planId, false);

        vm.prank(merchant);
        plans.setPlanActive(planId, false);
        assertFalse(plans.getPlan(planId).active);
    }

    function test_getPlan_revertsForUnknownPlan() public {
        vm.expectRevert(abi.encodeWithSelector(IPlanFactory.PlanNotFound.selector, 42));
        plans.getPlan(42);
    }
}

contract SubscribeTest is MonaVisaBase {
    function test_subscribe_chargesPricePlusFee() public {
        uint256 planId = _createPlan(0);
        uint256 subId = _subscribe(alice, planId);

        assertEq(usdc.balanceOf(merchantTreasury), PRICE);
        assertEq(usdc.balanceOf(address(fees)), FEE);
        assertEq(usdc.balanceOf(alice), 1000e6 - PRICE - FEE);
        assertEq(autopay.chargeAmount(planId), PRICE + FEE);
        _assertModuleEmpty();

        assertEq(registry.ownerOf(subId), alice);
        assertTrue(registry.isEntitled(alice, planId));
        ISubscriptionRegistry.Subscription memory s = registry.getSubscription(subId);
        assertEq(s.currentPeriodStart, block.timestamp);
        assertEq(s.currentPeriodEnd, block.timestamp + PERIOD);
        assertEq(uint8(s.status), uint8(ISubscriptionRegistry.Status.Active));
    }

    function test_subscribe_withTrial_chargesNothingUpfront() public {
        uint256 planId = _createPlan(7 days);
        uint256 subId = _subscribe(alice, planId);

        assertEq(usdc.balanceOf(merchantTreasury), 0);
        assertTrue(registry.isEntitled(alice, planId));
        assertEq(registry.getSubscription(subId).currentPeriodEnd, block.timestamp + 7 days);

        vm.warp(block.timestamp + 7 days);
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Renewed));
        assertEq(usdc.balanceOf(merchantTreasury), PRICE);
    }

    function test_subscribe_revertsWhenAlreadySubscribed() public {
        uint256 planId = _createPlan(0);
        uint256 subId = _subscribe(alice, planId);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionRegistry.AlreadySubscribed.selector, alice, planId, subId
            )
        );
        autopay.subscribe(planId);
    }

    function test_subscribe_revertsOnInactivePlan() public {
        uint256 planId = _createPlan(0);
        vm.prank(merchant);
        plans.setPlanActive(planId, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AutopayModule.PlanInactive.selector, planId));
        autopay.subscribe(planId);
    }

    function test_subscribe_revertsWithoutAllowance() public {
        uint256 planId = _createPlan(0);
        address bob = makeAddr("bob");
        usdc.mint(bob, 100e6);
        vm.prank(bob);
        vm.expectRevert();
        autopay.subscribe(planId);
        assertEq(registry.subscriptionOf(bob, planId), 0, "no subscription on failed charge");
    }

    function test_subscribeWithPermit_setsAllowanceThenCharges() public {
        uint256 planId = _createPlan(0);
        address bob = makeAddr("bob");
        usdc.mint(bob, 100e6);
        vm.prank(bob);
        usdc.approve(address(permit2), type(uint256).max);

        IAllowanceTransfer.PermitSingle memory permit = IAllowanceTransfer.PermitSingle({
            details: IAllowanceTransfer.PermitDetails({
                token: address(usdc),
                amount: 600e6,
                expiration: uint48(block.timestamp + 365 days),
                nonce: 0
            }),
            spender: address(autopay),
            sigDeadline: block.timestamp + 1 hours
        });
        vm.prank(bob);
        autopay.subscribeWithPermit(planId, permit, "");
        assertTrue(registry.isEntitled(bob, planId));
    }

    function test_resubscribe_afterExpiry() public {
        uint256 planId = _createPlan(0);
        uint256 subId = _subscribe(alice, planId);
        vm.prank(alice);
        registry.cancel(subId);
        vm.warp(block.timestamp + PERIOD);

        uint256 next = _subscribe(alice, planId);
        assertGt(next, subId);
        assertEq(
            uint8(registry.getSubscription(subId).status),
            uint8(ISubscriptionRegistry.Status.Expired)
        );
        assertTrue(registry.isEntitled(alice, planId));
    }
}

contract RenewalTest is MonaVisaBase {
    uint256 internal planId;
    uint256 internal subId;
    uint40 internal firstEnd;

    function setUp() public override {
        super.setUp();
        planId = _createPlan(0);
        subId = _subscribe(alice, planId);
        firstEnd = registry.getSubscription(subId).currentPeriodEnd;
    }

    function test_renew_notDueIsNoop() public {
        vm.prank(keeper);
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.NotDue));
        assertEq(usdc.balanceOf(merchantTreasury), PRICE);
    }

    function test_renew_chargesAndChainsPeriodsWithoutDrift() public {
        vm.warp(uint256(firstEnd) + 2 hours); // keeper is late
        vm.prank(keeper);
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Renewed));

        ISubscriptionRegistry.Subscription memory s = registry.getSubscription(subId);
        assertEq(s.currentPeriodStart, firstEnd);
        assertEq(s.currentPeriodEnd, firstEnd + PERIOD);
        assertEq(usdc.balanceOf(merchantTreasury), 2 * uint256(PRICE));
        assertEq(usdc.balanceOf(address(fees)), 2 * FEE);
        _assertModuleEmpty();
    }

    function test_renew_failureMarksPastDueThenGraceThenExpiry() public {
        vm.prank(alice);
        permit2.approve(address(usdc), address(autopay), 0, type(uint48).max);

        vm.warp(firstEnd);
        vm.expectEmit(true, false, false, false, address(autopay));
        emit AutopayModule.RenewalFailed(subId, "");
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.PastDue));
        assertEq(
            uint8(registry.getSubscription(subId).status),
            uint8(ISubscriptionRegistry.Status.PastDue)
        );
        assertTrue(registry.isEntitled(alice, planId), "access during grace");

        vm.warp(uint256(firstEnd) + GRACE);
        assertFalse(registry.isEntitled(alice, planId), "no access after grace");
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Expired));
        assertEq(
            uint8(registry.getSubscription(subId).status),
            uint8(ISubscriptionRegistry.Status.Expired)
        );
        assertEq(usdc.balanceOf(merchantTreasury), PRICE, "never charged after failure");
    }

    function test_renew_recoversInsideGrace() public {
        vm.prank(alice);
        permit2.approve(address(usdc), address(autopay), 0, type(uint48).max);
        vm.warp(firstEnd);
        autopay.renew(subId);

        vm.prank(alice);
        permit2.approve(address(usdc), address(autopay), type(uint160).max, type(uint48).max);
        vm.warp(uint256(firstEnd) + 1 days);
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Renewed));

        ISubscriptionRegistry.Subscription memory s = registry.getSubscription(subId);
        assertEq(uint8(s.status), uint8(ISubscriptionRegistry.Status.Active));
        assertEq(s.currentPeriodStart, firstEnd, "billing date unchanged");
    }

    function test_renew_respectsPermit2Cap() public {
        // Cap covers exactly one more renewal.
        vm.prank(alice);
        permit2.approve(address(usdc), address(autopay), uint160(PRICE + FEE), type(uint48).max);

        vm.warp(firstEnd);
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Renewed));
        vm.warp(uint256(firstEnd) + PERIOD);
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.PastDue));
    }

    function test_cancel_stopsRenewalsKeepsAccessUntilEnd() public {
        vm.prank(alice);
        registry.cancel(subId);
        assertTrue(registry.isEntitled(alice, planId));

        vm.warp(firstEnd);
        assertFalse(registry.isEntitled(alice, planId));
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Expired));
        assertEq(usdc.balanceOf(merchantTreasury), PRICE, "no charge after cancel");
    }

    function test_cancel_onlySubscriber() public {
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(ISubscriptionRegistry.NotSubscriber.selector, subId, keeper)
        );
        registry.cancel(subId);
    }

    function test_renewMany_mixesResults() public {
        address bob = makeAddr("bob");
        _fundAndApprove(bob, 1000e6);
        vm.warp(block.timestamp + 10 days);
        uint256 bobSub = _subscribe(bob, planId);

        vm.warp(firstEnd);
        uint256[] memory ids = new uint256[](3);
        ids[0] = subId;
        ids[1] = bobSub;
        ids[2] = 999;
        vm.expectRevert(
            abi.encodeWithSelector(ISubscriptionRegistry.SubscriptionNotFound.selector, 999)
        );
        autopay.renewMany(ids);

        uint256[] memory valid = new uint256[](2);
        valid[0] = subId;
        valid[1] = bobSub;
        AutopayModule.RenewalResult[] memory r = autopay.renewMany(valid);
        assertEq(uint8(r[0]), uint8(AutopayModule.RenewalResult.Renewed));
        assertEq(uint8(r[1]), uint8(AutopayModule.RenewalResult.NotDue));
    }

    function test_expire_isPermissionlessButOnlyWhenOver() public {
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionRegistry.NotExpirable.selector, subId));
        registry.expire(subId);
    }

    function test_subscriptionIsSoulbound() public {
        vm.prank(alice);
        vm.expectRevert(ISubscriptionRegistry.Soulbound.selector);
        registry.transferFrom(alice, keeper, subId);
    }

    function test_onlyModuleWritesBillingState() public {
        bytes32 role = registry.MODULE_ROLE();
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, role
            )
        );
        registry.renew(subId, 0, type(uint40).max);
    }
}

contract FeeCollectorTest is MonaVisaBase {
    function test_withdraw_routesToTreasury() public {
        _subscribe(alice, _createPlan(0));
        vm.prank(keeper);
        assertEq(fees.withdraw(address(usdc)), FEE);
        assertEq(usdc.balanceOf(protocolTreasury), FEE);
        assertEq(usdc.balanceOf(address(fees)), 0);
    }

    function test_feeRates_capped() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IFeeCollector.FeeTooHigh.selector, 1001, 1000));
        fees.setFeeRates(1001, 0);
    }

    function test_feeRates_onlyManager() public {
        bytes32 role = fees.FEE_MANAGER_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role
            )
        );
        fees.setFeeRates(0, 0);
    }

    function test_notifyFee_onlySources() public {
        bytes32 role = fees.FEE_SOURCE_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role
            )
        );
        fees.notifyFee(address(usdc), 1);
    }

    function testFuzz_charge_splitsExactly(uint96 price, uint16 bps) public {
        price = uint96(bound(price, 1, 1_000_000e6));
        bps = uint16(bound(bps, 0, fees.MAX_FEE_BPS()));
        vm.prank(admin);
        fees.setFeeRates(bps, bps);

        vm.prank(merchant);
        uint256 planId = plans.createPlan(address(usdc), price, PERIOD, 0, 0, merchantTreasury);
        uint256 fee = uint256(price) * bps / 10_000;
        address payer = makeAddr("payer");
        _fundAndApprove(payer, uint256(price) + fee);

        _subscribe(payer, planId);
        assertEq(usdc.balanceOf(merchantTreasury), price);
        assertEq(usdc.balanceOf(address(fees)), fee);
        assertEq(usdc.balanceOf(payer), 0);
        _assertModuleEmpty();
    }
}

contract AdminTest is MonaVisaBase {
    function test_rolesHandedToAdmin() public view {
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
        assertTrue(registry.hasRole(adminRole, admin));
        assertTrue(fees.hasRole(adminRole, admin));
        assertTrue(fees.hasRole(fees.FEE_MANAGER_ROLE(), admin));
        assertTrue(plans.hasRole(adminRole, admin));
        assertTrue(autopay.hasRole(adminRole, admin));
        assertTrue(registry.hasRole(registry.MODULE_ROLE(), address(autopay)));
        assertTrue(fees.hasRole(fees.FEE_SOURCE_ROLE(), address(autopay)));
    }

    function test_upgrade_onlyAdmin() public {
        address impl = address(new PlanFactory());
        bytes32 adminRole = plans.DEFAULT_ADMIN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, adminRole
            )
        );
        plans.upgradeToAndCall(impl, "");

        vm.prank(admin);
        plans.upgradeToAndCall(impl, "");
    }

    function test_implementationsCannotBeInitialized() public {
        FeeCollector impl = new FeeCollector();
        vm.expectRevert();
        impl.initialize(alice, alice, 0, 0);
    }
}
