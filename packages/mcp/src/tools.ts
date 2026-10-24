import {
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  type Hex,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  sessionVaultAbi,
  mandateHash as computeMandateHash,
  computeCommitment,
  getChain,
} from "@monavisa/core";
import {
  createRootMandate,
  createChildMandate,
  createAgentFetch,
  SessionClient,
  EscrowClient,
} from "@monavisa/agent";

export interface McpContext {
  chainId: number;
  rpcUrl: string;
  privateKey?: Hex | undefined;
  sessionVaultAddress?: Address | undefined;
  usdcAddress?: Address | undefined;
  platformUrl?: string | undefined;
}

export const MONAVISA_TOOLS = [
  {
    name: "get_balance",
    description: "Read native MON and USDC balance for an address on Monad",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Ethereum address (0x...)" },
      },
      required: ["address"],
    },
  },
  {
    name: "open_session",
    description: "Open a prepaid payment session in SessionVault on Monad",
    inputSchema: {
      type: "object",
      properties: {
        depositAmount: { type: "string", description: "Deposit amount in USDC (e.g. '10.5' or base units)" },
        durationSeconds: { type: "number", description: "Session duration in seconds (default 86400)" },
        token: { type: "string", description: "Optional USDC token address override" },
      },
      required: ["depositAmount"],
    },
  },
  {
    name: "top_up_session",
    description: "Top up an existing payment session with additional USDC",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "32-byte hex sessionId" },
        amount: { type: "string", description: "USDC amount to add" },
      },
      required: ["sessionId", "amount"],
    },
  },
  {
    name: "close_session",
    description: "Request closure of a payment session to start cooldown and withdraw funds",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "32-byte hex sessionId" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "pay_x402",
    description: "Call an HTTP resource requiring x402 payment and automatically settle",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the x402 resource" },
        method: { type: "string", description: "HTTP method (GET, POST, etc.)", default: "GET" },
        body: { type: "string", description: "Optional JSON or string payload" },
        sessionId: { type: "string", description: "Optional active sessionId for session scheme" },
      },
      required: ["url"],
    },
  },
  {
    name: "list_spend",
    description: "Query spend ledger or session details from Mona Visa platform",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional session ID to query" },
        limit: { type: "number", description: "Max results", default: 20 },
      },
    },
  },
  {
    name: "create_mandate",
    description: "Generate a signed MonAuth mandate or child mandate for delegated spend",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Authorized agent address" },
        maxTotal: { type: "string", description: "Max total spend in USDC base units" },
        maxPerCall: { type: "string", description: "Max per-call spend in USDC base units" },
        validUntilSeconds: { type: "number", description: "Validity duration from now in seconds" },
        allowedPayees: { type: "array", items: { type: "string" }, description: "Optional allowed payee addresses" },
        parentMandate: { type: "object", description: "Optional parent mandate if deriving child mandate" },
      },
      required: ["agent", "maxTotal", "maxPerCall", "validUntilSeconds"],
    },
  },
  {
    name: "revoke_mandate",
    description: "Revoke a MonAuth mandate on-chain via SessionVault",
    inputSchema: {
      type: "object",
      properties: {
        mandateHash: { type: "string", description: "32-byte hash of the mandate to revoke" },
      },
      required: ["mandateHash"],
    },
  },
  {
    name: "escrow_reserve",
    description: "Reserve funds into a Verify-Then-Settle escrow in SessionVault",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "32-byte hex sessionId" },
        provider: { type: "string", description: "Provider address" },
        amount: { type: "string", description: "USDC amount (base units)" },
        deadlineSeconds: { type: "number", description: "Deadline in seconds from now" },
      },
      required: ["sessionId", "provider", "amount", "deadlineSeconds"],
    },
  },
  {
    name: "escrow_verify_and_settle",
    description: "Commit deliverable hash and confirm settlement of an escrow",
    inputSchema: {
      type: "object",
      properties: {
        escrowId: { type: "string", description: "32-byte hex escrowId" },
        deliverableJson: { type: "string", description: "JSON string content of deliverable" },
      },
      required: ["escrowId", "deliverableJson"],
    },
  },
  {
    name: "check_entitlement",
    description: "Check if an address holds an active subscription or feature entitlement",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Customer wallet address" },
        featureKey: { type: "string", description: "Optional feature key (e.g. 'premium', 'api_access')" },
      },
      required: ["address"],
    },
  },
  {
    name: "create_payment_link",
    description: "Generate a Mona Visa checkout link for an invoice or subscription",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Plan or product ID" },
        customerAddress: { type: "string", description: "Optional customer address" },
        successUrl: { type: "string", description: "Redirect URL on success" },
      },
      required: ["productId"],
    },
  },
] as const;

