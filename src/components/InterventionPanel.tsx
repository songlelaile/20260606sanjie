"use client";

import { Flag, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { INTERVENTION_CATEGORIES, type Intervention } from "@/lib/types/domain";

const CATEGORIES = INTERVENTION_CATEGORIES;

function todayIso() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function InterventionPanel({
  initialInterventions,
  products
}: {
  initialInterventions: Intervention[];
  products: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialInterventions);
  const [date, setDate] = useState(todayIso());
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [products, search]);

  const nameById = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);

  function togglePicked(id: string) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function submit() {
    if (!title.trim()) {
      setMessage("请填写动作标题");
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/interventions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date, title, category, note, productIds: picked })
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { intervention: Intervention }; error?: string }
      | null;
    setBusy(false);
    if (!response.ok || !payload?.data) {
      setMessage(payload?.error ?? "标记失败，请重试");
      return;
    }
    setItems((cur) => [payload.data!.intervention, ...cur]);
    setTitle("");
    setNote("");
    setPicked([]);
    setSearch("");
    setMessage(`已标记动作「${payload.data.intervention.title}」`);
    router.refresh();
  }

  async function remove(item: Intervention) {
    if (!window.confirm(`删除动作「${item.title}」？`)) return;
    setBusy(true);
    const response = await fetch(`/api/interventions/${item.id}`, { method: "DELETE" });
    setBusy(false);
    if (response.ok) {
      setItems((cur) => cur.filter((x) => x.id !== item.id));
      setMessage(`已删除「${item.title}」`);
    } else {
      setMessage("删除失败，请重试");
    }
  }

  return (
    <section className="table-panel intervention-panel">
      <div className="panel-toolbar">
        <div>
          <strong>标记优化动作</strong>
          <span>记录某天做了什么调整：标题写具体动作（如「上调P1日预算30%」），类别选它对应整改的「三维八步」突破维度，用于后续在管理视角看前后数据变化。</span>
        </div>
      </div>

      <div className="intervention-form">
        <div className="intervention-form-row">
          <label>
            动作日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            类别
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="intervention-title-field">
            标题
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：上调 P1 日预算 30%"
            />
          </label>
        </div>
        <label>
          备注（可选）
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="调整细节、预期目标等"
          />
        </label>
        <div className="intervention-products">
          <div className="intervention-products-head">
            <span>受影响商品（不选 = 整店）· 已选 {picked.length}</span>
            <input
              className="intervention-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索商品ID/名称"
            />
          </div>
          {products.length === 0 ? (
            <p className="intervention-empty-products">暂无商品（先导入商品源数据并重算）。</p>
          ) : (
            <div className="intervention-products-list">
              {filteredProducts.map((p) => (
                <label key={p.id} className="intervention-product-item">
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    onChange={() => togglePicked(p.id)}
                  />
                  <span>
                    <strong>{p.id}</strong> {p.name}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="auth-submit intervention-submit" onClick={submit} disabled={busy}>
          <Flag size={15} />
          {busy ? "标记中…" : "标记动作"}
        </button>
        {message ? <p className="form-message">{message}</p> : null}
      </div>

      <div className="table-wrap">
        <table className="management-table intervention-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>类别</th>
              <th>动作</th>
              <th>受影响商品</th>
              <th>标记人</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-table-cell">
                  还没有标记任何优化动作。
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id}>
                  <td className="nowrap">{item.date}</td>
                  <td>
                    <span className="pill-pending">{item.category || "—"}</span>
                  </td>
                  <td>
                    <strong>{item.title}</strong>
                    {item.note ? <span>{item.note}</span> : null}
                  </td>
                  <td>
                    {item.productIds.length === 0
                      ? "整店"
                      : item.productIds
                          .slice(0, 3)
                          .map((id) => nameById.get(id) ?? id)
                          .join("、") + (item.productIds.length > 3 ? ` 等 ${item.productIds.length} 个` : "")}
                  </td>
                  <td className="nowrap">{item.createdBy || "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="danger-outline-button"
                      disabled={busy}
                      onClick={() => remove(item)}
                    >
                      <Trash2 size={14} />
                      删除
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
