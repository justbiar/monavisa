export const BPS_DENOMINATOR = 10_000n;

export interface PaymentSplit {
  /** Protocol fee routed to the FeeCollector. */
  fee: bigint;
  /** Amount the merchant treasury receives. */
  merchant: bigint;
}

/**
 * Protocol fee for a payment: F = ρ · P, with ρ in basis points.
 * Rounds down, so the protocol never takes more than the stated rate.
 */
export function computeFee(amount: bigint, feeBps: number): bigint {
  assertValidAmount(amount);
  assertValidBps(feeBps);
  return (amount * BigInt(feeBps)) / BPS_DENOMINATOR;
}

/**
 * Splits a fee-inclusive amount (an x402 call rate, an escrow payout) so that
 * `fee + merchant === amount` always holds.
 */
export function splitPayment(amount: bigint, feeBps: number): PaymentSplit {
  const fee = computeFee(amount, feeBps);
  return { fee, merchant: amount - fee };
}

export interface RenewalCharge extends PaymentSplit {
  /** What the subscriber pays: P + F. */
  total: bigint;
}

/**
 * Subscription charges add the fee on top of the plan price, so the merchant
 * receives the full price. A renewal succeeds only when balance(w) >= P + F.
 */
export function renewalCharge(price: bigint, feeBps: number): RenewalCharge {
  const fee = computeFee(price, feeBps);
  return { fee, merchant: price, total: price + fee };
}

function assertValidAmount(amount: bigint): void {
  if (amount < 0n) throw new RangeError(`Amount must be non-negative, got ${amount}`);
}

function assertValidBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || BigInt(feeBps) > BPS_DENOMINATOR) {
    throw new RangeError(`Fee must be an integer between 0 and 10000 bps, got ${feeBps}`);
  }
}
