import { getNetwork } from "@monavisa/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Address } from "viem";

export interface MonaVisaAddresses {
  planFactory: Address;
  registry: Address;
  autopay: Address;
  permit2: Address;
}

export interface MonaVisaContextValue {
  chainId: number;
  addresses: MonaVisaAddresses;
}

const MonaVisaContext = createContext<MonaVisaContextValue | null>(null);

export interface MonaVisaProviderProps {
  chainId: number;
  /** Overrides for a local devnet or before addresses are recorded in @monavisa/core. */
  addresses?: Partial<MonaVisaAddresses>;
  children: ReactNode;
}

/** Place inside WagmiProvider. Resolves contract addresses for `chainId`. */
export function MonaVisaProvider({ chainId, addresses, children }: MonaVisaProviderProps) {
  const value = useMemo<MonaVisaContextValue>(() => {
    const network = getNetwork(chainId);
    const resolve = (name: keyof MonaVisaAddresses, fallback: Address | null): Address => {
      const address = addresses?.[name] ?? fallback;
      if (!address) throw new Error(`Mona Visa ${name} address is not known for chain ${chainId}`);
      return address;
    };
    return {
      chainId,
      addresses: {
        planFactory: resolve("planFactory", network.contracts.planFactory),
        registry: resolve("registry", network.contracts.subscriptionRegistry),
        autopay: resolve("autopay", network.contracts.autopayModule),
        permit2: resolve("permit2", network.permit2),
      },
    };
  }, [chainId, addresses]);

  return <MonaVisaContext.Provider value={value}>{children}</MonaVisaContext.Provider>;
}

export function useMonaVisa(): MonaVisaContextValue {
  const value = useContext(MonaVisaContext);
  if (!value) throw new Error("useMonaVisa must be used inside <MonaVisaProvider>");
  return value;
}
