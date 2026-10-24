import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../api.js";
import { apiUrl, explorerTxUrl } from "../config.js";
import { formatDate, short, usdc } from "../format.js";
import { navigate } from "../router.js";
import { type Amount, type Invoice, type Overview as OverviewData, planLabel } from "../types.js";

const sum = (amounts: Amount[]) => amounts.reduce((total, a) => total + BigInt(a.amount), 0n);

interface RevenuePoint {
  date: string;
  amount: string;
  count: number;
}

export function Overview() {
  const { api } = useSession();
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<OverviewData>("/v1/overview"),
    refetchInterval: 5000,
  });
  const revenueHistory = useQuery({
    queryKey: ["revenue-history", 30],
    queryFn: () => api<{ data: RevenuePoint[] }>("/v1/revenue?days=30"),
    refetchInterval: 15000,
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

      <section className="panel stack" aria-label="Gelir Grafiği">
        <div className="status-row">
          <h2>Son 30 Günlük Gelir Trendi</h2>
        </div>
        <RevenueChart points={revenueHistory.data?.data} />
      </section>

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

function RevenueChart({ points }: { points: RevenuePoint[] | undefined }) {
  if (!points || points.length === 0) {
    return (
      <div className="subtle" style={{ padding: "2rem", textAlign: "center" }}>
        Son 30 güne ait gelir verisi henüz bulunmuyor.
      </div>
    );
  }

  const values = points.map((p) => Number(BigInt(p.amount) / 1000000n));
  const max = Math.max(...values, 10);
  const width = 600;
  const height = 140;
  const pad = 20;

  const coords = points.map((p, idx) => {
    const x = pad + (idx / Math.max(points.length - 1, 1)) * (width - 2 * pad);
    const val = Number(BigInt(p.amount) / 1000000n);
    const y = height - pad - (val / max) * (height - 2 * pad);
    return { x, y, date: p.date, val };
  });

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "160px", display: "block" }}
      >
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke="var(--line, #333)"
          strokeWidth="1"
        />
        <polyline
          fill="none"
          stroke="var(--primary, #00bb7f)"
          strokeWidth="2.5"
          points={polylinePoints}
        />
        {coords.map((c, i) => (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r="3.5"
            fill="var(--primary, #00bb7f)"
          >
            <title>{`${c.date}: ${c.val} USDC`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

export function InvoiceTable({ invoices }: { invoices: Invoice[] | undefined }) {
  const { token } = useSession();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const downloadPdf = async (id: string) => {
    try {
      setDownloadingId(id);
      const res = await fetch(`${apiUrl}/v1/invoices/${id}/pdf`, {
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error("PDF download failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`PDF indirilemedi: ${err.message}`);
    } finally {
      setDownloadingId(null);
    }
  };

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
            <th className="caption action">Fatura</th>
          </tr>
        </thead>
        <tbody>
          {invoices === undefined ? (
            <tr>
              <td colSpan={7} className="empty">
                Yükleniyor…
              </td>
            </tr>
          ) : invoices.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
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
                  <td className="action">
                    <button
                      type="button"
                      className="btn small"
                      disabled={downloadingId === i.id}
                      onClick={() => downloadPdf(i.id)}
                    >
                      {downloadingId === i.id ? "…" : "PDF"}
                    </button>
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
