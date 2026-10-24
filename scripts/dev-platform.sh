#!/usr/bin/env bash
# Runs the platform (API, indexer, webhooks) against the anvil fork seeded by local-devnet.sh.
# Uses a local SQLite file (DB, default .data/monavisa-dev.sqlite). The keeper stays off: it needs a private key.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB:-$ROOT/.data/monavisa-dev.sqlite}"
DEPLOYMENT="$ROOT/contracts/deployments/local.json"
[ -f "$DEPLOYMENT" ] || { echo "Run scripts/local-devnet.sh first" >&2; exit 1; }

field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$DEPLOYMENT" "$1"; }

export DATABASE_URL="$DB"
export RPC_URL="${RPC:-http://127.0.0.1:8545}"
export CHAIN_ID="$(field chainId)"
export PLAN_FACTORY_ADDRESS="$(field planFactory)"
export SUBSCRIPTION_REGISTRY_ADDRESS="$(field subscriptionRegistry)"
export AUTOPAY_MODULE_ADDRESS="$(field autopayModule)"
export START_BLOCK="$(field startBlock)"
export BLOCK_TAG=latest
export SIWE_DOMAINS=localhost:5174
export CORS_ORIGINS=http://localhost:5173,http://localhost:5174
export CHECKOUT_URL=http://localhost:5173

pnpm --dir "$ROOT" --filter @monavisa/platform build >/dev/null
node "$ROOT/apps/platform/dist/main.js" migrate
exec node "$ROOT/apps/platform/dist/main.js" all
