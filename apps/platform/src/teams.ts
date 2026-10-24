import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export interface Team {
  id: string;
  name: string;
  merchant: string;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Creates a team for a merchant address. The API key is returned once and only its hash is stored. */
export async function createTeam(
  db: Db,
  input: { name: string; merchant: string },
): Promise<{ team: Team; apiKey: string }> {
  const team: Team = {
    id: `team_${randomBytes(8).toString("hex")}`,
    name: input.name,
    merchant: input.merchant.toLowerCase(),
  };
  const apiKey = `mv_sk_${randomBytes(24).toString("hex")}`;
  await db.query("insert into teams (id, name, merchant, api_key_hash) values ($1, $2, $3, $4)", [
    team.id,
    team.name,
    team.merchant,
    hashApiKey(apiKey),
  ]);
  return { team, apiKey };
}

export async function teamForApiKey(db: Db, apiKey: string): Promise<Team | null> {
  const [row] = await db.query<Team>(
    "select id, name, merchant from teams where api_key_hash = $1",
    [hashApiKey(apiKey)],
  );
  return row ?? null;
}
