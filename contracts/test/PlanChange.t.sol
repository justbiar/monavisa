// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AutopayModule} from "../src/AutopayModule.sol";
import {ISubscriptionRegistry} from "../src/interfaces/ISubscriptionRegistry.sol";
import {MonCartBase} from "./MonCartBase.t.sol";

contract PlanChangeTest is MonCartBase {
    uint96 internal constant BASIC_PRICE = 10e6;

    uint256 internal basic;
    uint256 internal pro;

    function setUp() public override {
        super.setUp();
        vm.startPrank(merchant);
        basic = plans.createPlan(address(usdc), BASIC_PRICE, PERIOD, 0, GRACE, merchantTreasury);
        pro = plans.createPlan(address(usdc), PRICE, PERIOD, 0, GRACE, merchantTreasury);
        vm.stopPrank();
    }

    function test_upgrade_chargesProratedDifferenceAndRestartsPeriod() public {
        uint256 subId = _subscribe(alice, basic);
        uint256 before = usdc.balanceOf(merchantTreasury);

        vm.warp(block.timestamp + 10 days); // 20 of 30 days unused
        vm.prank(alice);
        autopay.changePlan(subId, pro);

        uint256 credit = uint256(BASIC_PRICE) * 20 days / PERIOD;
        uint256 due = PRICE - credit;
        assertEq(usdc.balanceOf(merchantTreasury) - before, due, "merchant gets the difference");
        assertEq(
            usdc.balanceOf(address(fees)), (uint256(BASIC_PRICE) + due) / 100, "fee on both charges"
        );
        _assertModuleEmpty();

        ISubscriptionRegistry.Subscription memory s = registry.getSubscription(subId);
        assertEq(s.planId, pro);
        assertEq(s.currentPeriodStart, block.timestamp);
        assertEq(s.currentPeriodEnd, block.timestamp + PERIOD);
        assertTrue(registry.isEntitled(alice, pro));
        assertFalse(registry.isEntitled(alice, basic));
        assertEq(registry.subscriptionOf(alice, basic), 0);
    }

    function test_upgrade_fromTrial_getsNoCredit() public {
        vm.prank(merchant);
        uint256 trialBasic =
            plans.createPlan(address(usdc), BASIC_PRICE, PERIOD, 14 days, GRACE, merchantTreasury);
        uint256 subId = _subscribe(alice, trialBasic);

        vm.prank(alice);
        autopay.changePlan(subId, pro);
        assertEq(usdc.balanceOf(merchantTreasury), PRICE, "full price, trial time is not credit");
        assertFalse(registry.getSubscription(subId).inTrial);
    }

    function test_downgrade_isScheduledAndAppliedAtRenewal() public {
        uint256 subId = _subscribe(alice, pro);
        uint40 end = registry.getSubscription(subId).currentPeriodEnd;

        vm.prank(alice);
        autopay.changePlan(subId, basic);
        ISubscriptionRegistry.Subscription memory s = registry.getSubscription(subId);
        assertEq(s.planId, pro, "still on pro until renewal");
        assertEq(s.pendingPlanId, basic);
        assertTrue(registry.isEntitled(alice, pro));

        vm.warp(end);
        assertEq(uint8(autopay.renew(subId)), uint8(AutopayModule.RenewalResult.Renewed));
        s = registry.getSubscription(subId);
        assertEq(s.planId, basic);
        assertEq(s.pendingPlanId, 0);
        assertEq(s.currentPeriodStart, end, "billing date kept");
        assertEq(
            usdc.balanceOf(merchantTreasury), uint256(PRICE) + BASIC_PRICE, "charged basic price"
        );
        assertTrue(registry.isEntitled(alice, basic));
        assertFalse(registry.isEntitled(alice, pro));
    }

    function test_cancelPlanChange_keepsCurrentPlan() public {
        uint256 subId = _subscribe(alice, pro);
        vm.startPrank(alice);
        autopay.changePlan(subId, basic);
        autopay.cancelPlanChange(subId);
        vm.stopPrank();

        vm.warp(registry.getSubscription(subId).currentPeriodEnd);
        autopay.renew(subId);
        assertEq(registry.getSubscription(subId).planId, pro);
        assertEq(usdc.balanceOf(merchantTreasury), 2 * uint256(PRICE));
    }

    function test_changePlan_rejectsOtherMerchantsAndTokens() public {
        uint256 subId = _subscribe(alice, basic);
        address rival = makeAddr("rival");
        vm.prank(rival);
        uint256 rivalPlan = plans.createPlan(address(usdc), PRICE, PERIOD, 0, 0, rival);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AutopayModule.InvalidPlanChange.selector, subId, rivalPlan)
        );
        autopay.changePlan(subId, rivalPlan);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AutopayModule.InvalidPlanChange.selector, subId, basic)
        );
        autopay.changePlan(subId, basic);
    }

    function test_changePlan_rejectsWhenAlreadyOnTargetPlan() public {
        uint256 basicSub = _subscribe(alice, basic);
        _subscribe(alice, pro);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AutopayModule.InvalidPlanChange.selector, basicSub, pro)
        );
        autopay.changePlan(basicSub, pro);
    }

    function test_changePlan_onlySubscriber() public {
        uint256 subId = _subscribe(alice, basic);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AutopayModule.NotSubscriber.selector, subId, keeper));
        autopay.changePlan(subId, pro);
    }

    function test_changePlan_requiresActive() public {
        uint256 subId = _subscribe(alice, basic);
        vm.prank(alice);
        registry.cancel(subId);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionRegistry.InvalidStatus.selector,
                subId,
                ISubscriptionRegistry.Status.Canceled
            )
        );
        autopay.changePlan(subId, pro);
    }

    function testFuzz_upgrade_neverChargesMoreThanNewPrice(uint32 elapsed) public {
        uint256 subId = _subscribe(alice, basic);
        elapsed = uint32(bound(elapsed, 0, PERIOD - 1));
        vm.warp(block.timestamp + elapsed);
        uint256 before = usdc.balanceOf(merchantTreasury);

        vm.prank(alice);
        autopay.changePlan(subId, pro);
        uint256 charged = usdc.balanceOf(merchantTreasury) - before;
        assertLe(charged, PRICE);
        assertGe(charged, PRICE - BASIC_PRICE);
        _assertModuleEmpty();
    }
}
