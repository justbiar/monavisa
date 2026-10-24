import { autopayModuleAbi } from "@monavisa/core";
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import type { Db } from "./db.js";

export interface KeeperConfig {
  autopay: Address;
  batchSize: number;
  /** Seconds to wait before retrying a past-due subscription whose charge failed. */
  retryAfterSec: number;
}

/**
 * Sends one renewMany transaction for the subscriptions that are due according to the index.
 * The contract decides what actually happens; the keeper only pays gas to trigger it.
 */
export async function runKeeperOnce(
  db: Db,
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account>,
  cfg: KeeperConfig,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ hash: Hex; subIds: bigint[] } | null> {
  const rows = await db.query<{ sub_id: string }>(
    `select sub_id from subscriptions
     where period_end <= $1
       and (status = 1
         or status = 3
         or (status = 2 and (last_keeper_attempt is null or last_keeper_attempt <= $2)))
     order by period_end
     limit $3`,
    [nowSec, nowSec - cfg.retryAfterSec, cfg.batchSize],
  );
  if (rows.length === 0) return null;

  const subIds = rows.map((r) => BigInt(r.sub_id));
  const call = {
    address: cfg.autopay,
    abi: autopayModuleAbi,
    functionName: "renewMany",
    args: [subIds],
    account: walletClient.account,
  } as const;

  // Monad bills the gas limit, not gas used, so keep the margin small.
  const estimate = await publicClient.estimateContractGas(call);
  const hash = await walletClient.writeContract({
    ...call,
    chain: walletClient.chain,
    gas: estimate + estimate / 10n,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  await db.query(
    `update subscriptions set last_keeper_attempt = $1
     where sub_id in (select cast(value as integer) from json_each($2))`,
    [nowSec, subIds.map(String)],
  );
  return { hash, subIds };
}
