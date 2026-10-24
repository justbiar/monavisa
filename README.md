# Mona Visa

Non-custodial subscriptions, entitlements and agent payments on Monad. See [docs/PLAN.md](docs/PLAN.md) for the full protocol plan.

## Layout

```
contracts/        Foundry project (Solidity 0.8.30, evm_version prague)
packages/core/    @monavisa/core: chains, addresses, ABIs, EIP-3009 typed data, fees, entitlement, webhook signing
packages/node/    @monavisa/node: server SDK (entitlement checks, customers, features, webhook verification)
packages/react/   @monavisa/react: wagmi v3 hooks (usePlan, useSubscription, useEntitlement, useCheckout, useManageSubscription)
apps/platform/    Indexer, renewal keeper, webhook dispatcher and HTTP API
apps/checkout/    Hosted checkout at /plan/<id> (Vite + React)
scripts/          Local devnet seeding
pitch/            90 second pitch page
```

## Setup

Requires Node 22, pnpm 10, Foundry and Postgres.

```bash
git submodule update --init --recursive
pnpm install
cp .env.example .env
```

## Commands

```bash
pnpm build          # build all packages
pnpm typecheck
pnpm test           # vitest across packages
pnpm lint           # prettier check
pnpm abis           # forge build and regenerate packages/core/src/abis.ts
pnpm contracts:test # forge tests (fork tests run when MONAD_RPC_URL / MONAD_TESTNET_RPC_URL are set)
```

`apps/platform/test/e2e.test.ts` deploys to an anvil fork of Monad testnet and runs the whole flow (subscribe, entitlement, keeper renewal, signed webhooks). It runs when `MONAD_TESTNET_RPC_URL` is set and anvil is installed.

## Running the platform

```bash
pnpm --filter @monavisa/platform build
cd apps/platform
node dist/main.js migrate
node dist/main.js create-team "My Team" 0xYourMerchantAddress   # prints the API key once
node dist/main.js all                                          # api + indexer + webhooks (+ keeper if KEEPER_PRIVATE_KEY is set)
```

Then from your backend:

```ts
import { MonaVisaClient } from "@monavisa/node";

const monavisa = new MonaVisaClient({
  apiKey: process.env.MONAVISA_API_KEY!,
  baseUrl: "http://localhost:8787",
});
await monavisa.setFeature("pro_dashboard", [1]);
const { enabled } = await monavisa.checkEntitlement("pro_dashboard", { address: customerWallet });
```

## Local devnet

```bash
anvil --fork-url https://testnet-rpc.monad.xyz --code-size-limit 131072
scripts/local-devnet.sh                     # deploy, create 2 plans, fund 2 subscribers, write apps/checkout/.env.local
pnpm --filter @monavisa/checkout dev         # http://localhost:5173/plan/1?name=Pro&merchant=Demo
```

The checkout shows a "Dev cüzdanı (anvil)" option that signs with an unlocked anvil account, so no keys or browser wallet are needed. The code size flag matches Monad's 128 KB limit.

anvil's default keys are public, and on Monad testnet those addresses carry EIP-7702 delegations set by strangers. The seed script clears them on the fork for accounts 0 to 2. Account 3 keeps its delegation so the checkout path for accounts with code (on-chain Permit2 approval instead of a signature) can be tested by pointing `VITE_DEV_ACCOUNT` at it.
