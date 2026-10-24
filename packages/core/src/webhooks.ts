export const WEBHOOK_SIGNATURE_HEADER = "monavisa-signature";
export const WEBHOOK_ID_HEADER = "monavisa-event-id";

export const webhookEventTypes = [
  "subscription.created",
  "subscription.renewed",
  "subscription.renewal_failed",
  "subscription.upgraded",
  "subscription.downgraded",
  "subscription.canceled",
  "subscription.expired",
  "invoice.created",
  "invoice.paid",
  "checkout.completed",
  "payment_link.paid",
  "session.opened",
  "session.closed",
  "x402.settled",
  "escrow.settled",
  "escrow.refunded",
  "mandate.revoked",
] as const;

export type WebhookEventType = (typeof webhookEventTypes)[number];

export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  /** Unix seconds. */
  createdAt: number;
  chainId: number;
  data: T;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signature header value: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<payload>">`. */
export async function signWebhook(
  payload: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${payload}`)}`;
}

export interface VerifyWebhookOptions {
  /** Maximum age of the signature in seconds. Default 300. */
  toleranceSec?: number;
  /** Override for the current time in unix seconds (tests). */
  now?: number;
}

/**
 * Verifies a webhook signature against the raw request body and returns the parsed event.
 * Throws WebhookVerificationError when the header is malformed, stale or does not match.
 */
export async function verifyWebhook<T = Record<string, unknown>>(
  payload: string,
  header: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent<T>> {
  if (!header) throw new WebhookVerificationError("Missing signature header");

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === undefined || !Number.isInteger(timestamp) || signatures.length === 0) {
    throw new WebhookVerificationError("Malformed signature header");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSec ?? 300)) {
    throw new WebhookVerificationError("Signature timestamp is outside the tolerance window");
  }

  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  if (!signatures.some((sig) => timingSafeEqual(sig, expected))) {
    throw new WebhookVerificationError("Signature does not match");
  }
  return JSON.parse(payload) as WebhookEvent<T>;
}
