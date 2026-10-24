import { randomBytes } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv, PlanMerchantReader } from "./context.js";
import { type Db, NOW_SQL } from "./db.js";
import { lastIndexedBlock } from "./indexer.js";
import { SUBSCRIPTION_SELECT, type SubscriptionRow, toSubscription } from "./subscriptions.js";
import { createApiKey, listApiKeys, renameTeam, revokeApiKey } from "./teams.js";

export interface DashboardOptions {
  now: () => number;
  readPlanMerchant?: PlanMerchantReader;
  /** e.g. https://pay.monavisa.xyz, used to build payment link URLs. */
  checkoutBaseUrl?: string;
}

const MONTH_SEC = 30n * 24n * 60n * 60n;
const DAY_SEC = 24 * 60 * 60;

const teamBody = z.object({ name: z.string().trim().min(1).max(60) });
const metadataBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
});
const linkBody = z.object({
  planId: z.string().regex(/^\d+$/),
  label: z.string().trim().max(60).optional(),
});
const keyBody = z.object({ label: z.string().trim().min(1).max(40) });

type Totals = Record<string, bigint>;
const add = (totals: Totals, token: string, amount: bigint) => {
  totals[token] = (totals[token] ?? 0n) + amount;
};
const asList = (totals: Totals) =>
  Object.entries(totals).map(([token, amount]) => ({ token, amount: amount.toString() }));

