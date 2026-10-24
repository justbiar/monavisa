/**
 * The small SQL surface the platform needs, in the SQLite dialect. Backed by Cloudflare D1 in the
 * Worker and node:sqlite in tests or local dev.
 *
 * Queries keep Postgres-style `$1` placeholders, rewritten to SQLite's `?1`. Token amounts are
 * stored as decimal text and only compared or summed in JS with BigInt, since SQLite integers stop
 * at 64 bits. Arrays are stored as JSON text and booleans as 0 or 1.
 *
 * D1 has no interactive transactions, so there is no `tx`: writes that must land together go
 * through `batch`, and everything else is idempotent.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs the statements atomically. */
  batch(statements: { sql: string; params?: unknown[] }[]): Promise<void>;
  close(): Promise<void>;
}

/** Current time as an ISO string, the format of every `*_at` text column. */
export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const toSqlite = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");

/** Converts a JS value into something both D1 and node:sqlite can bind. */
export function bindValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** Parses a JSON array column. */
export const jsonList = <T = string>(value: unknown): T[] =>
  typeof value === "string" ? (JSON.parse(value) as T[]) : ((value as T[] | null) ?? []);

const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `create table indexer_state (
        id text primary key,
        last_block integer not null
      )`,

      `create table plans (
        plan_id integer primary key,
        merchant text not null,
        token text not null,
        price text not null,
        period integer not null,
        trial_period integer not null,
        grace_period integer not null,
        treasury text not null,
        active integer not null,
        updated_block integer not null
      )`,
      `create index plans_merchant_idx on plans (merchant)`,

      `create table subscriptions (
        sub_id integer primary key,
        subscriber text not null,
        plan_id integer not null,
        pending_plan_id integer,
        period_start integer not null,
        period_end integer not null,
        status integer not null,
        in_trial integer not null,
        updated_block integer not null,
        last_keeper_attempt integer
      )`,
      `create index subscriptions_subscriber_idx on subscriptions (subscriber)`,
      `create index subscriptions_due_idx on subscriptions (status, period_end)`,

      `create table invoices (
        id text primary key,
        sub_id integer not null,
        payer text not null,
        treasury text not null,
        token text not null,
        amount text not null,
        fee text not null,
        tx_hash text not null,
        block_number integer not null,
        paid_at integer not null
      )`,
      `create index invoices_payer_idx on invoices (payer)`,
      `create index invoices_sub_idx on invoices (sub_id)`,

      `create table teams (
        id text primary key,
        name text not null,
        merchant text not null unique,
        created_at text not null default (${NOW_SQL})
      )`,

      `create table features (
        team_id text not null references teams (id),
        key text not null,
        plan_ids text not null,
        primary key (team_id, key)
      )`,

      `create table webhook_endpoints (
        id text primary key,
        team_id text not null references teams (id),
        url text not null,
        secret text not null,
        events text not null,
        active integer not null default 1,
        created_at text not null default (${NOW_SQL})
      )`,

      `create table events (
        id text primary key,
        type text not null,
        merchant text not null,
        payload text not null,
        created_at integer not null,
        fanned_out integer not null default 0
      )`,
      `create index events_pending_idx on events (created_at) where fanned_out = 0`,

      `create table webhook_deliveries (
        id integer primary key autoincrement,
        endpoint_id text not null references webhook_endpoints (id),
        event_id text not null references events (id),
        status text not null default 'pending',
        attempts integer not null default 0,
        next_attempt_at integer not null,
        last_error text,
        unique (endpoint_id, event_id)
      )`,
      `create index webhook_deliveries_due_idx on webhook_deliveries (status, next_attempt_at)`,

      // Dashboard: several revocable API keys per team, SIWE sessions, plan names, payment links.
      `create table api_keys (
        id text primary key,
        team_id text not null references teams (id),
        label text not null default 'Default',
        prefix text not null,
        key_hash text not null unique,
        created_at text not null default (${NOW_SQL}),
        revoked_at text
      )`,

      `create table auth_nonces (
        nonce text primary key,
        expires_at integer not null
      )`,

      `create table sessions (
        token_hash text primary key,
        team_id text not null references teams (id),
        address text not null,
        expires_at integer not null
      )`,

      `create table plan_metadata (
        plan_id integer primary key,
        name text not null,
        description text,
        updated_at text not null default (${NOW_SQL})
      )`,

      `create table payment_links (
        id text primary key,
        team_id text not null references teams (id),
        plan_id integer not null,
        label text,
        active integer not null default 1,
        created_at text not null default (${NOW_SQL})
      )`,
      `create index payment_links_team_idx on payment_links (team_id)`,

      // Agent payments, SessionVault index, vouchers, x402 settlement and escrow.
      `create table vault_sessions (
        session_id text primary key,
        owner text not null,
        signer text not null,
        token text not null,
        balance text not null,
        expires_at integer not null,
        closes_at integer not null default 0,
        updated_block integer not null
      )`,
      `create index vault_sessions_owner_idx on vault_sessions (owner)`,
      `create index vault_sessions_signer_idx on vault_sessions (signer)`,

      `create table vouchers (
        session_id text not null references vault_sessions (session_id),
        payee text not null,
        cumulative_amount text not null,
        signature text not null,
        redeemed_amount text not null default '0',
        updated_at integer not null,
        primary key (session_id, payee)
      )`,

      `create table x402_payments (
        id text primary key,
        scheme text not null,
        payer text not null,
        payee text not null,
        token text not null,
        amount text not null,
        tx_hash text,
        created_at integer not null
      )`,
      `create index x402_payments_payer_idx on x402_payments (payer)`,
      `create index x402_payments_payee_idx on x402_payments (payee)`,

      `create table escrows (
        escrow_id text primary key,
        session_id text not null references vault_sessions (session_id),
        provider text not null,
        amount text not null,
        deadline integer not null,
        status integer not null,
        commitment text,
        updated_block integer not null
      )`,
      `create index escrows_provider_idx on escrows (provider)`,

      `create table revoked_mandates (
        issuer text not null,
        mandate_hash text not null,
        primary key (issuer, mandate_hash)
      )`,
    ],
  },
];

export async function migrate(db: Db): Promise<number> {
  await db.query(
    `create table if not exists schema_migrations (version integer primary key, applied_at text not null default (${NOW_SQL}))`,
  );
  const applied = new Set(
    (await db.query<{ version: number }>("select version from schema_migrations")).map(
      (r) => r.version,
    ),
  );
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.batch([
      ...m.statements.map((sql) => ({ sql })),
      { sql: "insert into schema_migrations (version) values ($1)", params: [m.version] },
    ]);
    count++;
  }
  return count;
}
