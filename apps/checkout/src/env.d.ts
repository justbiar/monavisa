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
  /** Adds a "Dev wallet" connector for this unlocked anvil account. Never set in production. */
  readonly VITE_DEV_ACCOUNT?: string;
}
