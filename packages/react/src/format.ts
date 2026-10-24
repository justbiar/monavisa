const DAY = 86_400;

/** Human label for a billing period in seconds: "month", "year", "30 days", "12 hours". */
export function describePeriod(seconds: number): string {
  if (seconds === 30 * DAY) return "month";
  if (seconds === 365 * DAY) return "year";
  if (seconds === 7 * DAY) return "week";
  if (seconds % DAY === 0) {
    const days = seconds / DAY;
    return days === 1 ? "day" : `${days} days`;
  }
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? "hour" : `${hours} hours`;
}

/** Formats token base units with up to `maxFraction` decimals, trimming trailing zeros. */
export function formatAmount(amount: bigint, decimals: number, maxFraction = 2): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction);
  fraction = fraction.replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeStr}${fraction ? `.${fraction}` : ""}`;
}

export type CheckoutStep = "approve" | "sign" | "authorize" | "subscribe";

/**
 * Steps a subscriber goes through. The ERC-20 approval to Permit2 is a one-time step per token,
 * skipped when the existing approval already covers the allowance being granted.
 *
 * Accounts with code (smart accounts, EIP-7702 delegated EOAs) get the allowance through an
 * on-chain Permit2.approve instead of a signature: Permit2 checks their signatures through
 * ERC-1271, which not every account implements correctly.
 */
export function checkoutSteps(
  tokenAllowanceToPermit2: bigint,
  permitAmount: bigint,
  accountHasCode = false,
): CheckoutStep[] {
  const steps: CheckoutStep[] = [];
  if (tokenAllowanceToPermit2 < permitAmount) steps.push("approve");
  steps.push(accountHasCode ? "authorize" : "sign");
  steps.push("subscribe");
  return steps;
}
