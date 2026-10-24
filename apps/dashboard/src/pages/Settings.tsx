import { webhookEventTypes } from "@monavisa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { type Team, useSession } from "../api.js";
import { copy, short } from "../format.js";
import type { ApiKey, WebhookEndpoint } from "../types.js";

/** A secret is shown once, on the highlighter, with a copy button. */
function SecretOnce({
  title,
  value,
  onDone,
}: {
  title: string;
  value: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice ok stack tight" role="status">
      <strong>{title}</strong>
      <code className="mono hash">{value}</code>
      <span>Bu değer bir daha gösterilmeyecek. Güvenli bir yere kaydet.</span>
      <div className="row">
        <button
          type="button"
          className="btn small"
          onClick={async () => setCopied(await copy(value))}
        >
          {copied ? "Kopyalandı" : "Kopyala"}
        </button>
        <button type="button" className="btn small" onClick={onDone}>
          Kaydettim
        </button>
      </div>
    </div>
  );
}

export function Settings() {
  return (
    <div className="stack loose">
      <div className="page-head">
        <div>
          <div className="caption">Ayarlar</div>
          <h1>Mağaza ve entegrasyon</h1>
        </div>
      </div>
      <div className="split">
        <div className="stack">
          <TeamName />
          <ApiKeys />
        </div>
        <Webhooks />
      </div>
    </div>
  );
}

function TeamName() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ team: Team }>("/v1/me") });
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (me.data) setName(me.data.team.name);
  }, [me.data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api("/v1/me", { method: "PATCH", body: { name } });
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    setSaved(true);
  };

  return (
    <form className="panel stack" onSubmit={save} aria-label="Mağaza">
      <h2>Mağaza</h2>
      <div className="field">
        <label htmlFor="team-name">Checkout'ta görünen ad</label>
        <input
          id="team-name"
          value={name}
          maxLength={60}
          required
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      {me.data && (
        <p className="muted small">
          Satıcı cüzdanı <span className="mono">{short(me.data.team.merchant)}</span>
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn">
          Kaydet
        </button>
        {saved && <span className="muted small">Kaydedildi</span>}
      </div>
    </form>
  );
}

function ApiKeys() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api<{ data: ApiKey[] }>("/v1/api-keys"),
  });
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ apiKey: string }>("/v1/api-keys", {
        method: "POST",
        body: { label: label.trim() },
      });
      setSecret(res.apiKey);
      setLabel("");
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (id: string) => {
    await api(`/v1/api-keys/${id}`, { method: "DELETE" }).catch(() => {});
    await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  };

  const active = keys.data?.data.filter((k) => !k.revokedAt) ?? [];
  return (
    <section className="panel stack" aria-label="API anahtarları">
      <h2>API anahtarları</h2>
      <p className="muted small">
        Sunucunda <span className="mono">@monavisa/node</span> ile kullan. Tarayıcıya koyma.
      </p>
      {secret && (
        <SecretOnce title="Yeni API anahtarı" value={secret} onDone={() => setSecret(null)} />
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="caption">Etiket</th>
              <th className="caption">Anahtar</th>
              <th className="caption" aria-label="İşlemler" />
            </tr>
          </thead>
          <tbody>
            {active.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  Aktif anahtar yok.
                </td>
              </tr>
            )}
            {active.map((k) => (
              <tr key={k.id}>
                <td>{k.label}</td>
                <td className="mono">{k.prefix}</td>
                <td className="num">
                  <button type="button" className="btn small quiet" onClick={() => revoke(k.id)}>
                    İptal et
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="row" onSubmit={create}>
        <input
          id="key-label"
          aria-label="Anahtar etiketi"
          placeholder="Backend"
          value={label}
          maxLength={40}
          required
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="btn">
          Anahtar oluştur
        </button>
      </form>
      {error && <div className="notice error">{error}</div>}
    </section>
  );
}

function Webhooks() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const endpoints = useQuery({
    queryKey: ["webhooks"],
    queryFn: () => api<{ data: WebhookEndpoint[] }>("/v1/webhook-endpoints"),
  });
  const [url, setUrl] = useState("");
  const [event, setEvent] = useState("*");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ secret: string }>("/v1/webhook-endpoints", {
        method: "POST",
        body: { url: url.trim(), events: [event] },
      });
      setSecret(res.secret);
      setUrl("");
      await queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    await api(`/v1/webhook-endpoints/${id}`, { method: "DELETE" }).catch(() => {});
    await queryClient.invalidateQueries({ queryKey: ["webhooks"] });
  };

  return (
    <section className="panel stack" aria-label="Webhook'lar">
      <h2>Webhook'lar</h2>
      <p className="muted small">
        Olaylar <span className="mono">monavisa-signature</span> başlığıyla imzalanır. Doğrulamak
        için <span className="mono">verifyWebhook</span> kullan.
      </p>
      {secret && (
        <SecretOnce title="İmzalama anahtarı" value={secret} onDone={() => setSecret(null)} />
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="caption">Adres</th>
              <th className="caption">Olaylar</th>
              <th className="caption" aria-label="İşlemler" />
            </tr>
          </thead>
          <tbody>
            {endpoints.data?.data.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  Henüz webhook yok.
                </td>
              </tr>
            )}
            {endpoints.data?.data.map((w) => (
              <tr key={w.id}>
                <td className="mono hash">{w.url}</td>
                <td>{w.events.includes("*") ? "Tümü" : w.events.join(", ")}</td>
                <td className="num">
                  <button type="button" className="btn small quiet" onClick={() => remove(w.id)}>
                    Sil
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="stack tight" onSubmit={create}>
        <div className="field">
          <label htmlFor="hook-url">Adres</label>
          <input
            id="hook-url"
            type="url"
            placeholder="https://ornek.com/webhooks/monavisa"
            value={url}
            required
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="hook-event">Olay</label>
          <select id="hook-event" value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="*">Tüm olaylar</option>
            {webhookEventTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn">
          Webhook ekle
        </button>
      </form>
      {error && <div className="notice error">{error}</div>}
    </section>
  );
}
