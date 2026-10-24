import { planFactoryAbi } from "@monavisa/core";
import { useMonaVisa } from "@monavisa/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { parseEventLogs, parseUnits } from "viem";
import { useConfig, useConnection } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useSession } from "../api.js";
import { checkoutUrl, settlementToken } from "../config.js";
import { copy, daysTr, periodTr, USDC_DECIMALS, usdc } from "../format.js";
import { type Team } from "../api.js";
import { type DashboardPlan, planLabel } from "../types.js";
import { WalletRequired } from "../wallet.js";

const DAY = 24 * 60 * 60;
const PERIODS = [
  { value: 30 * DAY, label: "Aylık" },
  { value: 365 * DAY, label: "Yıllık" },
  { value: 7 * DAY, label: "Haftalık" },
];

const errorText = (err: unknown) => {
  const e = err as { shortMessage?: string; message?: string };
  return e.shortMessage ?? e.message ?? String(err);
};

export function Plans() {
  const { api } = useSession();
  const [awaiting, setAwaiting] = useState<string[]>([]);
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ data: DashboardPlan[] }>("/v1/plans"),
    // Poll faster while a freshly created plan waits for the indexer.
    refetchInterval: awaiting.length ? 1500 : 10_000,
  });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ team: Team }>("/v1/me") });
  const connection = useConnection();
  // Pausing sales is an on-chain call, so it is offered only with the merchant wallet connected.
  const canSign =
    connection.status === "connected" &&
    connection.address.toLowerCase() === me.data?.team.merchant;
  const indexed = new Set(plans.data?.data.map((p) => p.id));
  const pending = awaiting.filter((id) => !indexed.has(id));

  return (
    <div className="stack loose">
      <div className="page-head">
        <div>
          <div className="caption">Planlar</div>
          <h1>Ne satıyorsun?</h1>
        </div>
      </div>

      <div className="split">
        <section className="panel stack" aria-label="Planlar">
          <h2>Planların</h2>
          {plans.error && <div className="notice error">{plans.error.message}</div>}
          {pending.map((id) => (
            <div key={id} className="notice">
              Plan #{id} zincirde onaylandı. Index'e eklenmesi bekleniyor…
            </div>
          ))}
          {plans.data?.data.length === 0 && pending.length === 0 && (
            <p className="muted">Henüz plan yok. Sağdaki formdan ilk planını oluştur.</p>
          )}
          <div className="plan-list">
            {plans.data?.data.map((plan) => (
              <PlanRow key={plan.id} plan={plan} canSign={canSign} />
            ))}
          </div>
        </section>

        <CreatePlan onCreated={(id) => setAwaiting((ids) => [...ids, id])} />
      </div>
    </div>
  );
}

