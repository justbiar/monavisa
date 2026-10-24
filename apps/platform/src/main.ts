#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { buildApi, clients, signer } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { type Db, migrate } from "./db.js";
import { syncOnce } from "./indexer.js";
import { runKeeperOnce } from "./keeper.js";
import { runSettlerOnce } from "./settler.js";
import { createSqliteDb } from "./sqlite.js";
import { createTeam } from "./teams.js";
import { deliverDue, fanOutEvents } from "./webhooks.js";

const USAGE = `Usage: monavisa-platform <command>

  migrate                      Apply database migrations
  create-team <name> <merchant>  Create a team and print its API key once
  api                          Serve the HTTP API (includes /x402 facilitator)
  indexer                      Index contract events
  keeper                       Trigger due renewals (needs KEEPER_PRIVATE_KEY)
  settler                      Redeem pending vouchers in batches
  webhooks                     Deliver webhooks
  all                          Run api, indexer, keeper, settler and webhooks in one process`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

/** Runs `step` forever, polling only when it reports there was nothing to do. */
async function loop(name: string, pollMs: number, step: () => Promise<boolean>) {
  for (;;) {
    try {
      if (!(await step())) await sleep(pollMs);
    } catch (err) {
      console.error(`[${name}]`, err instanceof Error ? err.message : err);
      await sleep(pollMs * 5);
    }
  }
}

function runIndexer(db: Db, cfg: Config) {
  const { publicClient } = clients(cfg);
  return loop("indexer", cfg.pollMs, async () => {
    const r = await syncOnce(db, publicClient, {
      chainId: cfg.chainId,
      ...cfg.contracts,
      startBlock: cfg.startBlock,
      range: cfg.logRange,
      blockTag: cfg.blockTag,
    });
    if (r && r.logs > 0) console.log(`[indexer] blocks ${r.from}-${r.to}: ${r.logs} logs`);
    return r !== null;
  });
}

function runKeeper(db: Db, cfg: Config) {
  if (!cfg.keeperPrivateKey) throw new Error("KEEPER_PRIVATE_KEY is required for the keeper");
  const { publicClient } = clients(cfg);
  const walletClient = signer(cfg, cfg.keeperPrivateKey);
  return loop("keeper", Math.max(cfg.pollMs, 5000), async () => {
    const r = await runKeeperOnce(db, publicClient, walletClient, {
      autopay: cfg.contracts.autopay,
      batchSize: cfg.keeperBatchSize,
      retryAfterSec: cfg.keeperRetryAfterSec,
    });
    if (r) console.log(`[keeper] renewMany(${r.subIds.join(",")}) ${r.hash}`);
    return false;
  });
}

function runSettler(db: Db, cfg: Config) {
  const key = cfg.facilitatorPrivateKey ?? cfg.keeperPrivateKey;
  if (!key) throw new Error("FACILITATOR_PRIVATE_KEY or KEEPER_PRIVATE_KEY is required for the settler");
  const { publicClient } = clients(cfg);
  const walletClient = signer(cfg, key);
  return loop("settler", Math.max(cfg.pollMs, 10000), async () => {
    const r = await runSettlerOnce(db, publicClient, walletClient, {
      sessionVault: cfg.contracts.sessionVault,
      batchSize: 50,
    });
    if (r) console.log(`[settler] redeemMany(${r.count} vouchers) ${r.hash}`);
    return r !== null;
  });
}

function runWebhooks(db: Db, cfg: Config) {
  return loop("webhooks", cfg.pollMs, async () => {
    const fanned = await fanOutEvents(db, nowSec());
    const { delivered, failed } = await deliverDue(db, nowSec());
    if (delivered + failed > 0) console.log(`[webhooks] delivered ${delivered}, failed ${failed}`);
    return fanned + delivered + failed > 0;
  });
}

function runApi(db: Db, cfg: Config) {
  const app = buildApi(db, cfg);
  serve({ fetch: app.fetch, port: cfg.port });
  console.log(`[api] listening on http://localhost:${cfg.port}`);
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  const cfg = loadConfig();
  const db = createSqliteDb(cfg.databaseUrl);

  if (command === "migrate") {
    console.log(`Applied ${await migrate(db)} migration(s)`);
    return db.close();
  }
  if (command === "create-team") {
    const [name, merchant] = rest;
    if (!name || !merchant) throw new Error("Usage: create-team <name> <merchant>");
    const { team, apiKey } = await createTeam(db, { name, merchant });
    console.log(`Team ${team.id} for ${team.merchant}\nAPI key (shown once): ${apiKey}`);
    return db.close();
  }

  await migrate(db);
  switch (command) {
    case "api":
      return runApi(db, cfg);
    case "indexer":
      return runIndexer(db, cfg);
    case "keeper":
      return runKeeper(db, cfg);
    case "settler":
      return runSettler(db, cfg);
    case "webhooks":
      return runWebhooks(db, cfg);
    case "all":
      runApi(db, cfg);
      await Promise.all([
        runIndexer(db, cfg),
        runWebhooks(db, cfg),
        ...(cfg.keeperPrivateKey ? [runKeeper(db, cfg)] : []),
        ...(cfg.facilitatorPrivateKey ?? cfg.keeperPrivateKey ? [runSettler(db, cfg)] : []),
      ]);
      return;
    default:
      throw new Error(`Unknown command '${command}'\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
