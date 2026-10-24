import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WebhookVerificationError,
  signWebhook,
  verifyWebhook,
  webhookEventTypes,
} from "../src/index.js";

const secret = "whsec_test";
const payload = JSON.stringify({
  id: "evt_1",
  type: "subscription.renewed",
  createdAt: 1_760_000_000,
  chainId: 10143,
  data: { subId: "1" },
});

describe("webhooks", () => {
  it("defines the 17 event types from the plan", () => {
    expect(webhookEventTypes).toHaveLength(17);
    expect(new Set(webhookEventTypes).size).toBe(17);
  });

  it("signs with HMAC-SHA256 over '<t>.<payload>'", async () => {
    const header = await signWebhook(payload, secret, 1_760_000_000);
    const expected = createHmac("sha256", secret).update(`1760000000.${payload}`).digest("hex");
    expect(header).toBe(`t=1760000000,v1=${expected}`);
  });

  it("round-trips and returns the parsed event", async () => {
    const header = await signWebhook(payload, secret, 1_760_000_000);
    const event = await verifyWebhook(payload, header, secret, { now: 1_760_000_010 });
    expect(event.type).toBe("subscription.renewed");
    expect(event.data).toEqual({ subId: "1" });
  });

  it("rejects a tampered body, wrong secret, stale or missing signature", async () => {
    const header = await signWebhook(payload, secret, 1_760_000_000);
    const now = 1_760_000_000;
    await expect(verifyWebhook(payload + " ", header, secret, { now })).rejects.toThrow(
      WebhookVerificationError,
    );
    await expect(verifyWebhook(payload, header, "other", { now })).rejects.toThrow(/match/);
    await expect(verifyWebhook(payload, header, secret, { now: now + 301 })).rejects.toThrow(
      /tolerance/,
    );
    await expect(verifyWebhook(payload, undefined, secret)).rejects.toThrow(/Missing/);
    await expect(verifyWebhook(payload, "v1=abc", secret)).rejects.toThrow(/Malformed/);
  });

  it("accepts any matching v1 signature, for secret rotation", async () => {
    const header = await signWebhook(payload, secret, 1_760_000_000);
    const rotated = `t=1760000000,v1=${"0".repeat(64)},${header.split(",")[1]}`;
    await expect(
      verifyWebhook(payload, rotated, secret, { now: 1_760_000_000 }),
    ).resolves.toBeTruthy();
  });
});