/** Routes behind session or API key auth that power the merchant dashboard. */
export function dashboardRoutes(db: Db, options: DashboardOptions) {
  const app = new Hono<AppEnv>();
  const { now } = options;

  /** Whether `planId` belongs to the team: from the index, or from the chain if not indexed yet. */
  const ownsPlan = async (merchant: string, planId: string): Promise<boolean> => {
    const [row] = await db.query<{ merchant: string }>(
      "select merchant from plans where plan_id = $1",
      [planId],
    );
    if (row) return row.merchant === merchant;
    const onChain = await options.readPlanMerchant?.(BigInt(planId)).catch(() => null);
    return onChain?.toLowerCase() === merchant;
  };

  app.get("/me", (c) => c.json({ team: c.get("team"), auth: c.get("authKind") }));

  app.patch("/me", async (c) => {
    const parsed = teamBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Name must be 1 to 60 characters" }, 400);
    await renameTeam(db, c.get("team").id, parsed.data.name);
    return c.json({ team: { ...c.get("team"), name: parsed.data.name } });
  });

  app.get("/overview", async (c) => {
    const merchant = c.get("team").merchant;
    const nowSec = now();
    const subs = await db.query<{
      status: number;
      in_trial: number;
      period_end: string;
      price: string;
      period: number;
      token: string;
    }>(
      `select s.status, s.in_trial, s.period_end, p.price, p.period, p.token
       from subscriptions s join plans p on p.plan_id = s.plan_id where p.merchant = $1`,
      [merchant],
    );

    const counts = { active: 0, trialing: 0, pastDue: 0, canceling: 0 };
    const mrr: Totals = {};
    for (const s of subs) {
      if (s.status === 1 && s.in_trial) counts.trialing++;
      else if (s.status === 1) {
        counts.active++;
        add(mrr, s.token, (BigInt(s.price) * MONTH_SEC) / BigInt(s.period));
      } else if (s.status === 2) counts.pastDue++;
      else if (s.status === 3 && Number(s.period_end) > nowSec) counts.canceling++;
    }

    const invoices = await db.query<{
      token: string;
      amount: string;
      fee: string;
      paid_at: string;
    }>(
      `select i.token, i.amount, i.fee, i.paid_at from invoices i
       join subscriptions s on s.sub_id = i.sub_id join plans p on p.plan_id = s.plan_id
       where p.merchant = $1`,
      [merchant],
    );
    const revenue: Totals = {};
    const revenue30d: Totals = {};
    for (const i of invoices) {
      add(revenue, i.token, BigInt(i.amount));
      if (Number(i.paid_at) >= nowSec - 30 * DAY_SEC) add(revenue30d, i.token, BigInt(i.amount));
    }

    const block = await lastIndexedBlock(db);
    return c.json({
      subscribers: counts,
      mrr: asList(mrr),
      revenue: asList(revenue),
      revenue30d: asList(revenue30d),
      payments: invoices.length,
      lastIndexedBlock: block?.toString() ?? null,
    });
  });

  app.get("/plans", async (c) => {
    const rows = await db.query<{
      plan_id: string;
      token: string;
      price: string;
      period: number;
      trial_period: number;
      grace_period: number;
      treasury: string;
      active: number;
      name: string | null;
      description: string | null;
      active_count: string;
      trialing_count: string;
      past_due_count: string;
    }>(
      `select p.plan_id, p.token, p.price, p.period, p.trial_period, p.grace_period, p.treasury,
              p.active, m.name, m.description,
              count(s.sub_id) filter (where s.status = 1 and not s.in_trial) as active_count,
              count(s.sub_id) filter (where s.status = 1 and s.in_trial) as trialing_count,
              count(s.sub_id) filter (where s.status = 2) as past_due_count
       from plans p
       left join plan_metadata m on m.plan_id = p.plan_id
       left join subscriptions s on s.plan_id = p.plan_id
       where p.merchant = $1
       group by p.plan_id, m.name, m.description
       order by p.plan_id`,
      [c.get("team").merchant],
    );
    return c.json({
      data: rows.map((r) => ({
        id: String(r.plan_id),
        name: r.name,
        description: r.description,
        token: r.token,
        price: String(r.price),
        period: r.period,
        trialPeriod: r.trial_period,
        gracePeriod: r.grace_period,
        treasury: r.treasury,
        active: Boolean(r.active),
        subscribers: {
          active: Number(r.active_count),
          trialing: Number(r.trialing_count),
          pastDue: Number(r.past_due_count),
        },
      })),
    });
  });

  app.put("/plans/:id/metadata", async (c) => {
    const planId = c.req.param("id");
    if (!/^\d+$/.test(planId)) return c.json({ error: "Invalid plan id" }, 400);
    const parsed = metadataBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Name must be 1 to 60 characters" }, 400);
    if (!(await ownsPlan(c.get("team").merchant, planId))) {
      return c.json({ error: `Plan ${planId} does not belong to this team` }, 404);
    }
    await db.query(
      `insert into plan_metadata (plan_id, name, description) values ($1, $2, $3)
       on conflict (plan_id) do update set name = excluded.name, description = excluded.description,
         updated_at = ${NOW_SQL}`,
      [planId, parsed.data.name, parsed.data.description ?? null],
    );
    return c.json({
      id: planId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    });
  });

  app.get("/subscriptions", async (c) => {
    const planId = c.req.query("planId");
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    const params: unknown[] = [c.get("team").merchant];
    let where = "p.merchant = $1";
    if (planId && /^\d+$/.test(planId)) {
      params.push(planId);
      where += ` and s.plan_id = $${params.length}`;
    }
    params.push(limit);
    const rows = await db.query<SubscriptionRow & { name: string | null }>(
      `${SUBSCRIPTION_SELECT} left join plan_metadata m on m.plan_id = s.plan_id
       where ${where} order by s.sub_id desc limit $${params.length}`,
      params,
    );
    const nowSec = now();
    return c.json({
      data: rows.map((r) => ({ ...toSubscription(r, nowSec), planName: r.name })),
    });
  });

  app.get("/invoices", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 500);
    const rows = await db.query<{
      id: string;
      sub_id: string;
      payer: string;
      token: string;
      amount: string;
      fee: string;
      tx_hash: string;
      paid_at: string;
      plan_id: string;
      name: string | null;
    }>(
      `select i.id, i.sub_id, i.payer, i.token, i.amount, i.fee, i.tx_hash, i.paid_at, s.plan_id, m.name
       from invoices i
       join subscriptions s on s.sub_id = i.sub_id
       join plans p on p.plan_id = s.plan_id
       left join plan_metadata m on m.plan_id = s.plan_id
       where p.merchant = $1
       order by i.block_number desc, i.id desc
       limit $2`,
      [c.get("team").merchant, limit],
    );
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        subscriptionId: String(r.sub_id),
        customer: r.payer,
        planId: String(r.plan_id),
        planName: r.name,
        token: r.token,
        amount: String(r.amount),
        fee: String(r.fee),
        transactionHash: r.tx_hash,
        paidAt: Number(r.paid_at),
      })),
    });
  });

  app.get("/revenue", async (c) => {
    const merchant = c.get("team").merchant;
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 7), 365);
    const nowSec = now();
    const startSec = nowSec - days * DAY_SEC;

    const rows = await db.query<{ day: string; token: string; amount: string; fee: string }>(
      `select strftime('%Y-%m-%d', i.paid_at, 'unixepoch') as day, i.token, i.amount, i.fee
       from invoices i
       join subscriptions s on s.sub_id = i.sub_id
       join plans p on p.plan_id = s.plan_id
       where p.merchant = $1 and i.paid_at >= $2
       order by day asc`,
      [merchant, startSec],
    );

    // Summed here with BigInt: amounts are decimal text, beyond what SQLite integers can hold.
    const buckets = new Map<string, { date: string; token: string; amount: bigint; fee: bigint; count: number }>();
    for (const r of rows) {
      const key = `${r.day}|${r.token}`;
      const bucket = buckets.get(key) ?? { date: r.day, token: r.token, amount: 0n, fee: 0n, count: 0 };
      bucket.amount += BigInt(r.amount);
      bucket.fee += BigInt(r.fee);
      bucket.count++;
      buckets.set(key, bucket);
    }

    return c.json({
      days,
      data: [...buckets.values()].map((b) => ({
        date: b.date,
        token: b.token,
        amount: b.amount.toString(),
        fee: b.fee.toString(),
        count: b.count,
      })),
    });
  });

  app.get("/invoices/:id/pdf", async (c) => {
    const id = c.req.param("id");
    const [inv] = await db.query<{
      id: string;
      sub_id: string;
      payer: string;
      token: string;
      amount: string;
      fee: string;
      tx_hash: string;
      paid_at: string;
      plan_id: string;
      name: string | null;
    }>(
      `select i.id, i.sub_id, i.payer, i.token, i.amount, i.fee, i.tx_hash, i.paid_at, s.plan_id, m.name
       from invoices i
       join subscriptions s on s.sub_id = i.sub_id
       join plans p on p.plan_id = s.plan_id
       left join plan_metadata m on m.plan_id = s.plan_id
       where i.id = $1 and p.merchant = $2`,
      [id, c.get("team").merchant],
    );

    if (!inv) return c.json({ error: "Invoice not found" }, 404);

    const pdfData = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 300 >> stream
BT
/F1 20 Tf
50 720 Td
(MONA VISA INVOICE #${inv.id}) Tj
/F1 12 Tf
0 -40 Td
(Date: ${new Date(Number(inv.paid_at) * 1000).toISOString()}) Tj
0 -25 Td
(Customer: ${inv.payer}) Tj
0 -25 Td
(Subscription ID: #${inv.sub_id}) Tj
0 -25 Td
(Plan: ${inv.name ?? "Plan #" + inv.plan_id}) Tj
0 -25 Td
(Amount Paid: ${inv.amount} USDC) Tj
0 -25 Td
(Transaction Hash: ${inv.tx_hash}) Tj
ET
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000596 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
665
%%EOF`;

    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `attachment; filename="invoice-${id}.pdf"`);
    return c.body(pdfData);
  });

  const linkUrl = (id: string) =>
    options.checkoutBaseUrl ? `${options.checkoutBaseUrl.replace(/\/$/, "")}/l/${id}` : null;

  app.get("/payment-links", async (c) => {
    const rows = await db.query<{
      id: string;
      plan_id: string;
      label: string | null;
      created_at: Date | string;
      name: string | null;
    }>(
      `select l.id, l.plan_id, l.label, l.created_at, m.name from payment_links l
       left join plan_metadata m on m.plan_id = l.plan_id
       where l.team_id = $1 and l.active order by l.created_at desc, l.rowid desc`,
      [c.get("team").id],
    );
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        planId: String(r.plan_id),
        planName: r.name,
        label: r.label,
        url: linkUrl(r.id),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  });

  app.post("/payment-links", async (c) => {
    const parsed = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Body must be { planId: string, label?: string }" }, 400);
    const team = c.get("team");
    if (!(await ownsPlan(team.merchant, parsed.data.planId))) {
      return c.json({ error: `Plan ${parsed.data.planId} does not belong to this team` }, 404);
    }
    const id = randomBytes(6).toString("base64url");
    await db.query(
      "insert into payment_links (id, team_id, plan_id, label) values ($1, $2, $3, $4)",
      [id, team.id, parsed.data.planId, parsed.data.label || null],
    );
    return c.json(
      { id, planId: parsed.data.planId, label: parsed.data.label || null, url: linkUrl(id) },
      201,
    );
  });

  app.delete("/payment-links/:id", async (c) => {
    const rows = await db.query(
      "update payment_links set active = false where id = $1 and team_id = $2 and active returning id",
      [c.req.param("id"), c.get("team").id],
    );
    return rows.length ? c.body(null, 204) : c.json({ error: "Payment link not found" }, 404);
  });

  // API keys can only be managed from a signed-in session, never with another API key.
  const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("authKind") !== "session") {
      return c.json({ error: "Sign in to the dashboard to manage API keys" }, 403);
    }
    await next();
  };

  app.get("/api-keys", sessionOnly, async (c) =>
    c.json({ data: await listApiKeys(db, c.get("team").id) }),
  );

  /** The full key is only returned here. */
  app.post("/api-keys", sessionOnly, async (c) => {
    const parsed = keyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Label must be 1 to 40 characters" }, 400);
    const key = await createApiKey(db, c.get("team").id, parsed.data.label);
    return c.json(
      { id: key.id, label: parsed.data.label, prefix: key.prefix, apiKey: key.apiKey },
      201,
    );
  });

  app.delete("/api-keys/:id", sessionOnly, async (c) =>
    (await revokeApiKey(db, c.get("team").id, c.req.param("id")))
      ? c.body(null, 204)
      : c.json({ error: "API key not found" }, 404),
  );

  app.delete("/webhook-endpoints/:id", async (c) => {
    const rows = await db.query(
      "update webhook_endpoints set active = false where id = $1 and team_id = $2 and active returning id",
      [c.req.param("id"), c.get("team").id],
    );
    return rows.length ? c.body(null, 204) : c.json({ error: "Webhook endpoint not found" }, 404);
  });

  return app;
}
