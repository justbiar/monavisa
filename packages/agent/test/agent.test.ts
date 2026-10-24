import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createRootMandate,
  createChildMandate,
  createAgentFetch,
} from "../src/index.js";
import {
  evaluateSpend,
  encodeX402Header,
  decodeX402Header,
  caip2,
  X402_VERSION,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaymentRequired,
  type PaymentPayload,
} from "@monavisa/core";

const rootAccount = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const agent1Account = privateKeyToAccount(
  "0x2222222222222222222222222222222222222222222222222222222222222222",
);
const agent2Account = privateKeyToAccount(
  "0x3333333333333333333333333333333333333333333333333333333333333333",
);
const payeeAccount = privateKeyToAccount(
  "0x4444444444444444444444444444444444444444444444444444444444444444",
);

describe("Agent SDK - Mandates", () => {
  it("creates root and child mandates and evaluates spend correctly", async () => {
    const chainId = 10143;
    const now = Math.floor(Date.now() / 1000);

    const root = await createRootMandate({
      chainId,
      signer: rootAccount,
      agent: agent1Account.address,
      maxTotal: 1_000_000n,
      maxPerCall: 100_000n,
      validUntil: BigInt(now + 3600),
      nonce: 1n,
    });

    const child = await createChildMandate({
      chainId,
      signer: agent1Account,
      parent: root.mandate,
      agent: agent2Account.address,
      maxTotal: 500_000n,
      maxPerCall: 50_000n,
      validUntil: BigInt(now + 1800),
      nonce: 2n,
    });

    const evalResult = await evaluateSpend({
      chainId,
      mandateChain: [root, child],
      payee: payeeAccount.address,
      amount: 40_000n,
      totalSpentSoFar: 0n,
      nowSec: now,
    });

    expect(evalResult.allowed).toBe(true);

    // Over per-call limit
    const overLimit = await evaluateSpend({
      chainId,
      mandateChain: [root, child],
      payee: payeeAccount.address,
      amount: 60_000n,
      totalSpentSoFar: 0n,
      nowSec: now,
    });
    expect(overLimit.allowed).toBe(false);
    expect(overLimit.reason).toBe("exceeds_per_call_limit");
  });
});

describe("Agent SDK - createAgentFetch", () => {
  it("intercepts 402 and attaches PAYMENT-SIGNATURE", async () => {
    const chainId = 10143;
    const challenge: PaymentRequired = {
      x402Version: X402_VERSION,
      resource: {
        url: "https://api.example.com/compute",
      },
      accepts: [
        {
          scheme: "exact",
          network: caip2(chainId),
          amount: "100000",
          asset: "0x0000000000000000000000000000000000000001",
          payTo: payeeAccount.address,
          maxTimeoutSeconds: 300,
          extra: {
            name: "USD Coin",
            version: "2",
          },
        },
      ],
    };

    let callCount = 0;
    const baseFetch = vi.fn(async (url: any, init?: any) => {
      callCount++;
      if (callCount === 1) {
        return new Response("Payment Required", {
          status: 402,
          headers: {
            [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge),
          },
        });
      }
      // Second call should have PAYMENT-SIGNATURE header
      const headers = new Headers(init?.headers);
      const sigHeader = headers.get(PAYMENT_SIGNATURE_HEADER);
      expect(sigHeader).toBeDefined();
      const decoded = decodeX402Header<PaymentPayload>(sigHeader!);
      expect(decoded.accepted.scheme).toBe("exact");
      expect(decoded.accepted.amount).toBe("100000");

      return new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const agentFetch = createAgentFetch({
      account: agent1Account,
      fetch: baseFetch as any,
    });

    const res = await agentFetch("https://api.example.com/compute");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result).toBe("success");
    expect(callCount).toBe(2);
  });
});
