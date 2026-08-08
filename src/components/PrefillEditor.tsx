"use client";

import { Plus, Save, Tag, Wand2, X } from "lucide-react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PrefillItem, ProductGrade, ProductTag } from "@/lib/types/domain";
import { formatMoney } from "@/lib/format";
import { decimalToPercentInput, percentInputToDecimal } from "@/lib/percent-input";
import { isPrefillReady } from "@/lib/prefill-status";

type BatchField = "grade" | "monthlyGsvOpportunity" | "grossMarginRate" | "tag";
type FillState = "all" | "filled" | "empty";
type ReadyFilter = "all" | "ready" | "pending";
type GradeFilter = "all" | "unfilled" | ProductGrade;

const GRADES: ProductGrade[] = ["S", "A", "B", "C"];

const BATCH_FIELD_LABEL: Record<BatchField, string> = {
  grade: "分层",
  monthlyGsvOpportunity: "月GSV机会",
  grossMarginRate: "毛利率",
  tag: "看数分类"
};

function createTagId() {
  return `tag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanTagName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
}

function addUnique(ids: string[] | undefined, id: string) {
  const next = ids ?? [];
  return next.includes(id) ? next : [...next, id];
}

export function PrefillEditor({
  cycleId,
  initialItems,
  initialTags
}: {
  cycleId: string;
  initialItems: PrefillItem[];
  initialTags: ProductTag[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [tags, setTags] = useState(initialTags);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchField, setBatchField] = useState<BatchField>("grade");
  const [batchValue, setBatchValue] = useState("");
  const [newTagByItem, setNewTagByItem] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [readyFilter, setReadyFilter] = useState<ReadyFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [gsvFilter, setGsvFilter] = useState<FillState>("all");
  const [marginFilter, setMarginFilter] = useState<FillState>("all");
  const [tagPanelItemId, setTagPanelItemId] = useState<string | null>(null);

  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const readyCount = items.filter(isPrefillReady).length;

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const ready = isPrefillReady(item);
      const tagIds = item.tagIds ?? [];
      if (q && !`${item.productId} ${item.productName}`.toLowerCase().includes(q)) return false;
      if (readyFilter === "ready" && !ready) return false;
      if (readyFilter === "pending" && ready) return false;
      if (gradeFilter === "unfilled" && item.grade !== "") return false;
      if (gradeFilter !== "all" && gradeFilter !== "unfilled" && item.grade !== gradeFilter) return false;
      if (tagFilter === "untagged" && tagIds.length > 0) return false;
      if (tagFilter !== "all" && tagFilter !== "untagged" && !tagIds.includes(tagFilter)) return false;
      if (gsvFilter === "filled" && item.monthlyGsvOpportunity <= 0) return false;
      if (gsvFilter === "empty" && item.monthlyGsvOpportunity > 0) return false;
      if (marginFilter === "filled" && item.grossMarginRate <= 0) return false;
      if (marginFilter === "empty" && item.grossMarginRate > 0) return false;
      return true;
    });
  }, [items, query, readyFilter, gradeFilter, tagFilter, gsvFilter, marginFilter]);

  const allSelected =
    visibleItems.length > 0 && visibleItems.every((item) => selected.has(item.id));

  function updateItem(id: string, patch: Partial<PrefillItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function addTagToItem(id: string, tagId: string) {
    if (!tagId) return;
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, tagIds: addUnique(item.tagIds, tagId) } : item))
    );
  }

  function removeTagFromItem(id: string, tagId: string) {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, tagIds: (item.tagIds ?? []).filter((currentId) => currentId !== tagId) } : item
      )
    );
  }

  function createTagForItem(id: string) {
    const name = cleanTagName(newTagByItem[id] ?? "");
    if (!name) {
      setMessage("请输入分类名称");
      return;
    }
    const existing = tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      addTagToItem(id, existing.id);
      setNewTagByItem((current) => ({ ...current, [id]: "" }));
      setMessage(`已使用已有分类「${existing.name}」。`);
      return;
    }
    const tag: ProductTag = {
      id: createTagId(),
      name,
      createdAt: new Date().toISOString()
    };
    setTags((current) => [...current, tag]);
    addTagToItem(id, tag.id);
    setNewTagByItem((current) => ({ ...current, [id]: "" }));
    setMessage(`已新建分类「${tag.name}」，保存后生效。`);
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

  function selectVisible() {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of visibleItems) next.add(item.id);
      return next;
    });
  }

  function selectUnfilled() {
    setSelected(new Set(visibleItems.filter((item) => !isPrefillReady(item)).map((item) => item.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function clearFilters() {
    setQuery("");
    setReadyFilter("all");
    setGradeFilter("all");
    setTagFilter("all");
    setGsvFilter("all");
    setMarginFilter("all");
  }

  function applyBatch() {
    if (selected.size === 0) {
      return;
    }
    if (batchField === "tag") {
      if (!batchValue) {
        setMessage("请选择要添加的看数分类");
        return;
      }
      setItems((current) =>
        current.map((item) =>
          selected.has(item.id) ? { ...item, tagIds: addUnique(item.tagIds, batchValue) } : item
        )
      );
      const tagName = tagsById.get(batchValue)?.name ?? "看数分类";
      setMessage(`已为选中的 ${selected.size} 个商品添加看数分类「${tagName}」，记得点「保存并重算」生效。`);
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
    try {
      const response = await fetch(`/api/cycles/${cycleId}/prefill-items`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, tags })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setMessage(payload?.error ?? "保存失败");
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | { data?: { items?: PrefillItem[]; tags?: ProductTag[] } }
        | null;
      if (payload?.data?.items) setItems(payload.data.items);
      if (payload?.data?.tags) setTags(payload.data.tags);
      const nextItems = payload?.data?.items ?? items;
      const hasReadyItems = nextItems.some(isPrefillReady);
      if (hasReadyItems) {
        const calculation = await fetch("/api/calc-runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cycleId })
        });
        if (!calculation.ok) {
          const error = (await calculation.json().catch(() => null)) as { error?: string } | null;
          setMessage(`参数已保存，但重算失败：${error?.error ?? calculation.status}`);
          return;
        }
      }
      router.refresh();
      setMessage(
        hasReadyItems
          ? "已保存并重算，经营网络与各看板会按最新参数重新聚合。"
          : "已保存；当前暂无可纳入计算的商品，未触发重算。"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网络异常，保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="table-panel">
      <div className="panel-toolbar">
        <div>
          <strong>可编辑预填写参数</strong>
          <span>
            共 {items.length} 个商品，筛选后 <b>{visibleItems.length}</b> 个，已填写 <b>{readyCount}</b> 个纳入计算。
            看数分类仅用于分组展示，未分类商品仍可参与计算。
          </span>
        </div>
        <button type="button" onClick={save} disabled={saving}>
          <Save size={17} />
          {saving ? "保存并重算中" : "保存并重算"}
        </button>
      </div>

      <div className="prefill-filter-panel" aria-label="预填写表筛选条件">
        <label>
          <span>搜索商品</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="商品ID / 商品名" />
        </label>
        <label>
          <span>填写状态</span>
          <select value={readyFilter} onChange={(event) => setReadyFilter(event.target.value as ReadyFilter)}>
            <option value="all">全部</option>
            <option value="ready">已纳入计算</option>
            <option value="pending">待填写</option>
          </select>
        </label>
        <label>
          <span>分层</span>
          <select value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value as GradeFilter)}>
            <option value="all">全部分层</option>
            <option value="unfilled">未填写</option>
            {GRADES.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>看数分类</span>
          <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
            <option value="all">全部分类</option>
            <option value="untagged">未分类</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>月GSV</span>
          <select value={gsvFilter} onChange={(event) => setGsvFilter(event.target.value as FillState)}>
            <option value="all">全部</option>
            <option value="filled">已填写</option>
            <option value="empty">未填写</option>
          </select>
        </label>
        <label>
          <span>毛利率</span>
          <select value={marginFilter} onChange={(event) => setMarginFilter(event.target.value as FillState)}>
            <option value="all">全部</option>
            <option value="filled">已填写</option>
            <option value="empty">未填写</option>
          </select>
        </label>
        <button type="button" className="ghost-button" onClick={clearFilters}>
          清空筛选
        </button>
      </div>

      <div className="prefill-batch-bar">
        <div className="prefill-batch-select">
          <span>
            已选 <b>{selected.size}</b> / 筛选后 {visibleItems.length}
          </span>
          <button type="button" className="ghost-button" onClick={selectVisible}>
            全选当前筛选
          </button>
          <button type="button" className="ghost-button" onClick={selectUnfilled}>
            选当前未填写
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
            <option value="tag">看数分类</option>
          </select>
          <span>为</span>
          {batchField === "grade" ? (
            <select
              value={batchValue}
              onChange={(event) => setBatchValue(event.target.value)}
              aria-label="批量分层值"
            >
              <option value="">未填写</option>
              {GRADES.map((grade) => (
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
          ) : batchField === "tag" ? (
            <select
              value={batchValue}
              onChange={(event) => setBatchValue(event.target.value)}
              aria-label="批量看数分类"
            >
              <option value="">选择分类</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
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
        <table className="prefill-table">
          <thead>
            <tr>
              <th className="prefill-check-col">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => (event.target.checked ? selectVisible() : clearSelection())}
                  aria-label="全选当前筛选"
                />
              </th>
              <th>商品</th>
              <th>看数分类（选填）</th>
              <th>分层</th>
              <th>月GSV机会</th>
              <th>毛利率</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-table-cell">
                  当前筛选条件下暂无商品。
                </td>
              </tr>
            ) : (
              visibleItems.map((item) => {
                const ready = isPrefillReady(item);
                const checked = selected.has(item.id);
                const itemTags = (item.tagIds ?? []).map((id) => tagsById.get(id)).filter(Boolean) as ProductTag[];
                const availableTags = tags.filter((tag) => !(item.tagIds ?? []).includes(tag.id));
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
                      <div className="prefill-tag-cell">
                        <div className="prefill-tag-list">
                          {itemTags.length === 0 ? <span className="tag-empty">未分类</span> : null}
                          {itemTags.map((tag) => (
                            <button
                              key={tag.id}
                              type="button"
                              className="tag-chip"
                              onClick={() => removeTagFromItem(item.id, tag.id)}
                              title="点击移除分类"
                            >
                              <span className="tag-chip-label">{tag.name}</span>
                              <X size={12} />
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="tag-manage-button"
                          onClick={() => setTagPanelItemId((current) => (current === item.id ? null : item.id))}
                          aria-expanded={tagPanelItemId === item.id}
                          aria-label={`${item.productName} 设置看数分类`}
                          title="设置看数分类"
                        >
                          <Tag size={13} />
                          <Plus size={11} />
                        </button>
                        {tagPanelItemId === item.id ? (
                          <div className="prefill-tag-popover">
                            <label>
                              <span>选择已有</span>
                              <select
                                value=""
                                onChange={(event) => addTagToItem(item.id, event.target.value)}
                                aria-label={`${item.productName} 添加已有分类`}
                                disabled={availableTags.length === 0}
                              >
                                <option value="">{availableTags.length === 0 ? "暂无可选" : "选择分类"}</option>
                                {availableTags.map((tag) => (
                                  <option key={tag.id} value={tag.id}>
                                    {tag.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>新建分类</span>
                              <div className="tag-create-inline">
                                <input
                                  value={newTagByItem[item.id] ?? ""}
                                  maxLength={24}
                                  placeholder="输入分类名"
                                  onChange={(event) =>
                                    setNewTagByItem((current) => ({ ...current, [item.id]: event.target.value }))
                                  }
                                  aria-label={`${item.productName} 新建分类`}
                                />
                                <button type="button" onClick={() => createTagForItem(item.id)} aria-label="新建分类">
                                  <Plus size={14} />
                                </button>
                              </div>
                            </label>
                          </div>
                        ) : null}
                      </div>
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
                        {GRADES.map((grade) => (
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
                        {ready ? "纳入计算" : "待填写"}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {message ? (
        <p className="form-message">
          {message}
          {items.some(isPrefillReady) ? (
            <Link href="/dashboards/operating-network">查看经营网络</Link>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
