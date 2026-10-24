# MonCart · Tam Protokol Planı

ArcenPay'in protokol modelini (abonelik, entitlement, x402 agent ödemeleri, escrow, mandate, MCP) tek zincir olarak Monad'a uyarlayan, non-custodial bir faturalama altyapısı.

Hedef: Monad testnet'te uçtan uca çalışan protokol, ardından audit ve mainnet.

---

## 1. Kapsam

| Katman                 | İçerik                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| I. SDK'lar             | `@moncart/react`, `@moncart/node`, `@moncart/agent`, `@moncart/mcp`                    |
| II. Platform API       | Katalog, abonelik durumu, fatura, payment link, mandate, escrow kaydı, webhook         |
| III. Settlement Engine | Yenileme job'ları, x402 facilitator, session vault muhasebesi, webhook dispatch        |
| IV. Kontratlar         | `PlanFactory`, `SubscriptionRegistry`, `AutopayModule`, `FeeCollector`, `SessionVault` |
| V. MonAuth ve Escrow   | Hiyerarşik mandate'ler, policy engine, on-chain revocation, Verify-Then-Settle         |

ArcenPay'den bilinçli olarak çıkarılanlar:

- **MirrorRegistry ve çoklu zincir:** tek zincir (Monad) olduğu için gerek yok. Dev ve prod ayrımı testnet ile mainnet katalogları üzerinden yapılır.
- **Token:** yok. Ekonomi yalnızca protokol fee'si üzerinden.

---

## 2. Monad'a özgü kararlar

Monad EVM uyumlu, ama birkaç fark tasarımı doğrudan etkiliyor:

| Monad gerçeği                                                | Tasarıma etkisi                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Gas, kullanılan miktar değil **gas limit** üzerinden kesilir | Keeper ve facilitator her işlem için `eth_estimateGas` sonrası küçük bir sabit pay ekler, büyük buffer kullanmaz. Yenilemeler batch'lenir. |
| EIP-7702 ile delege edilmiş EOA 10 MON altına düşemez        | Varsayılan autopay yolu 7702'ye dayanmaz. 7702 yalnızca opsiyonel.                                                                         |
| Storage slotları 128'lik sayfalar halinde ısınır             | `Subscription` ve `Session` struct'ları sıkı paketlenir, ilgili alanlar ardışık slotlarda tutulur.                                         |
| Kontrat boyutu 128 KB                                        | `SessionVault` tek kontratta sessions + escrow + revocation taşıyabilir, proxy bölme zorunlu değil.                                        |
| Global mempool yok                                           | Frontrun yüzeyi farklı. Yine de escrow ve settle fonksiyonları imzaya ve nonce'a bağlı tutulur.                                            |
| Full node'lar eski state sunmaz                              | Geçmiş veriler için kendi indexer'ımız (Ponder) zorunlu. Dashboard RPC'den tarihsel okuma yapmaz.                                          |
| P256 precompile `0x0100` adresinde                           | Passkey imzalı mandate'ler ileride ucuza doğrulanabilir (faz 6).                                                                           |
| Hosted x402 facilitator'larda Monad desteği doğrulanamadı    | **Kendi facilitator'ımızı** yazıyoruz (`/verify`, `/settle`, `/supported`).                                                                |

### Ağ bilgileri

Hepsi 2026-10-24'te RPC üzerinden on-chain doğrulandı. Kaynak kodda tek doğru kaynak `contracts/src/libraries/MonadAddresses.sol` ve `packages/core/src/networks.ts`, bir test ikisinin senkron kaldığını kontrol ediyor.

|                 | Mainnet                                      | Testnet                                      |
| --------------- | -------------------------------------------- | -------------------------------------------- |
| Chain ID        | 143                                          | 10143                                        |
| RPC             | `https://rpc.monad.xyz`                      | `https://testnet-rpc.monad.xyz`              |
| Explorer        | monadscan.com, monadvision.com               | testnet.monadscan.com                        |
| Verify API      | Etherscan V2, `chainid=143`                  | Etherscan V2, `chainid=10143`                |
| USDC            | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| Permit2         | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | aynı                                         |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | aynı                                         |
| Multicall3      | `0xcA11bde05977b3631167028862bE2a173976CA11` | aynı                                         |

