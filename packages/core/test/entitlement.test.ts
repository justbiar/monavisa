import { describe, expect, it } from "vitest";
import { SubscriptionStatus, isEntitled, type SubscriptionPeriod } from "../src/index.js";

const period = (status: SubscriptionStatus, gracePeriod?: bigint): SubscriptionPeriod => ({
  status,
  currentPeriodStart: 1_000n,
  currentPeriodEnd: 2_000n,
  ...(gracePeriod === undefined ? {} : { gracePeriod }),
});

describe("isEntitled", () => {
  it("is true inside [t0, t0 + delta) for an active subscription", () => {
    const sub = period(SubscriptionStatus.Active);
    expect(isEntitled(sub, 999n)).toBe(false);
    expect(isEntitled(sub, 1_000n)).toBe(true);
    expect(isEntitled(sub, 1_999n)).toBe(true);
    expect(isEntitled(sub, 2_000n)).toBe(false);
  });

  it("keeps access until period end after cancellation", () => {
    const sub = period(SubscriptionStatus.Canceled);
    expect(isEntitled(sub, 1_500n)).toBe(true);
    expect(isEntitled(sub, 2_000n)).toBe(false);
  });

  it("extends access through the grace period when past due", () => {
    const sub = period(SubscriptionStatus.PastDue, 100n);
    expect(isEntitled(sub, 2_099n)).toBe(true);
    expect(isEntitled(sub, 2_100n)).toBe(false);
    expect(isEntitled(period(SubscriptionStatus.PastDue), 2_000n)).toBe(false);
  });

  it("denies expired and missing subscriptions", () => {
    expect(isEntitled(period(SubscriptionStatus.Expired), 1_500n)).toBe(false);
    expect(isEntitled(period(SubscriptionStatus.None), 1_500n)).toBe(false);
  });
});
