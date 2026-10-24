import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { x402Middleware } from "@monavisa/node";

const app = new Hono();

const MERCHANT_PAYTO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

// Unprotected health endpoint
app.get("/health", (c) => c.json({ status: "ok" }));

// Protected AI inference endpoint costing 0.10 USDC (100,000 base units)
app.use(
  "/compute",
  x402Middleware({
    payTo: MERCHANT_PAYTO,
    amount: "100000",
    description: "LLM Token Inference Compute",
  }),
);

app.post("/compute", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    status: "success",
    message: "Compute completed successfully",
    input: body,
    tokensGenerated: 42,
  });
});

const port = Number(process.env.PORT ?? 4020);
console.log(`x402 Protected API listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
