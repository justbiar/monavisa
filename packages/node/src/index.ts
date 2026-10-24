export {
  type SubscriptionStatusName,
  verifyWebhook,
  WebhookVerificationError,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
  type WebhookEventType,
} from "@monavisa/core";

import type { SubscriptionStatusName } from "@monavisa/core";

export const DEFAULT_BASE_URL = "http://localhost:8787";

export interface MonaVisaClientOptions {
  /** Secret API key (`mv_sk_...`). Keep it server-side. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** A customer is identified by their wallet address. */
export interface Customer {
  address: `0x${string}`;
}

export interface Subscription {
  id: string;
  customer: string;
  planId: string;
  pendingPlanId: string | null;
  status: SubscriptionStatusName;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  inTrial: boolean;
  entitled: boolean;
}

export interface Entitlement {
  feature: string;
  customer: string;
  enabled: boolean;
  subscription: Subscription | null;
}

export interface Invoice {
  id: string;
  subscriptionId: string;
  token: string;
  /** Base units of the token (USDC has 6 decimals). */
  amount: string;
  fee: string;
  transactionHash: string;
  paidAt: number;
}

export interface Feature {
  key: string;
  planIds: string[];
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  /** Only returned when the endpoint is created. */
  secret?: string;
}

export class MonaVisaError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MonaVisaError";
    this.status = status;
  }
}

export class MonaVisaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MonaVisaClientOptions) {
    if (!options.apiKey) throw new Error("MonaVisaClient needs an apiKey");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Whether the customer currently has `feature`, based on their on-chain subscriptions. */
  checkEntitlement(feature: string, customer: Customer): Promise<Entitlement> {
    const query = new URLSearchParams({ customer: customer.address });
    return this.request(`/v1/entitlements/${encodeURIComponent(feature)}?${query}`);
  }

  async listSubscriptions(customer: Customer): Promise<Subscription[]> {
    const res = await this.request<{ data: Subscription[] }>(
      `/v1/customers/${customer.address}/subscriptions`,
    );
    return res.data;
  }

  async listInvoices(customer: Customer): Promise<Invoice[]> {
    const res = await this.request<{ data: Invoice[] }>(
      `/v1/customers/${customer.address}/invoices`,
    );
    return res.data;
  }

  async listFeatures(): Promise<Feature[]> {
    return (await this.request<{ data: Feature[] }>("/v1/features")).data;
  }

  /** Makes `feature` available to subscribers of any of `planIds`. */
  setFeature(key: string, planIds: (string | number | bigint)[]): Promise<Feature> {
    return this.request(`/v1/features/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { planIds: planIds.map(String) },
    });
  }

  createWebhookEndpoint(url: string, events: string[] = ["*"]): Promise<WebhookEndpoint> {
    return this.request("/v1/webhook-endpoints", { method: "POST", body: { url, events } });
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const message =
        json && typeof json === "object" && "error" in json ? String(json.error) : res.statusText;
      throw new MonaVisaError(res.status, message);
    }
    return json as T;
  }
}
