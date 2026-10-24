import { buildApi, clients, signer } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { type D1Database, createD1Db } from "./d1.js";
import { type Db, migrate } from "./db.js";
import { syncOnce } from "./indexer.js";
import { runKeeperOnce } from "./keeper.js";
import { runSettlerOnce } from "./settler.js";
import { deliverDue, fanOutEvents } from "./webhooks.js";

/**
 * Cloudflare Worker entry point. `fetch` serves the HTTP API and `scheduled` runs one round of
 * the indexer, webhooks, keeper and settler per cron tick, in place of the Node polling loops.
 */

interface Env {
  /** The D1 database binding from wrangler.jsonc. */
  DB: D1Database;
  [name: string]: unknown;
}

/** Stop starting new indexer batches after this long, so a tick finishes well before the next. */
const TICK_BUDGET_MS = 40_000;

const nowSec = () => Math.floor(Date.now() / 1000);

function configFor(env: Env): Config {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  return loadConfig(vars);
}

// Migrations run once per isolate; a failure is retried on the next request.
let migrated: Promise<unknown> | undefined;
function ensureMigrated(db: Db) {
  migrated ??= migrate(db).catch((err) => {
    migrated = undefined;
    throw err;
  });
  return migrated;
}

async function withDb<R>(env: Env, fn: (db: Db) => Promise<R>) {
  const db = createD1Db(env.DB);
  await ensureMigrated(db);
  return fn(db);
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    console.error(`[${name}]`, err instanceof Error ? err.message : err);
  }
}

async function tick(db: Db, cfg: Config) {
  const { publicClient } = clients(cfg);
  const deadline = Date.now() + TICK_BUDGET_MS;

  await step("indexer", async () => {
    while (Date.now() < deadline) {
      const r = await syncOnce(db, publicClient, {
        chainId: cfg.chainId,
        ...cfg.contracts,
        startBlock: cfg.startBlock,
        range: cfg.logRange,
        blockTag: cfg.blockTag,
      });
      if (!r) break;
      if (r.logs > 0) console.log(`[indexer] blocks ${r.from}-${r.to}: ${r.logs} logs`);
    }
  });

  await step("webhooks", async () => {
    await fanOutEvents(db, nowSec());
    const { delivered, failed } = await deliverDue(db, nowSec());
    if (delivered + failed > 0) console.log(`[webhooks] delivered ${delivered}, failed ${failed}`);
  });

  if (cfg.keeperPrivateKey) {
    const walletClient = signer(cfg, cfg.keeperPrivateKey);
    await step("keeper", async () => {
      const r = await runKeeperOnce(db, publicClient, walletClient, {
        autopay: cfg.contracts.autopay,
        batchSize: cfg.keeperBatchSize,
        retryAfterSec: cfg.keeperRetryAfterSec,
      });
      if (r) console.log(`[keeper] renewMany(${r.subIds.join(",")}) ${r.hash}`);
    });
  }

  const settlerKey = cfg.facilitatorPrivateKey ?? cfg.keeperPrivateKey;
  if (settlerKey) {
    const walletClient = signer(cfg, settlerKey);
    await step("settler", async () => {
      const r = await runSettlerOnce(db, publicClient, walletClient, {
        sessionVault: cfg.contracts.sessionVault,
        batchSize: 50,
      });
      if (r) console.log(`[settler] redeemMany(${r.count} vouchers) ${r.hash}`);
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = configFor(env);
    return withDb(env, async (db) => buildApi(db, cfg).fetch(request));
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const cfg = configFor(env);
    await withDb(env, (db) => tick(db, cfg));
  },
};
