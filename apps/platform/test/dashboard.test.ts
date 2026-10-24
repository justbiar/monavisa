import { type Address, verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import type { Db } from "../src/db.js";
import { createTeam } from "../src/teams.js";
import { memoryDb } from "./helpers.js";

const NOW = 1_760_000_000;
const DOMAIN = "dashboard.test";
const CHAIN_ID = 10143;
const rival = "0x00000000000000000000000000000000000000bb";
const alice = "0x00000000000000000000000000000000000a11ce";

async function seedPlan(db: Db, planId: number, merchant: string, price = 49_000_000) {
  await db.query(
    `insert into plans (plan_id, merchant, token, price, period, trial_period, grace_period, treasury, active, updated_block)
     values ($1, $2, '0xusdc', $3, 2592000, 0, 259200, $2, true, 1)`,
    [planId, merchant.toLowerCase(), price],
  );
}

async function seedSub(db: Db, subId: number, planId: number, status: number, inTrial = false) {
  await db.query(
    `insert into subscriptions (sub_id, subscriber, plan_id, period_start, period_end, status, in_trial, updated_block)
     values ($1, $2, $3, $4, $5, $6, $7, 1)`,
    [subId, alice, planId, NOW - 86_400, NOW + 29 * 86_400, status, inTrial],
  );
}

describe("dashboard API", () => {
  let db: Db;
  let app: ReturnType<typeof createApi>;
  const merchant = privateKeyToAccount(generatePrivateKey());
  const onChainPlans = new Map<bigint, Address>();

  const json = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  async function signIn(
    account = merchant,
    overrides: { domain?: string; nonce?: string } = {},
  ): Promise<Response> {
    const { nonce } = (await (await app.request("/auth/nonce", { method: "POST" })).json()) as {
      nonce: string;
    };
    const message = createSiweMessage({
      domain: overrides.domain ?? DOMAIN,
      address: account.address,
      statement: "Mona Visa paneline giriş",
      uri: `https://${DOMAIN}`,
      version: "1",
      chainId: CHAIN_ID,
      nonce: overrides.nonce ?? nonce,
      issuedAt: new Date(NOW * 1000),
    });
    const signature = await account.signMessage({ message });
    return app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
  }

  const sessionToken = async () => ((await (await signIn()).json()) as { token: string }).token;

  beforeEach(async () => {
    db = await memoryDb();
    app = createApi(db, {
      chainId: CHAIN_ID,
      now: () => NOW,
      siweDomains: [DOMAIN],
      verifySiwe: ({ message, signature }) =>
        verifyMessage({ address: merchantFrom(message), message, signature }),
      readPlanMerchant: async (planId) => onChainPlans.get(planId) ?? null,
      checkoutBaseUrl: "https://pay.example",
    });
    await seedPlan(db, 1, merchant.address);
    await seedPlan(db, 2, rival);
  });

  afterEach(() => db.close());

  it("signs in with SIWE and creates the merchant's team", async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; team: { merchant: string } };
    expect(body.token).toMatch(/^mv_sess_/);
    expect(body.team.merchant).toBe(merchant.address.toLowerCase());

    const me = await app.request("/v1/me", { headers: json(body.token) });
    expect(await me.json()).toMatchObject({ auth: "session" });
  });

  it("rejects replayed nonces, foreign domains and wrong signers", async () => {
    const first = await signIn();
    expect(first.status).toBe(200);

    const replay = await signIn(merchant, { nonce: "notissued123" });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "Sign-in request expired. Try again." });

    const phishing = await signIn(merchant, { domain: "evil.example" });
    expect(await phishing.json()).toEqual({ error: "Sign-in from evil.example is not allowed" });

    const impostor = privateKeyToAccount(generatePrivateKey());
    const { nonce } = (await (await app.request("/auth/nonce", { method: "POST" })).json()) as {
      nonce: string;
    };
    const message = createSiweMessage({
      domain: DOMAIN,
      address: merchant.address,
      uri: `https://${DOMAIN}`,
      version: "1",
      chainId: CHAIN_ID,
      nonce,
    });
    const forged = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature: await impostor.signMessage({ message }) }),
    });
    expect(await forged.json()).toEqual({ error: "Signature does not match the wallet" });
  });

  it("refuses the exact same signed message twice", async () => {
    const { nonce } = (await (await app.request("/auth/nonce", { method: "POST" })).json()) as {
      nonce: string;
    };
    const message = createSiweMessage({
      domain: DOMAIN,
      address: merchant.address,
      uri: `https://${DOMAIN}`,
      version: "1",
      chainId: CHAIN_ID,
      nonce,
    });
    const body = JSON.stringify({ message, signature: await merchant.signMessage({ message }) });
    const post = () =>
      app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(401);
  });

  it("manages API keys only from a session", async () => {
    const token = await sessionToken();
    const created = (await (
      await app.request("/v1/api-keys", {
        method: "POST",
        headers: json(token),
        body: JSON.stringify({ label: "Backend" }),
      })
    ).json()) as { id: string; apiKey: string; prefix: string };
    expect(created.apiKey).toMatch(/^mv_sk_/);
    expect(created.apiKey.startsWith(created.prefix.slice(0, 10))).toBe(true);

    // The new key works for the API but cannot mint or list keys.
    expect((await app.request("/v1/features", { headers: json(created.apiKey) })).status).toBe(200);
    expect((await app.request("/v1/api-keys", { headers: json(created.apiKey) })).status).toBe(403);

    const list = (await (await app.request("/v1/api-keys", { headers: json(token) })).json()) as {
      data: { id: string; revokedAt: string | null }[];
    };
    expect(list.data.map((k) => k.id)).toEqual([created.id]);
    expect(JSON.stringify(list)).not.toContain(created.apiKey);

    const revoke = await app.request(`/v1/api-keys/${created.id}`, {
      method: "DELETE",
      headers: json(token),
    });
    expect(revoke.status).toBe(204);
    expect((await app.request("/v1/features", { headers: json(created.apiKey) })).status).toBe(401);
  });

  it("keeps keys created before migration 2 working", async () => {
    const { apiKey } = await createTeam(db, { name: "Legacy", merchant: rival });
    expect((await app.request("/v1/features", { headers: json(apiKey) })).status).toBe(200);
  });

  it("names only the team's own plans, checking the chain for unindexed ones", async () => {
    const token = await sessionToken();
    const put = (id: number, name: string) =>
      app.request(`/v1/plans/${id}/metadata`, {
        method: "PUT",
        headers: json(token),
        body: JSON.stringify({ name }),
      });

    expect((await put(1, "Pro Tıraş")).status).toBe(200);
    expect((await put(2, "Not mine")).status).toBe(404);

    onChainPlans.set(3n, merchant.address);
    expect((await put(3, "Fresh plan")).status).toBe(200);

    const plans = (await (await app.request("/v1/plans", { headers: json(token) })).json()) as {
      data: { id: string; name: string | null }[];
    };
    expect(plans.data).toEqual([expect.objectContaining({ id: "1", name: "Pro Tıraş" })]);

    const pub = (await (await app.request("/public/plans/1")).json()) as Record<string, unknown>;
    expect(pub).toMatchObject({ name: "Pro Tıraş", merchant: merchant.address.toLowerCase() });
  });

  it("summarises subscribers, MRR and revenue", async () => {
    await seedSub(db, 1, 1, 1);
    await seedSub(db, 2, 1, 1, true);
    await seedSub(db, 3, 1, 2);
    await seedSub(db, 4, 1, 3);
    await db.query(
      `insert into invoices (id, sub_id, payer, treasury, token, amount, fee, tx_hash, block_number, paid_at)
       values ('0xa:1', 1, $1, $2, '0xusdc', 49000000, 490000, '0xa', 10, $3),
              ('0xb:1', 3, $1, $2, '0xusdc', 49000000, 490000, '0xb', 11, $4)`,
      [alice, merchant.address.toLowerCase(), NOW - 86_400, NOW - 40 * 86_400],
    );

    const token = await sessionToken();
    const overview = await (await app.request("/v1/overview", { headers: json(token) })).json();
    expect(overview).toMatchObject({
      subscribers: { active: 1, trialing: 1, pastDue: 1, canceling: 1 },
      mrr: [{ token: "0xusdc", amount: "49000000" }],
      revenue: [{ token: "0xusdc", amount: "98000000" }],
      revenue30d: [{ token: "0xusdc", amount: "49000000" }],
      payments: 2,
    });
  });

  it("creates payment links that the checkout resolves publicly", async () => {
    const token = await sessionToken();
    const created = (await (
      await app.request("/v1/payment-links", {
        method: "POST",
        headers: json(token),
        body: JSON.stringify({ planId: "1", label: "Instagram" }),
      })
    ).json()) as { id: string; url: string };
    expect(created.url).toBe(`https://pay.example/l/${created.id}`);

    const foreign = await app.request("/v1/payment-links", {
      method: "POST",
      headers: json(token),
      body: JSON.stringify({ planId: "2" }),
    });
    expect(foreign.status).toBe(404);

    const resolved = await (await app.request(`/public/payment-links/${created.id}`)).json();
    expect(resolved).toMatchObject({ label: "Instagram", plan: { id: "1" } });

    await app.request(`/v1/payment-links/${created.id}`, {
      method: "DELETE",
      headers: json(token),
    });
    expect((await app.request(`/public/payment-links/${created.id}`)).status).toBe(404);
  });
});

/** The SIWE message names the signer on its second line. */
function merchantFrom(message: string): Address {
  const line = message.split("\n")[1];
  if (!line?.startsWith("0x")) throw new Error("No address in message");
  return line as Address;
}
