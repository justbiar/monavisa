# Mona Visa · Tam Protokol Planı

ArcenPay'in protokol modelini (abonelik, entitlement, x402 agent ödemeleri, escrow, mandate, MCP) tek zincir olarak Monad'a uyarlayan, non-custodial bir faturalama altyapısı.

Hedef: Monad testnet'te uçtan uca çalışan protokol, ardından audit ve mainnet.

---

## 1. Kapsam

| Katman                 | İçerik                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| I. SDK'lar             | `@monavisa/react`, `@monavisa/node`, `@monavisa/agent`, `@monavisa/mcp`                |
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

| Monad gerçeği                                                                                                                 | Tasarıma etkisi                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gas, kullanılan miktar değil **gas limit** üzerinden kesilir                                                                  | Keeper ve facilitator her işlem için `eth_estimateGas` sonrası küçük bir sabit pay ekler, büyük buffer kullanmaz. Yenilemeler batch'lenir.             |
| EIP-7702 ile delege edilmiş EOA 10 MON altına düşemez                                                                         | Varsayılan autopay yolu 7702'ye dayanmaz. 7702 yalnızca opsiyonel.                                                                                     |
| Storage slotları 128'lik sayfalar halinde ısınır                                                                              | `Subscription` ve `Session` struct'ları sıkı paketlenir, ilgili alanlar ardışık slotlarda tutulur.                                                     |
| Kontrat boyutu 128 KB                                                                                                         | `SessionVault` tek kontratta sessions + escrow + revocation taşıyabilir, proxy bölme zorunlu değil.                                                    |
| Global mempool yok                                                                                                            | Frontrun yüzeyi farklı. Yine de escrow ve settle fonksiyonları imzaya ve nonce'a bağlı tutulur.                                                        |
| Full node'lar eski state sunmaz                                                                                               | Geçmiş veriler için kendi indexer'ımız (Ponder) zorunlu. Dashboard RPC'den tarihsel okuma yapmaz.                                                      |
| Herkesçe bilinen ya da paylaşılmış anahtarlı EOA'larda EIP-7702 delegasyonu olabiliyor (anvil test hesaplarının hepsinde var) | Permit2 kodu olan hesapların imzasını ERC-1271 ile doğruluyor. Checkout, kodu olan hesaplarda imza yerine zincir üstünde `Permit2.approve` kullanıyor. |
| P256 precompile `0x0100` adresinde                                                                                            | Passkey imzalı mandate'ler ileride ucuza doğrulanabilir (faz 6).                                                                                       |
| Hosted x402 facilitator'larda Monad desteği doğrulanamadı                                                                     | **Kendi facilitator'ımızı** yazıyoruz (`/verify`, `/settle`, `/supported`).                                                                            |

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

İki ağdaki USDC de Circle FiatToken v2 (6 decimal, EIP-712 domain `USDC` / `2`) ve **EIP-3009 destekliyor**. Bu yüzden x402 `exact` şeması doğrudan `transferWithAuthorization` ile yapılır. Solidity hedefi `0.8.28` ve `evm_version = "prague"`.

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

> **Durum (2026-10-24):** abone ol, yenile, iptal, grace ve süre dolumu Faz 1'de; plan değiştirme Faz 2'de uygulandı. Daha pahalı plana geçiş hemen olur ve mevcut ödenmiş dönemin kalan kısmı kredi olarak düşülür (deneme süresi kredi sayılmaz). Daha ucuz plana geçiş bir sonraki yenilemede uygulanır, böylece iade gerekmez. Fiyat değişikliği yeni plan olarak açılır.

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

> **Faz 2 durumu (2026-10-24):** hepsi tek paket olarak `apps/platform` içinde. Modüller ayrı süreç olarak da çalışıyor (`monavisa-platform api|indexer|keeper|webhooks|all`). Redis ve Drizzle kullanılmadı, ince bir SQL katmanı yeterli oldu. Veritabanı SQLite: Cloudflare Worker'da D1, testlerde ve yerelde `node:sqlite`. Token tutarları metin olarak saklanıyor, toplamlar BigInt ile JS tarafında yapılıyor.

### 4.1 Platform API (`apps/platform/src/api.ts`)

