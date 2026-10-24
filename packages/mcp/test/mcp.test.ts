import { describe, it, expect } from "vitest";
import { MONAVISA_TOOLS, handleMcpToolCall, type McpContext } from "../src/tools.js";
import { privateKeyToAccount } from "viem/accounts";

const testAccount = privateKeyToAccount(
  "0x5555555555555555555555555555555555555555555555555555555555555555",
);

describe("Mona Visa MCP Server", () => {
  it("exposes all 12 planned tools", () => {
    expect(MONAVISA_TOOLS.length).toBe(12);
    const names = MONAVISA_TOOLS.map((t) => t.name);
    expect(names).toContain("get_balance");
    expect(names).toContain("open_session");
    expect(names).toContain("top_up_session");
    expect(names).toContain("close_session");
    expect(names).toContain("pay_x402");
    expect(names).toContain("list_spend");
    expect(names).toContain("create_mandate");
    expect(names).toContain("revoke_mandate");
    expect(names).toContain("escrow_reserve");
    expect(names).toContain("escrow_verify_and_settle");
    expect(names).toContain("check_entitlement");
    expect(names).toContain("create_payment_link");
  });

  it("creates a signed mandate via create_mandate tool", async () => {
    const ctx: McpContext = {
      chainId: 10143,
      rpcUrl: "http://localhost:8545",
      privateKey: "0x5555555555555555555555555555555555555555555555555555555555555555",
    };

    const res = await handleMcpToolCall(
      "create_mandate",
      {
        agent: "0x1111111111111111111111111111111111111111",
        maxTotal: "100000000",
        maxPerCall: "10000000",
        validUntilSeconds: 3600,
      },
      ctx,
    );

    if (res.isError) {
      console.error("DEBUG ERROR:", res.content[0]?.text);
    }
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0]!.text);
    expect(data.mandate).toBeDefined();
    expect(data.mandate.agent.toLowerCase()).toBe("0x1111111111111111111111111111111111111111");
    expect(data.signature).toMatch(/^0x/);
    expect(data.mandateHash).toMatch(/^0x/);
  });

  it("returns error for unknown tool", async () => {
    const ctx: McpContext = {
      chainId: 10143,
      rpcUrl: "http://localhost:8545",
    };
    const res = await handleMcpToolCall("non_existent_tool", {}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Unknown tool");
  });
});
