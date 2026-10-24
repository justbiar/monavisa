#!/usr/bin/env node
import { createMcpServer } from "./server.js";
import type { Hex, Address } from "viem";

async function main() {
  const server = createMcpServer({
    chainId: process.env.MONAD_CHAIN_ID ? Number(process.env.MONAD_CHAIN_ID) : 10143,
    rpcUrl: process.env.MONAD_RPC_URL ?? "http://localhost:8545",
    ...(process.env.PRIVATE_KEY ? { privateKey: process.env.PRIVATE_KEY as Hex } : {}),
    ...(process.env.SESSION_VAULT_ADDRESS ? { sessionVaultAddress: process.env.SESSION_VAULT_ADDRESS as Address } : {}),
    ...(process.env.USDC_ADDRESS ? { usdcAddress: process.env.USDC_ADDRESS as Address } : {}),
    ...(process.env.PLATFORM_URL ? { platformUrl: process.env.PLATFORM_URL } : {}),
  });

  await server.startStdio();
}

main().catch((err) => {
  console.error("Fatal MCP error:", err);
  process.exit(1);
});
