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
import { useEffect, useMemo, useRef, useState } from "react";
import { dmpReportIdentity } from "@/lib/dmp-report-library";
import type {
  DmpBusinessReportRecord,
  DmpBusinessReportSummary,
  DmpMarketScope,
  DmpReportKind,
  DmpReportShop
} from "@/lib/dmp-report-types";
import { DmpReportViewer } from "@/components/tools/DmpReportViewer";
import { dmpMarketCategoryLabel } from "@/components/tools/DmpMarketReportViewModel";
import styles from "./DmpReportWorkspace.module.css";

const REPORT_PAGE_SIZE = 24;

export interface DmpReportSummaryPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}

interface DmpSummaryGroup {
  key: string;
  reportType: DmpReportKind;
  subjectItemId: string;
  competitorItemId: string;
  subjectThumbnail: DmpBusinessReportSummary["subjectThumbnail"];
  marketScope?: DmpMarketScope;
  records: DmpBusinessReportSummary[];
}

interface DmpSummaryShopGroup {
  key: string;
  shopId: string;
  shopName: string;
  reportCount: number;
  groups: DmpSummaryGroup[];
}

type DmpReportListResponse = {
  data?: {
    reports?: DmpBusinessReportSummary[];
    pagination?: Partial<DmpReportSummaryPagination>;
  };
  error?: string;
};

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

function reportTypeLabel(record: Pick<DmpBusinessReportSummary, "reportType">) {
  return record.reportType === "market" ? "类目大盘" : record.reportType === "competition" ? "竞争态势" : "打爆路径";
}

function objectLabels(record: Pick<DmpBusinessReportSummary, "reportType">) {
  if (record.reportType === "market") return { subject: "类目", competitor: "" };
  return record.reportType === "competition"
    ? { subject: "本店", competitor: "竞店" }
    : { subject: "主体商品", competitor: "成功品" };
}

function marketScopeLabel(record: Pick<DmpBusinessReportSummary, "marketScope" | "subjectItemId">) {
  return dmpMarketCategoryLabel(record.marketScope, record.subjectItemId);
}

function primarySummaryLabel(record: DmpBusinessReportSummary) {
  return record.reportType === "market"
    ? marketScopeLabel(record)
    : `${objectLabels(record).subject} ${record.subjectItemId}`;
}

function primaryDetailLabel(record: DmpBusinessReportRecord) {
  const identity = dmpReportIdentity(record);
  return identity.reportType === "market"
    ? dmpMarketCategoryLabel(identity.marketScope, identity.subjectItemId)
    : `${identity.reportType === "competition" ? "本店" : "主体商品"} ${identity.subjectItemId}`;
}

function mergedGroupDateRange(records: DmpBusinessReportSummary[]) {
  const dates = new Set<string>();
  for (const record of records) {
    for (const value of [record.coverageStart, record.coverageEnd, record.period]) {
      for (const date of String(value ?? "").match(/\d{4}-\d{2}-\d{2}/g) ?? []) dates.add(date);
    }
  }
  const ordered = [...dates].sort();
  if (!ordered.length) return "";
  const start = ordered[0];
  const end = ordered.at(-1) ?? start;
  return start === end ? start : `${start} — ${end}`;
}

function summaryGroupKey(record: DmpBusinessReportSummary) {
  return record.reportType === "market"
    ? [record.reportType, record.marketScope?.category_path.join("/"), record.subjectItemId].join(":")
    : [record.reportType, record.subjectItemId, record.competitorItemId].join(":");
}

