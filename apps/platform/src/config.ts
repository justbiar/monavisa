import { existsSync, readFileSync } from "node:fs";
import { getNetwork } from "@monavisa/core";
import { type Address, getAddress, isAddress, isHex } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine(isAddress, "must be an address")
  .transform((a) => getAddress(a));

const schema = z.object({
  /** SQLite file for the Node entry point. The Worker uses its D1 binding instead. */
  DATABASE_URL: z.string().default("./.data/monavisa.sqlite"),
  RPC_URL: z.url().default("https://testnet-rpc.monad.xyz"),
  CHAIN_ID: z.coerce.number().int().default(10143),
  PLAN_FACTORY_ADDRESS: address.optional(),
  SUBSCRIPTION_REGISTRY_ADDRESS: address.optional(),
  AUTOPAY_MODULE_ADDRESS: address.optional(),
  SESSION_VAULT_ADDRESS: address.optional(),
  START_BLOCK: z.coerce.bigint().default(0n),
  LOG_RANGE: z.coerce.bigint().default(100n),
  BLOCK_TAG: z.enum(["finalized", "safe", "latest"]).default("finalized"),
  KEEPER_PRIVATE_KEY: z
    .string()
    .refine((k) => isHex(k) && k.length === 66, "must be a 0x-prefixed 32-byte hex key")
    .optional(),
  FACILITATOR_PRIVATE_KEY: z
    .string()
    .refine((k) => isHex(k) && k.length === 66, "must be a 0x-prefixed 32-byte hex key")
    .optional(),
  KEEPER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  KEEPER_RETRY_AFTER_SEC: z.coerce.number().int().positive().default(3600),
  POLL_MS: z.coerce.number().int().positive().default(1000),
  PORT: z.coerce.number().int().positive().default(8787),
  /** Comma-separated browser origins allowed to call the API. */
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:5174"),
  /** Comma-separated hosts accepted in dashboard sign-in messages. */
  SIWE_DOMAINS: z.string().default("localhost:5174"),
  CHECKOUT_URL: z.url().default("http://localhost:5173"),
});

export type Config = ReturnType<typeof loadConfig>;

const list = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const c = parsed.data;

  // Fall back to local.json or the addresses in @monavisa/core once contracts are deployed on this chain.
  let localDeploy: any = null;
  try {
    const localPath = new URL("../../../contracts/deployments/local.json", import.meta.url);
    if (existsSync(localPath)) {
      localDeploy = JSON.parse(readFileSync(localPath, "utf8"));
    }
  } catch {}

  const deployed = getNetwork(c.CHAIN_ID).contracts;
  const pick = (name: string, value: Address | undefined, fallback: Address | null, localVal?: string): Address => {
    const resolved = value ?? fallback ?? (localVal ? getAddress(localVal) : undefined);
    if (!resolved)
      throw new Error(`${name} is required: nothing is deployed on chain ${c.CHAIN_ID} yet`);
    return resolved;
  };

  return {
    databaseUrl: c.DATABASE_URL,
    rpcUrl: c.RPC_URL,
    chainId: c.CHAIN_ID,
    contracts: {
      planFactory: pick("PLAN_FACTORY_ADDRESS", c.PLAN_FACTORY_ADDRESS, deployed.planFactory, localDeploy?.planFactory),
      registry: pick(
        "SUBSCRIPTION_REGISTRY_ADDRESS",
        c.SUBSCRIPTION_REGISTRY_ADDRESS,
        deployed.subscriptionRegistry,
        localDeploy?.subscriptionRegistry,
      ),
      autopay: pick("AUTOPAY_MODULE_ADDRESS", c.AUTOPAY_MODULE_ADDRESS, deployed.autopayModule, localDeploy?.autopayModule),
      sessionVault: pick("SESSION_VAULT_ADDRESS", c.SESSION_VAULT_ADDRESS, deployed.sessionVault, localDeploy?.sessionVault),
    },
    startBlock:
      c.START_BLOCK > 0n
        ? c.START_BLOCK
        : localDeploy?.startBlock
          ? BigInt(localDeploy.startBlock)
          : 0n,
    logRange: c.LOG_RANGE,
    blockTag: c.BLOCK_TAG,
    keeperPrivateKey: c.KEEPER_PRIVATE_KEY as `0x${string}` | undefined,
    facilitatorPrivateKey: c.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined,
    keeperBatchSize: c.KEEPER_BATCH_SIZE,
    keeperRetryAfterSec: c.KEEPER_RETRY_AFTER_SEC,
    pollMs: c.POLL_MS,
    port: c.PORT,
    corsOrigins: list(c.CORS_ORIGINS),
    siweDomains: list(c.SIWE_DOMAINS),
    checkoutUrl: c.CHECKOUT_URL,
  };
}
