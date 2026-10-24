import { getChain, planFactoryAbi } from "@monavisa/core";
import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "./api.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

/** Shared by the Node entry point and the Cloudflare Worker. */
export function clients(cfg: Config): { chain: Chain; publicClient: PublicClient } {
  const chain = getChain(cfg.chainId);
  const publicClient: PublicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  return { chain, publicClient };
}

export function signer(cfg: Config, key: Hex): WalletClient<Transport, Chain, Account> {
  return createWalletClient({
    chain: getChain(cfg.chainId),
    account: privateKeyToAccount(key),
    transport: http(cfg.rpcUrl),
  });
}

export function buildApi(db: Db, cfg: Config) {
  const { publicClient } = clients(cfg);
  const facilitatorKey = cfg.facilitatorPrivateKey ?? cfg.keeperPrivateKey;
  const facilitatorWallet = facilitatorKey ? signer(cfg, facilitatorKey) : undefined;

  return createApi(db, {
    chainId: cfg.chainId,
    corsOrigins: cfg.corsOrigins,
    siweDomains: cfg.siweDomains,
    checkoutBaseUrl: cfg.checkoutUrl,
    sessionVault: cfg.contracts.sessionVault,
    publicClient,
    ...(facilitatorWallet ? { facilitatorWallet } : {}),
    // Covers EOAs, smart accounts and EIP-7702 delegated wallets.
    verifySiwe: ({ message, signature }) => publicClient.verifySiweMessage({ message, signature }),
    readPlanMerchant: async (planId) =>
      (
        await publicClient.readContract({
          address: cfg.contracts.planFactory,
          abi: planFactoryAbi,
          functionName: "getPlan",
          args: [planId],
        })
      ).merchant,
  });
}
