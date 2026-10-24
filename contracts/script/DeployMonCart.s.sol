// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AutopayModule} from "../src/AutopayModule.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {SubscriptionRegistry} from "../src/SubscriptionRegistry.sol";
import {IAllowanceTransfer} from "../src/interfaces/IAllowanceTransfer.sol";
import {IPlanFactory} from "../src/interfaces/IPlanFactory.sol";
import {ISubscriptionRegistry} from "../src/interfaces/ISubscriptionRegistry.sol";
import {MonadAddresses} from "../src/libraries/MonadAddresses.sol";

/// @notice Deploys the Faz 1 contracts behind UUPS proxies and wires their roles.
///
///   ADMIN=0x... TREASURY=0x... SUBSCRIPTION_FEE_BPS=100 \
///   forge script script/DeployMonCart.s.sol --rpc-url monad_testnet --account <keystore> --broadcast
///
/// ADMIN should be a Safe on mainnet. Omit --broadcast for a dry run.
contract DeployMonCart is Script {
    struct Deployment {
        FeeCollector feeCollector;
        PlanFactory planFactory;
        SubscriptionRegistry registry;
        AutopayModule autopay;
    }

    function run() external returns (Deployment memory d) {
        address admin = vm.envAddress("ADMIN");
        address treasury = vm.envAddress("TREASURY");
        uint16 subscriptionFeeBps = uint16(vm.envOr("SUBSCRIPTION_FEE_BPS", uint256(100)));
        uint16 agentFeeBps = uint16(vm.envOr("AGENT_FEE_BPS", uint256(100)));

        vm.startBroadcast();
        d = deploy(msg.sender, admin, treasury, subscriptionFeeBps, agentFeeBps);
        vm.stopBroadcast();

        console.log("FeeCollector        ", address(d.feeCollector));
        console.log("PlanFactory         ", address(d.planFactory));
        console.log("SubscriptionRegistry", address(d.registry));
        console.log("AutopayModule       ", address(d.autopay));
    }

    /// @dev The deployer holds admin only while wiring, then hands every admin role to `admin`.
    function deploy(
        address deployer,
        address admin,
        address treasury,
        uint16 subscriptionFeeBps,
        uint16 agentFeeBps
    ) public returns (Deployment memory d) {
        address[] memory tokens = new address[](1);
        tokens[0] = MonadAddresses.usdc(block.chainid);
        return deployWith(
            deployer,
            admin,
            treasury,
            subscriptionFeeBps,
            agentFeeBps,
            tokens,
            IAllowanceTransfer(MonadAddresses.PERMIT2)
        );
    }

    function deployWith(
        address deployer,
        address admin,
        address treasury,
        uint16 subscriptionFeeBps,
        uint16 agentFeeBps,
        address[] memory tokens,
        IAllowanceTransfer permit2
    ) public returns (Deployment memory d) {
        d.feeCollector = FeeCollector(
            _proxy(
                address(new FeeCollector()),
                abi.encodeCall(
                    FeeCollector.initialize, (deployer, treasury, subscriptionFeeBps, agentFeeBps)
                )
            )
        );
        d.planFactory = PlanFactory(
            _proxy(
                address(new PlanFactory()), abi.encodeCall(PlanFactory.initialize, (admin, tokens))
            )
        );
        d.registry = SubscriptionRegistry(
            _proxy(
                address(new SubscriptionRegistry()),
                abi.encodeCall(
                    SubscriptionRegistry.initialize,
                    (deployer, IPlanFactory(address(d.planFactory)))
                )
            )
        );
        d.autopay = AutopayModule(
            _proxy(
                address(new AutopayModule()),
                abi.encodeCall(
                    AutopayModule.initialize,
                    (
                        admin,
                        permit2,
                        IPlanFactory(address(d.planFactory)),
                        ISubscriptionRegistry(address(d.registry)),
                        d.feeCollector
                    )
                )
            )
        );

        d.registry.grantRole(d.registry.MODULE_ROLE(), address(d.autopay));
        d.feeCollector.grantRole(d.feeCollector.FEE_SOURCE_ROLE(), address(d.autopay));

        if (deployer != admin) {
            bytes32 adminRole = d.registry.DEFAULT_ADMIN_ROLE();
            d.registry.grantRole(adminRole, admin);
            d.registry.renounceRole(adminRole, deployer);

            bytes32 feeManager = d.feeCollector.FEE_MANAGER_ROLE();
            d.feeCollector.grantRole(feeManager, admin);
            d.feeCollector.grantRole(adminRole, admin);
            d.feeCollector.renounceRole(feeManager, deployer);
            d.feeCollector.renounceRole(adminRole, deployer);
        }
    }

    function _proxy(address impl, bytes memory init) private returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }
}
