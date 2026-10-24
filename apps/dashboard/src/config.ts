import { getChain, getNetwork } from "@monavisa/core";
import type { MonaVisaAddresses } from "@monavisa/react";
import { type Address, type Chain, defineChain, http, isAddress } from "viem";
import { createConfig } from "wagmi";
import { injected, mock } from "wagmi/connectors";

const local = __LOCAL_DEPLOYMENT__;
export const chainId = local?.chainId ?? Number(import.meta.env.VITE_CHAIN_ID ?? 10143);
const rpcUrl = import.meta.env.VITE_RPC_URL;

const base = getChain(chainId);
/** On a local fork the explorer would point at the real network, so it is dropped. */
export const chain: Chain = rpcUrl
  ? defineChain({ ...base, rpcUrls: { default: { http: [rpcUrl] } }, blockExplorers: undefined })
  : base;

export const addressOverrides: Partial<MonaVisaAddresses> | undefined = local
  ? {
      planFactory: local.planFactory,
      registry: local.subscriptionRegistry,
      autopay: local.autopayModule,
    }
  : undefined;

/** The settlement token new plans are priced in. */
export const settlementToken: Address = local?.usdc ?? getNetwork(chainId).usdc.address;

export const apiUrl = (import.meta.env.VITE_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const checkoutUrl = (import.meta.env.VITE_CHECKOUT_URL ?? "http://localhost:5173").replace(
  /\/$/,
  "",
);

const devAccount = import.meta.env.VITE_DEV_ACCOUNT;

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
