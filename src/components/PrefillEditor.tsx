"use client";

import { Save } from "lucide-react";
import { useState } from "react";
import type { PrefillItem, ProductGrade } from "@/lib/types/domain";
import { formatMoney } from "@/lib/format";
import { decimalToPercentInput, percentInputToDecimal } from "@/lib/percent-input";

export function PrefillEditor({ cycleId, initialItems }: { cycleId: string; initialItems: PrefillItem[] }) {
  const [items, setItems] = useState(initialItems.slice(0, 20));
  const [message, setMessage] = useState("");

  function updateItem(id: string, patch: Partial<PrefillItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function save() {
    const response = await fetch(`/api/cycles/${cycleId}/prefill-items`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
    setMessage(response.ok ? "已保存预填写参数，并生成版本记录" : "保存失败");
  }

  return (
    <section className="table-panel">
      <div className="panel-toolbar">
        <div>
          <strong>可编辑预填写参数</strong>
          <span>当前展示前 20 个商品，API 已支持全量保存</span>
        </div>
        <button type="button" onClick={save}>
          <Save size={17} />
          保存
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
              <th>付费访客占比</th>
              <th>人群策略</th>
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
                      <option key={grade}>{grade}</option>
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
                <td>
                  <label className="percent-field">
                    <input
                      type="number"
                      step="0.1"
                      value={decimalToPercentInput(item.paidVisitorRatio)}
                      onChange={(event) =>
                        updateItem(item.id, { paidVisitorRatio: percentInputToDecimal(event.target.value) })
                      }
                      aria-label={`${item.productName} 付费访客占比`}
                    />
                    <span>%</span>
                  </label>
                </td>
                <td>
                  <input
                    value={item.audienceStrategy ?? ""}
                    onChange={(event) => updateItem(item.id, { audienceStrategy: event.target.value })}
                    aria-label={`${item.productName} 人群策略`}
                  />
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