- Stack: Node.js / Cloudflare Workers, Hono, SQLite (D1).
- Auth: merchant için secret API key (`mv_sk_...`, yalnızca sha256 hash'i saklanır). Dashboard için SIWE Faz 3'te.
- Uygulanan uçlar: `GET /v1/entitlements/:feature?customer=`, `GET /v1/customers/:address/subscriptions`, `GET /v1/customers/:address/invoices`, `GET/PUT /v1/features/:key`, `GET/POST/DELETE /v1/webhook-endpoints`, `GET /health`.
- Panel uçları (Faz 3): `POST /auth/nonce`, `POST /auth/login` (SIWE, `publicClient.verifySiweMessage` ile, akıllı hesaplar dahil), `POST /auth/logout`, `GET/PATCH /v1/me`, `GET /v1/overview`, `GET /v1/plans`, `PUT /v1/plans/:id/metadata`, `GET /v1/subscriptions`, `GET /v1/invoices`, `GET/POST/DELETE /v1/payment-links`, `GET/POST/DELETE /v1/api-keys` (yalnızca oturumla). Herkese açık: `GET /public/plans/:id`, `GET /public/payment-links/:id`.
- Kimlik: `mv_sess_` oturum token'ı (7 gün) ya da `mv_sk_` API anahtarı. İkisinin de yalnızca sha256 hash'i saklanır. Nonce'lar tek kullanımlık ve 10 dakika geçerli.
- Entitlement çözümleme: indexer'daki on-chain durum, feature ile plan eşleşmesi ve grace süresi. Usage limitleri, payment link, checkout session, mandate ve escrow kaynakları sonraki fazlarda.
- Fatura: her `Charged` event'i bir fatura satırı, tx hash bağlantılı. PDF Faz 3'te.

### 4.2 Keeper ve webhook'lar

- **Renewal keeper:** vadesi gelen abonelikleri index'ten seçer, `renewMany` çağırır. Gas limiti `tahmin + %10`, çünkü Monad gas limit üzerinden ücretlendiriyor. Ödemesi başarısız olan abonelikler saatte bir yeniden denenir.
- **x402 facilitator:** `exact` şeması (EIP-3009 ile anında transfer) ve `session` şeması (SessionVault bakiyesinden düşüm, batch settle). Faz 4.
- **Webhook dispatcher:** outbox tablosundan endpoint başına teslim, HMAC-SHA256 imza (`monavisa-signature: t=..,v1=..`), olay id'si ile idempotent, 30 saniyeden 6 saate üstel backoff, 8 denemeden sonra `failed`.

Webhook event'leri: `subscription.created`, `subscription.renewed`, `subscription.renewal_failed`, `subscription.upgraded`, `subscription.downgraded`, `subscription.canceled`, `subscription.expired`, `invoice.created`, `invoice.paid`, `checkout.completed`, `payment_link.paid`, `session.opened`, `session.closed`, `x402.settled`, `escrow.settled`, `escrow.refunded`, `mandate.revoked`. Faz 2'de ilk yedisi ve `invoice.paid` üretiliyor.

### 4.3 Indexer (`apps/platform/src/indexer.ts`)

- Ponder yerine viem ile kendi indexer'ımız. Gerekçe: Monad'da finality yaklaşık 1 saniye olduğu için reorg yönetimine gerek yok, ve public RPC'lerin `eth_getLogs` sınırı (100 blok) basit bir parçalı taramayla karşılanıyor.
- `finalized` bloğa kadar tarar. Etkilenen plan ve abonelikleri o bloktaki kontrat durumundan okuyup yazar, event'leri webhook outbox'ına ekler. Tüm yazımlar idempotent.

---

## 5. SDK'lar

### `@monavisa/core`

Adresler, ABI'ler, chain config (143 ve 10143), tipler, EIP-712 domain'leri. Diğer paketler buna bağlı.

### `@monavisa/react`

> **Faz 3 durumu (2026-10-24):** `MonaVisaProvider`, `usePlan`, `useSubscription`, `useEntitlement(planIds)`, `useCheckout`, `useManageSubscription` hazır. Hazır UI bileşenleri yerine hook'lar öne çıktı, hosted checkout bunlarla kurulu. `useEntitlement` istemci tarafında zincirden okuyor, ücretli işlemler için sunucuda `@monavisa/node` ile tekrar kontrol edilmeli.

- wagmi v3 ve viem üzerine (planlandığında v2 idi, güncel ana sürüm v3).
- Bileşenler: `<PricingTable>`, `<Checkout>`, `<SubscriptionStatus>`, `<ManageSubscription>`, `<MonaVisaEmbed>` (iframe'siz, dashboard'dan gelen tasarım token'ları ile).
- Hook'lar: `useEntitlement(feature)`, `useSubscription()`, `useCheckout()`.

### `@monavisa/node`

- `MonaVisaClient`: `checkEntitlement`, `listSubscriptions`, `listInvoices`, `setFeature`, `createWebhookEndpoint` (Faz 2). `recordUsage` ve `createPaymentLink` sonraki fazlarda.
- `x402Middleware({ planId, ratePerCall, chainId: 143 })` (Express ve Hono).
- `verifyWebhook(payload, signature, secret)`.

### `@monavisa/agent`

- `createAgentFetch()`: 402 yanıtını yakalar, challenge'ı parse eder, imzalar, tekrar dener.
- Session yönetimi (aç, yükle, kapat), escrow istemcisi (`reserve`, `verify`, `confirm`).
- Mandate oluşturma ve alt mandate türetme (kapsam yalnızca daralabilir).

### `@monavisa/mcp`

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

- `apps/dashboard` (Vite + React, hazır): cüzdanla SIWE girişi; genel bakış (MRR, aktif abone, 30 günlük ve toplam gelir, son ödemeler); planlar (zincirde plan oluşturma, ad verme, satışı durdurma, checkout linki); aboneler; ödemeler; ödeme linkleri; ayarlar (mağaza adı, API anahtarları, webhook'lar). Gizli değerler bir kez gösterilir. Gelir grafikleri, feature yönetimi ve checkout tasarım editörü sonraki fazda.
- `apps/checkout` (Vite + React, hazır): `/plan/<id>` ve ödeme linkleri için `/l/<id>`. Cüzdan bağla, Permit2 tavanlı yetki ver, abone ol, durumu gör, iptal et. Plan ve mağaza adları panelden (API) gelir, `?name=&merchant=` yalnızca API yoksa yedektir; tutarlar ve satıcı adresi her zaman zincirden.
- `packages/theme`: iki uygulamanın paylaştığı Ramp benzeri token'lar ve bileşen stilleri.
- Faz 3'ten kalan: PDF fatura, gelir grafiği, feature (entitlement) yönetim ekranı.
- `apps/docs`: geliştirici dokümanı.
- `examples/`: SaaS gating örneği, x402 korumalı API, MCP ile ödeme yapan agent.

---

## 8. Repo yapısı

```
MonaVisa/
  contracts/            # Foundry
  packages/
    core/  react/  node/  agent/  mcp/
  apps/
    platform/  checkout/  dashboard/  docs/
  examples/
  docs/
```

pnpm workspaces ve Turborepo. TypeScript strict. Changesets ile paket versiyonlama. CI: GitHub Actions (forge test, lint, typecheck, Slither).

---

## 9. Fazlar ve Durum

| Faz | İçerik | Durum | Detaylar |
|---|---|---|---|
| **0. İskelet** | Monorepo, Foundry, `core` paketi, ağ bilgilerinin doğrulanması | ✅ Tamamlandı | Viem entegrasyonu, Monad testnet & mainnet RPC/USDC adresleri, CI yapılandırması. |
| **1. Abonelik çekirdeği** | `PlanFactory`, `SubscriptionRegistry`, `AutopayModule` (Permit2), `FeeCollector`, testler | ✅ Tamamlandı | Soulbound NFT, Permit2 periyodik çekim, UUPS yükseltilebilir kontratlar. |
| **2. Platform** | API, indexer, renewal keeper, webhook'lar, `node` SDK | ✅ Tamamlandı | SQLite şeması (D1 ve node:sqlite), Hono API, webhook HMAC-SHA256 retry kuyruğu. |
| **3. Ön yüz & Raporlama** | `react` SDK, hosted checkout, payment link, dashboard, PDF fatura & gelir grafiği | ✅ Tamamlandı | SIWE girişi, SVG 30 günlük gelir trendi, PDF fatura endpoint'i, `/features` yönetim ekranı. |
| **4. Agent ödemeleri** | `SessionVault` session kısmı, x402 facilitator, `agent` SDK | ✅ Tamamlandı | Session açılışı/kapanışı, EIP-712 kümülatif voucher'lar, x402 v2 `/verify` ve `/settle`, `createAgentFetch`. |
| **5. Escrow ve mandate** | Verify-Then-Settle escrow, mandate imza ve revocation, policy engine | ✅ Tamamlandı | JCS SHA-256 deliverable taahhüdü, monoton daralan MonAuth hiyerarşisi, deterministik harcama değerlendirme motoru. |
| **6. MCP ve sertleştirme** | `@monavisa/mcp` paketi (12 tool), `Autopay7579Executor.sol`, örnekler, fuzz & invariant testleri | ✅ Tamamlandı | Stdio MCP sunucusu, ERC-7579 execution modülü, SessionVault korunum invariant testleri, `examples/`. |
| **7. Mainnet Hazırlığı** | Harici audit kapsamı, deployment checklist'i, operasyonel izleme ve runbook'lar | ✅ Tamamlandı | `docs/AUDIT_SCOPE.md`, `docs/MAINNET_CHECKLIST.md`, `docs/MONITORING.md`. |

---

## 10. Açık sorular

1. Fee oranları ve üst sınır ne olacak?
2. Hosted servisler (API, engine) bizde mi kalacak, yoksa self-host seçeneği de olacak mı?
3. Marka ve domain: `monavisa.xyz` gibi bir domain alındı mı?

## Kaynaklar

- ArcenPay litepaper: https://www.arcenpay.com/litepaper
- Monad ağ bilgileri: https://docs.monad.xyz/getting-started/network-information
- Monad ile Ethereum farkları: https://docs.monad.xyz/developer-essentials/differences
