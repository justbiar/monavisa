import {
  caip2,
  encodeX402Header,
  type PaymentPayload,
  type PaymentRequirements,
  type SessionPayload,
  voucherTypedData,
  X402_VERSION,
} from "@monavisa/core";
import { type Address, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import type { Db } from "../src/db.js";
import { memoryDb } from "./helpers.js";

const sessionOwner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const sessionId = `0x${"01".repeat(32)}` as `0x${string}`;
const sessionSigner = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const payee = "0x0000000000000000000000000000000000000001" as Address;
const sessionVault = "0x1111111111111111111111111111111111111111" as Address;
const asset = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address;
const chainId = 10143;

describe("Facilitator API (/x402)", () => {
  let db: Db;
  let api: ReturnType<typeof createApi>;
  const now = 1_760_000_000;

  beforeAll(async () => {
    db = await memoryDb();
    const publicClient = createPublicClient({ transport: http("http://127.0.0.1:8545") });
    api = createApi(db, {
      chainId,
      sessionVault,
      publicClient,
      now: () => now,
    });

    // Seed an open session in vault_sessions
    await db.query(
      `insert into vault_sessions (session_id, owner, signer, token, balance, expires_at, closes_at, updated_block)
       values ($1, $2, $3, $4, $5, $6, 0, 1)`,
      [
        sessionId,
        sessionOwner.address.toLowerCase(),
        sessionSigner.address.toLowerCase(),
        asset.toLowerCase(),
        "100000000", // 100 USDC
        (now + 86400).toString(),
      ],
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it("GET /x402/supported returns exact and session kinds", async () => {
    const res = await api.request("http://localhost/x402/supported");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.kinds).toHaveLength(2);
    expect(body.kinds.map((k: any) => k.scheme)).toEqual(["exact", "session"]);
  });

  it("POST /x402/verify accepts valid session voucher", async () => {
    const requirements: PaymentRequirements = {
      scheme: "session",
      network: caip2(chainId),
      amount: "10000000", // 10 USDC
      asset,
      payTo: payee,
      maxTimeoutSeconds: 60,
      extra: { sessionVault },
    };

    const voucher = {
      sessionId,
      payee,
      cumulativeAmount: 10_000_000n,
    };
    const signature = await sessionSigner.signTypedData(
      voucherTypedData(chainId, sessionVault, voucher),
    );

    const payload: PaymentPayload<SessionPayload> = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: {
        sessionId,
        cumulativeAmount: "10000000",
        signature,
      },
    };

    const res = await api.request("http://localhost/x402/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.isValid).toBe(true);
    expect(body.payer?.toLowerCase()).toBe(sessionOwner.address.toLowerCase());
  });

  it("POST /x402/settle stores voucher and records payment", async () => {
    const requirements: PaymentRequirements = {
      scheme: "session",
      network: caip2(chainId),
      amount: "10000000",
      asset,
      payTo: payee,
      maxTimeoutSeconds: 60,
      extra: { sessionVault },
    };

    const voucher = {
      sessionId,
      payee,
      cumulativeAmount: 20_000_000n, // increased to 20 USDC
    };
    const signature = await sessionSigner.signTypedData(
      voucherTypedData(chainId, sessionVault, voucher),
    );

    const payload: PaymentPayload<SessionPayload> = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: {
        sessionId,
        cumulativeAmount: "20000000",
        signature,
      },
    };

    const res = await api.request("http://localhost/x402/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);

    // Verify voucher is recorded in database
    const [saved] = await db.query<{ cumulative_amount: string }>(
      "select cumulative_amount from vouchers where session_id = $1 and payee = $2",
      [sessionId, payee.toLowerCase()],
    );
    expect(saved?.cumulative_amount).toBe("20000000");

    // Verify payment record
    const payments = await db.query("select * from x402_payments where payee = $1", [
      payee.toLowerCase(),
    ]);
    expect(payments.length).toBeGreaterThan(0);
  });
});
