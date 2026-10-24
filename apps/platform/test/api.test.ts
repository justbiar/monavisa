import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import type { Db } from "../src/db.js";
import { createTeam } from "../src/teams.js";
import { memoryDb } from "./helpers.js";

const merchant = "0x00000000000000000000000000000000000000aa";
const rival = "0x00000000000000000000000000000000000000bb";
const alice = "0x00000000000000000000000000000000000a11ce";
const NOW = 1_760_000_000;

async function seedPlan(db: Db, planId: number, owner: string) {
  await db.query(
    `insert into plans (plan_id, merchant, token, price, period, trial_period, grace_period, treasury, active, updated_block)
     values ($1, $2, '0xusdc', 49000000, 2592000, 0, 259200, $2, true, 1)`,
    [planId, owner],
  );
}

async function seedSub(db: Db, subId: number, planId: number, status: number, end: number) {
  await db.query(
    `insert into subscriptions (sub_id, subscriber, plan_id, period_start, period_end, status, in_trial, updated_block)
     values ($1, $2, $3, $4, $5, $6, false, 1)`,
    [subId, alice, planId, end - 2_592_000, end, status],
  );
}

describe("api", () => {
  let db: Db;
  let apiKey: string;
  let app: ReturnType<typeof createApi>;
  const auth = () => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" });

  beforeEach(async () => {
    db = await memoryDb();
    apiKey = (await createTeam(db, { name: "Kazim Berber", merchant })).apiKey;
    await seedPlan(db, 1, merchant);
    await seedPlan(db, 2, rival);
    app = createApi(db, { chainId: 10143, now: () => NOW });
  });

  afterEach(() => db.close());

  it("rejects requests without a valid API key", async () => {
    expect((await app.request("/v1/features")).status).toBe(401);
    const res = await app.request("/v1/features", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("only maps features to the team's own plans", async () => {
    const res = await app.request("/v1/features/pro", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ planIds: ["1", "2"] }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Plans not found for this team: 2" });
  });

  it("answers entitlements from subscription state, including grace", async () => {
    await app.request("/v1/features/pro", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ planIds: ["1"] }),
    });
    const check = async () =>
      (await (
        await app.request(`/v1/entitlements/pro?customer=${alice}`, { headers: auth() })
      ).json()) as {
        enabled: boolean;
      };

    expect((await check()).enabled).toBe(false);

    await seedSub(db, 1, 1, 2, NOW - 100); // past due, inside 3 days grace
    expect((await check()).enabled).toBe(true);

    await db.query("update subscriptions set period_end = $1 where sub_id = 1", [NOW - 259_200]);
    expect((await check()).enabled).toBe(false);
  });

  it("validates the customer address and unknown features", async () => {
    const bad = await app.request("/v1/entitlements/pro?customer=bob", { headers: auth() });
    expect(bad.status).toBe(400);
    const missing = await app.request(`/v1/entitlements/nope?customer=${alice}`, {
      headers: auth(),
    });
    expect(missing.status).toBe(404);
  });

  it("returns the webhook secret only on creation", async () => {
    const created = await app.request("/v1/webhook-endpoints", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: "https://hooks.example/m", events: ["invoice.paid"] }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { secret: string }).secret).toMatch(/^whsec_/);

    const list = (await (
      await app.request("/v1/webhook-endpoints", { headers: auth() })
    ).json()) as {
      data: Record<string, unknown>[];
    };
    expect(list.data[0]).not.toHaveProperty("secret");

    const invalid = await app.request("/v1/webhook-endpoints", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: "https://hooks.example/m", events: ["not.a.type"] }),
    });
    expect(invalid.status).toBe(400);
  });
});
