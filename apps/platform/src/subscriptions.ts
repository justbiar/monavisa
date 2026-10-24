import { type SubscriptionStatus, isEntitled, subscriptionStatusName } from "@monavisa/core";

export interface SubscriptionRow {
  sub_id: string;
  subscriber: string;
  plan_id: string;
  pending_plan_id: string | null;
  period_start: string;
  period_end: string;
  status: number;
  in_trial: number | boolean;
  grace_period: number;
}

export const SUBSCRIPTION_SELECT = `
  select s.sub_id, s.subscriber, s.plan_id, s.pending_plan_id, s.period_start, s.period_end,
         s.status, s.in_trial, p.grace_period
  from subscriptions s join plans p on p.plan_id = s.plan_id`;

export function toSubscription(row: SubscriptionRow, nowSec: number) {
  const status = row.status as SubscriptionStatus;
  return {
    id: String(row.sub_id),
    customer: row.subscriber,
    planId: String(row.plan_id),
    pendingPlanId: row.pending_plan_id === null ? null : String(row.pending_plan_id),
    status: subscriptionStatusName(status),
    currentPeriodStart: Number(row.period_start),
    currentPeriodEnd: Number(row.period_end),
    inTrial: Boolean(row.in_trial),
    entitled: isEntitled(
      {
        status,
        currentPeriodStart: BigInt(row.period_start),
        currentPeriodEnd: BigInt(row.period_end),
        gracePeriod: BigInt(row.grace_period),
      },
      BigInt(nowSec),
    ),
  };
}