function groupDmpBusinessReportSummariesByShop(reports: DmpBusinessReportSummary[]): DmpSummaryShopGroup[] {
  const partitions = new Map<string, { shopId: string; shopName: string; records: DmpBusinessReportSummary[] }>();
  const ordered = [...reports].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const record of ordered) {
    const shopId = record.shopId.trim();
    const key = `shop:${shopId}`;
    const current = partitions.get(key);
    if (current) {
      current.records.push(record);
      if (!current.shopName && record.shopName.trim()) current.shopName = record.shopName.trim();
    } else {
      partitions.set(key, { shopId, shopName: record.shopName.trim(), records: [record] });
    }
  }

  return [...partitions].map(([key, partition]) => {
    const grouped = new Map<string, DmpSummaryGroup>();
    for (const record of partition.records) {
      const groupKey = summaryGroupKey(record);
      const current = grouped.get(groupKey);
      if (current) {
        current.records.push(record);
        if (!current.subjectThumbnail.url && record.subjectThumbnail.url) current.subjectThumbnail = record.subjectThumbnail;
      } else {
        grouped.set(groupKey, {
          key: groupKey,
          reportType: record.reportType,
          subjectItemId: record.subjectItemId,
          competitorItemId: record.competitorItemId,
          subjectThumbnail: record.subjectThumbnail,
          ...(record.marketScope ? { marketScope: record.marketScope } : {}),
          records: [record]
        });
      }
    }
    return {
      key,
      shopId: partition.shopId,
      shopName: partition.shopName || "未命名店铺",
      reportCount: partition.records.length,
      groups: [...grouped.values()]
    };
  });
}

function normalizedPagination(
  value: Partial<DmpReportSummaryPagination> | undefined,
  fallback: DmpReportSummaryPagination
): DmpReportSummaryPagination {
  return {
    page: Number.isFinite(value?.page) ? Math.max(1, Number(value?.page)) : fallback.page,
    pageSize: Number.isFinite(value?.pageSize) ? Math.max(1, Number(value?.pageSize)) : fallback.pageSize,
    total: Number.isFinite(value?.total) ? Math.max(0, Number(value?.total)) : fallback.total,
    totalPages: Number.isFinite(value?.totalPages) ? Math.max(0, Number(value?.totalPages)) : fallback.totalPages,
    hasNext: typeof value?.hasNext === "boolean" ? value.hasNext : fallback.hasNext
  };
}

