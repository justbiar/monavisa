# Mona Visa

Non-custodial subscriptions, entitlements and agent payments on [Monad](https://monad.xyz).

Merchants create plans on-chain and get paid in USDC straight to their own treasury. Subscribers approve once through Permit2, and renewals then run automatically without Mona Visa ever holding their funds. The same rails also let AI agents pay for APIs per request over HTTP 402 (x402), from prepaid sessions with spending mandates and escrow.

The full protocol design is in [docs/PLAN.md](docs/PLAN.md).

## Live

Mona Visa runs on Monad Mainnet and Monad Testnet side by side. Each network has its own dashboard, checkout, API and database, and the network strip at the top of each site links to the other one.

| | Monad Mainnet (chain `143`) | Monad Testnet (chain `10143`) |
| :-- | :-- | :-- |
| Merchant dashboard | https://monavisa-dashboard-mainnet.selfbiar.workers.dev | https://monavisa-dashboard.selfbiar.workers.dev |
| Hosted checkout | https://monavisa-checkout-mainnet.selfbiar.workers.dev | https://monavisa-checkout.selfbiar.workers.dev |
| Platform API | https://monavisa-api-mainnet.selfbiar.workers.dev | https://monavisa-api.selfbiar.workers.dev |

All of it runs on Cloudflare Workers, and each API keeps its index in its own Cloudflare D1 database.

### Fees

Mona Visa charges a **1% protocol fee** (100 bps) on both networks:

- **Subscriptions:** the fee is added on top of the plan price. A 10 USDC plan charges the subscriber 10.10 USDC, and the merchant receives the full 10 USDC.
- **Agent payments:** the fee comes out of each redeemed voucher or settled escrow, so a payee redeeming 1 USDC receives 0.99 USDC.

Fees accumulate in `FeeCollector`, and anyone can call `withdraw(token)` to send them to the treasury. The admin can change both rates, up to the contract's 10% cap. Renewal gas is paid by the keeper, not by merchants or subscribers.

## How it works

```
 subscriber wallet ──Permit2──▶ AutopayModule ──USDC──▶ merchant treasury
                                     │                 └─fee─▶ FeeCollector
                                     ▼
 merchant ──createPlan──▶ PlanFactory      SubscriptionRegistry
                                     │
                       events        ▼
 Platform (indexer · keeper · webhooks · x402 facilitator · API)
        │                       │                    │
   dashboard / checkout    @monavisa/node       agents (@monavisa/agent, MCP)
```

- **Subscriptions.** A plan fixes the token, price, period, trial and grace period. The keeper calls `renewMany` when periods end. If a charge fails, the subscription goes past due and is retried, then expires once the grace period runs out.
- **Entitlements.** Merchants map feature keys to plans. Their backend asks the API whether a wallet currently has a feature.
- **Webhooks.** Subscription, invoice, session and escrow events are signed with HMAC-SHA256 and retried with backoff.
- **Agent payments.** `SessionVault` holds prepaid sessions. Agents sign cumulative vouchers per payee, which the facilitator verifies off-chain and the settler redeems on-chain in batches. Exact one-off payments use EIP-3009 `transferWithAuthorization`. Hierarchical mandates cap what an agent may spend, and escrows support verify-then-settle.

## Contracts

Solidity 0.8.30 (EVM `prague`), deployed behind UUPS proxies. On both networks the admin roles and the fee treasury belong to `0x232BAe5D6548F9f01a4152584498497683e24a5a`; the deployer kept no roles.

### Monad Mainnet

| Contract | Address |
| :-- | :-- |
| PlanFactory | [`0xB6545c301e655CE45f64A44B51434466597D8f49`](https://monadscan.com/address/0xB6545c301e655CE45f64A44B51434466597D8f49) |
| SubscriptionRegistry | [`0x67ce32FC1CcC61d7CAC895A707DD2353C3ACE696`](https://monadscan.com/address/0x67ce32FC1CcC61d7CAC895A707DD2353C3ACE696) |
| AutopayModule | [`0xf5a46AE08fDA674D0a26Af661575867f37a612b7`](https://monadscan.com/address/0xf5a46AE08fDA674D0a26Af661575867f37a612b7) |
| FeeCollector | [`0x438e9181b308E502CA72907a2D20b8389Cc2Dd3F`](https://monadscan.com/address/0x438e9181b308E502CA72907a2D20b8389Cc2Dd3F) |
| SessionVault | [`0x6A3455667bEF02F014bB54dF3A66987b9Bd77F2c`](https://monadscan.com/address/0x6A3455667bEF02F014bB54dF3A66987b9Bd77F2c) |

Settlement token: USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`.

### Monad Testnet

| Contract | Address |
| :-- | :-- |
| PlanFactory | [`0xAB58722C88804461aeb3bf6ba19Db2A9591F0D07`](https://testnet.monadscan.com/address/0xAB58722C88804461aeb3bf6ba19Db2A9591F0D07) |
| SubscriptionRegistry | [`0x8e01FF28C628B975bd04e94C6F3441aC8B742D0a`](https://testnet.monadscan.com/address/0x8e01FF28C628B975bd04e94C6F3441aC8B742D0a) |
| AutopayModule | [`0x50F1dF3adF823676e1f7B6F0c1bD8da547d6291c`](https://testnet.monadscan.com/address/0x50F1dF3adF823676e1f7B6F0c1bD8da547d6291c) |
| FeeCollector | [`0x9fFeb1C740357e1B890C2f68B76FEc86DD0aBBfe`](https://testnet.monadscan.com/address/0x9fFeb1C740357e1B890C2f68B76FEc86DD0aBBfe) |
| SessionVault | [`0x9B9EDD27487122E89E972968e2A8e89dC15CCe9d`](https://testnet.monadscan.com/address/0x9B9EDD27487122E89E972968e2A8e89dC15CCe9d) |

Settlement token: USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3`.

Both networks use Circle USDC (EIP-2612 and EIP-3009) and the canonical Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` and Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`.

## Repository layout

```
contracts/          Foundry project: PlanFactory, SubscriptionRegistry, AutopayModule,
                    FeeCollector, SessionVault, ERC-7579 autopay executor
packages/core/      @monavisa/core   chain config, addresses, ABIs, typed data, x402, mandates
packages/node/      @monavisa/node   server SDK: entitlements, customers, webhooks, x402 middleware
packages/react/     @monavisa/react  wagmi hooks: usePlan, useSubscription, useCheckout, ...
packages/agent/     @monavisa/agent  agent SDK: x402 fetch, sessions, escrow, mandates
packages/mcp/       @monavisa/mcp    MCP server exposing agent payments as tools
packages/theme/     @monavisa/theme  shared design tokens and component styles
apps/platform/      indexer, renewal keeper, webhook dispatcher, settler, x402 facilitator, HTTP API
apps/dashboard/     merchant dashboard with Sign-In with Ethereum
apps/checkout/      hosted checkout (/plan/:id) and payment links (/l/:id)
examples/           x402-protected API, paying agent, MCP agent config
scripts/            testnet deploy, local devnet seeding, platform runner
docs/               protocol plan, audit scope, mainnet checklist, monitoring
```

## Getting started

Requirements: Node.js 22.13 or newer, pnpm 10 (through Corepack) and [Foundry](https://getfoundry.sh).

```bash
git clone --recurse-submodules https://github.com/justbiar/monavisa.git
cd monavisa
corepack pnpm install
corepack pnpm build
```

Run the checks:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm contracts:test
```

### Local development

Start an anvil fork of Monad Testnet and seed it with the contracts, a mock USDC, two plans and two funded subscribers:

```bash
anvil --fork-url https://testnet-rpc.monad.xyz --code-size-limit 131072
```

```bash
scripts/local-devnet.sh
```

Then, each in its own terminal:

```bash
scripts/dev-platform.sh
```

```bash
corepack pnpm --filter @monavisa/dashboard dev
```

```bash
corepack pnpm --filter @monavisa/checkout dev
```

The API listens on http://localhost:8787, the checkout on http://localhost:5173 and the dashboard on http://localhost:5174. Locally the platform stores its index in a SQLite file under `.data/`.

The platform CLI can also run each part on its own:

```bash
node apps/platform/dist/main.js all   # or: api, indexer, keeper, settler, webhooks, migrate
```

## Using the SDKs

### Gate features on your backend

```ts
import { MonaVisaClient } from "@monavisa/node";

const monavisa = new MonaVisaClient({
  apiKey: process.env.MONAVISA_API_KEY!,
  baseUrl: "https://monavisa-api.selfbiar.workers.dev",
});

await monavisa.setFeature("pro", ["1"]);

const { enabled } = await monavisa.checkEntitlement("pro", { address: customerWallet });
```

API keys are created in the dashboard under API keys.

### Subscribe from a React app

```tsx
import { useCheckout, usePlan, useSubscription } from "@monavisa/react";

// Rendered inside <WagmiProvider> and <MonaVisaProvider chainId={10143}>.
function Subscribe({ planId }: { planId: bigint }) {
  const { plan } = usePlan(planId);
  const { subscribe, state } = useCheckout(plan);
  const subscription = useSubscription(planId);
  // ...
}
```

Or skip the integration and send customers to the hosted checkout at `/plan/<id>`, or to a payment link created in the dashboard.

### Charge agents per request (x402)

```ts
import { Hono } from "hono";
import { x402Middleware } from "@monavisa/node";

const app = new Hono();

// 0.10 USDC per call, paid from a prepaid session or with an EIP-3009 authorization.
app.use("/compute", x402Middleware({ payTo: merchantAddress, amount: "100000" }));
```

### Pay as an agent

```ts
import { createAgentFetch } from "@monavisa/agent";

const agentFetch = createAgentFetch({ account, maxPerCall: 1_000_000n });
const res = await agentFetch("https://api.example.com/compute", { method: "POST" });
```

`agentFetch` answers 402 challenges by itself and never pays more than `maxPerCall`. For MCP clients such as Claude Desktop, see [examples/mcp-agent](examples/mcp-agent).

## Deploying

### Contracts

```bash
cd contracts
ADMIN=0x... TREASURY=0x... SUBSCRIPTION_FEE_BPS=100 AGENT_FEE_BPS=100 \
  forge script script/DeployMonaVisa.s.sol --rpc-url https://rpc.monad.xyz --account <keystore> --broadcast --slow
```

Monad prices cold storage access higher than the standard EVM, so Forge's local gas estimates can come out too low for the role-granting calls at the end. If one of them runs out of gas, resend the remaining calls from `broadcast/` with gas estimated by the Monad RPC. Record the new addresses in `packages/core/src/networks.ts`.

### Apps

Testnet builds read each app's `.env.production` and deploy as the default Worker. Mainnet builds read `.env.mainnet` and deploy to the `mainnet` Wrangler environment:

```bash
corepack pnpm --filter @monavisa/dashboard... --filter @monavisa/checkout... --filter @monavisa/platform... build
corepack pnpm --filter @monavisa/dashboard --filter @monavisa/checkout build:mainnet
```

```bash
cd apps/platform && npx wrangler deploy && npx wrangler deploy --env mainnet
```

Run the same two `wrangler deploy` commands in `apps/dashboard` and `apps/checkout`.

Each API Worker binds its D1 database (`monavisa` or `monavisa-mainnet`) as `DB` and applies its migrations on first use. The indexer, keeper, webhooks and settler run from a cron trigger every minute. The keeper and settler need a `KEEPER_PRIVATE_KEY` secret (`--env mainnet` for mainnet) for a wallet with some MON for gas. Renewals are permissionless, so this wallet needs no role. `FACILITATOR_PRIVATE_KEY` is optional and falls back to the keeper key.

## Status

Live on Monad Mainnet since October 2026. The contracts have **not been audited yet**, so use them at your own risk and keep amounts small. The audit scope and the remaining hardening work are in [docs/AUDIT_SCOPE.md](docs/AUDIT_SCOPE.md) and [docs/MAINNET_CHECKLIST.md](docs/MAINNET_CHECKLIST.md).

## License

MIT