export function safeJsonStringify(obj: any): string {
  return JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export async function handleMcpToolCall(
  name: string,
  args: any,
  ctx: McpContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const chain = getChain(ctx.chainId);
    const publicClient = createPublicClient({
      chain,
      transport: http(ctx.rpcUrl),
    });

    const account = ctx.privateKey ? privateKeyToAccount(ctx.privateKey) : undefined;
    const walletClient = account
      ? createWalletClient({
          account,
          chain,
          transport: http(ctx.rpcUrl),
        })
      : undefined;

    switch (name) {
      case "get_balance": {
        const address = getAddress(args.address);
        const nativeBal = await publicClient.getBalance({ address });
        let usdcBal = 0n;
        if (ctx.usdcAddress) {
          usdcBal = (await publicClient.readContract({
            address: ctx.usdcAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          })) as bigint;
        }
        return {
          content: [
            {
              type: "text",
              text: safeJsonStringify({
                address,
                nativeBalance: formatEther(nativeBal) + " MON",
                usdcBalance: formatUnits(usdcBal, 6) + " USDC",
                rawNative: nativeBal.toString(),
                rawUsdc: usdcBal.toString(),
              }),
            },
          ],
        };
      }

      case "open_session": {
        if (!walletClient || !account || !ctx.sessionVaultAddress) {
          throw new Error("Missing wallet client or sessionVaultAddress for write operation");
        }
        const client = new SessionClient({
          chainId: ctx.chainId,
          publicClient,
          walletClient,
          sessionVault: ctx.sessionVaultAddress,
        });
        const deposit = args.depositAmount.includes(".")
          ? parseUnits(args.depositAmount, 6)
          : BigInt(args.depositAmount);
        const durationSec = Number(args.durationSeconds ?? 86400);

        const res = await client.openSession({
          signer: account.address,
          amount: deposit,
          durationSec,
          ...(args.token ? { token: getAddress(args.token) } : {}),
        });

        return {
          content: [{ type: "text", text: safeJsonStringify(res) }],
        };
      }

      case "top_up_session": {
        if (!walletClient || !account || !ctx.sessionVaultAddress) {
          throw new Error("Missing wallet client or sessionVaultAddress for write operation");
        }
        const client = new SessionClient({
          chainId: ctx.chainId,
          publicClient,
          walletClient,
          sessionVault: ctx.sessionVaultAddress,
        });
        const amount = args.amount.includes(".") ? parseUnits(args.amount, 6) : BigInt(args.amount);
        const hash = await client.topUp(args.sessionId as Hex, amount);
        return {
          content: [{ type: "text", text: safeJsonStringify({ hash, sessionId: args.sessionId }) }],
        };
      }

      case "close_session": {
        if (!walletClient || !account || !ctx.sessionVaultAddress) {
          throw new Error("Missing wallet client or sessionVaultAddress for write operation");
        }
        const client = new SessionClient({
          chainId: ctx.chainId,
          publicClient,
          walletClient,
          sessionVault: ctx.sessionVaultAddress,
        });
        const hash = await client.requestClose(args.sessionId as Hex);
        return {
          content: [{ type: "text", text: safeJsonStringify({ hash, sessionId: args.sessionId }) }],
        };
      }

      case "pay_x402": {
        if (!account) {
          throw new Error("Cannot pay x402 without private key account");
        }
        const agentFetch = createAgentFetch({
          account,
          ...(args.sessionId ? { sessionId: args.sessionId as Hex } : {}),
          ...(ctx.sessionVaultAddress ? { sessionVault: ctx.sessionVaultAddress } : {}),
        });

        const init: RequestInit = {
          method: args.method ?? "GET",
          ...(args.body ? { body: args.body } : {}),
        };

        const res = await agentFetch(args.url, init);
        const text = await res.text();
        return {
          content: [
            {
              type: "text",
              text: safeJsonStringify({
                status: res.status,
                headers: Object.fromEntries(res.headers.entries()),
                body: text,
              }),
            },
          ],
        };
      }

      case "list_spend": {
        const platformUrl = ctx.platformUrl ?? "http://localhost:3000";
        const query = args.sessionId ? `?sessionId=${args.sessionId}` : "";
        const res = await fetch(`${platformUrl}/v1/spend${query}`);
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Platform API returned ${res.status}: ${await res.text()}` }],
            isError: true,
          };
        }
        const data = await res.json();
        return {
          content: [{ type: "text", text: safeJsonStringify(data) }],
        };
      }

      case "create_mandate": {
        if (!account) {
          throw new Error("Cannot sign mandate without configured account");
        }
        const now = Math.floor(Date.now() / 1000);
        const validUntil = BigInt(now + Number(args.validUntilSeconds));
        const maxTotal = BigInt(args.maxTotal);
        const maxPerCall = BigInt(args.maxPerCall);
        const agent = getAddress(args.agent);
        const allowedPayees = args.allowedPayees ? args.allowedPayees.map((p: string) => getAddress(p)) : undefined;

        if (args.parentMandate) {
          const signed = await createChildMandate({
            chainId: ctx.chainId,
            signer: account,
            parent: args.parentMandate,
            agent,
            maxTotal,
            maxPerCall,
            ...(allowedPayees ? { allowedPayees } : {}),
            validUntil,
          });
          return {
            content: [
              {
                type: "text",
                text: safeJsonStringify({
                  ...signed,
                  mandateHash: computeMandateHash(signed.mandate),
                }),
              },
            ],
          };
        } else {
          const signed = await createRootMandate({
            chainId: ctx.chainId,
            signer: account,
            agent,
            maxTotal,
            maxPerCall,
            ...(allowedPayees ? { allowedPayees } : {}),
            validUntil,
          });
          return {
            content: [
              {
                type: "text",
                text: safeJsonStringify({
                  ...signed,
                  mandateHash: computeMandateHash(signed.mandate),
                }),
              },
            ],
          };
        }
      }

      case "revoke_mandate": {
        if (!walletClient || !account || !ctx.sessionVaultAddress) {
          throw new Error("Missing wallet client or sessionVaultAddress for write operation");
        }
        const txHash = await walletClient.writeContract({
          address: ctx.sessionVaultAddress,
          abi: sessionVaultAbi,
          functionName: "revokeMandate",
          args: [args.mandateHash as Hex],
          chain: walletClient.chain,
          account,
        });
        return {
          content: [{ type: "text", text: safeJsonStringify({ txHash, mandateHash: args.mandateHash }) }],
        };
      }

      case "escrow_reserve": {
        if (!walletClient || !account || !ctx.sessionVaultAddress) {
          throw new Error("Missing wallet client or sessionVaultAddress for write operation");
        }
        const escrowClient = new EscrowClient({
          chainId: ctx.chainId,
          publicClient,
          walletClient,
          sessionVault: ctx.sessionVaultAddress,
        });
        const deadlineSec = Number(args.deadlineSeconds);
        const amount = BigInt(args.amount);
        const res = await escrowClient.reserve({
          sessionId: args.sessionId as Hex,
          provider: getAddress(args.provider),
          amount,
          deadlineSec,
        });
        return {
          content: [{ type: "text", text: safeJsonStringify(res) }],
        };
      }

      case "escrow_verify_and_settle": {
        if (!walletClient || !account || !ctx.sessionVaultAddress) {
          throw new Error("Missing wallet client or sessionVaultAddress for write operation");
        }
        const escrowClient = new EscrowClient({
          chainId: ctx.chainId,
          publicClient,
          walletClient,
          sessionVault: ctx.sessionVaultAddress,
        });

        const parsedDeliverable = JSON.parse(args.deliverableJson);
        const commitRes = await escrowClient.commit(args.escrowId as Hex, parsedDeliverable);
        const confirmHash = await escrowClient.confirm(args.escrowId as Hex);
        const commitment = computeCommitment(parsedDeliverable);

        return {
          content: [
            {
              type: "text",
              text: safeJsonStringify({
                escrowId: args.escrowId,
                commitment,
                commitHash: commitRes.hash,
                confirmHash,
                settled: true,
              }),
            },
          ],
        };
      }

      case "check_entitlement": {
        const platformUrl = ctx.platformUrl ?? "http://localhost:3000";
        const res = await fetch(`${platformUrl}/v1/entitlements/${args.address}`);
        if (!res.ok) {
          return {
            content: [{ type: "text", text: safeJsonStringify({ active: false, status: res.status }) }],
          };
        }
        const data = await res.json();
        return {
          content: [{ type: "text", text: safeJsonStringify(data) }],
        };
      }

      case "create_payment_link": {
        const platformUrl = ctx.platformUrl ?? "http://localhost:3000";
        const res = await fetch(`${platformUrl}/v1/checkout/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: args.productId,
            customerAddress: args.customerAddress,
            successUrl: args.successUrl ?? "https://monavisa.io/success",
          }),
        });
        const data = await res.json();
        return {
          content: [{ type: "text", text: safeJsonStringify(data) }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error executing ${name}: ${err.message ?? String(err)}` }],
      isError: true,
    };
  }
}