İki ağdaki USDC de Circle FiatToken v2 (6 decimal, EIP-712 domain `USDC` / `2`) ve **EIP-3009 destekliyor**. Bu yüzden x402 `exact` şeması doğrudan `transferWithAuthorization` ile yapılacak. Solidity hedefi `0.8.30` ve `evm_version = "prague"`.

--------------- | --------------------------------------------------------------------------- | --------------------- |
| Chain ID | 143 | 10143 (doğrulanacak) |
| RPC | `https://rpc.monad.xyz` | doğrulanacak |
| Explorer | monadvision.com, monadscan.com | doğrulanacak |
| USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (Circle docs ile doğrulanacak) | Circle testnet adresi |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` | aynı (doğrulanacak) |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | aynı (doğrulanacak) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | aynı |

Kodlamaya başlamadan önce testnet satırı ve USDC'nin EIP-3009 (`transferWithAuthorization`) desteği kontrol edilecek. x402 `exact` şeması buna dayanıyor.

---

## 3. Kontratlar (Foundry, Solidity 0.8.x)

Hepsi UUPS proxy arkasında, `AccessControl` ile yönetilir. Admin rolü bir Safe multisig'tedir.

### 3.1 `PlanFactory`

- Takımlar (merchant) plan kaydeder: `token`, `price`, `period`, `trialPeriod`, `merchantTreasury`, `active`.
- Plan fiyatı değişirse yeni versiyon oluşur. Mevcut aboneler eski versiyonda kalır, upgrade ile geçer.
- Event: `PlanCreated`, `PlanUpdated`, `PlanDeactivated`.

### 3.2 `SubscriptionRegistry`

- Her abonelik bir ERC-721 token. `(planId, subscriber, startedAt, currentPeriodEnd, status)` saklanır.
- Entitlement predicate'i on-chain: `isActive(subId) = status == Active && block.timestamp < currentPeriodEnd`.
- Upgrade, downgrade (proration hesabı), cancel at period end, grace period.
- Yalnızca `AutopayModule` dönemi uzatabilir.
- NFT varsayılan olarak transfer edilemez (soulbound). Plan bazında açılabilir.

> **Faz 1 durumu (2026-10-24):** abone ol, yenile, iptal, grace ve süre dolumu uygulandı. Upgrade, downgrade ve proration henüz yok, Faz 2'de eklenecek. Yeni fiyat şu an yeni bir plan olarak açılıyor.

### 3.3 `AutopayModule`

İki çekim yolu, aynı arayüz:

1. **Permit2 yolu (varsayılan):** abone tek seferlik Permit2 allowance imzalar (tutar tavanı ve süre ile). Her EOA ile çalışır, 7702 gerekmez.
2. **ERC-7579 modül yolu:** smart account (Safe, Kernel vb.) kullananlar için executor modülü. ArcenPay ile birebir uyumlu.

- `renew(subIds[])` batch fonksiyonu, keeper tarafından çağrılır. Koşul: `balance >= P + F` (litepaper 5.2).
- Fee `F = ρ · P` hesaplanır, `FeeCollector`'a, kalanı merchant hazinesine gider.
- Başarısız çekimde `RenewalFailed` event'i, abonelik grace period'a girer.

### 3.4 `FeeCollector`

- Plan bazında ve agent harcaması bazında fee oranları (`ρp`, `ρa`), basis point olarak, üst sınırlı.
- Biriken fee'ler deterministik olarak hazineye yönlendirilir. `Treasury(T) = Σ Fees(t)` event'lerden yeniden hesaplanabilir.

### 3.5 `SessionVault`

Agent tarafının tamamı burada:

- **Session'lar:** agent sahibi USDC yatırır, bir `sessionKey` ve harcama limiti tanımlar. x402 çağrıları off-chain imzalanır, facilitator periyodik olarak `settleBatch` ile on-chain düşer. `b(t+1) = b(t) − r·δ(t)`, `Pay ⇔ b(t) ≥ r`.
- **Escrow (Verify-Then-Settle):** `reserve(amount, provider, τmax)` → provider `commit(C = SHA-256(canon(D)))` → alıcı `confirm` ya da süre dolunca `refund`. Uyuşmazlıkta varsayılan iade.
- **Mandate revocation:** mandate hash'leri için revocation bitmap'i. Bir ebeveyn mandate iptal edilirse tüm alt mandate'ler geçersiz sayılır (zincir kontrolü facilitator'da, kök revocation on-chain).

### 3.6 Testler

- Unit ve fuzz (Foundry), invariant testleri: "vault bakiyesi ≥ tüm açık rezervasyonlar + session bakiyeleri", "fee + merchant payı = çekilen tutar".
- Monad testnet'e fork testleri.
- Slither ve Aderyn CI'da.

---

## 4. Off-chain servisler

### 4.1 Platform API (`apps/api`)

- Stack: Node.js, Hono, Postgres (Drizzle), Redis (BullMQ).
- Auth: merchant için API key (secret ve publishable ayrı), dashboard için SIWE.
- Kaynaklar: `teams`, `products`, `plans`, `features`, `entitlement_rules`, `customers`, `subscriptions`, `invoices`, `payment_links`, `checkout_sessions`, `mandates`, `escrows`, `webhook_endpoints`.
- Entitlement çözümleme: önce indexer'daki on-chain durum, sonra plan ve feature eşleşmesi, sonra usage limiti. Sonuç Redis'te kısa süreli cache'lenir.
- Fatura: her başarılı yenileme ve tek seferlik ödeme için PDF fatura, tx hash bağlantılı.

### 4.2 Settlement Engine (`apps/engine`)

- **Renewal keeper:** süresi yaklaşan abonelikleri indexer'dan çeker, gruplar halinde `renew` çağırır. Gas limiti hassas tahminle verilir.
- **x402 facilitator:** `exact` şeması (EIP-3009 ile anında transfer) ve `session` şeması (SessionVault bakiyesinden düşüm, batch settle). Replay koruması nonce ile.
- **Webhook dispatcher:** 17 event tipi, HMAC-SHA256 imzalı, idempotency key'li, exponential backoff.

Webhook event'leri: `subscription.created`, `subscription.renewed`, `subscription.renewal_failed`, `subscription.upgraded`, `subscription.downgraded`, `subscription.canceled`, `subscription.expired`, `invoice.created`, `invoice.paid`, `checkout.completed`, `payment_link.paid`, `session.opened`, `session.closed`, `x402.settled`, `escrow.settled`, `escrow.refunded`, `mandate.revoked`.

### 4.3 Indexer (`apps/indexer`)

- Ponder ile tüm kontrat event'leri Postgres'e. API ve dashboard tarihsel veriyi buradan okur.

---

## 5. SDK'lar

### `@moncart/core`

Adresler, ABI'ler, chain config (143 ve 10143), tipler, EIP-712 domain'leri. Diğer paketler buna bağlı.

### `@moncart/react`

- wagmi v2 ve viem üzerine.
- Bileşenler: `<PricingTable>`, `<Checkout>`, `<SubscriptionStatus>`, `<ManageSubscription>`, `<MonCartEmbed>` (iframe'siz, dashboard'dan gelen tasarım token'ları ile).
- Hook'lar: `useEntitlement(feature)`, `useSubscription()`, `useCheckout()`.

### `@moncart/node`

- `MonCartClient`: `checkEntitlement`, `recordUsage`, `createPaymentLink`, `listInvoices`.
- `x402Middleware({ planId, ratePerCall, chainId: 143 })` (Express ve Hono).
- `verifyWebhook(payload, signature, secret)`.

### `@moncart/agent`

- `createAgentFetch()`: 402 yanıtını yakalar, challenge'ı parse eder, imzalar, tekrar dener.
- Session yönetimi (aç, yükle, kapat), escrow istemcisi (`reserve`, `verify`, `confirm`).
- Mandate oluşturma ve alt mandate türetme (kapsam yalnızca daralabilir).

### `@moncart/mcp`

MCP sunucusu, 12 araç: `get_balance`, `open_session`, `top_up_session`, `close_session`, `pay_x402`, `list_spend`, `create_mandate`, `revoke_mandate`, `escrow_reserve`, `escrow_verify_and_settle`, `check_entitlement`, `create_payment_link`. Her araç mandate bütçesine karşı kontrol edilir. Claude Desktop ve Cursor için yapılandırma örneği ile gelir.

---

## 6. MonAuth: mandate modeli

```
Mandate {
  issuer        // ebeveyn mandate sahibi ya da kök wallet
  agent         // session key ya da agent adresi
  parent        // ebeveyn mandate hash'i (kök için 0)
  maxTotal      // toplam harcama tavanı
  maxPerCall
  allowedPayees // merchant ya da endpoint listesi (boş = hepsi, yalnızca kökte)
  validUntil
  nonce
}
```

- EIP-712 ile imzalanır.
- **Monoton daralma:** alt mandate'in her alanı ebeveynin alanına eşit ya da daha dar olmalı. Policy engine bunu deterministik kontrol eder.
- **Öncelik:** revoke > süre dolumu > açık deny > allow.
- Revocation on-chain (`SessionVault`), kontrol facilitator ve MCP sunucusunda.

---

## 7. Uygulamalar

- `apps/dashboard` (Next.js): plan ve feature yönetimi, abone listesi, gelir grafikleri, webhook ayarları, API key'ler, checkout tasarım editörü.
- `apps/checkout` (Next.js): hosted checkout ve payment link sayfaları, `pay.moncart.xyz/<id>` gibi.
- `apps/docs`: geliştirici dokümanı.
- `examples/`: SaaS gating örneği, x402 korumalı API, MCP ile ödeme yapan agent.

---

## 8. Repo yapısı

```
MonCart/
  contracts/            # Foundry
  packages/
    core/  react/  node/  agent/  mcp/
  apps/
    api/  engine/  indexer/  dashboard/  checkout/  docs/
  examples/
  docs/