function PlanRow({ plan, canSign }: { plan: DashboardPlan; canSign: boolean }) {
  const { api } = useSession();
  const config = useConfig();
  const { addresses, chainId } = useMonaVisa();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(plan.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = `${checkoutUrl}/plan/${plan.id}`;

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("name");
    setError(null);
    try {
      await api(`/v1/plans/${plan.id}/metadata`, { method: "PUT", body: { name } });
      await queryClient.invalidateQueries({ queryKey: ["plans"] });
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleSales = async () => {
    setBusy("active");
    setError(null);
    try {
      const hash = await writeContract(config, {
        address: addresses.planFactory,
        abi: planFactoryAbi,
        functionName: "setPlanActive",
        args: [BigInt(plan.id), !plan.active],
        chainId,
      });
      await waitForTransactionReceipt(config, { hash, chainId });
      await queryClient.invalidateQueries({ queryKey: ["plans"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const subs = plan.subscribers;
  return (
    <article className="plan-row">
      <div className="plan-main">
        {editing ? (
          <form className="row" onSubmit={saveName}>
            <input
              id={`plan-name-${plan.id}`}
              aria-label="Plan adı"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn small" disabled={busy !== null || !name.trim()}>
              Kaydet
            </button>
            <button type="button" className="link" onClick={() => setEditing(false)}>
              Vazgeç
            </button>
          </form>
        ) : (
          <div className="row">
            <h3>{planLabel(plan)}</h3>
            <span className={`pill ${plan.active ? "active" : "canceled"}`}>
              {plan.active ? "Satışta" : "Satış kapalı"}
            </span>
          </div>
        )}
        <div className="plan-price">
          {usdc(plan.price)} <span className="muted">USDC / {periodTr(plan.period)}</span>
        </div>
        <div className="muted small">
          #{plan.id}
          {plan.trialPeriod > 0 && ` · ${daysTr(plan.trialPeriod)} deneme`}
          {plan.gracePeriod > 0 && ` · ${daysTr(plan.gracePeriod)} ödeme süresi`}
        </div>
      </div>
      <dl className="lines compact plan-counts">
        <div>
          <dt>Aktif</dt>
          <dd>{subs.active}</dd>
        </div>
        <div>
          <dt>Denemede</dt>
          <dd>{subs.trialing}</dd>
        </div>
        <div>
          <dt>Ödeme bekliyor</dt>
          <dd>{subs.pastDue}</dd>
        </div>
      </dl>
      <div className="row">
        <button
          type="button"
          className="btn small quiet"
          onClick={async () => setCopied(await copy(link))}
        >
          {copied ? "Kopyalandı" : "Checkout linkini kopyala"}
        </button>
        <a className="btn small quiet" href={link} target="_blank" rel="noreferrer">
          Aç
        </a>
        {!editing && (
          <button type="button" className="btn small quiet" onClick={() => setEditing(true)}>
            Adını değiştir
          </button>
        )}
        {canSign && (
          <button
            type="button"
            className="btn small quiet"
            disabled={busy !== null}
            onClick={toggleSales}
          >
            {busy === "active" ? "Cüzdanında onayla…" : plan.active ? "Satışı durdur" : "Satışa aç"}
          </button>
        )}
      </div>
      {!copied && (
        <code className="mono muted hash" title="Checkout linki">
          {link}
        </code>
      )}
      {error && <div className="notice error">{error}</div>}
    </article>
  );
}

function CreatePlan({ onCreated }: { onCreated: (planId: string) => void }) {
  const { api } = useSession();
  const config = useConfig();
  const connection = useConnection();
  const { addresses, chainId } = useMonaVisa();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [period, setPeriod] = useState(PERIODS[0]!.value);
  const [trialDays, setTrialDays] = useState("0");
  const [graceDays, setGraceDays] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (connection.status !== "connected") {
      setError("Plan oluşturmak için satıcı cüzdanını bağla.");
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const amount = parseUnits(price.replace(",", "."), USDC_DECIMALS);
      if (amount <= 0n) throw new Error("Fiyat sıfırdan büyük olmalı");
      const hash = await writeContract(config, {
        address: addresses.planFactory,
        abi: planFactoryAbi,
        functionName: "createPlan",
        args: [
          settlementToken,
          amount,
          period,
          Number(trialDays || 0) * DAY,
          Number(graceDays || 0) * DAY,
          connection.address,
        ],
        chainId,
      });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId });
      const [created] = parseEventLogs({
        abi: planFactoryAbi,
        eventName: "PlanCreated",
        logs: receipt.logs,
      });
      if (!created) throw new Error("Plan oluşturma olayı makbuzda yok");
      const planId = created.args.planId.toString();
      await api(`/v1/plans/${planId}/metadata`, { method: "PUT", body: { name: name.trim() } });
      onCreated(planId);
      setDone(planId);
      setName("");
      setPrice("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel stack" onSubmit={submit} aria-label="Yeni plan">
      <h2>Yeni plan</h2>
      <div className="field">
        <label htmlFor="plan-name">Plan adı</label>
        <input
          id="plan-name"
          value={name}
          maxLength={60}
          required
          placeholder="Pro Tıraş"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="plan-price">Fiyat (USDC)</label>
          <input
            id="plan-price"
            inputMode="decimal"
            value={price}
            required
            placeholder="49"
            pattern="[0-9]+([.,][0-9]{1,6})?"
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="plan-period">Dönem</label>
          <select
            id="plan-period"
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value))}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="plan-trial">Deneme (gün)</label>
          <input
            id="plan-trial"
            type="number"
            min={0}
            max={90}
            value={trialDays}
            onChange={(e) => setTrialDays(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="plan-grace">Ödeme süresi (gün)</label>
          <input
            id="plan-grace"
            type="number"
            min={0}
            max={30}
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
          />
        </div>
      </div>
      <p className="muted small">
        Gelir doğrudan bağlı cüzdana gider. Fiyat sonradan değişmez: yeni fiyat için yeni plan
        açarsın, mevcut aboneler eski fiyatta kalır.
      </p>
      {done && <div className="notice ok">Plan #{done} oluşturuldu.</div>}
      {error && <div className="notice error">{error}</div>}
      <WalletRequired>
        <button type="submit" className="btn primary big" disabled={busy}>
          {busy ? "Cüzdanında onayla…" : "Planı zincirde oluştur"}
        </button>
      </WalletRequired>
    </form>
  );
}
