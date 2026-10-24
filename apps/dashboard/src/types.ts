export interface Amount {
  token: string;
  amount: string;
}

export interface Overview {
  subscribers: { active: number; trialing: number; pastDue: number; canceling: number };
  mrr: Amount[];
  revenue: Amount[];
  revenue30d: Amount[];
  payments: number;
  lastIndexedBlock: string | null;
}

export interface DashboardPlan {
  id: string;
  name: string | null;
  description: string | null;
  token: string;
  price: string;
  period: number;
  trialPeriod: number;
  gracePeriod: number;
  treasury: string;
  active: boolean;
  subscribers: { active: number; trialing: number; pastDue: number };
}

export interface DashboardSubscription {
  id: string;
  customer: string;
  planId: string;
  planName: string | null;
  status: string;
  currentPeriodEnd: number;
  inTrial: boolean;
  entitled: boolean;
}

export interface Invoice {
  id: string;
  subscriptionId: string;
  customer: string;
  planId: string;
  planName: string | null;
  amount: string;
  fee: string;
  transactionHash: string;
  paidAt: number;
}

export interface PaymentLink {
  id: string;
  planId: string;
  planName: string | null;
  label: string | null;
  url: string | null;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
}

export const planLabel = (plan: { id: string; name: string | null }) =>
  plan.name ?? `Plan #${plan.id}`;
