import type { Address } from "viem";
import {
  MONAD_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  UnsupportedChainError,
  type SupportedChainId,
} from "./chains.js";

/** A stablecoin Mona Visa settles in, with the EIP-712 domain it signs under. */
export interface Stablecoin {
  address: Address;
  symbol: string;
  decimals: number;
  /** EIP-712 domain name and version, used for EIP-2612 and EIP-3009 signatures. */
  eip712: { name: string; version: string };
}

/** Mona Visa protocol contracts. `null` until deployed on that network. */
export interface MonaVisaContracts {
  planFactory: Address | null;
  subscriptionRegistry: Address | null;
  autopayModule: Address | null;
  feeCollector: Address | null;
  sessionVault: Address | null;
}

export interface Network {
  chainId: SupportedChainId;
  usdc: Stablecoin;
  permit2: Address;
  entryPointV07: Address;
  multicall3: Address;
  contracts: MonaVisaContracts;
}

// Canonical contracts share one address on both networks.
// Kept in sync with contracts/src/libraries/MonadAddresses.sol (see test/networks.test.ts).
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ENTRYPOINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const NOT_DEPLOYED: MonaVisaContracts = {
  planFactory: null,
  subscriptionRegistry: null,
  autopayModule: null,
  feeCollector: null,
  sessionVault: null,
};

export const networks: Record<SupportedChainId, Network> = {
  [MONAD_CHAIN_ID]: {
    chainId: MONAD_CHAIN_ID,
    usdc: {
      address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      symbol: "USDC",
      decimals: 6,
      eip712: { name: "USDC", version: "2" },
    },
    permit2: PERMIT2,
    entryPointV07: ENTRYPOINT_V07,
    multicall3: MULTICALL3,
    contracts: NOT_DEPLOYED,
  },
  [MONAD_TESTNET_CHAIN_ID]: {
    chainId: MONAD_TESTNET_CHAIN_ID,
    usdc: {
      address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      symbol: "USDC",
      decimals: 6,
      eip712: { name: "USDC", version: "2" },
    },
    permit2: PERMIT2,
    entryPointV07: ENTRYPOINT_V07,
    multicall3: MULTICALL3,
    contracts: {
      planFactory: "0xAB58722C88804461aeb3bf6ba19Db2A9591F0D07",
      subscriptionRegistry: "0x8e01FF28C628B975bd04e94C6F3441aC8B742D0a",
      autopayModule: "0x50F1dF3adF823676e1f7B6F0c1bD8da547d6291c",
      feeCollector: "0x9fFeb1C740357e1B890C2f68B76FEc86DD0aBBfe",
      sessionVault: "0x9B9EDD27487122E89E972968e2A8e89dC15CCe9d",
    },
  },
};

export function getNetwork(chainId: number): Network {
  const network = networks[chainId as SupportedChainId];
  if (!network) throw new UnsupportedChainError(chainId);
  return network;
}

/** Returns a deployed Mona Visa contract address, or throws if it is not deployed yet. */
export function getContractAddress(chainId: number, name: keyof MonaVisaContracts): Address {
  const address = getNetwork(chainId).contracts[name];
  if (!address) throw new Error(`${name} is not deployed on chain ${chainId}`);
  return address;
}
