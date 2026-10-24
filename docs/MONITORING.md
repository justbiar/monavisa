# Mona Visa - Production Monitoring & Alerting Guide

This document outlines metrics, alerting thresholds, and operational runbooks for maintaining high-availability Mona Visa services on Monad.

---

## 1. Key Health Metrics

| Metric | Target | Warning Threshold | Critical Threshold |
|---|---|---|---|
| **Indexer Block Lag** | < 2 blocks | > 10 blocks | > 30 blocks |
| **Keeper MON Balance** | > 20 MON | < 10 MON | < 3 MON |
| **Settler MON Balance** | > 20 MON | < 10 MON | < 3 MON |
| **API Error Rate (5xx)** | 0% | > 0.5% | > 2% |
| **x402 Verification Latency** | < 150 ms | > 500 ms | > 1500 ms |
| **Webhook Delivery Latency** | < 1000 ms | > 5000 ms | > 30000 ms |
| **Webhook Retry Queue** | < 50 items | > 200 items | > 1000 items |

---

## 2. Prometheus Alerting Rules

```yaml
groups:
  - name: monavisa_alerts
    rules:
      - alert: IndexerBehind
        expr: monad_block_height - monavisa_last_indexed_block > 20
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Mona Visa indexer is behind chain head"
          description: "Indexer is lagging by {{ $value }} blocks on Monad."

      - alert: KeeperLowBalance
        expr: monavisa_keeper_mon_balance < 5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Keeper hot wallet balance low"
          description: "Keeper wallet {{ $labels.address }} has only {{ $value }} MON remaining."

      - alert: SettlerLowBalance
        expr: monavisa_settler_mon_balance < 5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Settler hot wallet balance low"
          description: "Settler wallet {{ $labels.address }} has only {{ $value }} MON remaining."

      - alert: HighWebhookFailureRate
        expr: rate(monavisa_webhook_deliveries_failed_total[5m]) / rate(monavisa_webhook_deliveries_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High webhook failure rate"
          description: ">10% of webhook dispatches are failing in the last 5 minutes."
```

---

## 3. Operational Runbooks

### Runbook 1: Indexer Behind Chain Head
1. Check RPC node health: `curl -s -X POST $MONAD_RPC_URL -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'`.
2. Inspect indexer logs: `journalctl -u monavisa-indexer -n 100 --no-pager`.
3. Check the D1 database (`npx wrangler d1 execute monavisa --remote --command "select * from indexer_state"`) for errors or a stalled indexer.
4. If a block caused a parser exception, inspect transaction receipt and restart indexer service with fallback RPC.

### Runbook 2: Keeper or Settler Hot Wallet Replenishment
1. Transfer native MON from the operations treasury to the hot wallet address:
   - Keeper address: configured via `KEEPER_PRIVATE_KEY`.
   - Settler address: configured via `FACILITATOR_PRIVATE_KEY`.
2. Verify gas limit headroom: Monad charges by gas limit, so ensure `gasLimit` buffer is bounded.

### Runbook 3: Stuck Vouchers or Settler Backlog
1. Query unredeemed vouchers:
   ```sql
   SELECT session_id, payee, max(cumulative_amount)
   FROM vouchers
   WHERE redeemed = false
   GROUP BY session_id, payee;
   ```
2. Trigger manual settler execution:
   ```bash
   monavisa settler --once
   ```
3. Check `SessionVault.isClosing(sessionId)`: if session is in cooldown delay, ensure redemption occurs before `closeDeadline`.
