import { useQuery } from "@tanstack/react-query";
import { useSession } from "../api.js";
import type { Invoice } from "../types.js";
import { InvoiceTable } from "./Overview.js";

export function Payments() {
  const { api } = useSession();
  const invoices = useQuery({
    queryKey: ["invoices", 200],
    queryFn: () => api<{ data: Invoice[] }>("/v1/invoices?limit=200"),
    refetchInterval: 5000,
  });
  return (
    <div className="stack loose">
      <div className="page-head">
        <div>
          <div className="caption">Ödemeler</div>
          <h1>Zincirdeki her tahsilat</h1>
        </div>
      </div>
      <section className="panel stack" aria-label="Ödemeler">
        <p className="muted small">
          Her satır zincirdeki bir ödemedir. Tutar doğrudan cüzdanına gelir, protokol ücreti ayrıca
          alınır.
        </p>
        {invoices.error && <div className="notice error">{invoices.error.message}</div>}
        <InvoiceTable invoices={invoices.data?.data} />
      </section>
    </div>
  );
}
