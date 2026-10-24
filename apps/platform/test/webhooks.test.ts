import { verifyWebhook } from "@monavisa/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { createTeam } from "../src/teams.js";
import { MAX_ATTEMPTS, deliverDue, fanOutEvents, retryDelaySec } from "../src/webhooks.js";
import { memoryDb } from "./helpers.js";

const merchant = "0x00000000000000000000000000000000000000aa";
const NOW = 1_760_000_000;

describe("webhook dispatch", () => {
  let db: Db;
  let teamId: string;

  beforeEach(async () => {
    db = await memoryDb();
    teamId = (await createTeam(db, { name: "Kazim Berber", merchant })).team.id;
    await db.query(
      "insert into webhook_endpoints (id, team_id, url, secret, events) values ($1, $2, $3, $4, $5)",
      ["we_all", teamId, "https://hooks.example/all", "whsec_all", ["*"]],
    );
    await db.query(
      "insert into webhook_endpoints (id, team_id, url, secret, events) values ($1, $2, $3, $4, $5)",
      ["we_inv", teamId, "https://hooks.example/inv", "whsec_inv", ["invoice.paid"]],
    );
    const event = {
      id: "evt_1",
      type: "subscription.renewed",
      createdAt: NOW,
      chainId: 10143,
      data: { subId: "1" },
    };
    await db.query(
      "insert into events (id, type, merchant, payload, created_at) values ($1, $2, $3, $4, $5)",
      [event.id, event.type, merchant, JSON.stringify(event), NOW],
    );
  });

  afterEach(() => db.close());

  it("fans out only to endpoints subscribed to the event type, once", async () => {
    expect(await fanOutEvents(db, NOW)).toBe(1);
    expect(await fanOutEvents(db, NOW)).toBe(0);
    const rows = await db.query<{ endpoint_id: string }>(
      "select endpoint_id from webhook_deliveries",
    );
    expect(rows.map((r) => r.endpoint_id)).toEqual(["we_all"]);
  });

  it("delivers a signed body the receiver can verify", async () => {
    await fanOutEvents(db, NOW);
    const received: { body: string; signature: string | null }[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      received.push({ body: String(init?.body), signature: headers.get("monavisa-signature") });
      return new Response(null, { status: 204 });
    };

    expect(await deliverDue(db, NOW, fakeFetch)).toEqual({ delivered: 1, failed: 0 });
    const [msg] = received;
    const event = await verifyWebhook(msg!.body, msg!.signature, "whsec_all", { now: NOW });
    expect(event.type).toBe("subscription.renewed");
  });

  it("retries with backoff and gives up after the last attempt", async () => {
    await fanOutEvents(db, NOW);
    const failing: typeof fetch = async () => new Response("nope", { status: 500 });

    let now = NOW;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await deliverDue(db, now, failing)).toEqual({ delivered: 0, failed: 1 });
      expect(await deliverDue(db, now, failing)).toEqual({ delivered: 0, failed: 0 });
      now += retryDelaySec(attempt);
    }
    const [row] = await db.query<{ status: string; attempts: number; last_error: string }>(
      "select status, attempts, last_error from webhook_deliveries",
    );
    expect(row).toEqual({ status: "failed", attempts: MAX_ATTEMPTS, last_error: "HTTP 500" });
  });

  it("backs off exponentially with a ceiling", () => {
    expect(retryDelaySec(1)).toBe(30);
    expect(retryDelaySec(2)).toBe(60);
    expect(retryDelaySec(20)).toBe(6 * 60 * 60);
  });
});
