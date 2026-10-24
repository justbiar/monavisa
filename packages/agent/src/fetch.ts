import {
  decodeX402Header,
  encodeX402Header,
  exactTypedData,
  parseCaip2,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SessionPayload,
  type SignedMandate,
  type SignedMandateJson,
  voucherTypedData,
  X402_VERSION,
} from "@monavisa/core";
import {
  type Account,
  type Address,
  getAddress,
  type Hex,
  toHex,
} from "viem";

export interface AgentFetchOptions {
  account: Account;
  sessionId?: Hex;
  sessionVault?: Address;
  preferredScheme?: "session" | "exact";
  maxPerCall?: bigint;
  mandateChain?: SignedMandate[];
  fetchImpl?: typeof fetch;
  fetch?: typeof fetch;
}

/**
 * Creates an agent-aware fetch wrapper that automatically handles HTTP 402 challenges
 * and signs payment payloads (via SessionVault vouchers or EIP-3009 exact authorizations).
 */
export function createAgentFetch(options: AgentFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? options.fetch ?? fetch;
  const cumulativeSpentByPayee = new Map<string, bigint>();

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await fetchImpl(input, init);
    if (res.status !== 402) {
      return res;
    }

    const requiredHeader = res.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!requiredHeader) {
      return res;
    }

    let required: PaymentRequired;
    try {
      required = decodeX402Header<PaymentRequired>(requiredHeader);
    } catch {
      return res;
    }

    if (required.x402Version !== X402_VERSION || !required.accepts || required.accepts.length === 0) {
      return res;
    }

    // Select suitable requirement
    const chosen = selectRequirement(required.accepts, options);
    if (!chosen) {
      return res;
    }

    const amount = BigInt(chosen.amount);
    if (options.maxPerCall && amount > options.maxPerCall) {
      throw new Error(`Payment requirement amount (${amount}) exceeds agent maxPerCall (${options.maxPerCall})`);
    }

    const chainId = parseCaip2(chosen.network);
    const payee = getAddress(chosen.payTo);

    if (!options.account.signTypedData) {
      throw new Error("Account does not support signTypedData");
    }

    let paymentPayload: PaymentPayload;

    if (chosen.scheme === "session") {
      if (!options.sessionId) {
        throw new Error("Cannot pay with session scheme: no sessionId provided");
      }
      const sessionVault = (chosen.extra?.sessionVault as Address) ?? options.sessionVault;
      if (!sessionVault) {
        throw new Error("SessionVault contract address missing in requirements and options");
      }

      const prevCumulative = cumulativeSpentByPayee.get(payee.toLowerCase()) ?? 0n;
      const newCumulative = prevCumulative + amount;

      const voucher = {
        sessionId: options.sessionId,
        payee,
        cumulativeAmount: newCumulative,
      };

      const signature = await options.account.signTypedData(
        voucherTypedData(chainId, sessionVault, voucher),
      );

      const mandateJson: SignedMandateJson[] | undefined = options.mandateChain?.map((m) => ({
        mandate: {
          issuer: m.mandate.issuer,
          agent: m.mandate.agent,
          parent: m.mandate.parent,
          maxTotal: m.mandate.maxTotal.toString(),
          maxPerCall: m.mandate.maxPerCall.toString(),
          allowedPayees: m.mandate.allowedPayees,
          validUntil: m.mandate.validUntil.toString(),
          nonce: m.mandate.nonce.toString(),
        },
        signature: m.signature,
      }));

      const sessionPayload: SessionPayload = {
        sessionId: options.sessionId,
        cumulativeAmount: newCumulative.toString(),
        signature,
        ...(mandateJson ? { mandates: mandateJson } : {}),
      };

      paymentPayload = {
        x402Version: X402_VERSION,
        accepted: chosen,
        payload: sessionPayload,
      };
    } else if (chosen.scheme === "exact") {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));

      const authMessage = {
        from: options.account.address,
        to: payee,
        value: amount,
        validAfter: nowSec - 60n,
        validBefore: nowSec + 3600n,
        nonce,
      };

      const signature = await options.account.signTypedData(
        exactTypedData(chosen, authMessage),
      );

      paymentPayload = {
        x402Version: X402_VERSION,
        accepted: chosen,
        payload: {
          signature,
          authorization: {
            from: options.account.address,
            to: payee,
            value: amount.toString(),
            validAfter: (nowSec - 60n).toString(),
            validBefore: (nowSec + 3600n).toString(),
            nonce,
          },
        },
      };
    } else {
      return res;
    }

    // Clone headers and retry request with PAYMENT-SIGNATURE
    const headers = new Headers(init?.headers);
    headers.set(PAYMENT_SIGNATURE_HEADER, encodeX402Header(paymentPayload));

    const retryRes = await fetchImpl(input, {
      ...init,
      headers,
    });

    if (retryRes.ok && chosen.scheme === "session") {
      const prev = cumulativeSpentByPayee.get(payee.toLowerCase()) ?? 0n;
      cumulativeSpentByPayee.set(payee.toLowerCase(), prev + amount);
    }

    return retryRes;
  };
}

function selectRequirement(
  accepts: PaymentRequirements[],
  options: AgentFetchOptions,
): PaymentRequirements | undefined {
  const preferred = options.preferredScheme ?? (options.sessionId ? "session" : "exact");
  const match = accepts.find((a) => a.scheme === preferred);
  if (match) return match;
  return accepts[0];
}
