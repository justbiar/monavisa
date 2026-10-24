// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionVault} from "../../src/SessionVault.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Drives SessionVault through random opens, top-ups, redemptions, closes and withdrawals.
contract SessionVaultHandler is Test {
    SessionVault public immutable vault;
    MockUSDC public immutable usdc;
    uint256 internal constant SIGNER_KEY = 0x5157;
    address internal immutable signer;

    address[3] internal owners = [address(0x0A1), address(0x0A2), address(0x0A3)];
    address[3] internal payees = [address(0x0B1), address(0x0B2), address(0x0B3)];

    bytes32[] public sessionIds;
    mapping(bytes32 => mapping(address => uint256)) public issued;

    uint256 public ghostDeposited;
    uint256 public ghostPaidOut;
    uint256 public ghostWithdrawn;

    constructor(SessionVault vault_, MockUSDC usdc_) {
        vault = vault_;
        usdc = usdc_;
        signer = vm.addr(SIGNER_KEY);
        for (uint256 i; i < owners.length; ++i) {
            vm.prank(owners[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function sessionCount() external view returns (uint256) {
        return sessionIds.length;
    }

    function open(uint256 ownerSeed, uint96 amount, uint32 duration) external {
        address owner = owners[ownerSeed % owners.length];
        amount = uint96(bound(amount, 1, 1000e6));
        duration = uint32(bound(duration, 1 hours, 30 days));
        usdc.mint(owner, amount);
        vm.prank(owner);
        bytes32 id =
            vault.openSession(signer, address(usdc), amount, uint40(block.timestamp + duration));
        sessionIds.push(id);
        ghostDeposited += amount;
    }

    function topUp(uint256 seed, uint96 amount) external {
        if (sessionIds.length == 0) return;
        bytes32 id = sessionIds[seed % sessionIds.length];
        SessionVault.Session memory s = vault.getSession(id);
        if (s.closesAt != 0 || block.timestamp >= s.expiresAt) return;
        amount = uint96(bound(amount, 1, 100e6));
        usdc.mint(s.owner, amount);
        vm.prank(s.owner);
        vault.topUp(id, amount);
        ghostDeposited += amount;
    }

    function redeem(uint256 seed, uint256 payeeSeed, uint256 increment) external {
        if (sessionIds.length == 0) return;
        bytes32 id = sessionIds[seed % sessionIds.length];
        if (block.timestamp >= vault.redemptionDeadline(id)) return;
        address payee = payees[payeeSeed % payees.length];
        uint256 cumulative = issued[id][payee] + bound(increment, 1, 200e6);
        issued[id][payee] = cumulative;
        if (vault.getSession(id).balance == 0) return;

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, vault.voucherDigest(id, payee, cumulative));
        ghostPaidOut += vault.redeem(id, payee, cumulative, abi.encodePacked(r, s, v));
    }

    function requestClose(uint256 seed) external {
        if (sessionIds.length == 0) return;
        bytes32 id = sessionIds[seed % sessionIds.length];
        SessionVault.Session memory s = vault.getSession(id);
        if (s.closesAt != 0) return;
        vm.prank(s.owner);
        vault.requestClose(id);
    }

    function withdraw(uint256 seed) external {
        if (sessionIds.length == 0) return;
        bytes32 id = sessionIds[seed % sessionIds.length];
        if (block.timestamp < vault.redemptionDeadline(id)) return;
        vm.prank(vault.getSession(id).owner);
        ghostWithdrawn += vault.withdraw(id);
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1, 3 days));
    }
}
