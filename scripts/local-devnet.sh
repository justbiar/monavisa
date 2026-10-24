#!/usr/bin/env bash
# Seeds a running anvil fork of Monad testnet for local checkout development:
#   anvil --fork-url https://testnet-rpc.monad.xyz --code-size-limit 131072
#   scripts/local-devnet.sh
#
# Deploys Mona Visa with a mintable mock USDC, creates two plans as the merchant (anvil account 1),
# funds two subscribers (anvil accounts 2 and 3) with 1,000 mock USDC each and writes
# apps/checkout/.env.local.
# Uses anvil's unlocked accounts, so no private keys are involved.
set -euo pipefail

RPC="${RPC:-http://127.0.0.1:8545}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

accounts=$(cast rpc eth_accounts --rpc-url "$RPC")
account() { python3 -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])])" "$accounts" "$1"; }
DEPLOYER=$(account 0)
MERCHANT=$(account 1)
SUBSCRIBER=$(account 2)
SMART_SUBSCRIBER=$(account 3)

# anvil's default keys are public, so on Monad testnet these addresses carry EIP-7702 delegations
# set by strangers. Clear them for the deployer, merchant and the plain-EOA subscriber. Account 3
# keeps its delegation to exercise the checkout path for accounts with code.
for a in "$DEPLOYER" "$MERCHANT" "$SUBSCRIBER"; do
  cast rpc anvil_setCode "$a" 0x --rpc-url "$RPC" >/dev/null
done

echo "Deploying to $RPC as $DEPLOYER"
(cd "$ROOT/contracts" && forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast \
  --unlocked --sender "$DEPLOYER" --code-size-limit 131072 --silent)

field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$ROOT/contracts/deployments/local.json" "$1"; }
USDC=$(field usdc)
PLAN_FACTORY=$(field planFactory)

send() { cast send --rpc-url "$RPC" --unlocked --from "$@" >/dev/null; }
DAY=86400
send "$MERCHANT" "$PLAN_FACTORY" "createPlan(address,uint96,uint32,uint32,uint32,address)" \
  "$USDC" 49000000 $((30 * DAY)) 0 $((3 * DAY)) "$MERCHANT"
send "$MERCHANT" "$PLAN_FACTORY" "createPlan(address,uint96,uint32,uint32,uint32,address)" \
  "$USDC" 99000000 $((30 * DAY)) $((7 * DAY)) $((3 * DAY)) "$MERCHANT"
send "$DEPLOYER" "$USDC" "mint(address,uint256)" "$SUBSCRIBER" 1000000000
send "$DEPLOYER" "$USDC" "mint(address,uint256)" "$SMART_SUBSCRIBER" 1000000000

API="${API:-http://localhost:8787}"
cat > "$ROOT/apps/checkout/.env.local" <<EOF
VITE_USE_LOCAL_DEPLOYMENT=1
VITE_RPC_URL=$RPC
VITE_API_URL=$API
VITE_DEV_ACCOUNT=$SUBSCRIBER
EOF
cat > "$ROOT/apps/dashboard/.env.local" <<EOF
VITE_USE_LOCAL_DEPLOYMENT=1
VITE_RPC_URL=$RPC
VITE_API_URL=$API
VITE_CHECKOUT_URL=http://localhost:5173
VITE_DEV_ACCOUNT=$MERCHANT
EOF

echo
echo "Merchant:   $MERCHANT"
echo "Subscriber: $SUBSCRIBER (plain EOA, 1,000 mock USDC)"
echo "Smart subscriber: $SMART_SUBSCRIBER (has code, 1,000 mock USDC). Set VITE_DEV_ACCOUNT to it to test that path."
echo "Plan 1: 49 USDC / 30 days, 3 days grace"
echo "Plan 2: 99 USDC / 30 days, 7 day trial"
echo "Wrote apps/checkout/.env.local and apps/dashboard/.env.local."
echo "Next: scripts/dev-platform.sh, then pnpm --filter @monavisa/dashboard dev and pnpm --filter @monavisa/checkout dev"
