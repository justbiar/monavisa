import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useSession } from "../api.js";
import { copy } from "../format.js";
import { type DashboardPlan, type PaymentLink, planLabel } from "../types.js";

export function Links() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ data: DashboardPlan[] }>("/v1/plans"),
  });
  const links = useQuery({
    queryKey: ["links"],
    queryFn: () => api<{ data: PaymentLink[] }>("/v1/payment-links"),
  });
  const [planId, setPlanId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const selected = planId || plans.data?.data.find((p) => p.active)?.id || "";

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/v1/payment-links", {
        method: "POST",
        body: { planId: selected, ...(label.trim() ? { label: label.trim() } : {}) },
      });
      setLabel("");
      await queryClient.invalidateQueries({ queryKey: ["links"] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const disable = async (id: string) => {
    await api(`/v1/payment-links/${id}`, { method: "DELETE" }).catch(() => {});
    await queryClient.invalidateQueries({ queryKey: ["links"] });
  };

  return (
    <div className="stack loose">
      <div className="page-head">
        <div>
          <div className="caption">Ödeme linkleri</div>
          <h1>Her kanal için bir link</h1>
        </div>
      </div>

      <div className="split">
        <section className="panel stack" aria-label="Linkler">
          <h2>Aktif linkler</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="caption">Etiket</th>
                  <th className="caption">Plan</th>
                  <th className="caption">Link</th>
                  <th className="caption" aria-label="İşlemler" />
                </tr>
              </thead>
              <tbody>
                {links.data?.data.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      Henüz link yok. Instagram, WhatsApp ya da web siten için ayrı linkler aç.
                    </td>
                  </tr>
                )}
                {links.data?.data.map((l) => (
                  <tr key={l.id}>
                    <td>{l.label ?? "Etiketsiz"}</td>
                    <td>{planLabel({ id: l.planId, name: l.planName })}</td>
                    <td className="mono hash">{l.url ?? `/l/${l.id}`}</td>
                    <td className="num">
                      <div className="row end">
                        {l.url && (
                          <button
                            type="button"
                            className="btn small quiet"
                            onClick={async () => setCopied((await copy(l.url!)) ? l.id : null)}
                          >
                            {copied === l.id ? "Kopyalandı" : "Kopyala"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn small quiet"
                          onClick={() => disable(l.id)}
                        >
                          Kapat
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <form className="panel stack" onSubmit={create} aria-label="Yeni link">
          <h2>Yeni link</h2>
          <div className="field">
            <label htmlFor="link-plan">Plan</label>
            <select
              id="link-plan"
              value={selected}
              onChange={(e) => setPlanId(e.target.value)}
              required
            >
              {plans.data?.data.length === 0 && <option value="">Önce bir plan oluştur</option>}
              {plans.data?.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {planLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="link-label">Etiket (isteğe bağlı)</label>
            <input
              id="link-label"
              value={label}
              maxLength={60}
              placeholder="Instagram"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          {error && <div className="notice error">{error}</div>}
          <button type="submit" className="btn primary" disabled={!selected}>
            Link oluştur
          </button>
        </form>
      </div>
    </div>
  );
}
