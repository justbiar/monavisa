import { defineChain } from "viem";
import { monad as viemMonad, monadTestnet as viemMonadTestnet } from "viem/chains";

export const MONAD_CHAIN_ID = 143;
export const MONAD_TESTNET_CHAIN_ID = 10143;

export const monad = viemMonad;

/** viem's testnet entry points at an older explorer, so Monadscan is used instead. */
export const monadTestnet = defineChain({
  ...viemMonadTestnet,
  blockExplorers: {
    default: {
      name: "Monadscan Testnet",
      url: "https://testnet.monadscan.com",
      apiUrl: "https://api.etherscan.io/v2/api?chainid=10143",
    },
  },
});

export const supportedChains = [monad, monadTestnet] as const;

export type SupportedChain = (typeof supportedChains)[number];
export type SupportedChainId = SupportedChain["id"];

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return supportedChains.some((chain) => chain.id === chainId);
}

export function getChain(chainId: number): SupportedChain {
  const chain = supportedChains.find((c) => c.id === chainId);
  if (!chain) throw new UnsupportedChainError(chainId);
  return chain;
}

export class UnsupportedChainError extends Error {
  readonly chainId: number;

  constructor(chainId: number) {
    super(`Chain ${chainId} is not supported by Mona Visa`);
    this.name = "UnsupportedChainError";
    this.chainId = chainId;
  }
}
