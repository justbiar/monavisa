// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IAllowanceTransfer} from "../src/interfaces/IAllowanceTransfer.sol";
import {MonadAddresses} from "../src/libraries/MonadAddresses.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {DeployMonCart} from "./DeployMonCart.s.sol";

/// @notice Deploys MonCart plus a mintable mock USDC to a local anvil fork of Monad testnet,
///         using the real Permit2 from the fork, and writes the addresses to deployments/local.json.
///
///   anvil --fork-url https://testnet-rpc.monad.xyz
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key>
contract DeployLocal is Script {
    function run() external {
        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        DeployMonCart deployer = new DeployMonCart();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        DeployMonCart.Deployment memory d = deployer.deployWith(
            address(deployer),
            msg.sender,
            msg.sender,
            100,
            100,
            tokens,
            IAllowanceTransfer(MonadAddresses.PERMIT2)
        );
        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "startBlock", block.number);
        vm.serializeAddress(key, "usdc", address(usdc));
        vm.serializeAddress(key, "planFactory", address(d.planFactory));
        vm.serializeAddress(key, "subscriptionRegistry", address(d.registry));
        vm.serializeAddress(key, "feeCollector", address(d.feeCollector));
        string memory json = vm.serializeAddress(key, "autopayModule", address(d.autopay));
        vm.writeJson(json, "./deployments/local.json");
    }
}
