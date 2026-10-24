import { type Db, migrate } from "../src/db.js";
import { createSqliteDb } from "../src/sqlite.js";

/** A migrated in-memory SQLite database for tests, the same dialect as D1. */
export async function memoryDb(): Promise<Db> {
  const db = createSqliteDb(":memory:");
  await migrate(db);
  return db;
}
