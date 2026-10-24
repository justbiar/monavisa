import { WEBHOOK_ID_HEADER, WEBHOOK_SIGNATURE_HEADER, signWebhook } from "@monavisa/core";
import type { Db } from "./db.js";

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_SEC = 30;
const MAX_DELAY_SEC = 6 * 60 * 60;
const TIMEOUT_MS = 10_000;

/** Creates one pending delivery per matching endpoint for every new event. */
export async function fanOutEvents(db: Db, nowSec: number): Promise<number> {
  const events = await db.query<{ id: string; type: string; merchant: string }>(
    "select id, type, merchant from events where fanned_out = 0 order by created_at limit 200",
  );
  // Both writes are idempotent, so a crash between them only repeats the fan-out.
  for (const event of events) {
    await db.batch([
      {
        sql: `insert into webhook_deliveries (endpoint_id, event_id, next_attempt_at)
              select e.id, $1, $2
              from webhook_endpoints e join teams t on t.id = e.team_id
              where e.active and t.merchant = $3
                and exists (select 1 from json_each(e.events) where value in ($4, '*'))
              on conflict (endpoint_id, event_id) do nothing`,
        params: [event.id, nowSec, event.merchant, event.type],
      },
      { sql: "update events set fanned_out = 1 where id = $1", params: [event.id] },
    ]);
  }
  return events.length;
}

export function retryDelaySec(attempts: number): number {
  return Math.min(BASE_DELAY_SEC * 2 ** (attempts - 1), MAX_DELAY_SEC);
}

/** Posts due deliveries. Non-2xx responses and network errors are retried with backoff. */
export async function deliverDue(
  db: Db,
  nowSec: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ delivered: number; failed: number }> {
  const due = await db.query<{
    id: string;
    attempts: number;
    url: string;
    secret: string;
    event_id: string;
    payload: unknown;
  }>(
    `select d.id, d.attempts, e.url, e.secret, d.event_id, ev.payload
     from webhook_deliveries d
     join webhook_endpoints e on e.id = d.endpoint_id
     join events ev on ev.id = d.event_id
     where d.status = 'pending' and d.next_attempt_at <= $1
     order by d.next_attempt_at
     limit 50`,
    [nowSec],
  );

  let delivered = 0;
  let failed = 0;
  for (const d of due) {
    const body = typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload);
    let error: string | null = null;
    try {
      const res = await fetchImpl(d.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(body, d.secret, nowSec),
          [WEBHOOK_ID_HEADER]: d.event_id,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (error === null) {
      await db.query(
        "update webhook_deliveries set status = 'delivered', attempts = attempts + 1, last_error = null where id = $1",
        [d.id],
      );
      delivered++;
      continue;
    }

    const attempts = d.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await db.query(
      `update webhook_deliveries
       set attempts = $2, last_error = $3, status = $4, next_attempt_at = $5
       where id = $1`,
      [d.id, attempts, error, giveUp ? "failed" : "pending", nowSec + retryDelaySec(attempts)],
    );
    failed++;
  }
  return { delivered, failed };
}
