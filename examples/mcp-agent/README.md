# Mona Visa MCP Agent Example

This example demonstrates how to integrate the Mona Visa Model Context Protocol (MCP) server with AI assistants like Claude Desktop, Cursor, or autonomous LLM agents.

## 1. Setup

Add the configuration in `claude_desktop_config.json` to your Claude Desktop config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

## 2. Environment Variables

| Variable | Description |
|---|---|
| `MONAD_RPC_URL` | Monad RPC node endpoint (e.g. `https://testnet-rpc.monad.xyz`) |
| `MONAD_CHAIN_ID` | `10143` (testnet) or `143` (mainnet) |
| `PRIVATE_KEY` | Hex private key for the agent wallet |
| `SESSION_VAULT_ADDRESS` | Deployed `SessionVault` address |
| `USDC_ADDRESS` | Deployed or canonical Monad USDC token address |
| `PLATFORM_URL` | Mona Visa platform API (default: `https://platform.monavisa.io`) |

## 3. Available Tools

The MCP server exposes 12 specialized tools:
1. `get_balance`: Check native MON and USDC token balances.
2. `open_session`: Deposit USDC into a prepaid `SessionVault` session.
3. `top_up_session`: Add funds to an existing active session.
4. `close_session`: Request session closure and start cooldown.
5. `pay_x402`: Execute an HTTP request to an x402-protected endpoint and automatically settle payment.
6. `list_spend`: Inspect historical spend ledger and session usage.
7. `create_mandate`: Create and sign a MonAuth root or child mandate.
8. `revoke_mandate`: Revoke a mandate on-chain.
9. `escrow_reserve`: Reserve funds for milestone-based or verify-then-settle task.
10. `escrow_verify_and_settle`: Submit canonical deliverable hash and settle escrow.
11. `check_entitlement`: Verify customer feature entitlement or active subscription.
12. `create_payment_link`: Generate a hosted checkout session link.
