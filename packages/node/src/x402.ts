import {
  caip2,
  decodeX402Header,
  encodeX402Header,
  getNetwork,
  MONAD_TESTNET_CHAIN_ID,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  type X402Scheme,
  X402_VERSION,
} from "@monavisa/core";
import type { Address } from "viem";

export interface X402MiddlewareOptions {
  payTo: Address;
  /** Amount in token base units (e.g. 1000000n for 1 USDC). */
  amount: bigint | string;
  asset?: Address;
  chainId?: number;
  schemes?: X402Scheme[];
  facilitatorUrl?: string;
  description?: string;
  fetchImpl?: typeof fetch;
}

export function buildPaymentRequirements(
  options: X402MiddlewareOptions,
  scheme: X402Scheme,
): PaymentRequirements {
  const chainId = options.chainId ?? MONAD_TESTNET_CHAIN_ID;
  const networkInfo = getNetwork(chainId);
  const asset = options.asset ?? networkInfo.usdc.address;

  const base: PaymentRequirements = {
    scheme,
    network: caip2(chainId),
    amount: options.amount.toString(),
    asset,
    payTo: options.payTo,
    maxTimeoutSeconds: 60,
  };

  if (scheme === "exact") {
    base.extra = {
      name: networkInfo.usdc.eip712.name,
      version: networkInfo.usdc.eip712.version,
    };
  } else if (scheme === "session") {
    base.extra = {
      sessionVault: networkInfo.contracts.sessionVault ?? undefined,
    };
  }

  return base;
}

export function buildPaymentRequired(
  options: X402MiddlewareOptions,
  url: string,
): PaymentRequired {
  const schemes = options.schemes ?? ["session", "exact"];
  return {
    x402Version: X402_VERSION,
    resource: {
      url,
      ...(options.description ? { description: options.description } : {}),
    },
    accepts: schemes.map((s) => buildPaymentRequirements(options, s)),
  };
}

/**
 * Hono middleware protecting an endpoint with x402 v2 payment requirements.
 */
export function x402HonoMiddleware(options: X402MiddlewareOptions) {
  const facilitatorUrl = (options.facilitatorUrl ?? "http://localhost:8787").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (c: any, next: () => Promise<void>) => {
    const signatureHeader = c.req.header(PAYMENT_SIGNATURE_HEADER);
    const url = c.req.url;

    if (!signatureHeader) {
      const required = buildPaymentRequired(options, url);
      c.header(PAYMENT_REQUIRED_HEADER, encodeX402Header(required));
      c.header("content-type", "application/json");
      return c.json({ error: "Payment required", accepts: required.accepts }, 402);
    }

    let payload: PaymentPayload;
    try {
      payload = decodeX402Header<PaymentPayload>(signatureHeader);
    } catch {
      return c.json({ error: "Malformed PAYMENT-SIGNATURE header" }, 400);
    }

    const requirements = buildPaymentRequirements(options, payload.accepted.scheme as X402Scheme);

    // Call facilitator to settle payment
    const settleRes = await fetchImpl(`${facilitatorUrl}/x402/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
    });

    const settleData = (await settleRes.json().catch(() => null)) as SettleResponse | null;
    if (!settleRes.ok || !settleData?.success) {
      const error = settleData?.errorReason ?? "Payment settlement failed";
      return c.json({ error }, 402);
    }

    c.set("x402Payer", settleData.payer);
    await next();

    c.header(PAYMENT_RESPONSE_HEADER, encodeX402Header(settleData));
  };
}

/**
 * Express middleware protecting an endpoint with x402 v2 payment requirements.
 */
export function x402ExpressMiddleware(options: X402MiddlewareOptions) {
  const facilitatorUrl = (options.facilitatorUrl ?? "http://localhost:8787").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (req: any, res: any, next: (err?: any) => void) => {
    const signatureHeader = req.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()];
    const url = req.originalUrl || req.url;

    if (!signatureHeader) {
      const required = buildPaymentRequired(options, url);
      res.setHeader(PAYMENT_REQUIRED_HEADER, encodeX402Header(required));
      res.setHeader("content-type", "application/json");
      return res.status(402).json({ error: "Payment required", accepts: required.accepts });
    }

    let payload: PaymentPayload;
    try {
      payload = decodeX402Header<PaymentPayload>(signatureHeader);
    } catch {
      return res.status(400).json({ error: "Malformed PAYMENT-SIGNATURE header" });
    }

    const requirements = buildPaymentRequirements(options, payload.accepted.scheme as X402Scheme);

    const settleRes = await fetchImpl(`${facilitatorUrl}/x402/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
    });

    const settleData = (await settleRes.json().catch(() => null)) as SettleResponse | null;
    if (!settleRes.ok || !settleData?.success) {
      const error = settleData?.errorReason ?? "Payment settlement failed";
      return res.status(402).json({ error });
    }

    req.x402Payer = settleData.payer;
    res.setHeader(PAYMENT_RESPONSE_HEADER, encodeX402Header(settleData));
    next();
  };
}

export const x402Middleware = Object.assign(x402HonoMiddleware, {
  hono: x402HonoMiddleware,
  express: x402ExpressMiddleware,
});
