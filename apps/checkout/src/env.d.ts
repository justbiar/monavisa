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
  /** Mona Visa platform API, for plan names and payment links. Optional. */
  readonly VITE_API_URL?: string;
  /** Adds a "Dev wallet" connector for this unlocked anvil account. Never set in production. */
  readonly VITE_DEV_ACCOUNT?: string;
  /** The merchant dashboard on the same network, linked from the homepage. */
  readonly VITE_DASHBOARD_URL?: string;
  /** A live plan to try, linked from the homepage. Defaults to /plan/1. */
  readonly VITE_DEMO_PLAN_URL?: string;
  /** The same site on the other Monad network, linked from the network strip. */
  readonly VITE_OTHER_NETWORK_URL?: string;
}
