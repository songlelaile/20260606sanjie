"use client";

import { Save, Wand2 } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PrefillItem, ProductGrade } from "@/lib/types/domain";
import { formatMoney } from "@/lib/format";
import { decimalToPercentInput, percentInputToDecimal } from "@/lib/percent-input";
import { isPrefillReady } from "@/lib/prefill-status";

type BatchField = "grade" | "monthlyGsvOpportunity" | "grossMarginRate";

const BATCH_FIELD_LABEL: Record<BatchField, string> = {
  grade: "分层",
  monthlyGsvOpportunity: "月GSV机会",
  grossMarginRate: "毛利率"
};

export function PrefillEditor({ cycleId, initialItems }: { cycleId: string; initialItems: PrefillItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchField, setBatchField] = useState<BatchField>("grade");
  const [batchValue, setBatchValue] = useState("");
  const readyCount = items.filter(isPrefillReady).length;
  const allSelected = items.length > 0 && selected.size === items.length;

  function updateItem(id: string, patch: Partial<PrefillItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function toggleRow(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(items.map((item) => item.id)));
  }

  function selectUnfilled() {
    setSelected(new Set(items.filter((item) => !isPrefillReady(item)).map((item) => item.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function applyBatch() {
    if (selected.size === 0) {
      return;
    }
    let patch: Partial<PrefillItem>;
    if (batchField === "grade") {
      patch = { grade: batchValue as ProductGrade | "" };
    } else if (batchField === "grossMarginRate") {
      patch = { grossMarginRate: percentInputToDecimal(batchValue) };
    } else {
      patch = { monthlyGsvOpportunity: Number(batchValue) || 0 };
    }
    setItems((current) => current.map((item) => (selected.has(item.id) ? { ...item, ...patch } : item)));
    setMessage(
      `已对选中的 ${selected.size} 个商品批量设置「${BATCH_FIELD_LABEL[batchField]}」，记得点「保存并重算」生效。`
    );
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
          <span>
            共 {items.length} 个商品，已填写 <b>{readyCount}</b> 个纳入计算；
            未填写（分层/毛利率/月GSV机会缺项）仅占位，不参与三阶计算。
          </span>
        </div>
        <button type="button" onClick={save} disabled={saving}>
          <Save size={17} />
          {saving ? "保存并重算中" : "保存并重算"}
        </button>
      </div>

      <div className="prefill-batch-bar">
        <div className="prefill-batch-select">
          <span>
            已选 <b>{selected.size}</b> / {items.length}
          </span>
          <button type="button" className="ghost-button" onClick={selectAll}>
            全选
          </button>
          <button type="button" className="ghost-button" onClick={selectUnfilled}>
            选未填写
          </button>
          <button type="button" className="ghost-button" onClick={clearSelection} disabled={selected.size === 0}>
            清空选择
          </button>
        </div>
        <div className="prefill-batch-fill">
          <Wand2 size={15} />
          <span>批量设置</span>
          <select
            value={batchField}
            onChange={(event) => {
              setBatchField(event.target.value as BatchField);
              setBatchValue("");
            }}
            aria-label="批量设置字段"
          >
            <option value="grade">分层</option>
            <option value="monthlyGsvOpportunity">月GSV机会</option>
            <option value="grossMarginRate">毛利率</option>
          </select>
          <span>为</span>
          {batchField === "grade" ? (
            <select
              value={batchValue}
              onChange={(event) => setBatchValue(event.target.value)}
              aria-label="批量分层值"
            >
              <option value="">未填写</option>
              {["S", "A", "B", "C"].map((grade) => (
                <option key={grade} value={grade}>
                  {grade}
                </option>
              ))}
            </select>
          ) : batchField === "grossMarginRate" ? (
            <label className="percent-field">
              <input
                type="number"
                step="0.1"
                value={batchValue}
                placeholder="毛利率"
                onChange={(event) => setBatchValue(event.target.value)}
                aria-label="批量毛利率值"
              />
              <span>%</span>
            </label>
          ) : (
            <input
              type="number"
              value={batchValue}
              placeholder="月GSV机会"
              onChange={(event) => setBatchValue(event.target.value)}
              aria-label="批量月GSV机会值"
            />
          )}
          <button type="button" onClick={applyBatch} disabled={selected.size === 0}>
            应用到选中 {selected.size} 个
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="prefill-check-col">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => (event.target.checked ? selectAll() : clearSelection())}
                  aria-label="全选"
                />
              </th>
              <th>商品</th>
              <th>分层</th>
              <th>月GSV机会</th>
              <th>毛利率</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const ready = isPrefillReady(item);
              const checked = selected.has(item.id);
              return (
                <tr
                  key={item.id}
                  className={[ready ? "" : "row-unfilled", checked ? "row-selected" : ""]
                    .filter(Boolean)
                    .join(" ") || undefined}
                >
                  <td className="prefill-check-col">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRow(item.id)}
                      aria-label={`选择 ${item.productName}`}
                    />
                  </td>
                  <td>
                    <strong>{item.productId}</strong>
                    <span>{item.productName}</span>
                  </td>
                  <td>
                    <select
                      value={item.grade}
                      onChange={(event) =>
                        updateItem(item.id, { grade: event.target.value as ProductGrade | "" })
                      }
                      aria-label={`${item.productName} 分层`}
                    >
                      <option value="">未填写</option>
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
                      value={item.monthlyGsvOpportunity || ""}
                      placeholder="未填"
                      onChange={(event) =>
                        updateItem(item.id, { monthlyGsvOpportunity: Number(event.target.value) })
                      }
                      aria-label={`${item.productName} 月GSV机会`}
                    />
                    <small>{item.monthlyGsvOpportunity > 0 ? formatMoney(item.monthlyGsvOpportunity) : "—"}</small>
                  </td>
                  <td>
                    <label className="percent-field">
                      <input
                        type="number"
                        step="0.1"
                        value={item.grossMarginRate > 0 ? decimalToPercentInput(item.grossMarginRate) : ""}
                        placeholder="未填"
                        onChange={(event) =>
                          updateItem(item.id, { grossMarginRate: percentInputToDecimal(event.target.value) })
                        }
                        aria-label={`${item.productName} 毛利率`}
                      />
                      <span>%</span>
                    </label>
                  </td>
                  <td>
                    <span className={ready ? "pill-ready" : "pill-pending"}>
                      {ready ? "✓ 纳入计算" : "待填写"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {message ? <p className="form-message">{message}</p> : null}
    </section>
  );
}
