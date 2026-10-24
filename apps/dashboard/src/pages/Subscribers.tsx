import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../api.js";
import { STATUS_TR, formatDate, short } from "../format.js";
import { type DashboardPlan, type DashboardSubscription, planLabel } from "../types.js";

export function Subscribers() {
  const { api } = useSession();
  const [planId, setPlanId] = useState("");
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ data: DashboardPlan[] }>("/v1/plans"),
  });
  const subs = useQuery({
    queryKey: ["subscriptions", planId],
    queryFn: () =>
      api<{ data: DashboardSubscription[] }>(
        `/v1/subscriptions${planId ? `?planId=${planId}` : ""}`,
      ),
    refetchInterval: 5000,
  });

  return (
    <div className="stack loose">
      <div className="page-head">
        <div>
          <div className="caption">Aboneler</div>
          <h1>Kim abone?</h1>
        </div>
        <div className="field inline">
          <label htmlFor="sub-plan">Plan</label>
          <select id="sub-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Tüm planlar</option>
            {plans.data?.data.map((p) => (
              <option key={p.id} value={p.id}>
                {planLabel(p)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section className="panel" aria-label="Abone listesi">
        {subs.error && <div className="notice error">{subs.error.message}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="caption">Abonelik</th>
                <th className="caption">Müşteri</th>
                <th className="caption">Plan</th>
                <th className="caption">Durum</th>
                <th className="caption">Dönem sonu</th>
                <th className="caption">Erişim</th>
              </tr>
            </thead>
            <tbody>
              {subs.data === undefined ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Yükleniyor…
                  </td>
                </tr>
              ) : subs.data.data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Henüz abone yok. Plan sayfasından checkout linkini paylaş.
                  </td>
                </tr>
              ) : (
                subs.data.data.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">#{s.id}</td>
                    <td className="mono" title={s.customer}>
                      {short(s.customer)}
                    </td>
                    <td>{planLabel({ id: s.planId, name: s.planName })}</td>
                    <td>
                      <span className={`pill ${s.status}`}>
                        {s.inTrial && s.status === "active" ? "Denemede" : STATUS_TR[s.status]}
                      </span>
                    </td>
                    <td>{formatDate(s.currentPeriodEnd)}</td>
                    <td>{s.entitled ? "Açık" : "Kapalı"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
