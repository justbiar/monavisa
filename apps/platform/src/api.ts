import { randomBytes } from "node:crypto";
import { webhookEventTypes } from "@monavisa/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Account, type Address, type Chain, type Hex, isAddress, isHex, type PublicClient, type Transport, type WalletClient } from "viem";
import { z } from "zod";
import {
  SESSION_PREFIX,
  type SiweVerifier,
  issueNonce,
  login,
  logout,
  teamForSession,
} from "./auth.js";
import type { AppEnv, PlanMerchantReader } from "./context.js";
import { dashboardRoutes } from "./dashboard.js";
import { type Db, jsonList } from "./db.js";
import { createFacilitatorRouter } from "./facilitator.js";
import { lastIndexedBlock } from "./indexer.js";
import { publicRoutes } from "./public.js";
import { SUBSCRIPTION_SELECT, type SubscriptionRow, toSubscription } from "./subscriptions.js";
import { teamForApiKey } from "./teams.js";

export interface ApiOptions {
  chainId: number;
  /** Current time in unix seconds; injectable for tests. */
  now?: () => number;
  /** Verifies dashboard sign-in signatures. Without it, /auth/login is disabled. */
  verifySiwe?: SiweVerifier;
  /** Hosts allowed in sign-in messages, e.g. ["localhost:5174"]. */
  siweDomains?: readonly string[];
  /** Browser origins allowed to call the API (dashboard, checkout). */
  corsOrigins?: readonly string[];
  readPlanMerchant?: PlanMerchantReader;
  checkoutBaseUrl?: string;
  sessionVault?: Address;
  publicClient?: PublicClient;
  facilitatorWallet?: WalletClient<Transport, Chain, Account>;
}

const featureBody = z.object({ planIds: z.array(z.string().regex(/^\d+$/)).min(1) });
const endpointBody = z.object({
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(z.enum([...webhookEventTypes, "*"])).min(1),
});
const loginBody = z.object({
  message: z.string().min(1).max(4000),
  signature: z.string().refine((s) => isHex(s), "must be hex"),
});

const bearer = (header: string | undefined) =>
  header?.startsWith("Bearer ") ? header.slice(7) : null;

export function createApi(db: Db, options: ApiOptions) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<AppEnv>();

  if (options.corsOrigins?.length) {
    app.use(
      "*",
      cors({
        origin: [...options.corsOrigins],
        allowHeaders: ["authorization", "content-type"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        maxAge: 600,
      }),
    );
  }

  app.get("/health", async (c) => {
    const block = await lastIndexedBlock(db);
    return c.json({
      ok: true,
      chainId: options.chainId,
      lastIndexedBlock: block?.toString() ?? null,
    });
  });

  app.route("/public", publicRoutes(db));

  if (options.sessionVault && options.publicClient) {
    app.route(
      "/x402",
      createFacilitatorRouter(db, {
        chainId: options.chainId,
        sessionVault: options.sessionVault,
        publicClient: options.publicClient,
        ...(options.facilitatorWallet ? { walletClient: options.facilitatorWallet } : {}),
        now,
      }),
    );
  }

  // ---------------------------------------------------------------- dashboard sign-in (SIWE)

  app.post("/auth/nonce", async (c) => c.json({ nonce: await issueNonce(db, now()) }));

  app.post("/auth/login", async (c) => {
    if (!options.verifySiwe || !options.siweDomains?.length) {
      return c.json({ error: "Dashboard sign-in is not configured" }, 503);
    }
    const parsed = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { message, signature }" }, 400);
    const result = await login(
      db,
      { message: parsed.data.message, signature: parsed.data.signature as Hex },
      {
        verify: options.verifySiwe,
        domains: options.siweDomains,
        chainId: options.chainId,
        now: now(),
      },
    );
    if (!result.ok) return c.json({ error: result.error }, 401);
    return c.json({ token: result.token, team: result.team, expiresAt: result.expiresAt });
  });

  app.post("/auth/logout", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (token?.startsWith(SESSION_PREFIX)) await logout(db, token);
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- authenticated API

  /** A dashboard session token (mv_sess_...) or a secret API key (mv_sk_...). */
  app.use("/v1/*", async (c, next) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "Invalid or missing API key" }, 401);
    const isSession = token.startsWith(SESSION_PREFIX);
    const team = isSession
      ? await teamForSession(db, token, now())
      : await teamForApiKey(db, token);
    if (!team) {
      return c.json(
        { error: isSession ? "Session expired. Sign in again." : "Invalid or missing API key" },
        401,
      );
    }
    c.set("team", team);
    c.set("authKind", isSession ? "session" : "key");
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

    const [row] = await db.query<{ plan_ids: string }>(
      "select plan_ids from features where team_id = $1 and key = $2",
      [team.id, feature],
    );
    if (!row) return c.json({ error: `Feature '${feature}' is not defined` }, 404);

    const subs = await db.query<SubscriptionRow>(
      `${SUBSCRIPTION_SELECT}
       where s.subscriber = $1 and s.plan_id in (select cast(value as integer) from json_each($2))
         and p.merchant = $3
       order by s.period_end desc`,
      [customer.toLowerCase(), jsonList(row.plan_ids), team.merchant],
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
        subscriptionId: String(r.sub_id),
        token: r.token,
        amount: String(r.amount),
        fee: String(r.fee),
        transactionHash: r.tx_hash,
        paidAt: Number(r.paid_at),
      })),
    });
  });

  app.get("/v1/features", async (c) => {
    const rows = await db.query<{ key: string; plan_ids: string }>(
      "select key, plan_ids from features where team_id = $1 order by key",
      [c.get("team").id],
    );
    return c.json({
      data: rows.map((r) => ({ key: r.key, planIds: jsonList(r.plan_ids).map(String) })),
    });
  });

  /** Maps a feature key to the plans that unlock it. Plans must belong to this team's merchant. */
  app.put("/v1/features/:key", async (c) => {
    const team = c.get("team");
    const parsed = featureBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { planIds: string[] }" }, 400);

    const owned = await db.query<{ plan_id: string }>(
      `select plan_id from plans
       where plan_id in (select cast(value as integer) from json_each($1)) and merchant = $2`,
      [parsed.data.planIds, team.merchant],
    );
    const ownedIds = new Set(owned.map((r) => String(r.plan_id)));
    const foreign = parsed.data.planIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      return c.json({ error: `Plans not found for this team: ${foreign.join(", ")}` }, 422);
    }

    const key = c.req.param("key");
    await db.query(
      `insert into features (team_id, key, plan_ids) values ($1, $2, $3)
       on conflict (team_id, key) do update set plan_ids = excluded.plan_ids`,
      [team.id, key, parsed.data.planIds],
    );
    return c.json({ key, planIds: parsed.data.planIds });
  });

  app.get("/v1/webhook-endpoints", async (c) => {
    const rows = await db.query<{ id: string; url: string; events: string; active: number }>(
      "select id, url, events, active from webhook_endpoints where team_id = $1 and active order by created_at, rowid",
      [c.get("team").id],
    );
    return c.json({
      data: rows.map((r) => ({ ...r, events: jsonList(r.events), active: Boolean(r.active) })),
    });
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

  app.route(
    "/v1",
    dashboardRoutes(db, {
      now,
      ...(options.readPlanMerchant ? { readPlanMerchant: options.readPlanMerchant } : {}),
      ...(options.checkoutBaseUrl ? { checkoutBaseUrl: options.checkoutBaseUrl } : {}),
    }),
  );

  return app;
}
