import { describe, expect, it } from "vitest";
import { MonCartClient, MonCartError } from "../src/index.js";

const customer = { address: "0x00000000000000000000000000000000000a11ce" } as const;

function fakeFetch(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return async (input, init) => {
    seen.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status });
  };
}

describe("MonCartClient", () => {
  it("checks an entitlement with the API key and customer address", async () => {
    const seen: Request[] = [];
    const client = new MonCartClient({
      apiKey: "mc_sk_test",
      baseUrl: "https://api.example.com/",
      fetch: fakeFetch(200, { feature: "analytics_export", enabled: true }, seen),
    });

    const result = await client.checkEntitlement("analytics_export", customer);
    expect(result.enabled).toBe(true);

    const req = seen[0]!;
    expect(req.url).toBe(
      `https://api.example.com/v1/entitlements/analytics_export?customer=${customer.address}`,
    );
    expect(req.headers.get("authorization")).toBe("Bearer mc_sk_test");
  });

  it("sends JSON bodies for writes", async () => {
    const seen: Request[] = [];
    const client = new MonCartClient({
      apiKey: "k",
      fetch: fakeFetch(200, { key: "pro", planIds: ["1"] }, seen),
    });
    await client.setFeature("pro", [1n]);
    expect(seen[0]!.method).toBe("PUT");
    expect(await seen[0]!.json()).toEqual({ planIds: ["1"] });
  });

  it("raises MonCartError with the API's message", async () => {
    const client = new MonCartClient({
      apiKey: "k",
      fetch: fakeFetch(404, { error: "Feature 'x' is not defined" }),
    });
    await expect(client.checkEntitlement("x", customer)).rejects.toMatchObject({
      name: "MonCartError",
      status: 404,
      message: "Feature 'x' is not defined",
    });
    await expect(client.checkEntitlement("x", customer)).rejects.toBeInstanceOf(MonCartError);
  });

  it("requires an API key", () => {
    expect(() => new MonCartClient({ apiKey: "" })).toThrow(/apiKey/);
  });
});
