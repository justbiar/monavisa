// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IFeeCollector {
    event FeeRatesSet(uint16 subscriptionFeeBps, uint16 agentFeeBps);
    event TreasurySet(address treasury);
    event FeeReceived(address indexed token, address indexed source, uint256 amount);
    event FeesWithdrawn(address indexed token, address indexed treasury, uint256 amount);

    error FeeTooHigh(uint16 feeBps, uint16 maxFeeBps);
    error InvalidTreasury();

    function subscriptionFeeBps() external view returns (uint16);

    function agentFeeBps() external view returns (uint16);

    function notifyFee(address token, uint256 amount) external;
}
