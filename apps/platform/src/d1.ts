import { bindValue, type Db, toSqlite } from "./db.js";

/** The parts of the Cloudflare D1 binding the platform uses. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T>(): Promise<{ results: T[] }>;
}

export function createD1Db(d1: D1Database): Db {
  const statement = (sql: string, params: unknown[] = []) =>
    d1.prepare(toSqlite(sql)).bind(...params.map(bindValue));
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return (await statement(sql, params).all<T>()).results;
    },
    async batch(statements) {
      await d1.batch(statements.map((s) => statement(s.sql, s.params)));
    },
    close: async () => {},
  };
}
