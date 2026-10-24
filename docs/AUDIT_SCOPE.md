# Mona Visa Protocol - Audit Scope & Threat Model

This document outlines the scope, threat model, architectural invariants, and Monad-specific execution properties for security audits of the Mona Visa smart contracts.

---

## 1. Contracts in Scope

| Contract | SLOC | Description |
|---|---|---|
| `contracts/src/SessionVault.sol` | ~450 | Non-custodial prepaid sessions, off-chain EIP-712 cumulative vouchers, Verify-Then-Settle escrow, on-chain mandate revocation bitmap. |
| `contracts/src/AutopayModule.sol` | ~280 | Permissionless subscription renewal engine pulling `price + fee` through Permit2 allowances. |
| `contracts/src/FeeCollector.sol` | ~120 | Splits protocol fees between treasury and referral sources with immutable rate caps. |
| `contracts/src/SubscriptionRegistry.sol` | ~200 | Soulbound ERC-721 token representing active subscriptions and billing period records. |
| `contracts/src/PlanFactory.sol` | ~90 | Merchant plan registry and terms validation. |
| `contracts/src/Autopay7579Executor.sol` | ~90 | ERC-7579 execution module allowing smart accounts to delegate recurring transfers. |

---

## 2. Protocol Invariants

### 2.1 Token Conservation (SessionVault)
$$\sum_{i} \text{sessionBalance}_i + \sum_{j} \text{reservedEscrow}_j + \sum_{k} \text{pendingWithdrawals}_k = \text{IERC20}(\text{token}).\text{balanceOf}(\text{address}(\text{this}))$$
- No operation (voucher redemption, fee extraction, escrow settlement, refund, withdrawal) may break this equality.
- Handled via formal invariant fuzz testing in `contracts/test/invariant/SessionVault.invariant.t.sol`.

### 2.2 Voucher Monotonicity & Payee Independence
- Each voucher specifies a `sessionId`, `payee`, and `cumulativeAmount`.
- A voucher can only be redeemed if `cumulativeAmount > redeemed[sessionId][payee]`.
- The vault only transfers the incremental delta $(\text{cumulativeAmount} - \text{redeemed})$.
- If the session balance is less than the delta, the vault pays what remains, charges the proportional fee, and closes the session.
- Vouchers signed for payee A cannot be redeemed by or redirected to payee B.

### 2.3 Verify-Then-Settle Escrow
- Escrow transitions:
  $$\text{None} \xrightarrow{\text{reserve}} \text{Reserved} \xrightarrow{\text{commit}} \text{Committed} \xrightarrow{\text{confirm}} \text{Settled}$$
  $$\text{Reserved / Committed} \xrightarrow{\text{refund (if } t \ge \text{deadline)}} \text{Refunded}$$
- Only the session owner can call `reserve`.
- Only the assigned provider can call `commit` with deliverable commitment $C = \text{SHA-256}(\text{JCS}(D))$.
- Only the buyer (or designated arbiter) can call `confirm` prior to deadline.
- Upon deadline expiry, funds can only be refunded back to the buyer's session balance.

### 2.4 MonAuth Monotonic Narrowing
- A child mandate must satisfy:
  - $\text{maxPerCall}_{\text{child}} \le \text{maxPerCall}_{\text{parent}}$
  - $\text{maxTotal}_{\text{child}} \le \text{maxTotal}_{\text{parent}}$
  - $\text{validUntil}_{\text{child}} \le \text{validUntil}_{\text{parent}}$
  - $\text{allowedPayees}_{\text{child}} \subseteq \text{allowedPayees}_{\text{parent}}$ (when restricted)
- Revocation of any mandate in the chain on-chain (`SessionVault.revokeMandate`) immediately invalidates all descendants.

---

## 3. Monad-Specific Execution Properties

1. **Gas Limit Billing:**
   Monad charges gas according to the transaction's specified gas limit rather than actual gas consumed. All keepers, settlers, and agent SDKs estimate gas and apply a tight buffer (10%) to prevent overpaying execution fees.

2. **Parallel State Access & Storage Compaction:**
   Monad executes transactions optimistically in parallel. To maximize concurrency and optimize for 128-slot state page cache lines:
   - Session data is packed into single 32-byte slots (`uint96 balance`, `uint40 expiry`, `uint40 closeRequestedAt`).
   - Escrow records are packed into 32-byte slots (`uint96 amount`, `uint40 deadline`, `uint8 status`).

3. **Prague EVM Target:**
   - Bytecode limit is 128 KB (well within bounds; contracts are modular and < 24 KB each).
   - Transient storage (`TSTORE` / `TLOAD`) used for reentrancy guards (`ReentrancyGuardTransient`).

---

## 4. Threat Model & External Attack Vectors

1. **Keeper Replay & Front-running:**
   - Permitted: Anyone may call `renewMany` or `redeemMany`. Keepers compete permissionlessly, and cannot alter the recipient or amounts.
2. **Signature Replay Across Chains:**
   - Mitigated by EIP-712 domain separators containing `chainId` and contract verifying addresses.
3. **ERC-1271 Smart Wallet Signature Griefing:**
   - Smart wallet signers call `isValidSignature(bytes32, bytes)`. Gas limits for staticcalls prevent infinite loops.
4. **Malicious Tokens:**
   - Protocol operates strictly on canonical, vetted stablecoins (USDC) with 6 decimals.
