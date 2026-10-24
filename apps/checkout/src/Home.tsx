import { MONAD_CHAIN_ID, MONAD_TESTNET_CHAIN_ID, getChain, getNetwork } from "@monavisa/core";
import { type FormEvent, useState } from "react";
import { chainId, dashboardUrl, demoPlanUrl, repoUrl } from "./config.js";

const AUDIENCES = [
  {
    title: "Satıcılar",
    body: "Planını oluştur, ödeme linkini paylaş. Abonelerini, gelirini ve ödemelerini panelden izle. API ve webhook'larla kendi uygulamanda erişimi aç ya da kapat.",
  },
  {
    title: "Aboneler",
    body: "Cüzdanını bağla, tek onayla abone ol. Kart bilgisi yok, hesap açmak yok. İstediğin an iptal edersin. Kontrat her dönem plan fiyatı ve %1 ücretten fazlasını çekemez.",
  },
  {
    title: "AI ajanları",
    body: "API'lere istek başına öde (x402). Önceden yüklenmiş bir oturumdan, senin koyduğun harcama limitleriyle. Sonuç gelene kadar ödeme emanette bekler.",
  },
];

const STEPS = [
  {
    title: "Satıcı planı zincire kaydeder",
    body: "Fiyat, dönem, deneme ve tolerans süresi kontrata yazılır. Fiyat sonradan değiştirilemez, abone neye onay verdiğini bilir.",
  },
  {
    title: "Abone bir kez izin verir",
    body: "Permit2 ile Mona Visa'nın ödeme modülüne miktarı ve süresi sınırlı bir USDC izni verir. İlk ödeme hemen yapılır.",
  },
  {
    title: "Yenilemeler kendiliğinden çekilir",
    body: "Dönem bitince keeper yenilemeyi tetikler. Para doğrudan satıcıya gider, yenileme gas'ını abone ödemez.",
  },
];

const WHY_MONAD = [
  {
    title: "Kuruşluk ödemeler anlamlı",
    body: "0.10 USDC'lik bir API çağrısı ya da yüzlerce aboneliğin toplu yenilenmesi, ancak gas bu kadar ucuzken kârlı.",
  },
  {
    title: "Onay anında",
    body: "Bloklar saniyenin altında. Abone ödemenin onaylandığını checkout ekranından ayrılmadan görür.",
  },
  {
    title: "Kimse parayı tutmaz",
    body: "Kurallar kontratta. Mona Visa paranı saklamaz, durduramaz, fiyatı değiştiremez. Satıcı ödemeyi aracısız alır.",
  },
];

const CONTRACTS = [
  ["PlanFactory", "planFactory"],
  ["SubscriptionRegistry", "subscriptionRegistry"],
  ["AutopayModule", "autopayModule"],
  ["SessionVault", "sessionVault"],
  ["FeeCollector", "feeCollector"],
] as const;

export function Home() {
  // The network this site runs on comes first.
  const networks = [
    { id: MONAD_CHAIN_ID, name: "Monad Mainnet" },
    { id: MONAD_TESTNET_CHAIN_ID, name: "Monad Testnet" },
  ].sort((a, b) => Number(b.id === chainId) - Number(a.id === chainId));

  return (
    <main className="home">
      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">Monad üzerinde abonelik ve ajan ödemeleri</p>
        <h1 id="hero-title">Cüzdandan otomatik ödenen abonelikler.</h1>
        <p className="lede">
          Mona Visa, satıcıların USDC ile abonelik satmasını sağlar. Abone bir kez onay verir,
          her dönem ödeme kendiliğinden çekilir ve aracıya uğramadan satıcının cüzdanına gider.
          Aynı altyapıyla AI ajanları da API'lere istek başına ödeme yapar.
        </p>
        <div className="cta-row">
          {dashboardUrl && (
            <a className="btn primary big" href={dashboardUrl}>
              Satıcı paneline gir
            </a>
          )}
          <a className="btn big" href={demoPlanUrl}>
            Örnek planı dene
          </a>
          <a className="link" href={repoUrl}>
            GitHub'da incele
          </a>
        </div>
      </section>

      <section className="home-section" aria-labelledby="who">
        <h2 id="who">Kimin için?</h2>
        <div className="cards">
          {AUDIENCES.map((a) => (
            <article key={a.title} className="card">
              <h3>{a.title}</h3>
              <p>{a.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section" aria-labelledby="how">
        <h2 id="how">Nasıl çalışır?</h2>
        <ol className="how">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="how-num">{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="home-section" aria-labelledby="why">
        <h2 id="why">Neden Monad?</h2>
        <div className="cards">
          {WHY_MONAD.map((w) => (
            <article key={w.title} className="card">
              <h3>{w.title}</h3>
              <p>{w.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section split" aria-labelledby="fees">
        <div>
          <h2 id="fees">Ücret</h2>
          <p className="big-number">%1</p>
        </div>
        <p className="muted">
          Abonelikte fiyatın üstüne eklenir: 10 USDC'lik planda abone 10.10 USDC öder, satıcıya
          10 USDC'nin tamamı geçer. Ajan ödemelerinde alıcının payından kesilir. Başka ücret yok,
          yenileme gas'ını keeper öder.
        </p>
      </section>

      <section className="home-section" aria-labelledby="contracts">
        <h2 id="contracts">Canlı kontratlar</h2>
        {networks.map((network) => {
          const { contracts, usdc } = getNetwork(network.id);
          const explorer = getChain(network.id).blockExplorers?.default.url;
          const rows: [string, string | null][] = [
            ...CONTRACTS.map(([label, key]) => [label, contracts[key]] as [string, string | null]),
            ["USDC", usdc.address],
          ];
          return (
            <div key={network.id} className="network-contracts">
              <h3>
                {network.name} <span className="muted">· chain {network.id}</span>
              </h3>
              <dl className="contracts">
                {rows.map(([label, address]) =>
                  address ? (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd className="mono">
                        {explorer ? (
                          <a href={`${explorer}/address/${address}`}>{address}</a>
                        ) : (
                          address
                        )}
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </div>
          );
        })}
        <p className="muted small">
          Kontratlar henüz audit edilmedi. Audit tamamlanana kadar küçük tutarlarla kullan.
        </p>
      </section>

      <OpenLink />
    </main>
  );
}

/** For subscribers who got a link or plan number from a merchant. */
function OpenLink() {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = value.trim();
    const link = input.match(/\/l\/([A-Za-z0-9_-]{4,32})\/?$/)?.[1];
    if (link) {
      window.location.href = `/l/${link}`;
      return;
    }
    const id = input.match(/(\d+)\s*$/)?.[1];
    if (id) window.location.href = `/plan/${id}`;
  };
  return (
    <section className="home-section" aria-labelledby="open">
      <h2 id="open">Abonelik bağlantın mı var?</h2>
      <form onSubmit={submit} className="landing-form">
        <label htmlFor="plan">Satıcının paylaştığı bağlantı ya da plan numarası</label>
        <div className="row">
          <input
            id="plan"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`${window.location.origin}/plan/1`}
          />
          <button type="submit" className="btn primary">
            Aç
          </button>
        </div>
      </form>
    </section>
  );
}
