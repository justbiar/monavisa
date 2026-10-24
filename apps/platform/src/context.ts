import type { Address } from "viem";
import type { Team } from "./teams.js";

export type AuthKind = "session" | "key";

export interface AppEnv {
  Variables: { team: Team; authKind: AuthKind };
}

/** Reads a plan's merchant from the chain, for plans the indexer has not reached yet. */
export type PlanMerchantReader = (planId: bigint) => Promise<Address | null>;
