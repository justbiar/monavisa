import { randomBytes } from "node:crypto";
import { SubscriptionStatus, isEntitled, webhookEventTypes } from "@monavisa/core";
import { Hono } from "hono";
import { isAddress } from "viem";
import { z } from "zod";
import type { Db } from "./db.js";
import { lastIndexedBlock } from "./indexer.js";
import { type Team, teamForApiKey } from "./teams.js";

export interface ApiOptions {
  chainId: number;
  /** Current time in unix seconds; injectable for tests. */
  now?: () => number;
}

interface SubscriptionRow {
  sub_id: string;
  subscriber: string;
  plan_id: string;
  pending_plan_id: string | null;
  period_start: string;
  period_end: string;
  status: number;
  in_trial: boolean;
  grace_period: number;
}

function toSubscription(row: SubscriptionRow, nowSec: number) {
  const status = row.status as SubscriptionStatus;
  return {
    id: row.sub_id,
    customer: row.subscriber,
    planId: row.plan_id,
    pendingPlanId: row.pending_plan_id,
    status: Object.keys(SubscriptionStatus)[status]?.toLowerCase() ?? "unknown",
    currentPeriodStart: Number(row.period_start),
    currentPeriodEnd: Number(row.period_end),
    inTrial: row.in_trial,
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

const SUBSCRIPTION_SELECT = `
  select s.sub_id, s.subscriber, s.plan_id, s.pending_plan_id, s.period_start, s.period_end,
         s.status, s.in_trial, p.grace_period
  from subscriptions s join plans p on p.plan_id = s.plan_id`;

const featureBody = z.object({ planIds: z.array(z.string().regex(/^\d+$/)).min(1) });
const endpointBody = z.object({
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(z.enum([...webhookEventTypes, "*"])).min(1),
});

export function createApi(db: Db, options: ApiOptions) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: { team: Team } }>();

  app.get("/health", async (c) => {
    const block = await lastIndexedBlock(db);
    return c.json({
      ok: true,
      chainId: options.chainId,
      lastIndexedBlock: block?.toString() ?? null,
    });
  });

  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization");
    const key = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const team = key ? await teamForApiKey(db, key) : null;
    if (!team) return c.json({ error: "Invalid or missing API key" }, 401);
    c.set("team", team);
    await next();
  });

  /** Whether `customer` currently has `feature`. Only this team's plans count. */
  app.get("/v1/entitlements/:feature", async (c) => {
    const team = c.get("team");
    const feature = c.req.param("feature");
    const customer = c.req.query("customer");
    if (!customer || !isAddress(customer)) {
      return c.json({ error: "Query parameter 'customer' must be a wallet address" }, 400);
    }

    const [row] = await db.query<{ plan_ids: string[] }>(
      "select plan_ids from features where team_id = $1 and key = $2",
      [team.id, feature],
    );
    if (!row) return c.json({ error: `Feature '${feature}' is not defined` }, 404);

    const subs = await db.query<SubscriptionRow>(
      `${SUBSCRIPTION_SELECT}
       where s.subscriber = $1 and s.plan_id = any($2::bigint[]) and p.merchant = $3
       order by s.period_end desc`,
      [customer.toLowerCase(), row.plan_ids, team.merchant],
    );
    const nowSec = now();
    const mapped = subs.map((s) => toSubscription(s, nowSec));
    const active = mapped.find((s) => s.entitled) ?? null;
    return c.json({
      feature,
      customer: customer.toLowerCase(),
      enabled: active !== null,
      subscription: active,
    });
  });

  app.get("/v1/customers/:address/subscriptions", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "Invalid address" }, 400);
    const rows = await db.query<SubscriptionRow>(
      `${SUBSCRIPTION_SELECT} where s.subscriber = $1 and p.merchant = $2 order by s.sub_id desc`,
      [address.toLowerCase(), c.get("team").merchant],
    );
    const nowSec = now();
    return c.json({ data: rows.map((r) => toSubscription(r, nowSec)) });
  });

  app.get("/v1/customers/:address/invoices", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "Invalid address" }, 400);
    const rows = await db.query<{
      id: string;
      sub_id: string;
      token: string;
      amount: string;
      fee: string;
      tx_hash: string;
      paid_at: string;
    }>(
      `select i.id, i.sub_id, i.token, i.amount, i.fee, i.tx_hash, i.paid_at
       from invoices i
       join subscriptions s on s.sub_id = i.sub_id
       join plans p on p.plan_id = s.plan_id
       where i.payer = $1 and p.merchant = $2
       order by i.block_number desc`,
      [address.toLowerCase(), c.get("team").merchant],
    );
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        subscriptionId: r.sub_id,
        token: r.token,
        amount: r.amount,
        fee: r.fee,
        transactionHash: r.tx_hash,
        paidAt: Number(r.paid_at),
      })),
    });
  });

  app.get("/v1/features", async (c) => {
    const rows = await db.query<{ key: string; plan_ids: string[] }>(
      "select key, plan_ids from features where team_id = $1 order by key",
      [c.get("team").id],
    );
    return c.json({ data: rows.map((r) => ({ key: r.key, planIds: r.plan_ids.map(String) })) });
  });

  /** Maps a feature key to the plans that unlock it. Plans must belong to this team's merchant. */
  app.put("/v1/features/:key", async (c) => {
    const team = c.get("team");
    const parsed = featureBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { planIds: string[] }" }, 400);

    const owned = await db.query<{ plan_id: string }>(
      "select plan_id from plans where plan_id = any($1::bigint[]) and merchant = $2",
      [parsed.data.planIds, team.merchant],
    );
    const ownedIds = new Set(owned.map((r) => String(r.plan_id)));
    const foreign = parsed.data.planIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      return c.json({ error: `Plans not found for this team: ${foreign.join(", ")}` }, 422);
    }

    const key = c.req.param("key");
    await db.query(
      `insert into features (team_id, key, plan_ids) values ($1, $2, $3::bigint[])
       on conflict (team_id, key) do update set plan_ids = excluded.plan_ids`,
      [team.id, key, parsed.data.planIds],
    );
    return c.json({ key, planIds: parsed.data.planIds });
  });

  app.get("/v1/webhook-endpoints", async (c) => {
    const rows = await db.query<{ id: string; url: string; events: string[]; active: boolean }>(
      "select id, url, events, active from webhook_endpoints where team_id = $1 order by created_at",
      [c.get("team").id],
    );
    return c.json({ data: rows });
  });

  /** Registers an endpoint. The signing secret is only returned here. */
  app.post("/v1/webhook-endpoints", async (c) => {
    const parsed = endpointBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Body must be { url: string, events: string[] }" }, 400);
    }
    const id = `we_${randomBytes(8).toString("hex")}`;
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    await db.query(
      "insert into webhook_endpoints (id, team_id, url, secret, events) values ($1, $2, $3, $4, $5)",
      [id, c.get("team").id, parsed.data.url, secret, parsed.data.events],
    );
    return c.json({ id, url: parsed.data.url, events: parsed.data.events, secret }, 201);
  });

  return app;
}
