// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SessionVault} from "../src/SessionVault.sol";
import {MonaVisaBase} from "./MonaVisaBase.t.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";

contract SessionVaultTest is MonaVisaBase {
    uint256 internal signerKey = 0xA11CE;
    address internal signer;
    address internal owner = makeAddr("owner");
    address internal payee = makeAddr("payee");
    address internal payee2 = makeAddr("payee2");
    address internal relayer = makeAddr("relayer");

    uint96 internal constant DEPOSIT = 100e6;

    function setUp() public override {
        super.setUp();
        signer = vm.addr(signerKey);
        usdc.mint(owner, 1000e6);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _open(uint96 amount) internal returns (bytes32 id) {
        vm.prank(owner);
        id = vault.openSession(signer, address(usdc), amount, uint40(block.timestamp + 7 days));
    }

    function _sign(uint256 key, bytes32 id, address to, uint256 cumulative)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.voucherDigest(id, to, cumulative));
        return abi.encodePacked(r, s, v);
    }

    function _redeem(bytes32 id, address to, uint256 cumulative) internal returns (uint256) {
        bytes memory sig = _sign(signerKey, id, to, cumulative);
        vm.prank(relayer);
        return vault.redeem(id, to, cumulative, sig);
    }

    // ------------------------------------------------------------------ open / top up

    function test_openSession_storesAndPulls() public {
        bytes32 id = _open(DEPOSIT);
        SessionVault.Session memory s = vault.getSession(id);
        assertEq(s.owner, owner);
        assertEq(s.signer, signer);
        assertEq(s.balance, DEPOSIT);
        assertEq(s.token, address(usdc));
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT);
        assertEq(id, keccak256(abi.encode(owner, uint256(1))));
    }

    function test_openSession_validates() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.TokenNotAllowed.selector, address(1)));
        vault.openSession(signer, address(1), 1, uint40(block.timestamp + 1));
        vm.expectRevert(SessionVault.InvalidSigner.selector);
        vault.openSession(address(0), address(usdc), 1, uint40(block.timestamp + 1));
        vm.expectRevert(SessionVault.InvalidAmount.selector);
        vault.openSession(signer, address(usdc), 0, uint40(block.timestamp + 1));
        vm.expectRevert(SessionVault.InvalidExpiry.selector);
        vault.openSession(signer, address(usdc), 1, uint40(block.timestamp));
        vm.expectRevert(SessionVault.InvalidExpiry.selector);
        vault.openSession(signer, address(usdc), 1, uint40(block.timestamp + 366 days));
        vm.stopPrank();
    }

    function test_topUp_anyoneWhileOpen() public {
        bytes32 id = _open(DEPOSIT);
        vm.prank(alice);
        usdc.approve(address(vault), 10e6);
        vm.prank(alice);
        vault.topUp(id, 10e6);
        assertEq(vault.getSession(id).balance, DEPOSIT + 10e6);
    }

    function test_topUp_rejectedWhenClosingOrExpired() public {
        bytes32 id = _open(DEPOSIT);
        vm.prank(owner);
        vault.requestClose(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionClosing.selector, id));
        vault.topUp(id, 1);

        bytes32 id2 = _open(DEPOSIT);
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionExpired.selector, id2));
        vault.topUp(id2, 1);
    }

    function test_extendSession() public {
        bytes32 id = _open(DEPOSIT);
        uint40 later = uint40(block.timestamp + 30 days);
        vm.prank(owner);
        vault.extendSession(id, later);
        assertEq(vault.getSession(id).expiresAt, later);

        vm.prank(owner);
        vm.expectRevert(SessionVault.InvalidExpiry.selector);
        vault.extendSession(id, later - 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.NotSessionOwner.selector, id, alice));
        vault.extendSession(id, later + 1);
    }

    // ------------------------------------------------------------------ redeem

    function test_redeem_paysDeltaMinusFee() public {
        bytes32 id = _open(DEPOSIT);
        uint256 paid = _redeem(id, payee, 10e6);
        assertEq(paid, 10e6);
        assertEq(usdc.balanceOf(payee), 10e6 - 1e5); // 1% agent fee
        assertEq(usdc.balanceOf(address(fees)), 1e5);
        assertEq(vault.redeemed(id, payee), 10e6);
        assertEq(vault.getSession(id).balance, DEPOSIT - 10e6);

        // A later voucher only pays what is new.
        paid = _redeem(id, payee, 25e6);
        assertEq(paid, 15e6);
        assertEq(vault.redeemed(id, payee), 25e6);
        assertEq(vault.getSession(id).balance, DEPOSIT - 25e6);
    }

    function test_redeem_rejectsReplayAndStaleVouchers() public {
        bytes32 id = _open(DEPOSIT);
        bytes memory sig = _sign(signerKey, id, payee, 10e6);
        vault.redeem(id, payee, 10e6, sig);
        vm.expectRevert(SessionVault.NothingToRedeem.selector);
        vault.redeem(id, payee, 10e6, sig);

        bytes memory older = _sign(signerKey, id, payee, 5e6);
        vm.expectRevert(SessionVault.NothingToRedeem.selector);
        vault.redeem(id, payee, 5e6, older);
    }

    function test_redeem_rejectsWrongSignerOrPayee() public {
        bytes32 id = _open(DEPOSIT);
        bytes memory forged = _sign(0xBAD, id, payee, 10e6);
        vm.expectRevert(SessionVault.InvalidVoucherSignature.selector);
        vault.redeem(id, payee, 10e6, forged);

        // A voucher for one payee cannot be redeemed by another.
        bytes memory sig = _sign(signerKey, id, payee, 10e6);
        vm.expectRevert(SessionVault.InvalidVoucherSignature.selector);
        vault.redeem(id, payee2, 10e6, sig);
    }

    function test_redeem_unknownSession() public {
        bytes32 id = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionNotFound.selector, id));
        vault.redeem(id, payee, 1, "");
    }

    function test_redeem_shortBalancePaysWhatItCanThenRest() public {
        bytes32 id = _open(10e6);
        uint256 paid = _redeem(id, payee, 15e6);
        assertEq(paid, 10e6);
        assertEq(vault.getSession(id).balance, 0);

        bytes memory sig = _sign(signerKey, id, payee, 15e6);
        vm.expectRevert(SessionVault.NothingToRedeem.selector);
        vault.redeem(id, payee, 15e6, sig);

        vm.prank(owner);
        vault.topUp(id, 20e6);
        paid = _redeem(id, payee, 15e6);
        assertEq(paid, 5e6);
        assertEq(vault.redeemed(id, payee), 15e6);
    }

    function test_redeem_independentPerPayee() public {
        bytes32 id = _open(DEPOSIT);
        _redeem(id, payee, 10e6);
        _redeem(id, payee2, 3e6);
        assertEq(vault.redeemed(id, payee), 10e6);
        assertEq(vault.redeemed(id, payee2), 3e6);
        assertEq(vault.getSession(id).balance, DEPOSIT - 13e6);
    }

    function test_redeemMany_batches() public {
        bytes32 id = _open(DEPOSIT);
        SessionVault.Redemption[] memory batch = new SessionVault.Redemption[](2);
        batch[0] = SessionVault.Redemption(id, payee, 4e6, _sign(signerKey, id, payee, 4e6));
        batch[1] = SessionVault.Redemption(id, payee2, 6e6, _sign(signerKey, id, payee2, 6e6));
        uint256[] memory paid = vault.redeemMany(batch);
        assertEq(paid[0], 4e6);
        assertEq(paid[1], 6e6);
        assertEq(vault.getSession(id).balance, DEPOSIT - 10e6);
    }

    function test_redeem_erc1271Signer() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(signer);
        vm.prank(owner);
        bytes32 id = vault.openSession(
            address(wallet), address(usdc), DEPOSIT, uint40(block.timestamp + 1 days)
        );
        uint256 paid = _redeem(id, payee, 2e6);
        assertEq(paid, 2e6);
    }

    function test_redeem_worksDuringCloseDelayButNotAfter() public {
        bytes32 id = _open(DEPOSIT);
        vm.prank(owner);
        vault.requestClose(id);
        uint256 deadline = vault.redemptionDeadline(id);
        assertEq(deadline, block.timestamp + vault.closeDelay());

        vm.warp(deadline - 1);
        _redeem(id, payee, 1e6);

        vm.warp(deadline);
        bytes memory sig = _sign(signerKey, id, payee, 2e6);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.RedemptionWindowOver.selector, id));
        vault.redeem(id, payee, 2e6, sig);
    }

    // ------------------------------------------------------------------ close / withdraw

    function test_withdraw_onlyAfterDeadline() public {
        bytes32 id = _open(DEPOSIT);
        _redeem(id, payee, 10e6);
        vm.prank(owner);
        vault.requestClose(id);

        uint256 deadline = vault.redemptionDeadline(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.StillRedeemable.selector, id, deadline));
        vault.withdraw(id);

        vm.warp(deadline);
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        uint256 refunded = vault.withdraw(id);
        assertEq(refunded, DEPOSIT - 10e6);
        assertEq(usdc.balanceOf(owner), before + refunded);
        assertEq(vault.getSession(id).balance, 0);
    }

    function test_withdraw_afterExpiryWithoutCloseRequest() public {
        bytes32 id = _open(DEPOSIT);
        SessionVault.Session memory s = vault.getSession(id);
        vm.warp(uint256(s.expiresAt) + vault.closeDelay());
        vm.prank(owner);
        assertEq(vault.withdraw(id), DEPOSIT);
    }

    function test_requestClose_onlyOwnerOnce() public {
        bytes32 id = _open(DEPOSIT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.NotSessionOwner.selector, id, alice));
        vault.requestClose(id);
        vm.startPrank(owner);
        vault.requestClose(id);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionClosing.selector, id));
        vault.requestClose(id);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ admin

    function test_setCloseDelay_boundsAndRole() public {
        vm.expectRevert();
        vault.setCloseDelay(1 hours);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.InvalidCloseDelay.selector, 1));
        vault.setCloseDelay(1);
        vault.setCloseDelay(2 hours);
        vm.stopPrank();
        assertEq(vault.closeDelay(), 2 hours);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Payee share + fee always equals what left the session, and the session never pays more
    ///      than the voucher or its balance.
    function testFuzz_redeem_conservesValue(uint96 deposit, uint256 cumulative, uint16 feeBps)
        public
    {
        deposit = uint96(bound(deposit, 1, 1000e6));
        cumulative = bound(cumulative, 1, 2000e6);
        feeBps = uint16(bound(feeBps, 0, 1000));
        vm.prank(admin);
        fees.setFeeRates(FEE_BPS, feeBps);

        bytes32 id = _open(deposit);
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        uint256 paid = _redeem(id, payee, cumulative);

        uint256 expected = cumulative < deposit ? cumulative : deposit;
        assertEq(paid, expected);
        assertEq(usdc.balanceOf(payee) + usdc.balanceOf(address(fees)), paid);
        assertEq(vaultBefore - usdc.balanceOf(address(vault)), paid);
        assertEq(vault.getSession(id).balance, deposit - paid);
    }

    // ------------------------------------------------------------------ mandate revocation

    function test_revokeMandate_setsFlagAndEmits() public {
        bytes32 mandateHash = keccak256("test-mandate");
        assertFalse(vault.isMandateRevoked(owner, mandateHash));

        vm.prank(owner);
        vault.revokeMandate(mandateHash);
        assertTrue(vault.isMandateRevoked(owner, mandateHash));
        assertFalse(vault.isMandateRevoked(alice, mandateHash));
    }

    // ------------------------------------------------------------------ escrow tests

    function test_escrow_reserveAndCommitAndConfirm() public {
        bytes32 id = _open(DEPOSIT);
        address provider = makeAddr("provider");
        bytes32 nonce = keccak256("nonce1");
        bytes32 escrowId;

        {
            bytes32 digest =
                vault.reserveDigest(id, provider, 20e6, uint40(block.timestamp + 1 days), nonce);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
            vm.prank(relayer);
            escrowId = vault.reserve(
                id,
                provider,
                20e6,
                uint40(block.timestamp + 1 days),
                nonce,
                abi.encodePacked(r, s, v)
            );
        }

        assertEq(vault.getSession(id).balance, DEPOSIT - 20e6);
        assertEq(uint8(vault.getEscrow(escrowId).status), uint8(SessionVault.EscrowStatus.Reserved));

        // Provider commits delivery commitment
        bytes32 commitment = keccak256("delivery-payload");
        vm.prank(provider);
        vault.commit(escrowId, commitment);
        assertEq(
            uint8(vault.getEscrow(escrowId).status), uint8(SessionVault.EscrowStatus.Committed)
        );

        // Signer confirms delivery
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 feeBefore = usdc.balanceOf(address(fees));
        {
            bytes32 confirmDigest = vault.confirmDigest(escrowId);
            (uint8 cv, bytes32 cr, bytes32 cs) = vm.sign(signerKey, confirmDigest);
            vm.prank(relayer);
            uint256 paid = vault.confirm(escrowId, abi.encodePacked(cr, cs, cv));
            assertEq(paid, 20e6);
        }

        assertEq(uint8(vault.getEscrow(escrowId).status), uint8(SessionVault.EscrowStatus.Settled));
        assertEq(usdc.balanceOf(provider), providerBefore + 20e6 - 2e5);
        assertEq(usdc.balanceOf(address(fees)), feeBefore + 2e5);
    }

    function test_escrow_refundAfterDeadline() public {
        bytes32 id = _open(DEPOSIT);
        address provider = makeAddr("provider");
        uint96 amount = 30e6;
        uint40 deadline = uint40(block.timestamp + 1 days);
        bytes32 nonce = keccak256("nonce2");

        bytes32 digest = vault.reserveDigest(id, provider, amount, deadline, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes32 escrowId = vault.reserve(id, provider, amount, deadline, nonce, sig);
        assertEq(vault.getSession(id).balance, DEPOSIT - amount);

        // Cannot refund before deadline
        vm.expectRevert(
            abi.encodeWithSelector(SessionVault.EscrowDeadlineNotPassed.selector, escrowId)
        );
        vault.refund(escrowId);

        // Warp past deadline
        vm.warp(deadline);
        uint256 refunded = vault.refund(escrowId);
        assertEq(refunded, amount);
        assertEq(vault.getSession(id).balance, DEPOSIT);
        assertEq(uint8(vault.getEscrow(escrowId).status), uint8(SessionVault.EscrowStatus.Refunded));
    }

    function test_escrow_commit_rejections() public {
        bytes32 id = _open(DEPOSIT);
        address provider = makeAddr("provider");
        uint96 amount = 10e6;
        uint40 deadline = uint40(block.timestamp + 1 days);
        bytes32 nonce = keccak256("nonce3");

        vm.prank(owner);
        bytes32 escrowId = vault.reserve(id, provider, amount, deadline, nonce, "");

        // Only provider can commit
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SessionVault.NotEscrowProvider.selector, escrowId, alice)
        );
        vault.commit(escrowId, keccak256("c"));

        // Warp past deadline
        vm.warp(deadline);
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(SessionVault.EscrowDeadlinePassed.selector, escrowId)
        );
        vault.commit(escrowId, keccak256("c"));
    }
}