export function DmpReportWorkspace({
  initialReports,
  initialPagination,
  initialShops,
  activeShopId,
  canCreateShop,
  initialSelectedReport = null,
  focusReport = false,
  initialNotice = ""
}: {
  initialReports: DmpBusinessReportSummary[];
  initialPagination: DmpReportSummaryPagination;
  initialShops: DmpReportShop[];
  activeShopId: string;
  canCreateShop: boolean;
  initialSelectedReport?: DmpBusinessReportRecord | null;
  focusReport?: boolean;
  initialNotice?: string;
}) {
  const activeShop = initialShops.find((shop) => shop.id === activeShopId) ?? null;
  const [reports, setReports] = useState(initialReports);
  const [pagination, setPagination] = useState(initialPagination);
  const [shops, setShops] = useState(initialShops);
  const [shopEditorId, setShopEditorId] = useState(activeShop?.id ?? "");
  const [shopNameDraft, setShopNameDraft] = useState(activeShop?.name ?? "");
  const [selectedId, setSelectedId] = useState(initialSelectedReport?.id ?? "");
  const [selectedRecord, setSelectedRecord] = useState<DmpBusinessReportRecord | null>(initialSelectedReport);
  const [loadingReportId, setLoadingReportId] = useState("");
  const [busy, setBusy] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [sharingId, setSharingId] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState(initialNotice);
  const detailRequestSequence = useRef(0);
  const detailAbortController = useRef<AbortController | null>(null);
  const detailCache = useRef(new Map<string, DmpBusinessReportRecord>(
    initialSelectedReport ? [[initialSelectedReport.id, initialSelectedReport]] : []
  ));

  useEffect(() => () => detailAbortController.current?.abort(), []);

  const visibleReports = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return reports;
    return reports.filter((record) => [
      reportTypeLabel(record),
      record.title,
      record.subjectItemId,
      record.competitorItemId,
      marketScopeLabel(record),
      record.shopName,
      record.period,
      createdAtLabel(record.createdAt),
      record.createdAt
    ].some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword)));
  }, [query, reports]);
  const visibleShopGroups = useMemo(() => groupDmpBusinessReportSummariesByShop(visibleReports), [visibleReports]);
  const visibleGroupCount = visibleShopGroups.reduce((total, shopGroup) => total + shopGroup.groups.length, 0);
  const activeSummary = reports.find((record) => record.id === selectedId) ?? null;

  async function selectReport(record: DmpBusinessReportSummary) {
    const requestSequence = detailRequestSequence.current + 1;
    detailRequestSequence.current = requestSequence;
    detailAbortController.current?.abort();
    setSelectedId(record.id);
    const cached = detailCache.current.get(record.id);
    if (cached) {
      setSelectedRecord(cached);
      setLoadingReportId("");
      setNotice("");
      return;
    }
    if (!activeShopId) {
      setSelectedRecord(null);
      setNotice("请先选择当前店铺后再预览报告");
      return;
    }

    const controller = new AbortController();
    detailAbortController.current = controller;
    setSelectedRecord(null);
    setLoadingReportId(record.id);
    setNotice("正在加载报告正文…");
    try {
      const response = await fetch(`/api/dmp-reports?id=${encodeURIComponent(record.id)}`, {
        cache: "no-store",
        headers: { "x-sanjie-shop": activeShopId },
        signal: controller.signal
      });
      const result = await response.json().catch(() => null) as {
        data?: { report?: DmpBusinessReportRecord };
        error?: string;
      } | null;
      if (!response.ok || !result?.data?.report) throw new Error(result?.error ?? "报告正文加载失败");
      if (requestSequence !== detailRequestSequence.current || controller.signal.aborted) return;
      if (result.data.report.id !== record.id || result.data.report.shopId !== activeShopId) {
        throw new Error("报告不属于当前店铺，已停止加载");
      }
      detailCache.current.set(record.id, result.data.report);
      setSelectedRecord(result.data.report);
      setNotice("");
    } catch (error) {
      if (controller.signal.aborted || requestSequence !== detailRequestSequence.current) return;
      setSelectedRecord(null);
      setNotice(error instanceof Error ? error.message : "报告正文加载失败");
    } finally {
      if (requestSequence === detailRequestSequence.current) setLoadingReportId("");
    }
  }

  async function createShare(record: Pick<DmpBusinessReportRecord, "id">) {
    if (!activeShopId) {
      setNotice("请先选择当前店铺后再生成分享链接");
      return;
    }
    setSharingId(record.id);
    try {
      const response = await fetch("/api/dmp-report-shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sanjie-shop": activeShopId },
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
    if (!activeShopId) {
      setNotice("当前店铺未明确，不能保存店铺资料");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(shopEditorId ? `/api/shops/${encodeURIComponent(shopEditorId)}` : "/api/shops", {
        method: shopEditorId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "x-sanjie-shop": activeShopId },
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

  async function assignGroupToShop(group: DmpSummaryGroup, targetShopId: string) {
    if (!activeShopId) {
      setNotice("当前店铺未明确，不能修改报告归属");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/dmp-reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-sanjie-shop": activeShopId },
        body: JSON.stringify({
          sourceShopId: activeShopId,
          targetShopId,
          reportType: group.reportType,
          subjectItemId: group.subjectItemId,
          competitorItemId: group.competitorItemId
        })
      });
      const result = await response.json().catch(() => null) as {
        data?: { assignment?: { reportIds: string[]; count?: number; shop: DmpReportShop | null } };
        error?: string;
      } | null;
      const assignment = result?.data?.assignment;
      if (!response.ok || !assignment) throw new Error(result?.error ?? "报告归属保存失败");
      const assignedIds = new Set(assignment.reportIds);
      if (targetShopId === activeShopId) {
        setReports((current) => current.map((record) => assignedIds.has(record.id)
          ? { ...record, shopName: assignment.shop?.name ?? record.shopName }
          : record));
      } else {
        setReports((current) => current.filter((record) => summaryGroupKey(record) !== group.key));
        setPagination((current) => {
          const movedCount = Number.isFinite(assignment.count)
            ? Math.max(assignedIds.size, Number(assignment.count))
            : assignedIds.size;
          const total = Math.max(0, current.total - movedCount);
          const totalPages = Math.ceil(total / current.pageSize);
          return { ...current, total, totalPages, hasNext: current.page < totalPages };
        });
        if (activeSummary && summaryGroupKey(activeSummary) === group.key) clearSelectedReport();
      }
      setNotice(assignment.shop ? `报告组已归入「${assignment.shop.name}」` : "报告组已移至未归类");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "报告归属保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function refreshReports() {
    if (!activeShopId) {
      setNotice("请先选择当前店铺后再刷新");
      return;
    }
    setBusy(true);
    try {
      const headers = { "x-sanjie-shop": activeShopId };
      const [reportResponse, shopResponse] = await Promise.all([
        fetch(`/api/dmp-reports?page=1&pageSize=${REPORT_PAGE_SIZE}`, { cache: "no-store", headers }),
        fetch("/api/shops", { cache: "no-store", headers })
      ]);
      const result = await reportResponse.json().catch(() => null) as DmpReportListResponse | null;
      const shopResult = await shopResponse.json().catch(() => null) as { data?: { shops?: DmpReportShop[] }; error?: string } | null;
      if (!reportResponse.ok) throw new Error(result?.error ?? "刷新失败");
      if (!shopResponse.ok) throw new Error(shopResult?.error ?? "店铺资料刷新失败");
      const nextReports = result?.data?.reports ?? [];
      const nextShops = shopResult?.data?.shops ?? [];
      const nextEditor = nextShops.find((shop) => shop.id === shopEditorId)
        ?? nextShops.find((shop) => shop.id === activeShopId)
        ?? null;
      setReports(nextReports);
      setPagination(normalizedPagination(result?.data?.pagination, {
        page: 1,
        pageSize: REPORT_PAGE_SIZE,
        total: nextReports.length,
        totalPages: nextReports.length ? 1 : 0,
        hasNext: false
      }));
      setShops(nextShops);
      setShopEditorId(nextEditor?.id ?? "");
      setShopNameDraft(nextEditor?.name ?? "");
      const total = result?.data?.pagination?.total ?? nextReports.length;
      setNotice(total ? `已同步 ${total} 份历史报告摘要` : "暂时没有历史报告");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "刷新失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreReports() {
    if (!activeShopId || listBusy || !pagination.hasNext) return;
    setListBusy(true);
    try {
      const page = pagination.page + 1;
      const response = await fetch(`/api/dmp-reports?page=${page}&pageSize=${pagination.pageSize}`, {
        cache: "no-store",
        headers: { "x-sanjie-shop": activeShopId }
      });
      const result = await response.json().catch(() => null) as DmpReportListResponse | null;
      if (!response.ok) throw new Error(result?.error ?? "加载更多失败");
      const nextReports = result?.data?.reports ?? [];
      setReports((current) => {
        const known = new Set(current.map((record) => record.id));
        return [...current, ...nextReports.filter((record) => !known.has(record.id))];
      });
      setPagination(normalizedPagination(result?.data?.pagination, { ...pagination, page }));
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "加载更多失败，请稍后重试");
    } finally {
      setListBusy(false);
    }
  }

  async function deleteReport(record: DmpBusinessReportSummary) {
    const subject = record.reportType === "market"
      ? marketScopeLabel(record)
      : `${objectLabels(record).subject} ${record.subjectItemId}`;
    if (!window.confirm(`确认删除${subject}的这份报告？`)) return;
    if (!activeShopId) {
      setNotice("当前店铺未明确，不能删除报告");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/dmp-reports?id=${encodeURIComponent(record.id)}`, {
        method: "DELETE",
        headers: { "x-sanjie-shop": activeShopId }
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "删除失败");
      setReports((current) => current.filter((candidate) => candidate.id !== record.id));
      setPagination((current) => {
        const total = Math.max(0, current.total - 1);
        const totalPages = Math.ceil(total / current.pageSize);
        return { ...current, total, totalPages, hasNext: current.page < totalPages };
      });
      detailCache.current.delete(record.id);
      if (selectedId === record.id) clearSelectedReport();
      setNotice("报告已删除");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function clearSelectedReport() {
    detailRequestSequence.current += 1;
    detailAbortController.current?.abort();
    detailAbortController.current = null;
    setSelectedId("");
    setSelectedRecord(null);
    setLoadingReportId("");
  }

  const countLabel = query.trim()
    ? `${visibleReports.length} / 已加载 ${reports.length} / 共 ${pagination.total} 份`
    : `已加载 ${reports.length} / 共 ${pagination.total} 份`;

  return (
    <section className={`dmp-workspace ${styles.workspace}`}>
      {focusReport ? (
        <div className={styles.focusToolbar}>
          <div className={styles.focusIdentity}>
            <span>当前报告</span>
            <strong>{selectedRecord ? primaryDetailLabel(selectedRecord) : "暂无报告"}</strong>
            {notice ? <p className={styles.loadingNotice} aria-live="polite">{notice}</p> : null}
          </div>
          <div className={styles.toolbar}>
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
                <span className={styles.count}>{countLabel} · {visibleGroupCount} 组</span>
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
                  placeholder="搜索商品、类目名称、日期或类型"
                />
              </label>
              <button type="button" onClick={() => void refreshReports()} disabled={busy || listBusy}>
                <RefreshCw className={busy ? "spin" : ""} size={15} /> 刷新
              </button>
              {activeSummary ? (
                <button className={styles.primaryAction} type="button" onClick={() => void createShare(activeSummary)} disabled={Boolean(sharingId) || busy}>
                  <Share2 size={15} /> {sharingId === activeSummary.id ? "生成中…" : "分享当前报告"}
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
                                  <strong>{dmpMarketCategoryLabel(group.marketScope, group.subjectItemId)}</strong>
                                  <small>类目大盘</small>
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
                                onChange={(event) => void assignGroupToShop(group, event.target.value)}
                                disabled={busy}
                                aria-label={group.reportType === "market"
                                  ? `设置${dmpMarketCategoryLabel(group.marketScope, group.subjectItemId)}报告组的店铺归属`
                                  : `设置主体 ${group.subjectItemId} 报告组的店铺归属`}
                              >
                                <option value="">未归类</option>
                                {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
                              </select>
                            </label>
                            <span>{group.records.length} 份</span>
                          </header>
                          <div className={styles.reportGrid}>
                            {group.records.map((record) => {
                              const thumbnail = record.subjectThumbnail;
                              const cardTitle = record.title || primarySummaryLabel(record);
                              const fallback = (cardTitle || objectLabels(record).subject).slice(0, 1) || "品";
                              return (
                                <article className={`${styles.reportCard}${selectedId === record.id ? ` ${styles.active}` : ""}`} key={record.id}>
                                  <button className={styles.reportMain} type="button" onClick={() => void selectReport(record)} aria-pressed={selectedId === record.id} disabled={busy}>
                                    <span className={styles.reportThumbnail}>
                                      <span aria-hidden="true">{fallback}</span>
                                      {thumbnail.url ? <img src={thumbnail.url} alt={`${thumbnail.title}主图`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
                                    </span>
                                    <span className={styles.cardCopy}>
                                      <span className={styles.cardMeta}>
                                        <time>{createdAtLabel(record.createdAt)}</time>
                                      </span>
                                      <strong>{cardTitle}</strong>
                                      <small>{record.reportType === "market"
                                        ? marketScopeLabel(record)
                                        : `${objectLabels(record).subject} ${record.subjectItemId}`}</small>
                                      <span className={styles.period}>{loadingReportId === record.id ? "正在加载报告…" : record.period}</span>
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
          {pagination.hasNext ? (
            <div className={styles.loadMoreRow}>
              <button type="button" onClick={() => void loadMoreReports()} disabled={listBusy || busy}>
                {listBusy ? "加载中…" : "加载更多"}
              </button>
            </div>
          ) : null}
        </section>
      )}

      {selectedRecord ? <DmpReportViewer key={selectedRecord.id} record={selectedRecord} variant="preview" /> : null}
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
