/// <reference types="vite/client" />

declare const __LOCAL_DEPLOYMENT__: {
  chainId: number;
  planFactory: `0x${string}`;
  subscriptionRegistry: `0x${string}`;
  autopayModule: `0x${string}`;
  usdc: `0x${string}`;
} | null;

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  /** Overrides the chain's default RPC, e.g. a local anvil fork. */
  readonly VITE_RPC_URL?: string;
  /** Mona Visa platform API. Defaults to http://localhost:8787. */
  readonly VITE_API_URL?: string;
  /** Hosted checkout, for plan links. Defaults to http://localhost:5173. */
  readonly VITE_CHECKOUT_URL?: string;
  /** Adds a "Dev wallet" connector for this unlocked anvil account. Never set in production. */
  readonly VITE_DEV_ACCOUNT?: string;
  /** The same site on the other Monad network, linked from the network strip. */
  readonly VITE_OTHER_NETWORK_URL?: string;
}
