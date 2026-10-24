import { createAgentFetch } from "@monavisa/agent";
import { privateKeyToAccount } from "viem/accounts";

async function main() {
  const privateKey =
    (process.env.AGENT_PRIVATE_KEY as `0x${string}`) ||
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const account = privateKeyToAccount(privateKey);

  console.log(`Agent initialized with address: ${account.address}`);

  // Wrap standard fetch with Mona Visa x402 auto-payment capabilities
  const agentFetch = createAgentFetch({
    account,
    maxPerCall: 1_000_000n, // Max 1 USDC per call limit
  });

  const targetUrl = process.env.API_URL ?? "http://localhost:4020/compute";
  console.log(`Calling x402 resource at ${targetUrl}...`);

  const response = await agentFetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Hello, autonomous AI world on Monad!" }),
  });

  console.log(`Response status: ${response.status}`);
  const result = await response.json();
  console.log("Response payload:", result);
}

main().catch((err) => {
  console.error("Agent error:", err);
  process.exit(1);
});
