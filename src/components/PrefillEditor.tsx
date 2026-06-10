"use client";

import { Save } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PrefillItem, ProductGrade } from "@/lib/types/domain";
import { formatMoney } from "@/lib/format";
import { decimalToPercentInput, percentInputToDecimal } from "@/lib/percent-input";

export function PrefillEditor({ cycleId, initialItems }: { cycleId: string; initialItems: PrefillItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function updateItem(id: string, patch: Partial<PrefillItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function save() {
    setSaving(true);
    setMessage("");
    const response = await fetch(`/api/cycles/${cycleId}/prefill-items`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(payload?.error ?? "保存失败");
      setSaving(false);
      return;
    }
    // 保存后立即重算，让填写的月GSV机会/分层/毛利率参与三个看板计算
    await fetch("/api/calc-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId })
    });
    router.refresh();
    setSaving(false);
    setMessage("已保存并重算，切换到看板即可看到按你填写参数计算的结果。");
  }

  return (
    <section className="table-panel">
      <div className="panel-toolbar">
        <div>
          <strong>可编辑预填写参数</strong>
          <span>共 {items.length} 个商品，填写月GSV机会等参数后保存即重算并进入看板</span>
        </div>
        <button type="button" onClick={save} disabled={saving}>
          <Save size={17} />
          {saving ? "保存并重算中" : "保存并重算"}
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th>分层</th>
              <th>月GSV机会</th>
              <th>毛利率</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.productId}</strong>
                  <span>{item.productName}</span>
                </td>
                <td>
                  <select
                    value={item.grade}
                    onChange={(event) => updateItem(item.id, { grade: event.target.value as ProductGrade })}
                  >
                    {["S", "A", "B", "C"].map((grade) => (
                      <option key={grade} value={grade}>
                        {grade}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    value={item.monthlyGsvOpportunity}
                    onChange={(event) =>
                      updateItem(item.id, { monthlyGsvOpportunity: Number(event.target.value) })
                    }
                    aria-label={`${item.productName} 月GSV机会`}
                  />
                  <small>{formatMoney(item.monthlyGsvOpportunity)}</small>
                </td>
                <td>
                  <label className="percent-field">
                    <input
                      type="number"
                      step="0.1"
                      value={decimalToPercentInput(item.grossMarginRate)}
                      onChange={(event) =>
                        updateItem(item.id, { grossMarginRate: percentInputToDecimal(event.target.value) })
                      }
                      aria-label={`${item.productName} 毛利率`}
                    />
                    <span>%</span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message ? <p className="form-message">{message}</p> : null}
    </section>
  );
}
