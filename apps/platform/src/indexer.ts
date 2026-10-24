import {
  autopayModuleAbi,
  planFactoryAbi,
  sessionVaultAbi,
  subscriptionRegistryAbi,
  type WebhookEvent,
  type WebhookEventType,
} from "@monavisa/core";
import type { Address, BlockTag, Hex, PublicClient } from "viem";
import type { Db } from "./db.js";

export interface IndexerConfig {
  chainId: number;
  planFactory: Address;
  registry: Address;
  autopay: Address;
  sessionVault?: Address;
  /** First block to scan when nothing has been indexed yet (the deployment block). */
  startBlock: bigint;
  /** Monad public RPCs cap eth_getLogs at 100 blocks. */
  range: bigint;
  /** "finalized" in production; "latest" on a local devnet. */
  blockTag: BlockTag;
}

const STATE_ID = "chain";

const indexedEvents = [
  ...planFactoryAbi.filter(
    (x) =>
      x.type === "event" && ["PlanCreated", "PlanActiveSet", "PlanTreasurySet"].includes(x.name),
  ),
  ...subscriptionRegistryAbi.filter(
    (x) =>
      x.type === "event" &&
      [
        "SubscriptionActivated",
        "SubscriptionRenewed",
        "SubscriptionPastDue",
        "SubscriptionPlanChanged",
        "SubscriptionPlanChangeScheduled",
        "SubscriptionCanceled",
        "SubscriptionExpired",
      ].includes(x.name),
  ),
  ...autopayModuleAbi.filter(
    (x) => x.type === "event" && ["Charged", "RenewalFailed"].includes(x.name),
  ),
  ...sessionVaultAbi.filter(
    (x) =>
      x.type === "event" &&
      [
        "SessionOpened",
        "SessionToppedUp",
        "SessionExtended",
        "VoucherRedeemed",
        "SessionCloseRequested",
        "SessionClosed",
        "EscrowReserved",
        "EscrowCommitted",
        "EscrowSettled",
        "EscrowRefunded",
        "MandateRevoked",
      ].includes(x.name),
  ),
];

