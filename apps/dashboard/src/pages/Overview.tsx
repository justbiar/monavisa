import { useQuery } from "@tanstack/react-query";
import { useSession } from "../api.js";
import { explorerTxUrl } from "../config.js";
import { formatDate, short, usdc } from "../format.js";
import { navigate } from "../router.js";
import { type Amount, type Invoice, type Overview as OverviewData, planLabel } from "../types.js";

const sum = (amounts: Amount[]) => amounts.reduce((total, a) => total + BigInt(a.amount), 0n);

export function Overview() {
  const { api } = useSession();
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<OverviewData>("/v1/overview"),
    refetchInterval: 5000,
  });
  const invoices = useQuery({
    queryKey: ["invoices", 8],
    queryFn: () => api<{ data: Invoice[] }>("/v1/invoices?limit=8"),
    refetchInterval: 5000,
  });

  const o = overview.data;
  return (
    <div className="stack loose">
      <div className="page-head">
        <div>
          <div className="caption">Genel bakış</div>
          <h1>Gelir</h1>
        </div>
        <button type="button" className="btn primary" onClick={() => navigate("/plans")}>
          Plan oluştur
        </button>
      </div>

      {overview.error && <div className="notice error">{overview.error.message}</div>}

      <section className="metrics" aria-label="Özet">
        <div className="metric">
          <span className="caption">Aylık tekrarlayan gelir</span>
          <span className="value">
            {o ? usdc(sum(o.mrr)) : "…"} <small>USDC</small>
          </span>
        </div>
        <div className="metric">
          <span className="caption">Aktif abone</span>
          <span className="value">{o ? o.subscribers.active : "…"}</span>
        </div>
        <div className="metric">
          <span className="caption">Son 30 gün</span>
          <span className="value">
            {o ? usdc(sum(o.revenue30d)) : "…"} <small>USDC</small>
          </span>
        </div>
        <div className="metric">
          <span className="caption">Toplam gelir</span>
          <span className="value">
            {o ? usdc(sum(o.revenue)) : "…"} <small>USDC</small>
          </span>
        </div>
      </section>

      {o && (
        <dl className="lines compact counts">
          <div>
            <dt>Denemede</dt>
            <dd>{o.subscribers.trialing}</dd>
          </div>
          <div>
            <dt>Ödeme bekliyor</dt>
            <dd>{o.subscribers.pastDue}</dd>
          </div>
          <div>
            <dt>İptal edildi, erişimi sürüyor</dt>
            <dd>{o.subscribers.canceling}</dd>
          </div>
          <div>
            <dt>Toplam ödeme</dt>
            <dd>{o.payments}</dd>
          </div>
        </dl>
      )}

      <section className="panel stack" aria-label="Son ödemeler">
        <div className="status-row">
          <h2>Son ödemeler</h2>
          <button type="button" className="link" onClick={() => navigate("/payments")}>
            Tümü
          </button>
        </div>
        <InvoiceTable invoices={invoices.data?.data} />
      </section>
    </div>
  );
}

export function InvoiceTable({ invoices }: { invoices: Invoice[] | undefined }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="caption">Tarih</th>
            <th className="caption">Müşteri</th>
            <th className="caption">Plan</th>
            <th className="caption num">Tutar</th>
            <th className="caption num">Protokol</th>
            <th className="caption">İşlem</th>
          </tr>
        </thead>
        <tbody>
          {invoices === undefined ? (
            <tr>
              <td colSpan={6} className="empty">
                Yükleniyor…
              </td>
            </tr>
          ) : invoices.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty">
                Henüz ödeme yok. İlk abone geldiğinde burada görünür.
              </td>
            </tr>
          ) : (
            invoices.map((i) => {
              const url = explorerTxUrl(i.transactionHash);
              return (
                <tr key={i.id}>
                  <td>{formatDate(i.paidAt)}</td>
                  <td className="mono">{short(i.customer)}</td>
                  <td>{planLabel({ id: i.planId, name: i.planName })}</td>
                  <td className="num">{usdc(i.amount)} USDC</td>
                  <td className="num muted">{usdc(i.fee)}</td>
                  <td className="mono">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer">
                        {short(i.transactionHash)}
                      </a>
                    ) : (
                      short(i.transactionHash)
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
