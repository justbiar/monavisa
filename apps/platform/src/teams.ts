import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export interface Team {
  id: string;
  name: string;
  merchant: string;
}

export interface ApiKeySummary {
  id: string;
  label: string;
  /** First characters of the key, enough to recognise it. The key itself is never stored. */
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Creates a team for a merchant address with one API key, returned once. */
export async function createTeam(
  db: Db,
  input: { name: string; merchant: string },
): Promise<{ team: Team; apiKey: string }> {
  const team: Team = {
    id: `team_${randomBytes(8).toString("hex")}`,
    name: input.name,
    merchant: input.merchant.toLowerCase(),
  };
  await db.query("insert into teams (id, name, merchant) values ($1, $2, $3)", [
    team.id,
    team.name,
    team.merchant,
  ]);
  const { apiKey } = await createApiKey(db, team.id, "Default");
  return { team, apiKey };
}

export async function teamForMerchant(db: Db, merchant: string): Promise<Team | null> {
  const [row] = await db.query<Team>("select id, name, merchant from teams where merchant = $1", [
    merchant.toLowerCase(),
  ]);
  return row ?? null;
}

/** The merchant's team, created on first sign-in without any API key. */
export async function ensureTeamForMerchant(db: Db, merchant: string): Promise<Team> {
  const existing = await teamForMerchant(db, merchant);
  if (existing) return existing;
  const team: Team = {
    id: `team_${randomBytes(8).toString("hex")}`,
    name: shortAddress(merchant),
    merchant: merchant.toLowerCase(),
  };
  await db.query(
    "insert into teams (id, name, merchant) values ($1, $2, $3) on conflict (merchant) do nothing",
    [team.id, team.name, team.merchant],
  );
  return (await teamForMerchant(db, merchant)) ?? team;
}

export async function renameTeam(db: Db, teamId: string, name: string): Promise<void> {
  await db.query("update teams set name = $2 where id = $1", [teamId, name]);
}

export async function createApiKey(
  db: Db,
  teamId: string,
  label: string,
): Promise<{ id: string; apiKey: string; prefix: string }> {
  const id = `key_${randomBytes(8).toString("hex")}`;
  const apiKey = `mv_sk_${randomBytes(24).toString("hex")}`;
  const prefix = `${apiKey.slice(0, 10)}…`;
  await db.query(
    "insert into api_keys (id, team_id, label, prefix, key_hash) values ($1, $2, $3, $4, $5)",
    [id, teamId, label, prefix, hashApiKey(apiKey)],
  );
  return { id, apiKey, prefix };
}

export async function listApiKeys(db: Db, teamId: string): Promise<ApiKeySummary[]> {
  const rows = await db.query<{
    id: string;
    label: string;
    prefix: string;
    created_at: Date | string;
    revoked_at: Date | string | null;
  }>(
    "select id, label, prefix, created_at, revoked_at from api_keys where team_id = $1 order by created_at",
    [teamId],
  );
  const iso = (v: Date | string) => new Date(v).toISOString();
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    prefix: r.prefix,
    createdAt: iso(r.created_at),
    revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
  }));
}

/** Revokes a key immediately. Returns false when the key is unknown or already revoked. */
export async function revokeApiKey(db: Db, teamId: string, keyId: string): Promise<boolean> {
  const rows = await db.query(
    "update api_keys set revoked_at = now() where id = $1 and team_id = $2 and revoked_at is null returning id",
    [keyId, teamId],
  );
  return rows.length > 0;
}

export async function teamForApiKey(db: Db, apiKey: string): Promise<Team | null> {
  const [row] = await db.query<Team>(
    `select t.id, t.name, t.merchant from api_keys k join teams t on t.id = k.team_id
     where k.key_hash = $1 and k.revoked_at is null`,
    [hashApiKey(apiKey)],
  );
  return row ?? null;
}
