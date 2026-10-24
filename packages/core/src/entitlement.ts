export const SubscriptionStatus = {
  None: 0,
  Active: 1,
  PastDue: 2,
  Canceled: 3,
  Expired: 4,
} as const;

export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export interface SubscriptionPeriod {
  status: SubscriptionStatus;
  /** Unix seconds. */
  currentPeriodStart: bigint;
  /** Unix seconds, exclusive. */
  currentPeriodEnd: bigint;
  /** Extra seconds of access after a failed renewal. */
  gracePeriod?: bigint;
}

/**
 * E(c, f, t) = 1[ Sub(c) ∧ t0 ≤ t < t0 + Δ ].
 * A canceled subscription keeps access until its paid period ends;
 * a past-due one keeps it through the grace period.
 */
export function isEntitled(sub: SubscriptionPeriod, now: bigint): boolean {
  if (now < sub.currentPeriodStart) return false;
  switch (sub.status) {
    case SubscriptionStatus.Active:
    case SubscriptionStatus.Canceled:
      return now < sub.currentPeriodEnd;
    case SubscriptionStatus.PastDue:
      return now < sub.currentPeriodEnd + (sub.gracePeriod ?? 0n);
    default:
      return false;
  }
}
