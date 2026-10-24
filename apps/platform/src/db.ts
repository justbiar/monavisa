import pg from "pg";

/** The small SQL surface the platform needs. Backed by pg in production and PGlite in tests. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

function wrap(client: Queryable): Pick<Db, "query"> {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rows as T[];
    },
  };
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner: Db = {
          ...wrap(client),
          tx: (nested) => nested(inner),
          close: async () => {},
        };
        const result = await fn(inner);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      create table indexer_state (
        id text primary key,
        last_block bigint not null
      );

      create table plans (
        plan_id bigint primary key,
        merchant text not null,
        token text not null,
        price numeric(78, 0) not null,
        period integer not null,
        trial_period integer not null,
        grace_period integer not null,
        treasury text not null,
        active boolean not null,
        updated_block bigint not null
      );
      create index plans_merchant_idx on plans (merchant);

      create table subscriptions (
        sub_id bigint primary key,
        subscriber text not null,
        plan_id bigint not null,
        pending_plan_id bigint,
        period_start bigint not null,
        period_end bigint not null,
        status smallint not null,
        in_trial boolean not null,
        updated_block bigint not null,
        last_keeper_attempt bigint
      );
      create index subscriptions_subscriber_idx on subscriptions (subscriber);
      create index subscriptions_due_idx on subscriptions (status, period_end);

      create table invoices (
        id text primary key,
        sub_id bigint not null,
        payer text not null,
        treasury text not null,
        token text not null,
        amount numeric(78, 0) not null,
        fee numeric(78, 0) not null,
        tx_hash text not null,
        block_number bigint not null,
        paid_at bigint not null
      );
      create index invoices_payer_idx on invoices (payer);
      create index invoices_sub_idx on invoices (sub_id);

      create table teams (
        id text primary key,
        name text not null,
        merchant text not null unique,
        api_key_hash text not null unique,
        created_at timestamptz not null default now()
      );

      create table features (
        team_id text not null references teams (id),
        key text not null,
        plan_ids bigint[] not null,
        primary key (team_id, key)
      );

      create table webhook_endpoints (
        id text primary key,
        team_id text not null references teams (id),
        url text not null,
        secret text not null,
        events text[] not null,
        active boolean not null default true,
        created_at timestamptz not null default now()
      );

      create table events (
        id text primary key,
        type text not null,
        merchant text not null,
        payload jsonb not null,
        created_at bigint not null,
        fanned_out boolean not null default false
      );
      create index events_pending_idx on events (created_at) where not fanned_out;

      create table webhook_deliveries (
        id bigserial primary key,
        endpoint_id text not null references webhook_endpoints (id),
        event_id text not null references events (id),
        status text not null default 'pending',
        attempts integer not null default 0,
        next_attempt_at bigint not null,
        last_error text,
        unique (endpoint_id, event_id)
      );
      create index webhook_deliveries_due_idx on webhook_deliveries (status, next_attempt_at);
    `,
  },
];

export async function migrate(db: Db): Promise<number> {
  await db.query(
    "create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set(
    (await db.query<{ version: number }>("select version from schema_migrations")).map(
      (r) => r.version,
    ),
  );
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.tx(async (tx) => {
      await tx.query(m.sql);
      await tx.query("insert into schema_migrations (version) values ($1)", [m.version]);
    });
    count++;
  }
  return count;
}
