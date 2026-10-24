# MonCart

Non-custodial subscriptions, entitlements and agent payments on Monad. See [docs/PLAN.md](docs/PLAN.md) for the full protocol plan.

## Layout

```
contracts/        Foundry project (Solidity 0.8.30, evm_version prague)
packages/core/    @moncart/core: chains, addresses, ABIs, EIP-3009 typed data, fees, entitlement, webhook signing
packages/node/    @moncart/node: server SDK (entitlement checks, customers, features, webhook verification)
apps/platform/    Indexer, renewal keeper, webhook dispatcher and HTTP API
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
pnpm --filter @moncart/platform build
cd apps/platform
node dist/main.js migrate
node dist/main.js create-team "My Team" 0xYourMerchantAddress   # prints the API key once
node dist/main.js all                                          # api + indexer + webhooks (+ keeper if KEEPER_PRIVATE_KEY is set)
```

Then from your backend:

```ts
import { MonCartClient } from "@moncart/node";

const moncart = new MonCartClient({
  apiKey: process.env.MONCART_API_KEY!,
  baseUrl: "http://localhost:8787",
});
await moncart.setFeature("pro_dashboard", [1]);
const { enabled } = await moncart.checkEntitlement("pro_dashboard", { address: customerWallet });
```

## Local devnet

```bash
anvil --fork-url https://testnet-rpc.monad.xyz --code-size-limit 131072
cd contracts && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 \
  --broadcast --unlocked --sender <first anvil account> --code-size-limit 131072
```

Addresses are written to `contracts/deployments/local.json`. The code size flag matches Monad's 128 KB limit.
