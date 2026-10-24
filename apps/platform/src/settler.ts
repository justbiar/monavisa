import { sessionVaultAbi } from "@monavisa/core";
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import type { Db } from "./db.js";

export interface SettlerConfig {
  sessionVault: Address;
  batchSize: number;
}

/**
 * Batches and redeems pending vouchers on-chain via SessionVault.redeemMany.
 */
export async function runSettlerOnce(
  db: Db,
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account>,
  cfg: SettlerConfig,
): Promise<{ hash: Hex; count: number } | null> {
  const rows = await db.query<{
    session_id: string;
    payee: string;
    cumulative_amount: string;
    signature: string;
    redeemed_amount: string;
  }>(
    `select session_id, payee, cumulative_amount, signature, redeemed_amount
     from vouchers
     where cumulative_amount != redeemed_amount and signature != ''
     order by updated_at asc
     limit $1`,
    [cfg.batchSize],
  );
  // Amounts are decimal text, so compare them as BigInt rather than in SQL.
  const pending = rows.filter((r) => BigInt(r.cumulative_amount) > BigInt(r.redeemed_amount));

  if (pending.length === 0) return null;

  const redemptions = pending.map((r) => ({
    sessionId: r.session_id as Hex,
    payee: r.payee as Address,
    cumulativeAmount: BigInt(r.cumulative_amount),
    signature: r.signature as Hex,
  }));

  const call = {
    address: cfg.sessionVault,
    abi: sessionVaultAbi,
    functionName: "redeemMany",
    args: [redemptions],
    account: walletClient.account,
  } as const;

  const estimate = await publicClient.estimateContractGas(call);
  const hash = await walletClient.writeContract({
    ...call,
    chain: walletClient.chain,
    gas: estimate + estimate / 10n,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  for (const r of redemptions) {
    await db.query(
      "update vouchers set redeemed_amount = cumulative_amount where session_id = $1 and payee = $2",
      [r.sessionId, r.payee.toLowerCase()],
    );
  }

  return { hash, count: redemptions.length };
}
