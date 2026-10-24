# Mona Visa

Non-custodial subscriptions, entitlements and agent payments on [Monad](https://monad.xyz).

Merchants create plans on-chain and get paid in USDC straight to their own treasury. Subscribers approve once through Permit2, and renewals then run automatically without Mona Visa ever holding their funds. The same rails also let AI agents pay for APIs per request over HTTP 402 (x402), from prepaid sessions with spending mandates and escrow.

The full protocol design is in [docs/PLAN.md](docs/PLAN.md).

## Live on Monad Testnet

| | |
| :-- | :-- |
| Merchant dashboard | https://monavisa-dashboard.selfbiar.workers.dev |
| Hosted checkout (plan 1) | https://monavisa-checkout.selfbiar.workers.dev/plan/1 |
| Platform API | https://monavisa-api.selfbiar.workers.dev |

All three run on Cloudflare Workers. The API keeps its index in Cloudflare D1.

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

Solidity 0.8.30 (EVM `prague`), deployed behind UUPS proxies on Monad Testnet (chain ID `10143`).

| Contract | Address |
| :-- | :-- |
| PlanFactory | [`0xAB58722C88804461aeb3bf6ba19Db2A9591F0D07`](https://testnet.monadscan.com/address/0xAB58722C88804461aeb3bf6ba19Db2A9591F0D07) |
| SubscriptionRegistry | [`0x8e01FF28C628B975bd04e94C6F3441aC8B742D0a`](https://testnet.monadscan.com/address/0x8e01FF28C628B975bd04e94C6F3441aC8B742D0a) |
| AutopayModule | [`0x50F1dF3adF823676e1f7B6F0c1bD8da547d6291c`](https://testnet.monadscan.com/address/0x50F1dF3adF823676e1f7B6F0c1bD8da547d6291c) |
| FeeCollector | [`0x9fFeb1C740357e1B890C2f68B76FEc86DD0aBBfe`](https://testnet.monadscan.com/address/0x9fFeb1C740357e1B890C2f68B76FEc86DD0aBBfe) |
| SessionVault | [`0x9B9EDD27487122E89E972968e2A8e89dC15CCe9d`](https://testnet.monadscan.com/address/0x9B9EDD27487122E89E972968e2A8e89dC15CCe9d) |

External contracts used on testnet: USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3` (Circle FiatToken, EIP-2612 and EIP-3009), Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` and Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`.

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

Contracts go to testnet with `scripts/deploy-testnet.mjs`. The apps deploy to Cloudflare Workers. Production builds read each app's `.env.production`:

```bash
corepack pnpm --filter @monavisa/dashboard... --filter @monavisa/checkout... --filter @monavisa/platform... build
```

```bash
cd apps/platform && npx wrangler deploy
```

Run the same `wrangler deploy` in `apps/dashboard` and `apps/checkout`.

The API Worker binds the D1 database `monavisa` as `DB` and applies its migrations on first use. The keeper and settler run from a cron trigger every minute and need a `KEEPER_PRIVATE_KEY` secret for a wallet with some MON for gas. `FACILITATOR_PRIVATE_KEY` is optional and falls back to the keeper key.

## Status

Testnet only. The contracts have not been audited yet. See [docs/AUDIT_SCOPE.md](docs/AUDIT_SCOPE.md) and [docs/MAINNET_CHECKLIST.md](docs/MAINNET_CHECKLIST.md) for what remains before mainnet.

## License

MIT
