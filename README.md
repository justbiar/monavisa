# MonCart

Non-custodial subscriptions, entitlements and agent payments on Monad. See [docs/PLAN.md](docs/PLAN.md) for the full protocol plan.

## Layout

```
contracts/        Foundry project (Solidity 0.8.30, evm_version prague)
packages/core/    @moncart/core: chains, canonical addresses, EIP-3009 typed data, fee and entitlement math
apps/             Platform API, settlement engine, indexer, dashboard, checkout (upcoming)
examples/         Integration examples (upcoming)
```

## Setup

Requires Node 22, pnpm 10 and Foundry.

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
pnpm contracts:test # forge tests (fork tests run when MONAD_RPC_URL / MONAD_TESTNET_RPC_URL are set)
```
