# Mona Visa - Mainnet Deployment Checklist

This document details the step-by-step checklist and operational procedure for deploying Mona Visa to the Monad Mainnet (`chainId: 143`).

---

## 1. Pre-Deployment Configuration

- [ ] **Address Verification**:
  - [ ] Canonical USDC address on Monad Mainnet confirmed.
  - [ ] Canonical Uniswap Permit2 address on Monad Mainnet confirmed (`0x000000000022D473030F116dDEE9F6B43aC78BA3`).
- [ ] **Account Preparation**:
  - [ ] **Deployer EOA**: Funded with native MON for contract creation gas.
  - [ ] **Protocol Multisig / Timelock**: Configured for `DEFAULT_ADMIN_ROLE`.
  - [ ] **Keeper Hot Wallet**: Funded with native MON for `renewMany` execution.
  - [ ] **Settler Hot Wallet**: Funded with native MON for `redeemMany` execution.
  - [ ] **Facilitator Signer**: Hot key for signing x402 payment responses.

---

## 2. On-Chain Deployment Execution

1. **Run Deployment Script**:
   ```bash
   forge script contracts/script/DeployMonaVisa.s.sol:DeployMonaVisa \
     --rpc-url $MONAD_MAINNET_RPC \
     --broadcast \
     --verify \
     --verifier monadscan \
     --legacy
   ```

2. **Role & Permission Setup**:
   - [ ] Verify `FeeCollector.hasRole(FEE_SOURCE_ROLE, autopayModuleAddress)` is `true`.
   - [ ] Verify `FeeCollector.hasRole(FEE_SOURCE_ROLE, sessionVaultAddress)` is `true`.
   - [ ] Set `SessionVault.setCloseDelay(86400)` (1 day delay on mainnet).
   - [ ] Transfer `DEFAULT_ADMIN_ROLE` and `MANAGER_ROLE` on all contracts to the Protocol Multisig.
   - [ ] Renounce admin role from Deployer EOA.

3. **Source Code Verification**:
   - [ ] Verify all contracts on Monadscan with exact compiler version (`0.8.28`) and optimizer runs (200).

---

## 3. Platform & Infrastructure Setup

1. **Environment Variables**:
   - [ ] Set `MONAD_CHAIN_ID=143`
   - [ ] Set `MONAD_RPC_URL=https://rpc.monad.xyz`
   - [ ] Set `USDC_ADDRESS=<mainnet_usdc>`
   - [ ] Set `PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3`
   - [ ] Set `SESSION_VAULT_ADDRESS=<mainnet_session_vault>`
   - [ ] Set `AUTOPAY_MODULE_ADDRESS=<mainnet_autopay_module>`
   - [ ] Set `REGISTRY_ADDRESS=<mainnet_subscription_registry>`
   - [ ] Set `PLAN_FACTORY_ADDRESS=<mainnet_plan_factory>`
   - [ ] Set `FEE_COLLECTOR_ADDRESS=<mainnet_fee_collector>`

2. **Database Migrations**:
   - [ ] Run platform migrations 1, 2, and 3 (`npm run db:migrate`).
   - [ ] Set `indexed_blocks` starting block to the deployment block height.

3. **Services Startup**:
   - [ ] Start Indexer worker (`monavisa indexer`).
   - [ ] Start Renewal Keeper worker (`monavisa keeper`).
   - [ ] Start Voucher Settler worker (`monavisa settler`).
   - [ ] Start Webhook Dispatcher worker (`monavisa webhooks`).
   - [ ] Start HTTP API & Facilitator server (`monavisa api`).

---

## 4. Smoke Test in Production

- [ ] Create a live merchant plan via Dashboard (`1 USDC / month`).
- [ ] Subscribe with a test smart account / EOA via hosted checkout.
- [ ] Confirm Permit2 allowance was consumed and subscription NFT was minted.
- [ ] Open a small session (`5 USDC`) in `SessionVault`.
- [ ] Make an x402 payment to a test protected endpoint using `@monavisa/agent`.
- [ ] Run settler and verify voucher redemption on Monadscan.
- [ ] Verify invoice PDF generation and revenue chart update on Dashboard.
