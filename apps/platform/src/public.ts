import { Hono } from "hono";
import type { Db } from "./db.js";

interface PublicPlanRow {
  plan_id: string;
  merchant: string;
  active: boolean;
  name: string | null;
  description: string | null;
  merchant_name: string | null;
}

const PUBLIC_PLAN_SELECT = `
  select p.plan_id, p.merchant, p.active, m.name, m.description, t.name as merchant_name
  from plans p
  left join plan_metadata m on m.plan_id = p.plan_id
  left join teams t on t.merchant = p.merchant`;

const toPublicPlan = (r: PublicPlanRow) => ({
  id: String(r.plan_id),
  merchant: r.merchant,
  merchantName: r.merchant_name,
  name: r.name,
  description: r.description,
  active: r.active,
});

/**
 * Unauthenticated display data for the hosted checkout: plan and merchant names, and what a
 * payment link points at. Amounts are not served here; the checkout reads them from the chain.
 */
export function publicRoutes(db: Db) {
  const app = new Hono();

  app.get("/plans/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) return c.json({ error: "Invalid plan id" }, 400);
    const [row] = await db.query<PublicPlanRow>(`${PUBLIC_PLAN_SELECT} where p.plan_id = $1`, [id]);
    return row ? c.json(toPublicPlan(row)) : c.json({ error: "Plan not found" }, 404);
  });

  app.get("/payment-links/:id", async (c) => {
    const [link] = await db.query<{ plan_id: string; label: string | null }>(
      "select plan_id, label from payment_links where id = $1 and active",
      [c.req.param("id")],
    );
    if (!link) return c.json({ error: "Payment link not found or no longer active" }, 404);
    const [row] = await db.query<PublicPlanRow>(`${PUBLIC_PLAN_SELECT} where p.plan_id = $1`, [
      link.plan_id,
    ]);
    return c.json({
      id: c.req.param("id"),
      label: link.label,
      plan: row ? toPublicPlan(row) : { id: String(link.plan_id) },
    });
  });

  return app;
}
