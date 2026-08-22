"use client";

/* 达摩盘主图来自运行时报告数据，不能使用需要预配置远端域名的 next/image。 */
/* eslint-disable @next/next/no-img-element */

import {
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Save,
  Search,
  Share2,
  Store,
  Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  dmpReportGroupIdsByShopAndIdentity,
  dmpReportIdentity,
  dmpReportSubjectThumbnail,
  groupDmpBusinessReportsByShop,
  mergeDmpReportGroupDaily
} from "@/lib/dmp-report-library";
import type { DmpBusinessReportRecord, DmpReportShop } from "@/lib/dmp-report-types";
import { DmpReportViewer } from "@/components/tools/DmpReportViewer";
import styles from "./DmpReportWorkspace.module.css";

function createdAtLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date);
}

function isCompetitionReport(record: DmpBusinessReportRecord | null) {
  return record?.reportType === "competition" || record?.report.report_type === "competition";
}

function isMarketReport(record: DmpBusinessReportRecord | null) {
  return record?.reportType === "market" || record?.report.report_type === "market";
}

function reportTypeLabel(record: DmpBusinessReportRecord) {
  return isMarketReport(record) ? "类目大盘" : isCompetitionReport(record) ? "竞争态势" : "打爆路径";
}

function objectLabels(record: DmpBusinessReportRecord) {
  if (isMarketReport(record)) return { subject: "类目", competitor: "" };
  return isCompetitionReport(record)
    ? { subject: "本店", competitor: "竞店" }
    : { subject: "主体商品", competitor: "成功品" };
}

function marketScopeLabel(record: DmpBusinessReportRecord) {
  const scope = record.report.market_scope;
  return scope?.category_path.join(" / ") || scope?.category_name || "类目大盘";
}

function primaryReportLabel(record: DmpBusinessReportRecord) {
  return isMarketReport(record)
    ? `${marketScopeLabel(record)}（${dmpReportIdentity(record).subjectItemId}）`
    : `${objectLabels(record).subject} ${dmpReportIdentity(record).subjectItemId}`;
}

function mergedGroupDateRange(records: DmpBusinessReportRecord[]) {
  const merged = mergeDmpReportGroupDaily(records);
  const dates = new Set<string>();
  if (merged) {
    for (const table of merged.report.tables) {
      const dateIndex = table.columns.findIndex((column) => /^(?:日期|请求截止日|截止日)$/.test(String(column).trim()));
      if (dateIndex < 0) continue;
      for (const row of table.rows) {
        const date = String(row.cells[dateIndex] ?? "").trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
      }
    }
  }
  if (!dates.size) {
    for (const record of records) {
      for (const value of [record.period, record.report.period]) {
        for (const date of String(value ?? "").match(/\d{4}-\d{2}-\d{2}/g) ?? []) dates.add(date);
      }
    }
  }
  const ordered = [...dates].sort();
  if (!ordered.length) return "";
  const start = ordered[0];
  const end = ordered.at(-1) ?? start;
  return start === end ? start : `${start} — ${end}`;
}

