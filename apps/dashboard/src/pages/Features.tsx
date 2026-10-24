import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../api.js";
import { type DashboardPlan, planLabel } from "../types.js";

interface Feature {
  key: string;
  planIds: string[];
}

export function Features() {
  const { api } = useSession();
  const qc = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const featuresQuery = useQuery({
    queryKey: ["features"],
    queryFn: () => api<{ data: Feature[] }>("/v1/features"),
  });

  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => api<{ data: DashboardPlan[] }>("/v1/plans"),
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, planIds }: { key: string; planIds: string[] }) => {
      await api(`/v1/features/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: { planIds },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["features"] });
      setNewKey("");
      setSelectedPlanIds([]);
      setEditingKey(null);
    },
  });

  const plans = plansQuery.data?.data ?? [];
  const features = featuresQuery.data?.data ?? [];

  const handleTogglePlan = (planId: string) => {
    setSelectedPlanIds((prev) =>
      prev.includes(planId) ? prev.filter((id) => id !== planId) : [...prev, planId],
    );
  };

  const startEdit = (feat: Feature) => {
    setEditingKey(feat.key);
    setNewKey(feat.key);
    setSelectedPlanIds(feat.planIds);
  };

  return (
    <div className="stack loose">
      <div className="page-head">
        <div>
          <div className="caption">Erişim Yönetimi</div>
          <h1>Özellik Yetkileri (Features)</h1>
        </div>
      </div>

      <p className="subtle">
        Özellik anahtarlarını (feature key) abonelik planlarıyla eşleştirin. Mona Visa SDK ve
        entitlement API ile kullanıcı cüzdanının bu özelliklere erişimini doğrulayabilirsiniz.
      </p>

      <section className="card stack">
        <h2>{editingKey ? `Özelliği Düzenle: ${editingKey}` : "Yeni Özellik Tanımla"}</h2>
        <div className="stack compact">
          <label className="caption">Özellik Anahtarı (Feature Key)</label>
          <input
            type="text"
            className="input"
            placeholder="ör. pro_analytics, ai_tokens, api_access"
            value={newKey}
            disabled={editingKey !== null}
            onChange={(e) => setNewKey(e.target.value)}
          />
        </div>

        <div className="stack compact">
          <label className="caption">Erişim Veren Planlar</label>
          <div className="grid-plans">
            {plans.map((p) => (
              <label key={p.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectedPlanIds.includes(p.id)}
                  onChange={() => handleTogglePlan(p.id)}
                />
                <span>
                  <strong>{planLabel(p)}</strong> (#{p.id})
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="cluster">
          <button
            type="button"
            className="btn primary"
            disabled={!newKey.trim() || saveMutation.isPending}
            onClick={() => saveMutation.mutate({ key: newKey.trim(), planIds: selectedPlanIds })}
          >
            {saveMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
          </button>
          {editingKey && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditingKey(null);
                setNewKey("");
                setSelectedPlanIds([]);
              }}
            >
              İptal
            </button>
          )}
        </div>
      </section>

      <section className="card stack">
        <h2>Tanımlı Özellikler</h2>
        {features.length === 0 ? (
          <div className="subtle">Henüz tanımlanmış bir özellik yok.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Özellik Anahtarı</th>
                <th>Bağlı Planlar</th>
                <th className="action">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {features.map((f) => (
                <tr key={f.key}>
                  <td>
                    <code>{f.key}</code>
                  </td>
                  <td>
                    {f.planIds.length === 0 ? (
                      <span className="subtle">Hiçbir plan bağlı değil</span>
                    ) : (
                      f.planIds
                        .map((id) => {
                          const p = plans.find((x) => x.id === id);
                          return p ? `${planLabel(p)} (#${id})` : `#${id}`;
                        })
                        .join(", ")
                    )}
                  </td>
                  <td className="action">
                    <button type="button" className="btn small" onClick={() => startEdit(f)}>
                      Düzenle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