```

pnpm workspaces ve Turborepo. TypeScript strict. Changesets ile paket versiyonlama. CI: GitHub Actions (forge test, lint, typecheck, Slither).

---

## 9. Fazlar

| Faz                    | İçerik                                                                                    | Bitti sayılır                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0. İskelet             | Monorepo, Foundry, `core` paketi, ağ bilgilerinin doğrulanması                            | `pnpm build` ve `forge test` yeşil                                    |
| 1. Abonelik çekirdeği  | `PlanFactory`, `SubscriptionRegistry`, `AutopayModule` (Permit2), `FeeCollector`, testler | Testnet'te plan oluştur, abone ol, yenile, iptal et                   |
| 2. Platform            | API, indexer, renewal keeper, webhook'lar, `node` SDK                                     | `checkEntitlement` on-chain duruma göre doğru cevap veriyor           |
| 3. Ön yüz              | `react` SDK, hosted checkout, payment link, dashboard                                     | Wallet bağlayıp USDC ile abonelik ve fatura uçtan uca                 |
| 4. Agent ödemeleri     | `SessionVault` session kısmı, x402 facilitator, `agent` SDK                               | Korumalı API'ye agent 402 alıp otomatik ödüyor                        |
| 5. Escrow ve mandate   | Escrow, mandate imza ve revocation, policy engine                                         | Hatalı teslimatta otomatik iade, iptal edilen mandate ile ödeme reddi |
| 6. MCP ve sertleştirme | `mcp` paketi, ERC-7579 modül yolu, passkey mandate'leri, fuzz ve invariant genişletme     | Claude Desktop'tan bütçe sınırlı ödeme                                |
| 7. Mainnet             | Harici audit, Safe ile admin, mainnet deploy, izleme                                      | Kritik ve yüksek bulgu sıfır, chain ID 143'te canlı                   |

---

## 10. Açık sorular

1. Fee oranları ve üst sınır ne olacak?
2. Hosted servisler (API, engine) bizde mi kalacak, yoksa self-host seçeneği de olacak mı?
3. Marka ve domain: `moncart.xyz` gibi bir domain alındı mı?

## Kaynaklar

- ArcenPay litepaper: https://www.arcenpay.com/litepaper
- Monad ağ bilgileri: https://docs.monad.xyz/getting-started/network-information
- Monad ile Ethereum farkları: https://docs.monad.xyz/developer-essentials/differences
