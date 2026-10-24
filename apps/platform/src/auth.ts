import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import type { Db } from "./db.js";
import { ensureTeamForMerchant, hashApiKey, type Team } from "./teams.js";

export const NONCE_TTL_SEC = 10 * 60;
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
export const SESSION_PREFIX = "mv_sess_";

/**
 * Checks the SIWE signature. In production this is publicClient.verifySiweMessage, which also
 * covers smart accounts and EIP-7702 delegated EOAs (ERC-1271 / ERC-6492).
 */
export type SiweVerifier = (args: { message: string; signature: Hex }) => Promise<boolean>;

export interface LoginOptions {
  verify: SiweVerifier;
  /** Hosts allowed in the message's domain field, e.g. "localhost:5174" or "dashboard.monavisa.xyz". */
  domains: readonly string[];
  chainId: number;
  now: number;
}

export type LoginResult =
  | { ok: true; token: string; team: Team; address: string; expiresAt: number }
  | { ok: false; error: string };

export async function issueNonce(db: Db, now: number): Promise<string> {
  const nonce = generateSiweNonce();
  await db.query("delete from auth_nonces where expires_at <= $1", [now]);
  await db.query("insert into auth_nonces (nonce, expires_at) values ($1, $2)", [
    nonce,
    now + NONCE_TTL_SEC,
  ]);
  return nonce;
}

export async function login(
  db: Db,
  input: { message: string; signature: Hex },
  options: LoginOptions,
): Promise<LoginResult> {
  let fields: ReturnType<typeof parseSiweMessage>;
  try {
    fields = parseSiweMessage(input.message);
  } catch {
    return { ok: false, error: "Message is not a valid sign-in message" };
  }
  const { address, domain, nonce, chainId, expirationTime } = fields;
  if (!address || !domain || !nonce || chainId === undefined) {
    return { ok: false, error: "Message is missing address, domain, nonce or chain" };
  }
  if (!options.domains.includes(domain)) {
    return { ok: false, error: `Sign-in from ${domain} is not allowed` };
  }
  if (chainId !== options.chainId) {
    return { ok: false, error: `Sign in on chain ${options.chainId}` };
  }
  if (expirationTime && expirationTime.getTime() / 1000 < options.now) {
    return { ok: false, error: "Sign-in message has expired" };
  }

  // Nonces are single use: the delete fails for a replayed or expired one.
  const used = await db.query(
    "delete from auth_nonces where nonce = $1 and expires_at > $2 returning nonce",
    [nonce, options.now],
  );
  if (used.length === 0) return { ok: false, error: "Sign-in request expired. Try again." };

  const valid = await options.verify(input).catch(() => false);
  if (!valid) return { ok: false, error: "Signature does not match the wallet" };

  const team = await ensureTeamForMerchant(db, address);
  const token = `${SESSION_PREFIX}${randomBytes(24).toString("hex")}`;
  const expiresAt = options.now + SESSION_TTL_SEC;
  await db.query(
    "insert into sessions (token_hash, team_id, address, expires_at) values ($1, $2, $3, $4)",
    [hashApiKey(token), team.id, address.toLowerCase(), expiresAt],
  );
  return { ok: true, token, team, address: address.toLowerCase(), expiresAt };
}

export async function teamForSession(db: Db, token: string, now: number): Promise<Team | null> {
  const [row] = await db.query<Team>(
    `select t.id, t.name, t.merchant from sessions s join teams t on t.id = s.team_id
     where s.token_hash = $1 and s.expires_at > $2`,
    [hashApiKey(token), now],
  );
  return row ?? null;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query("delete from sessions where token_hash = $1", [hashApiKey(token)]);
}
