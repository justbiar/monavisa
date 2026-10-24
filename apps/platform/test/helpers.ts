import { PGlite, type Transaction } from "@electric-sql/pglite";
import { type Db, migrate } from "../src/db.js";

type PgLike = Pick<PGlite, "query" | "exec"> | Transaction;

function wrap(pg: PgLike): Pick<Db, "query"> {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      // PGlite runs multi-statement SQL (migrations) only through exec.
      if (params.length === 0) {
        const results = await pg.exec(sql);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      return (await pg.query<T>(sql, params)).rows;
    },
  };
}

/** A migrated in-process Postgres for tests. */
export async function memoryDb(): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    ...wrap(pg),
    tx: (fn) =>
      pg.transaction(async (t) => {
        const inner: Db = { ...wrap(t), tx: (nested) => nested(inner), close: async () => {} };
        return fn(inner);
      }),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
