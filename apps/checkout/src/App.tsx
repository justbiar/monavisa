import {
  type CheckoutStep,
  type Plan,
  type SubscriptionView,
  describePeriod,
  formatAmount,
  useCheckout,
  useManageSubscription,
  usePlan,
  useSubscription,
} from "@monavisa/react";
import { type FormEvent, useEffect, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { chain, explorerTxUrl } from "./config.js";

interface Route {
  planId: bigint | null;
  /** Display labels from the link. Amounts and the merchant address always come from the chain. */
  planName: string | null;
  merchantName: string | null;
}

function parseRoute(): Route {
  const match = window.location.pathname.match(/^\/plan\/(\d+)\/?$/);
  const params = new URLSearchParams(window.location.search);
  return {
    planId: match?.[1] ? BigInt(match[1]) : null,
    planName: params.get("name"),
    merchantName: params.get("merchant"),
  };
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

const PERIOD_TR: Record<string, string> = {
  month: "ay",
  year: "yıl",
  week: "hafta",
  day: "gün",
  hour: "saat",
};
const periodTr = (seconds: number) => {
  const label = describePeriod(seconds);
  return PERIOD_TR[label] ?? label.replace("days", "gün").replace("hours", "saat");
};

export function App() {
  const [route] = useState(parseRoute);
  return (
    <div className="page">
      <header className="topbar">
        <span className="brand">
          Mona <b>Visa</b>
        </span>
        <span className="network">
          <i aria-hidden="true" />
          {chain.name}
        </span>
      </header>
      {route.planId === null ? <Landing /> : <Checkout route={route} planId={route.planId} />}
      <footer className="foot">
        Ödeme doğrudan satıcının cüzdanına gider. Mona Visa paranı hiçbir zaman tutmaz.
      </footer>
    </div>
  );
}

function Landing() {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = value.trim().match(/(\d+)\s*$/)?.[1];
    if (id) window.location.href = `/plan/${id}`;
  };
  return (
    <main className="landing">
      <h1>Abonelik bağlantısını aç</h1>
      <p>Satıcının paylaştığı bağlantıyı ya da plan numarasını gir.</p>
      <form onSubmit={submit} className="landing-form">
        <label htmlFor="plan">Plan bağlantısı veya numarası</label>
        <div className="row">
          <input
            id="plan"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://pay.monavisa.xyz/plan/1"
          />
          <button type="submit" className="btn primary">
            Aç
          </button>
        </div>
      </form>
    </main>
  );
}

function Checkout({ route, planId }: { route: Route; planId: bigint }) {
  const { plan, isLoading, error } = usePlan(planId);

  if (isLoading) return <main className="checkout loading">Plan yükleniyor…</main>;
  if (error || !plan) {
    return (
      <main className="checkout">
        <div className="notice error">
          <strong>Plan #{planId.toString()} bulunamadı.</strong> Bağlantıyı satıcıdan tekrar iste.
        </div>
      </main>
    );
  }

  return (
    <main className="checkout">
      <Summary plan={plan} route={route} />
      <section className="panel" aria-label="Ödeme">
        <WalletGate>
          <PlanAction plan={plan} />
        </WalletGate>
      </section>
    </main>
  );
}

function Summary({ plan, route }: { plan: Plan; route: Route }) {
  const fee = plan.charge - plan.price;
  const amount = (v: bigint) => formatAmount(v, plan.tokenDecimals);
  const period = periodTr(plan.period);
  return (
    <section className="summary" aria-label="Sipariş özeti">
      <div className="merchant">
        <span className="avatar" aria-hidden="true">
          {(route.merchantName ?? "M").slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className="merchant-name">{route.merchantName ?? "Satıcı"}</div>
          <div className="mono muted" title={plan.merchant}>
            {short(plan.merchant)}
          </div>
        </div>
      </div>

      <h1 className="plan-name">{route.planName ?? `Plan #${plan.id.toString()}`}</h1>
      <div className="price">
        <span className="amount">{amount(plan.price)}</span>
        <span className="unit">
          {plan.tokenSymbol} / {period}
        </span>
      </div>
      {plan.trialPeriod > 0 && (
        <p className="trial">
          İlk {periodTr(plan.trialPeriod)} ücretsiz. Deneme bitince ilk ödeme alınır.
        </p>
      )}

      <dl className="lines">
        <div>
          <dt>Plan ücreti</dt>
          <dd>
            {amount(plan.price)} {plan.tokenSymbol}
          </dd>
        </div>
        <div>
          <dt>Protokol ücreti</dt>
          <dd>
            {amount(fee)} {plan.tokenSymbol}
          </dd>
        </div>
        <div className="total">
          <dt>Her {period} ödenecek</dt>
          <dd>
            {amount(plan.charge)} {plan.tokenSymbol}
          </dd>
        </div>
      </dl>

      {!plan.active && (
        <div className="notice warn">
          Bu plan yeni abone almıyor. Mevcut abonelikler devam ediyor.
        </div>
      )}
    </section>
  );
}

function connectorLabel(connector: { type: string; name: string }): string {
  if (connector.type === "mock") return "Dev cüzdanı (anvil)";
  if (connector.name === "Injected") return "Tarayıcı cüzdanı (MetaMask, Rabby…)";
  return connector.name;
}

function WalletGate({ children }: { children: React.ReactNode }) {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();

  if (connection.status !== "connected") {
    return (
      <div className="stack">
        <h2>Cüzdanını bağla</h2>
        <p className="muted">Abonelik cüzdanına bağlanır. Kart veya hesap açman gerekmez.</p>
        <div className="stack tight">
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              type="button"
              className="btn wallet"
              disabled={connect.isPending}
              onClick={() => connect.mutate({ connector })}
            >
              {connectorLabel(connector)}
            </button>
          ))}
        </div>
        {connect.error && (
          <div className="notice error">{connect.error.message.split("\n")[0]}</div>
        )}
      </div>
    );
  }

  const wrongChain = connection.chainId !== chain.id;
  return (
    <div className="stack">
      <div className="account">
        <span className="dot" aria-hidden="true" />
        <span className="mono">{short(connection.address)}</span>
        <button type="button" className="link" onClick={() => disconnect.mutate()}>
          Bağlantıyı kes
        </button>
      </div>
      {wrongChain ? (
        <div className="stack">
          <div className="notice warn">
            Cüzdanın başka bir ağda. Devam etmek için {chain.name} ağına geç.
          </div>
          <button
            type="button"
            className="btn primary"
            onClick={() => switchChain.mutate({ chainId: chain.id })}
          >
            {chain.name} ağına geç
          </button>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

interface Receipt {
  subscriptionId: bigint;
  transactionHash: string;
}

function PlanAction({ plan }: { plan: Plan }) {
  const { subscription, entitled, isLoading, refetch } = useSubscription(plan.id);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  if (isLoading) return <p className="muted">Abonelik durumu okunuyor…</p>;

  const live =
    subscription &&
    (subscription.status === "active" ||
      subscription.status === "past_due" ||
      (subscription.status === "canceled" && entitled));
  return live ? (
    <div className="stack">
      {receipt && <SuccessBanner receipt={receipt} />}
      <Manage plan={plan} subscription={subscription} entitled={entitled} onChange={refetch} />
    </div>
  ) : (
    <Subscribe
      plan={plan}
      onDone={async (r) => {
        setReceipt(r);
        await refetch();
      }}
    />
  );
}

function SuccessBanner({ receipt }: { receipt: Receipt }) {
  const url = explorerTxUrl(receipt.transactionHash);
  return (
    <div className="notice ok" role="status">
      <strong>Abonelik başladı.</strong> Abonelik #{receipt.subscriptionId.toString()} cüzdanına
      eklendi, yenilemeler otomatik yapılır.{" "}
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          İşlemi gör
        </a>
      ) : (
        <span className="mono hash">{receipt.transactionHash}</span>
      )}
    </div>
  );
}

const STEP_LABELS: Record<CheckoutStep, { title: string; detail: string }> = {
  approve: {
    title: "USDC'yi Permit2 için onayla",
    detail: "Bu token için bir kerelik işlem.",
  },
  sign: {
    title: "Ödeme yetkisini imzala",
    detail: "Gas ödemezsin. Tavanı ve süresi aşağıda yazıyor.",
  },
  authorize: {
    title: "Ödeme yetkisini ver",
    detail: "Akıllı hesaplarda yetki zincir üstünde verilir. Tavanı aşağıda yazıyor.",
  },
  subscribe: {
    title: "Aboneliği başlat",
    detail: "İlk dönem tahsil edilir ve abonelik cüzdanına eklenir.",
  },
};

function Subscribe({ plan, onDone }: { plan: Plan; onDone: (receipt: Receipt) => Promise<void> }) {
  const { state, subscribe, reset } = useCheckout(plan);
  const periods = 12;
  const cap = formatAmount(plan.charge * BigInt(periods), plan.tokenDecimals);

  useEffect(() => {
    if (state.status === "success") {
      void onDone({ subscriptionId: state.subscriptionId, transactionHash: state.transactionHash });
    }
    // Run once per successful checkout.
  }, [state.status]);

  if (state.status === "success") return <p className="muted">Abonelik doğrulanıyor…</p>;

  const steps: CheckoutStep[] =
    state.status === "running" ? state.steps : ["approve", "sign", "subscribe"];
  const activeIndex = state.status === "running" ? steps.indexOf(state.step) : -1;
  const running = state.status === "running";

  return (
    <div className="stack">
      <h2>{plan.trialPeriod > 0 ? "Denemeyi başlat" : "Abone ol"}</h2>
      <ol className="steps">
        {steps.map((step, i) => {
          const status = !running
            ? "todo"
            : i < activeIndex
              ? "done"
              : i === activeIndex
                ? "active"
                : "todo";
          return (
            <li key={step} data-status={status}>
              <span className="bullet" aria-hidden="true">
                {status === "done" ? "✓" : i + 1}
              </span>
              <div>
                <div className="step-title">{STEP_LABELS[step].title}</div>
                <div className="step-detail">
                  {step === "subscribe" && plan.trialPeriod > 0
                    ? `Deneme başlar. İlk ödeme ${periodTr(plan.trialPeriod)} sonra alınır.`
                    : STEP_LABELS[step].detail}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="cap">
        En fazla{" "}
        <b>
          {cap} {plan.tokenSymbol}
        </b>{" "}
        çekilebilir ({periods} yenileme). Yetkiyi istediğin zaman iptal edebilirsin.
      </p>

      {state.status === "error" && (
        <div className="notice error" role="alert">
          {state.step ? `${STEP_LABELS[state.step].title} adımı başarısız: ` : ""}
          {state.error.message}
        </div>
      )}

      <button
        type="button"
        className="btn primary big"
        disabled={running || !plan.active}
        onClick={() => {
          if (state.status === "error") reset();
          void subscribe();
        }}
      >
        {running
          ? "Cüzdanında onayla…"
          : plan.trialPeriod > 0
            ? "Ücretsiz denemeyi başlat"
            : `${formatAmount(plan.charge, plan.tokenDecimals)} ${plan.tokenSymbol} öde ve abone ol`}
      </button>
    </div>
  );
}

const STATUS_TR: Record<SubscriptionView["status"], string> = {
  none: "Yok",
  active: "Aktif",
  past_due: "Ödeme bekliyor",
  canceled: "İptal edildi",
  expired: "Sona erdi",
};

function Manage({
  plan,
  subscription,
  entitled,
  onChange,
}: {
  plan: Plan;
  subscription: SubscriptionView;
  entitled: boolean;
  onChange: () => Promise<void>;
}) {
  const manage = useManageSubscription(subscription.id);
  const [confirming, setConfirming] = useState(false);
  const end = formatDate(subscription.currentPeriodEnd);

  const cancel = async () => {
    await manage.cancel();
    setConfirming(false);
    await onChange();
  };

  return (
    <div className="stack">
      <div className="status-row">
        <h2>Aboneliğin</h2>
        <span className={`pill ${subscription.status}`}>{STATUS_TR[subscription.status]}</span>
      </div>
      <dl className="lines compact">
        <div>
          <dt>Abonelik</dt>
          <dd className="mono">#{subscription.id.toString()}</dd>
        </div>
        <div>
          <dt>Erişim</dt>
          <dd>{entitled ? "Açık" : "Kapalı"}</dd>
        </div>
        <div>
          <dt>{subscription.status === "canceled" ? "Erişim bitişi" : "Sonraki yenileme"}</dt>
          <dd>{end}</dd>
        </div>
        {subscription.inTrial && (
          <div>
            <dt>Deneme</dt>
            <dd>{end} tarihinde biter</dd>
          </div>
        )}
      </dl>

      {subscription.status === "past_due" && (
        <div className="notice warn">
          Son yenileme tahsil edilemedi. Cüzdanında en az{" "}
          {formatAmount(plan.charge, plan.tokenDecimals)} {plan.tokenSymbol} olduğundan emin ol, bir
          sonraki denemede yenilenir.
        </div>
      )}
      {subscription.pendingPlanId !== null && (
        <div className="notice">
          {end} tarihinde Plan #{subscription.pendingPlanId.toString()} planına geçeceksin.
        </div>
      )}
      {subscription.status === "canceled" ? (
        <p className="muted">Yenileme yapılmayacak. Erişimin {end} tarihine kadar sürer.</p>
      ) : confirming ? (
        <div className="stack tight">
          <p>Aboneliği iptal edersen {end} tarihinden sonra yenileme yapılmaz.</p>
          <div className="row">
            <button
              type="button"
              className="btn danger"
              disabled={manage.pending !== null}
              onClick={cancel}
            >
              {manage.pending === "cancel" ? "İptal ediliyor…" : "Evet, iptal et"}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Vazgeç
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          Aboneliği iptal et
        </button>
      )}
      {manage.error && <div className="notice error">{manage.error.message}</div>}
    </div>
  );
}