interface DecodedLog {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export async function lastIndexedBlock(db: Db): Promise<bigint | null> {
  const [row] = await db.query<{ last_block: string }>(
    "select last_block from indexer_state where id = $1",
    [STATE_ID],
  );
  return row ? BigInt(row.last_block) : null;
}

/**
 * Indexes the next range of blocks. Returns the range processed, or null when caught up.
 * Every write is idempotent (plans, subscriptions and vault sessions are copied from chain state
 * at the end of the range rather than adjusted by deltas), so a crash mid-range only repeats work.
 */
export async function syncOnce(
  db: Db,
  client: PublicClient,
  cfg: IndexerConfig,
): Promise<{ from: bigint; to: bigint; logs: number } | null> {
  const head = (await client.getBlock({ blockTag: cfg.blockTag })).number;
  if (head === null) return null;
  const last = (await lastIndexedBlock(db)) ?? cfg.startBlock - 1n;
  if (last >= head) return null;

  const from = last + 1n;
  const to = from + cfg.range - 1n < head ? from + cfg.range - 1n : head;
  const addresses: Address[] = [cfg.planFactory, cfg.registry, cfg.autopay];
  if (cfg.sessionVault) addresses.push(cfg.sessionVault);

  const logs = (await client.getLogs({
    address: addresses,
    events: indexedEvents,
    fromBlock: from,
    toBlock: to,
    strict: true,
  })) as unknown as DecodedLog[];
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

  const planIds = new Set<bigint>();
  const subIds = new Set<bigint>();
  for (const log of logs) {
    const { planId, subId, fromPlanId, toPlanId } = log.args as Record<string, bigint | undefined>;
    if (log.address.toLowerCase() === cfg.planFactory.toLowerCase() && planId !== undefined) {
      planIds.add(planId);
    }
    if (subId !== undefined) subIds.add(subId);
    if (fromPlanId !== undefined) planIds.add(fromPlanId);
    if (toPlanId !== undefined && toPlanId !== 0n) planIds.add(toPlanId);
  }

  const plans = await Promise.all(
    [...planIds].map(async (id) => ({
      id,
      plan: await client.readContract({
        address: cfg.planFactory,
        abi: planFactoryAbi,
        functionName: "getPlan",
        args: [id],
        blockNumber: to,
      }),
    })),
  );
  const subs = await Promise.all(
    [...subIds].map(async (id) => {
      const [sub, subscriber] = await Promise.all([
        client.readContract({
          address: cfg.registry,
          abi: subscriptionRegistryAbi,
          functionName: "getSubscription",
          args: [id],
          blockNumber: to,
        }),
        client.readContract({
          address: cfg.registry,
          abi: subscriptionRegistryAbi,
          functionName: "subscriberOf",
          args: [id],
          blockNumber: to,
        }),
      ]);
      return { id, sub, subscriber };
    }),
  );

  // Escrow events after the reservation only carry the escrow id.
  const escrowSessions = new Map<string, string>();
  for (const log of logs) {
    const { escrowId, sessionId } = log.args;
    if (escrowId !== undefined && sessionId !== undefined) {
      escrowSessions.set(String(escrowId), String(sessionId));
    }
  }
  const sessionIds = new Set<string>();
  if (cfg.sessionVault) {
    for (const log of logs) {
      if (log.address.toLowerCase() !== cfg.sessionVault.toLowerCase()) continue;
      const { sessionId, escrowId } = log.args;
      if (sessionId !== undefined) sessionIds.add(String(sessionId));
      else if (escrowId !== undefined) {
        const known = escrowSessions.get(String(escrowId));
        const [row] = known
          ? [{ session_id: known }]
          : await db.query<{ session_id: string }>(
              "select session_id from escrows where escrow_id = $1",
              [String(escrowId)],
            );
        if (row) sessionIds.add(row.session_id);
      }
    }
  }
  const vaultSessions = await Promise.all(
    [...sessionIds].map(async (id) => ({
      id,
      session: await client.readContract({
        address: cfg.sessionVault!,
        abi: sessionVaultAbi,
        functionName: "getSession",
        args: [id as Hex],
        blockNumber: to,
      }),
    })),
  );

  const blockTimes = new Map<bigint, bigint>();
  for (const log of logs) {
    if (!blockTimes.has(log.blockNumber)) {
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      blockTimes.set(log.blockNumber, block.timestamp);
    }
  }

  for (const { id, plan } of plans) {
    await db.query(
      `insert into plans (plan_id, merchant, token, price, period, trial_period, grace_period, treasury, active, updated_block)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (plan_id) do update set
         treasury = excluded.treasury, active = excluded.active, updated_block = excluded.updated_block`,
      [
        id.toString(),
        plan.merchant.toLowerCase(),
        plan.token.toLowerCase(),
        plan.price.toString(),
        plan.period,
        plan.trialPeriod,
        plan.gracePeriod,
        plan.treasury.toLowerCase(),
        plan.active,
        to.toString(),
      ],
    );
  }

  for (const { id, sub, subscriber } of subs) {
    await db.query(
      `insert into subscriptions (sub_id, subscriber, plan_id, pending_plan_id, period_start, period_end, status, in_trial, updated_block)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (sub_id) do update set
         plan_id = excluded.plan_id, pending_plan_id = excluded.pending_plan_id,
         period_start = excluded.period_start, period_end = excluded.period_end,
         status = excluded.status, in_trial = excluded.in_trial, updated_block = excluded.updated_block`,
      [
        id.toString(),
        subscriber.toLowerCase(),
        sub.planId.toString(),
        sub.pendingPlanId === 0n ? null : sub.pendingPlanId.toString(),
        sub.currentPeriodStart.toString(),
        sub.currentPeriodEnd.toString(),
        sub.status,
        sub.inTrial,
        to.toString(),
      ],
    );
  }

  // Before the logs, which reference these rows from vouchers and escrows.
  for (const { id, session } of vaultSessions) {
    if (/^0x0+$/.test(session.owner)) continue;
    await db.query(
      `insert into vault_sessions (session_id, owner, signer, token, balance, expires_at, closes_at, updated_block)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (session_id) do update set
         signer = excluded.signer, balance = excluded.balance, expires_at = excluded.expires_at,
         closes_at = excluded.closes_at, updated_block = excluded.updated_block`,
      [
        id,
        session.owner.toLowerCase(),
        session.signer.toLowerCase(),
        session.token.toLowerCase(),
        session.balance.toString(),
        session.expiresAt.toString(),
        session.closesAt.toString(),
        to.toString(),
      ],
    );
  }

  for (const log of logs) {
    await applyLog(db, cfg, log, blockTimes.get(log.blockNumber) ?? 0n);
  }

  // Last, so a range is only marked done once everything above has been written.
  await db.query(
    `insert into indexer_state (id, last_block) values ($1, $2)
     on conflict (id) do update set last_block = excluded.last_block`,
    [STATE_ID, to.toString()],
  );

  return { from, to, logs: logs.length };
}

async function applyLog(db: Db, cfg: IndexerConfig, log: DecodedLog, timestamp: bigint) {
  const id = `${log.transactionHash}:${log.logIndex}`;
  const args = log.args;

  if (log.eventName === "Charged") {
    await db.query(
      `insert into invoices (id, sub_id, payer, treasury, token, amount, fee, tx_hash, block_number, paid_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (id) do nothing`,
      [
        id,
        String(args.subId),
        String(args.payer).toLowerCase(),
        String(args.treasury).toLowerCase(),
        String(args.token).toLowerCase(),
        String(args.price),
        String(args.fee),
        log.transactionHash,
        log.blockNumber.toString(),
        timestamp.toString(),
      ],
    );
  } else if (log.eventName === "VoucherRedeemed") {
    // Session balances come from chain state in syncOnce; only the voucher is tracked here.
    const { sessionId, payee, cumulativeAmount } = args as Record<string, unknown>;
    const [prev] = await db.query<{ cumulative_amount: string }>(
      "select cumulative_amount from vouchers where session_id = $1 and payee = $2",
      [String(sessionId), String(payee).toLowerCase()],
    );
    const redeemed = BigInt(String(cumulativeAmount));
    // A newer voucher the facilitator accepted may already be ahead of what was redeemed.
    const cumulative = prev && BigInt(prev.cumulative_amount) > redeemed ? BigInt(prev.cumulative_amount) : redeemed;
    await db.query(
      `insert into vouchers (session_id, payee, cumulative_amount, signature, redeemed_amount, updated_at)
       values ($1, $2, $3, '', $4, $5)
       on conflict (session_id, payee) do update set
         redeemed_amount = excluded.redeemed_amount,
         cumulative_amount = excluded.cumulative_amount,
         updated_at = excluded.updated_at`,
      [
        String(sessionId),
        String(payee).toLowerCase(),
        cumulative.toString(),
        redeemed.toString(),
        timestamp.toString(),
      ],
    );
  } else if (log.eventName === "EscrowReserved") {
    const { escrowId, sessionId, provider, amount, deadline } = args as Record<string, unknown>;
    await db.query(
      `insert into escrows (escrow_id, session_id, provider, amount, deadline, status, commitment, updated_block)
       values ($1, $2, $3, $4, $5, 1, null, $6)
       on conflict (escrow_id) do update set status = 1, updated_block = excluded.updated_block`,
      [
        String(escrowId),
        String(sessionId),
        String(provider).toLowerCase(),
        String(amount),
        String(deadline),
        log.blockNumber.toString(),
      ],
    );
  } else if (log.eventName === "EscrowCommitted") {
    const { escrowId, commitment } = args as Record<string, unknown>;
    await db.query(
      `update escrows set commitment = $1, status = 2, updated_block = $2 where escrow_id = $3`,
      [String(commitment), log.blockNumber.toString(), String(escrowId)],
    );
  } else if (log.eventName === "EscrowSettled") {
    const { escrowId } = args as Record<string, unknown>;
    await db.query(
      `update escrows set status = 3, updated_block = $1 where escrow_id = $2`,
      [log.blockNumber.toString(), String(escrowId)],
    );
  } else if (log.eventName === "EscrowRefunded") {
    const { escrowId } = args as Record<string, unknown>;
    await db.query(
      `update escrows set status = 4, updated_block = $1 where escrow_id = $2`,
      [log.blockNumber.toString(), String(escrowId)],
    );
  } else if (log.eventName === "MandateRevoked") {
    const { issuer, mandateHash } = args as Record<string, unknown>;
    await db.query(
      `insert into revoked_mandates (issuer, mandate_hash) values ($1, $2) on conflict do nothing`,
      [String(issuer).toLowerCase(), String(mandateHash)],
    );
  }

  const type = await webhookTypeFor(db, log);
  if (!type) return;

  const merchant = await merchantForLog(db, log);
  if (!merchant) return;

  const event: WebhookEvent = {
    id: `evt_${id}`,
    type,
    createdAt: Number(timestamp),
    chainId: cfg.chainId,
    data: {
      ...serializeArgs(args),
      ...(log.eventName === "Charged" ? { invoiceId: id } : {}),
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber.toString(),
    },
  };
  await db.query(
    `insert into events (id, type, merchant, payload, created_at) values ($1, $2, $3, $4, $5)
     on conflict (id) do nothing`,
    [event.id, event.type, merchant, JSON.stringify(event), Number(timestamp)],
  );
}

async function webhookTypeFor(db: Db, log: DecodedLog): Promise<WebhookEventType | null> {
  switch (log.eventName) {
    case "SubscriptionActivated":
      return "subscription.created";
    case "SubscriptionRenewed":
      return "subscription.renewed";
    case "RenewalFailed":
      return "subscription.renewal_failed";
    case "SubscriptionCanceled":
      return "subscription.canceled";
    case "SubscriptionExpired":
      return "subscription.expired";
    case "Charged":
      return "invoice.paid";
    case "SessionOpened":
      return "session.opened";
    case "SessionClosed":
      return "session.closed";
    case "VoucherRedeemed":
      return "x402.settled";
    case "EscrowSettled":
      return "escrow.settled";
    case "EscrowRefunded":
      return "escrow.refunded";
    case "MandateRevoked":
      return "mandate.revoked";
    case "SubscriptionPlanChanged": {
      const { fromPlanId, toPlanId } = log.args as { fromPlanId: bigint; toPlanId: bigint };
      const rows = await db.query<{ plan_id: string; price: string; period: number }>(
        "select plan_id, price, period from plans where plan_id in (select cast(value as integer) from json_each($1))",
        [[fromPlanId.toString(), toPlanId.toString()]],
      );
      const rate = (planId: bigint) => {
        const row = rows.find((r) => String(r.plan_id) === planId.toString());
        return row ? { price: BigInt(row.price), period: BigInt(row.period) } : null;
      };
      const a = rate(fromPlanId);
      const b = rate(toPlanId);
      if (!a || !b) return "subscription.upgraded";
      return b.price * a.period > a.price * b.period
        ? "subscription.upgraded"
        : "subscription.downgraded";
    }
    default:
      return null;
  }
}

async function merchantForLog(db: Db, log: DecodedLog): Promise<string | null> {
  const args = log.args;
  if (args.subId !== undefined) {
    return merchantOfSub(db, args.subId as bigint);
  }
  const candidates: string[] = [];
  if (args.payee) candidates.push(String(args.payee).toLowerCase());
  if (args.provider) candidates.push(String(args.provider).toLowerCase());
  if (args.owner) candidates.push(String(args.owner).toLowerCase());
  if (args.issuer) candidates.push(String(args.issuer).toLowerCase());
  if (candidates.length > 0) {
    const [row] = await db.query<{ merchant: string }>(
      `select merchant from teams where merchant in (select value from json_each($1)) limit 1`,
      [candidates],
    );
    if (row) return row.merchant;
  }
  return null;
}

async function merchantOfSub(db: Db, subId: bigint): Promise<string | null> {
  const [row] = await db.query<{ merchant: string }>(
    `select p.merchant from subscriptions s join plans p on p.plan_id = s.plan_id where s.sub_id = $1`,
    [subId.toString()],
  );
  return row?.merchant ?? null;
}

function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === "bigint" ? value.toString() : value;
  }
  return out;
}
