import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bindValue, type Db, toSqlite } from "./db.js";

/** File-backed SQLite for the Node entry point, or in-memory (":memory:") for tests. */
export function createSqliteDb(path = "./.data/monavisa.sqlite"): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  // Matches D1, which enforces foreign keys.
  sqlite.exec("pragma foreign_keys = on; pragma journal_mode = wal;");

  // node:sqlite binds every JS number as REAL, which turns 49000000 into "49000000.0" in a text
  // column. Whole numbers go in as integers instead, as D1 does.
  const bind = (value: unknown) => {
    const v = bindValue(value);
    return typeof v === "number" && Number.isInteger(v) ? BigInt(v) : v;
  };
  const run = <T>(sql: string, params: unknown[] = []) =>
    sqlite.prepare(toSqlite(sql)).all(...params.map(bind)) as T[];

  return {
    async query<T>(sql: string, params?: unknown[]) {
      // Copy out of the null-prototype rows node:sqlite returns, so they compare like plain objects.
      return run<T>(sql, params).map((r) => ({ ...r }));
    },
    async batch(statements) {
      sqlite.exec("begin");
      try {
        for (const s of statements) run(s.sql, s.params);
        sqlite.exec("commit");
      } catch (err) {
        sqlite.exec("rollback");
        throw err;
      }
    },
    close: async () => sqlite.close(),
  };
}
