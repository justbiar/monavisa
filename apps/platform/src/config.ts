import { getNetwork } from "@moncart/core";
import { type Address, getAddress, isAddress, isHex } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine(isAddress, "must be an address")
  .transform((a) => getAddress(a));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.url(),
  CHAIN_ID: z.coerce.number().int().default(10143),
  PLAN_FACTORY_ADDRESS: address.optional(),
  SUBSCRIPTION_REGISTRY_ADDRESS: address.optional(),
  AUTOPAY_MODULE_ADDRESS: address.optional(),
  START_BLOCK: z.coerce.bigint().default(0n),
  LOG_RANGE: z.coerce.bigint().default(100n),
  BLOCK_TAG: z.enum(["finalized", "safe", "latest"]).default("finalized"),
  KEEPER_PRIVATE_KEY: z
    .string()
    .refine((k) => isHex(k) && k.length === 66, "must be a 0x-prefixed 32-byte hex key")
    .optional(),
  KEEPER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  KEEPER_RETRY_AFTER_SEC: z.coerce.number().int().positive().default(3600),
  POLL_MS: z.coerce.number().int().positive().default(1000),
  PORT: z.coerce.number().int().positive().default(8787),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const c = parsed.data;

  // Fall back to the addresses in @moncart/core once contracts are deployed on this chain.
  const deployed = getNetwork(c.CHAIN_ID).contracts;
  const pick = (name: string, value: Address | undefined, fallback: Address | null): Address => {
    const resolved = value ?? fallback;
    if (!resolved)
      throw new Error(`${name} is required: nothing is deployed on chain ${c.CHAIN_ID} yet`);
    return resolved;
  };

  return {
    databaseUrl: c.DATABASE_URL,
    rpcUrl: c.RPC_URL,
    chainId: c.CHAIN_ID,
    contracts: {
      planFactory: pick("PLAN_FACTORY_ADDRESS", c.PLAN_FACTORY_ADDRESS, deployed.planFactory),
      registry: pick(
        "SUBSCRIPTION_REGISTRY_ADDRESS",
        c.SUBSCRIPTION_REGISTRY_ADDRESS,
        deployed.subscriptionRegistry,
      ),
      autopay: pick("AUTOPAY_MODULE_ADDRESS", c.AUTOPAY_MODULE_ADDRESS, deployed.autopayModule),
    },
    startBlock: c.START_BLOCK,
    logRange: c.LOG_RANGE,
    blockTag: c.BLOCK_TAG,
    keeperPrivateKey: c.KEEPER_PRIVATE_KEY as `0x${string}` | undefined,
    keeperBatchSize: c.KEEPER_BATCH_SIZE,
    keeperRetryAfterSec: c.KEEPER_RETRY_AFTER_SEC,
    pollMs: c.POLL_MS,
    port: c.PORT,
  };
}
