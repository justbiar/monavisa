import { MONAD_CHAIN_ID, getChain } from "@monavisa/core";
import type { MonaVisaAddresses } from "@monavisa/react";
import { type Address, type Chain, defineChain, http, isAddress } from "viem";
import { createConfig } from "wagmi";
import { injected, mock } from "wagmi/connectors";

const local = __LOCAL_DEPLOYMENT__;
export const chainId = local?.chainId ?? Number(import.meta.env.VITE_CHAIN_ID ?? 10143);
const rpcUrl = import.meta.env.VITE_RPC_URL;

const base = getChain(chainId);

export const isMainnet = chainId === MONAD_CHAIN_ID;
/** viem calls mainnet just "Monad"; spell it out next to the testnet. */
export const networkName = isMainnet ? "Monad Mainnet" : base.name;
export const otherNetworkUrl = import.meta.env.VITE_OTHER_NETWORK_URL?.replace(/\/$/, "") || null;
/** On a local fork the explorer would point at the real network, so it is dropped. */
export const chain: Chain = rpcUrl
  ? defineChain({
      ...base,
      rpcUrls: { default: { http: [rpcUrl] } },
      blockExplorers: undefined,
    })
  : base;

export const addressOverrides: Partial<MonaVisaAddresses> | undefined = local
  ? {
      planFactory: local.planFactory,
      registry: local.subscriptionRegistry,
      autopay: local.autopayModule,
    }
  : undefined;

const devAccount = import.meta.env.VITE_DEV_ACCOUNT;

/** Platform API for display data. Amounts never come from here; they are read from the chain. */
export const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, "") || null;

export const dashboardUrl = import.meta.env.VITE_DASHBOARD_URL?.replace(/\/$/, "") || null;
export const demoPlanUrl = import.meta.env.VITE_DEMO_PLAN_URL || "/plan/1";
export const repoUrl = "https://github.com/justbiar/monavisa";

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    injected(),
    ...(devAccount && isAddress(devAccount)
      ? [mock({ accounts: [devAccount as Address], features: { reconnect: true } })]
      : []),
  ],
  transports: { [chain.id]: http(rpcUrl) },
});

export function explorerTxUrl(hash: string): string | null {
  const explorer = chain.blockExplorers?.default.url;
  return explorer ? `${explorer}/tx/${hash}` : null;
}

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