export function DmpReportWorkspace({
  initialReports,
  initialShops,
  canCreateShop,
  initialSelectedId = "",
  focusReport = false
}: {
  initialReports: DmpBusinessReportRecord[];
  initialShops: DmpReportShop[];
  canCreateShop: boolean;
  initialSelectedId?: string;
  focusReport?: boolean;
}) {
  const requestedInitialId = initialSelectedId.trim();
  const initialId = requestedInitialId
    ? initialReports.some((record) => record.id === requestedInitialId) ? requestedInitialId : ""
    : initialReports[0]?.id ?? "";
  const [reports, setReports] = useState(initialReports);
  const [shops, setShops] = useState(initialShops);
  const [shopEditorId, setShopEditorId] = useState(initialShops[0]?.id ?? "");
  const [shopNameDraft, setShopNameDraft] = useState(initialShops[0]?.name ?? "");
  const [selectedId, setSelectedId] = useState(initialId);
  const [busy, setBusy] = useState(false);
  const [sharingId, setSharingId] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");

  const selectedRecord = useMemo(
    () => reports.find((record) => record.id === selectedId) ?? null,
    [reports, selectedId]
  );
  const visibleReports = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return reports;
    return reports.filter((record) => {
      const identity = dmpReportIdentity(record);
      return [
        reportTypeLabel(record),
        identity.subjectItemId,
        identity.competitorItemId,
        marketScopeLabel(record),
        record.shopName ?? "",
        record.period,
        createdAtLabel(record.createdAt),
        record.createdAt
      ].some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword));
    });
  }, [query, reports]);
  const visibleShopGroups = useMemo(() => groupDmpBusinessReportsByShop(visibleReports), [visibleReports]);
  const reportShopGroups = useMemo(() => groupDmpBusinessReportsByShop(reports), [reports]);
  const visibleGroupCount = visibleShopGroups.reduce((total, shopGroup) => total + shopGroup.groups.length, 0);
  const activeRecord = query.trim()
    ? visibleReports.find((record) => record.id === selectedRecord?.id) ?? visibleReports[0] ?? null
    : selectedRecord;
  const selectedViewRecord = useMemo(() => {
    const group = reportShopGroups
      .flatMap((shopGroup) => shopGroup.groups)
      .find((candidate) => candidate.records.some((record) => record.id === activeRecord?.id));
    return group ? mergeDmpReportGroupDaily(group.records, activeRecord?.id) : activeRecord;
  }, [activeRecord, reportShopGroups]);

  function selectReport(record: DmpBusinessReportRecord) {
    setSelectedId(record.id);
  }

  async function createShare(record: DmpBusinessReportRecord) {
    setSharingId(record.id);
    try {
      const response = await fetch("/api/dmp-report-shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: record.id })
      });
      const result = await response.json().catch(() => null) as { data?: { share?: { url?: string } }; error?: string } | null;
      if (!response.ok || !result?.data?.share?.url) throw new Error(result?.error ?? "分享链接生成失败");
      await copyText(result.data.share.url);
      setNotice("公开只读报告链接已复制；任何拿到链接的人均可直接打开");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "分享链接生成失败");
    } finally {
      setSharingId("");
    }
  }

  function selectShopProfile(shopId: string) {
    const shop = shops.find((candidate) => candidate.id === shopId);
    setShopEditorId(shopId);
    setShopNameDraft(shop?.name ?? "");
    setNotice("");
  }

  async function saveShopProfile() {
    const name = shopNameDraft.trim();
    if (!name) {
      setNotice("请输入店铺名称");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(shopEditorId ? `/api/shops/${encodeURIComponent(shopEditorId)}` : "/api/shops", {
        method: shopEditorId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const result = await response.json().catch(() => null) as { data?: { shop?: DmpReportShop }; error?: string } | null;
      const shop = result?.data?.shop;
      if (!response.ok || !shop) throw new Error(result?.error ?? "店铺资料保存失败");
      setShops((current) => current.some((candidate) => candidate.id === shop.id)
        ? current.map((candidate) => candidate.id === shop.id ? shop : candidate)
        : [...current, shop]);
      setReports((current) => current.map((record) => record.shopId === shop.id
        ? { ...record, shopName: shop.name }
        : record));
      setShopEditorId(shop.id);
      setShopNameDraft(shop.name);
      setNotice(shopEditorId ? `店铺署名已更新为「${shop.name}」` : `已新增店铺「${shop.name}」`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "店铺资料保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function assignGroupToShop(reportIds: string[], shopId: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/dmp-reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportIds, shopId })
      });
      const result = await response.json().catch(() => null) as {
        data?: { assignment?: { reportIds: string[]; shop: DmpReportShop | null } };
        error?: string;
      } | null;
      const assignment = result?.data?.assignment;
      if (!response.ok || !assignment) throw new Error(result?.error ?? "报告归属保存失败");
      const assignedIds = new Set(assignment.reportIds);
      setReports((current) => current.map((record) => assignedIds.has(record.id)
        ? {
            ...record,
            shopId: assignment.shop?.id ?? "",
            shopName: assignment.shop?.name ?? ""
          }
        : record));
      setNotice(assignment.shop ? `报告组已归入「${assignment.shop.name}」` : "报告组已移至未归类");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "报告归属保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function refreshReports() {
    setBusy(true);
    try {
      const [reportResponse, shopResponse] = await Promise.all([
        fetch("/api/dmp-reports", { cache: "no-store" }),
        fetch("/api/shops", { cache: "no-store" })
      ]);
      const result = await reportResponse.json().catch(() => null) as { data?: { reports?: DmpBusinessReportRecord[] }; error?: string } | null;
      const shopResult = await shopResponse.json().catch(() => null) as { data?: { shops?: DmpReportShop[] }; error?: string } | null;
      if (!reportResponse.ok) throw new Error(result?.error ?? "刷新失败");
      if (!shopResponse.ok) throw new Error(shopResult?.error ?? "店铺资料刷新失败");
      const nextReports = result?.data?.reports ?? [];
      const nextShops = shopResult?.data?.shops ?? [];
      const nextEditor = nextShops.find((shop) => shop.id === shopEditorId) ?? nextShops[0];
      setReports(nextReports);
      setShops(nextShops);
      setShopEditorId(nextEditor?.id ?? "");
      setShopNameDraft(nextEditor?.name ?? "");
      setSelectedId((current) => nextReports.some((record) => record.id === current) ? current : nextReports[0]?.id ?? "");
      setNotice(nextReports.length ? `已同步 ${nextReports.length} 份历史报告` : "暂时没有历史报告");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "刷新失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport(record: DmpBusinessReportRecord) {
    const labels = objectLabels(record);
    const identity = dmpReportIdentity(record);
    if (!window.confirm(`确认删除${labels.subject} ${identity.subjectItemId} 的这份报告？`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/dmp-reports?id=${encodeURIComponent(record.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "删除失败");
      const nextReports = reports.filter((candidate) => candidate.id !== record.id);
      setReports(nextReports);
      setSelectedId((current) => current === record.id || !nextReports.some((candidate) => candidate.id === current)
        ? nextReports[0]?.id ?? ""
        : current);
      setNotice("报告已删除");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`dmp-workspace ${styles.workspace}`}>
      {focusReport ? (
        <div className={styles.focusToolbar}>
          <div className={styles.focusIdentity}>
            <span>当前报告</span>
            <strong>{selectedRecord ? primaryReportLabel(selectedRecord) : "暂无报告"}</strong>
          </div>
          <div className={styles.toolbar}>
            <button type="button" onClick={() => void refreshReports()} disabled={busy}>
              <RefreshCw className={busy ? "spin" : ""} size={15} /> 刷新
            </button>
            <a href="/tools/dmp-report">浏览全部报告</a>
            {selectedRecord ? (
              <button className={styles.primaryAction} type="button" onClick={() => void createShare(selectedRecord)} disabled={Boolean(sharingId) || busy}>
                <Share2 size={15} /> {sharingId === selectedRecord.id ? "生成中…" : "复制分享链接"}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <section className={styles.library}>
          <header className={styles.libraryHeader}>
            <div className={styles.headerCopy}>
              <div className={styles.headingRow}>
                <h2>历史报告</h2>
                <span className={styles.count}>{query ? `${visibleReports.length} / ${reports.length} 份` : `${reports.length} 份`} · {visibleGroupCount} 组</span>
              </div>
              {notice ? <p aria-live="polite">{notice}</p> : null}
            </div>
            <div className={styles.toolbar}>
              <label className={styles.searchField}>
                <Search size={14} aria-hidden="true" />
                <span className={styles.srOnly}>搜索历史报告</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索商品/类目 ID、名称、日期或类型"
                />
              </label>
              <button type="button" onClick={() => void refreshReports()} disabled={busy}>
                <RefreshCw className={busy ? "spin" : ""} size={15} /> 刷新
              </button>
              {activeRecord ? (
                <button className={styles.primaryAction} type="button" onClick={() => void createShare(activeRecord)} disabled={Boolean(sharingId) || busy}>
                  <Share2 size={15} /> {sharingId === activeRecord.id ? "生成中…" : "分享当前报告"}
                </button>
              ) : null}
            </div>
          </header>
          <section className={styles.shopManager} aria-label="店铺档案">
            <div>
              <Store size={17} aria-hidden="true" />
              <strong>店铺档案</strong>
            </div>
            <label>
              <span className={styles.srOnly}>选择要维护的店铺</span>
              <select value={shopEditorId} onChange={(event) => selectShopProfile(event.target.value)} disabled={busy}>
                {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
                <option value="" disabled={!canCreateShop}>新建店铺档案</option>
              </select>
            </label>
            <label>
              <span className={styles.srOnly}>店铺名称</span>
              <input
                value={shopNameDraft}
                maxLength={40}
                onChange={(event) => setShopNameDraft(event.target.value)}
                placeholder="填写店铺名称"
                disabled={busy}
              />
            </label>
            <button type="button" onClick={() => void saveShopProfile()} disabled={busy || (!shopEditorId && !canCreateShop)}>
              <Save size={14} /> {shopEditorId ? "保存名称" : "创建店铺"}
            </button>
            {shopEditorId && canCreateShop ? (
              <button className={styles.secondaryAction} type="button" onClick={() => selectShopProfile("")} disabled={busy}>
                <Plus size={14} /> 新增
              </button>
            ) : null}
          </section>
          {visibleReports.length ? (
            <div className={styles.reportGroups}>
              {visibleShopGroups.map((shopGroup) => (
                <section className={styles.shopSection} key={shopGroup.key}>
                  <header className={styles.shopSectionHeader}>
                    <div><Store size={16} aria-hidden="true" /><strong>{shopGroup.shopName}</strong></div>
                    <span>{shopGroup.reportCount} 份 · {shopGroup.groups.length} 组</span>
                  </header>
                  <div className={styles.shopSectionGroups}>
                    {shopGroup.groups.map((group) => {
                      const groupFallback = group.subjectThumbnail.title.slice(0, 1) || "品";
                      const mergedDateRange = mergedGroupDateRange(group.records);
                      const completeReportIds = dmpReportGroupIdsByShopAndIdentity(
                        reportShopGroups,
                        shopGroup.key,
                        group.key
                      );
                      return (
                        <section className={styles.reportGroup} key={group.key}>
                          <header className={styles.groupHeader}>
                            <div>
                              <span className={`${styles.reportThumbnail} ${styles.groupThumbnail}`}>
                                <span aria-hidden="true">{groupFallback}</span>
                                {group.subjectThumbnail.url ? <img src={group.subjectThumbnail.url} alt={`${group.subjectThumbnail.title}主图`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
                              </span>
                              <span className={styles.typeBadge}>{group.reportType === "market" ? "类目大盘" : group.reportType === "competition" ? "竞争态势" : "打爆路径"}</span>
                              {group.reportType === "market" ? (
                                <>
                                  <strong>{group.marketScope?.category_path.join(" / ") || group.marketScope?.category_name || "类目大盘"}</strong>
                                  <small>类目 ID {group.subjectItemId}</small>
                                </>
                              ) : (
                                <>
                                  <strong>{group.reportType === "competition" ? "本店" : "主体商品"} {group.subjectItemId}</strong>
                                  <small>{group.reportType === "competition" ? "竞店" : "成功品"} {group.competitorItemId || "—"}</small>
                                </>
                              )}
                            </div>
                            {mergedDateRange ? <time className={styles.groupCoverage}>{mergedDateRange}</time> : null}
                            <label className={styles.groupAssignment}>
                              <span>归属</span>
                              <select
                                value={shopGroup.shopId}
                                onChange={(event) => {
                                  if (!completeReportIds.length) {
                                    setNotice("报告组加载不完整，请刷新后重试");
                                    return;
                                  }
                                  void assignGroupToShop(completeReportIds, event.target.value);
                                }}
                                disabled={busy || !completeReportIds.length}
                                aria-label={`设置${group.reportType === "market" ? "类目" : "主体"} ${group.subjectItemId} 报告组的店铺归属`}
                              >
                                <option value="">未归类</option>
                                {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
                              </select>
                            </label>
                            <span>{group.records.length} 份</span>
                          </header>
                          <div className={styles.reportGrid}>
                            {group.records.map((record) => {
                              const thumbnail = dmpReportSubjectThumbnail(record);
                              const fallback = (thumbnail.title || objectLabels(record).subject).slice(0, 1) || "品";
                              return (
                                <article className={`${styles.reportCard}${activeRecord?.id === record.id ? ` ${styles.active}` : ""}`} key={record.id}>
                                  <button className={styles.reportMain} type="button" onClick={() => selectReport(record)} aria-pressed={activeRecord?.id === record.id} disabled={busy}>
                                    <span className={styles.reportThumbnail}>
                                      <span aria-hidden="true">{fallback}</span>
                                      {thumbnail.url ? <img src={thumbnail.url} alt={`${thumbnail.title}主图`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
                                    </span>
                                    <span className={styles.cardCopy}>
                                      <span className={styles.cardMeta}>
                                        <time>{createdAtLabel(record.createdAt)}</time>
                                      </span>
                                      <strong>{thumbnail.title || primaryReportLabel(record)}</strong>
                                      <small>{isMarketReport(record) ? "类目 ID" : objectLabels(record).subject} {dmpReportIdentity(record).subjectItemId}</small>
                                      <span className={styles.period}>{record.period}</span>
                                    </span>
                                  </button>
                                  <div className={styles.cardActions}>
                                    <button type="button" onClick={() => void createShare(record)} disabled={Boolean(sharingId) || busy} title="复制分享链接">
                                      <Share2 size={15} /> <span>{sharingId === record.id ? "生成中" : "分享"}</span>
                                    </button>
                                    <button className={styles.dangerAction} type="button" onClick={() => void deleteReport(record)} disabled={busy} aria-label="删除报告" title="删除报告"><Trash2 size={15} /></button>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : reports.length ? (
            <div className={styles.noMatches}>
              <Search size={24} />
              <strong>没有匹配的报告</strong>
              <button type="button" onClick={() => setQuery("")}>清除搜索</button>
            </div>
          ) : (
            <div className={styles.emptyState}>
              <FileSpreadsheet size={36} />
              <strong>还没有历史报告</strong>
              <span>达摩盘一体化插件完成任一模式取数后，报告会自动保存到当前账号。</span>
            </div>
          )}
        </section>
      )}

      {selectedViewRecord ? <DmpReportViewer key={selectedViewRecord.id} record={selectedViewRecord} variant="preview" /> : null}
    </section>
  );
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}
