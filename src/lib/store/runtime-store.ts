import "server-only";
import {
  gradeRows,
  lifecycleColumns,
  marginMatrix,
  runThreeStageCalculation
} from "@/lib/algorithm/three-stage";
import { prisma } from "@/lib/db";
import { requireTenantId } from "@/lib/session-server";
import { mapImportedRows, type MappedSourceRows } from "@/lib/imports/map-rows";
import {
  pruneAdminVersionSnapshots,
  pruneHistoryRecordsByMonths,
  retentionPolicy,
  validateTenantDatasetSize
} from "@/lib/retention-policy";
import type {
  AnalysisCycle,
  CalcRun,
  DamoProductRow,
  GrowthProfitConfigRow,
  InviteCode,
  ImportBatch,
  ImportValidationResult,
  Lifecycle,
  ManagementHistoryRecord,
  ManagementHistoryReport,
  ManagementHistoryRetention,
  ManagementHistoryState,
  ManagedUser,
  PrefillItem,
  ProductGrade,
  ProductSourceRow,
  ProfitMarginMatrix,
  ReportType,
  Shop,
  Tenant,
  User,
  VersionSnapshot
} from "@/lib/types/domain";

// ——————————————————————————————————————————————————————————————
// 工作区（每租户一份）数据形状：业务状态以 JSON blob 持久化于 Workspace.data。
// 邀请码 / 管理用户已落入关系表（跨租户索引），不在 blob 内。
// ——————————————————————————————————————————————————————————————

export interface WorkspaceContext {
  tenant: Tenant;
  user: User;
  shop: Shop;
  cycle: AnalysisCycle;
}

interface WorkspaceData {
  context: WorkspaceContext;
  imports: ImportBatch[];
  uploadedSources: MappedSourceRows;
  currentTenantDatasetId: string | null;
  currentTenantDatasetBytes: number;
  prefillItems: PrefillItem[];
  growthProfitConfig: GrowthProfitConfigRow[];
  calcRun: CalcRun;
  versions: VersionSnapshot[];
  historyRecords: ManagementHistoryRecord[];
  historyReports: ManagementHistoryReport[];
  historyRetention: ManagementHistoryRetention;
}

const initialGrowthProfitConfig = matrixToGrowthProfitConfig(marginMatrix);

/** 为某租户构造初始（空白业务数据）工作区。 */
export function buildInitialWorkspaceData(context: WorkspaceContext): WorkspaceData {
  return {
    context,
    imports: [],
    uploadedSources: {},
    currentTenantDatasetId: null,
    currentTenantDatasetBytes: 0,
    prefillItems: [],
    growthProfitConfig: initialGrowthProfitConfig,
    calcRun: runThreeStageCalculation({
      cycleId: context.cycle.id,
      productSourceRows: [],
      damoProductRows: [],
      promotionProductRows: [],
      audienceSourceRows: [],
      prefillItems: [],
      marginMatrix
    }),
    versions: [],
    historyRecords: [],
    historyReports: [],
    historyRetention: {
      tenantId: context.tenant.id,
      months: 12,
      updatedAt: new Date().toISOString(),
      updatedBy: context.user.name
    }
  };
}

/** 由租户行派生默认上下文（shop/cycle 以 tenantId 派生，保证隔离）。 */
function defaultContextFor(tenant: Tenant, user: User): WorkspaceContext {
  const shop: Shop = {
    id: `shop-${tenant.id}`,
    tenantId: tenant.id,
    name: tenant.name,
    platform: "淘宝"
  };
  const cycle: AnalysisCycle = {
    id: `cycle-${tenant.id}`,
    tenantId: tenant.id,
    shopId: shop.id,
    name: "当前分析周期",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    status: "draft"
  };
  return { tenant, user, shop, cycle };
}

// ——————————————————————————————————————————————————————————————
// 工作区读写：每次请求从 DB 读取 → 内存内复用既有领域逻辑 → 写回 DB。
// ——————————————————————————————————————————————————————————————

async function loadWorkspace(tenantId: string): Promise<WorkspaceData> {
  const row = await prisma.workspace.findUnique({ where: { tenantId } });
  if (row) {
    return row.data as unknown as WorkspaceData;
  }
  // 工作区不存在（理论上租户创建时已建）：按租户行兜底初始化。
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const userRow = await prisma.user.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "asc" }
  });
  const tenantDomain: Tenant = {
    id: tenantId,
    name: tenant?.name ?? "租户",
    slug: tenant?.slug ?? tenantId
  };
  const userDomain: User = {
    id: userRow?.id ?? `user-${tenantId}`,
    tenantId,
    name: userRow?.name ?? "运营负责人",
    email: userRow?.email ?? "",
    role: (userRow?.role as User["role"]) ?? "owner"
  };
  const data = buildInitialWorkspaceData(defaultContextFor(tenantDomain, userDomain));
  await saveWorkspace(tenantId, data);
  return data;
}

async function saveWorkspace(tenantId: string, data: WorkspaceData): Promise<void> {
  const json = data as unknown as object;
  await prisma.workspace.upsert({
    where: { tenantId },
    update: { data: json },
    create: { tenantId, data: json }
  });
}

/** 取当前请求租户的工作区（读 cookie → 加载 blob）。 */
async function ctx(): Promise<{ tenantId: string; state: WorkspaceData }> {
  const tenantId = await requireTenantId();
  const state = await loadWorkspace(tenantId);
  return { tenantId, state };
}

// ——————————————————————————————————————————————————————————————
// 公开 API（保持原语义，全部改为 async；tenant 由会话内部解析）
// ——————————————————————————————————————————————————————————————

export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const { state } = await ctx();
  return state.context;
}

export async function getImportBatches(): Promise<ImportBatch[]> {
  const { state } = await ctx();
  return state.imports;
}

export async function getRetentionStatus() {
  const { state } = await ctx();
  const versionsByShop = new Map<string, number>();
  for (const version of state.versions) {
    versionsByShop.set(version.shopId, (versionsByShop.get(version.shopId) ?? 0) + 1);
  }
  return {
    policy: retentionPolicy,
    tenantDataset: {
      datasetId: state.currentTenantDatasetId,
      savedBytes: state.currentTenantDatasetBytes,
      savedBatchCount: state.imports.length,
      mustClearBeforeNewUpload: state.imports.length > 0
    },
    adminRollback: {
      shopCount: versionsByShop.size,
      versionsByShop: [...versionsByShop.entries()].map(([shopId, versionCount]) => ({
        shopId,
        versionCount
      }))
    }
  };
}

export async function clearImportBatches(): Promise<void> {
  const { tenantId, state } = await ctx();
  const now = new Date().toISOString();
  state.imports = [];
  state.uploadedSources = {};
  state.prefillItems = [];
  state.currentTenantDatasetId = null;
  state.currentTenantDatasetBytes = 0;
  state.calcRun = runThreeStageCalculation({
    cycleId: state.context.cycle.id,
    productSourceRows: [],
    damoProductRows: [],
    promotionProductRows: [],
    audienceSourceRows: [],
    prefillItems: [],
    marginMatrix: growthProfitConfigToMarginMatrix(state.growthProfitConfig)
  });
  pushVersion(state, {
    id: `version-import-clear-${Date.now()}`,
    cycleId: state.context.cycle.id,
    shopId: state.context.shop.id,
    kind: "import",
    title: "清空源数据",
    createdAt: now,
    createdBy: state.context.user.name,
    summary: "租户端当前源数据已清空，看板同步清空，可上传下一次最新数据。"
  });
  await saveWorkspace(tenantId, state);
}

export async function addImportBatch(input: {
  cycleId: string;
  datasetId: string;
  datasetTotalBytes: number;
  reportType: ReportType;
  fileName: string;
  fileSizeBytes: number;
  validation: ImportValidationResult;
  parsedHeaders?: string[];
  parsedRows?: unknown[][];
}): Promise<ImportBatch> {
  const { tenantId, state } = await ctx();
  const preflightError = validateImportDatasetWriteOn(state, {
    datasetId: input.datasetId,
    datasetTotalBytes: input.datasetTotalBytes
  });
  if (preflightError) {
    throw new ImportRetentionError(preflightError.message, preflightError.status);
  }

  const batch: ImportBatch = {
    id: `import-${input.reportType}-${Date.now()}`,
    cycleId: input.cycleId,
    datasetId: input.datasetId,
    reportType: input.reportType,
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes,
    status: input.validation.ok ? "validated" : "failed",
    rowCount: input.validation.rowCount,
    createdAt: new Date().toISOString(),
    validation: input.validation
  };
  state.currentTenantDatasetId = input.datasetId;
  state.currentTenantDatasetBytes = input.datasetTotalBytes;
  state.imports = [
    batch,
    ...state.imports.filter(
      (item) => item.datasetId === input.datasetId && item.reportType !== input.reportType
    )
  ];
  if (input.validation.ok && input.parsedHeaders && input.parsedRows) {
    state.uploadedSources = {
      ...state.uploadedSources,
      ...mapImportedRows(input.reportType, input.parsedHeaders, input.parsedRows)
    };
  }
  pushVersion(state, {
    id: `version-import-${Date.now()}`,
    cycleId: input.cycleId,
    shopId: state.context.shop.id,
    kind: "import",
    title: `${input.validation.ok ? "通过" : "失败"}：${input.fileName}`,
    createdAt: batch.createdAt,
    createdBy: state.context.user.name,
    summary: input.validation.ok
      ? `当前租户数据集 ${formatMegabytes(input.datasetTotalBytes)}，识别 ${input.validation.rowCount} 行，${input.validation.uniqueEntityCount} 个主体。`
      : input.validation.errors.join("；")
  });
  await saveWorkspace(tenantId, state);
  return batch;
}

function validateImportDatasetWriteOn(
  state: WorkspaceData,
  input: { datasetId: string; datasetTotalBytes: number }
) {
  const sizeError = validateTenantDatasetSize(input.datasetTotalBytes);
  if (sizeError) {
    return { ok: false as const, status: 413, message: sizeError };
  }
  if (
    state.currentTenantDatasetId !== null &&
    state.currentTenantDatasetId !== input.datasetId &&
    state.imports.length > 0
  ) {
    return {
      ok: false as const,
      status: 409,
      message: "租户端仅保存最新一次源数据。请先点击“清空源数据”，再上传新的数据集。"
    };
  }
  return null;
}

/** 上传前置校验（路由会单独调用）。 */
export async function validateImportDatasetWrite(input: {
  datasetId: string;
  datasetTotalBytes: number;
}) {
  const { state } = await ctx();
  return validateImportDatasetWriteOn(state, input);
}

export async function getImportBatch(id: string): Promise<ImportBatch | undefined> {
  const { state } = await ctx();
  return state.imports.find((batch) => batch.id === id);
}

export async function getPrefillItems(cycleId?: string): Promise<PrefillItem[]> {
  const { state } = await ctx();
  const cid = cycleId ?? state.context.cycle.id;
  return state.prefillItems.filter((item) => item.cycleId === cid);
}

export async function getGrowthProfitConfig(): Promise<GrowthProfitConfigRow[]> {
  const { state } = await ctx();
  return cloneGrowthProfitConfig(state.growthProfitConfig);
}

export async function updateGrowthProfitConfig(
  cycleId: string,
  rows: GrowthProfitConfigRow[]
): Promise<GrowthProfitConfigRow[]> {
  const { tenantId, state } = await ctx();
  state.growthProfitConfig = normalizeGrowthProfitConfig(rows);
  pushVersion(state, {
    id: `version-profit-config-${Date.now()}`,
    cycleId,
    shopId: state.context.shop.id,
    kind: "profit_config",
    title: "V9 增长利润配置更新",
    createdAt: new Date().toISOString(),
    createdBy: state.context.user.name,
    summary: "更新 SAB 分层与生命周期对应的增长利润率矩阵。"
  });
  await saveWorkspace(tenantId, state);
  return cloneGrowthProfitConfig(state.growthProfitConfig);
}

const EDITABLE_PREFILL_FIELDS = [
  "grade",
  "monthlyGsvOpportunity",
  "grossMarginRate",
  "paidVisitorRatio",
  "audienceStrategy",
  "competitorConversionExpectation",
  "benchmarkProductId",
  "imageUrl"
] as const;

function pickEditablePrefillFields(patch: PrefillItem): Partial<PrefillItem> {
  const result: Partial<PrefillItem> = {};
  for (const field of EDITABLE_PREFILL_FIELDS) {
    if (patch[field] !== undefined) {
      (result as Record<string, unknown>)[field] = patch[field];
    }
  }
  return result;
}

export async function updatePrefillItems(
  cycleId: string,
  items: PrefillItem[]
): Promise<PrefillItem[]> {
  const { tenantId, state } = await ctx();
  const byId = new Map(items.map((item) => [item.id, item]));
  state.prefillItems = state.prefillItems.map((item) =>
    item.cycleId === cycleId && byId.has(item.id)
      ? { ...item, ...pickEditablePrefillFields(byId.get(item.id)!) }
      : item
  );
  pushVersion(state, {
    id: `version-prefill-${Date.now()}`,
    cycleId,
    shopId: state.context.shop.id,
    kind: "prefill",
    title: "预填写参数更新",
    createdAt: new Date().toISOString(),
    createdBy: state.context.user.name,
    summary: `更新 ${items.length} 个商品的分层、GSV、毛利或付费访客参数。`
  });
  const result = state.prefillItems.filter((item) => item.cycleId === cycleId);
  await saveWorkspace(tenantId, state);
  return result;
}

const STAGE_TO_GRADE: Record<Lifecycle, ProductGrade> = {
  冷启期: "C",
  新品成长期: "C",
  成长期: "B",
  新品打爆期: "A",
  爆品期: "S",
  平销期: "A"
};

function derivePrefillItems(
  cycleId: string,
  productRows: ProductSourceRow[],
  damoRows: DamoProductRow[],
  existing: PrefillItem[]
): PrefillItem[] {
  const existingById = new Map(
    existing.filter((item) => item.cycleId === cycleId).map((item) => [item.productId, item])
  );
  const damoById = new Map(damoRows.map((row) => [row.productId, row]));
  return productRows.map((product, index) => {
    const prev = existingById.get(product.productId);
    const damo = damoById.get(product.productId);
    const fallbackGrade: ProductGrade = damo ? STAGE_TO_GRADE[damo.growthStage] ?? "C" : "C";
    return {
      id: prev?.id ?? `prefill-upload-${index + 1}`,
      cycleId,
      productId: product.productId,
      productCode: prev?.productCode ?? product.productId,
      productName: product.productName,
      grade: prev?.grade ?? fallbackGrade,
      monthlyGsvOpportunity:
        prev?.monthlyGsvOpportunity ?? Math.max(0, product.paymentAmount - product.refundAmount),
      grossMarginRate: prev?.grossMarginRate ?? 0,
      paidVisitorRatio: prev?.paidVisitorRatio ?? 0.3,
      audienceStrategy: prev?.audienceStrategy,
      benchmarkProductId: prev?.benchmarkProductId,
      competitorConversionExpectation: prev?.competitorConversionExpectation,
      imageUrl: prev?.imageUrl
    };
  });
}

export async function runCalculation(cycleId?: string): Promise<CalcRun> {
  const { tenantId, state } = await ctx();
  const cid = cycleId ?? state.context.cycle.id;
  const productSourceRows = state.uploadedSources.product_source ?? [];
  const damoProductRows = state.uploadedSources.damo_product_source ?? [];
  const promotionProductRows = state.uploadedSources.promotion_product_source ?? [];
  const audienceSourceRows = state.uploadedSources.audience_source ?? [];

  let prefillItems: PrefillItem[];
  if (state.uploadedSources.product_source) {
    prefillItems = derivePrefillItems(cid, productSourceRows, damoProductRows, state.prefillItems);
    const others = state.prefillItems.filter((item) => item.cycleId !== cid);
    state.prefillItems = [...others, ...prefillItems];
  } else {
    prefillItems = state.prefillItems.filter((item) => item.cycleId === cid);
  }

  state.calcRun = runThreeStageCalculation({
    cycleId: cid,
    productSourceRows,
    damoProductRows,
    promotionProductRows,
    audienceSourceRows,
    prefillItems,
    marginMatrix: growthProfitConfigToMarginMatrix(state.growthProfitConfig)
  });
  pushVersion(state, {
    id: `version-calc-${Date.now()}`,
    cycleId: cid,
    shopId: state.context.shop.id,
    kind: "calculation",
    title: "三阶评估算法重新运行",
    createdAt: state.calcRun.createdAt,
    createdBy: state.context.user.name,
    summary: `生成 ${state.calcRun.investmentResults.length} 个商品结果和 ${state.calcRun.audiencePlans.length} 条人群计划。`
  });
  await saveWorkspace(tenantId, state);
  return state.calcRun;
}

export async function getLatestCalcRun(): Promise<CalcRun> {
  const { state } = await ctx();
  return state.calcRun;
}

export async function getVersions(cycleId?: string): Promise<VersionSnapshot[]> {
  const { state } = await ctx();
  const cid = cycleId ?? state.context.cycle.id;
  return state.versions
    .filter((version) => version.cycleId === cid)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

// ——————————————————————————————————————————————————————————————
// 邀请码（关系表，跨租户索引）
// ——————————————————————————————————————————————————————————————

export async function getInviteCodes(): Promise<InviteCode[]> {
  const tenantId = await requireTenantId();
  const rows = await prisma.inviteCode.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(toDomainInvite);
}

export async function createInviteCode(input: {
  note: string;
  maxUses: number;
}): Promise<InviteCode> {
  const { tenantId, state } = await ctx();
  const code = await generateUniqueInviteCode();
  const row = await prisma.inviteCode.create({
    data: {
      tenantId,
      code,
      registrationUrl: `/login?invite=${code}`,
      usedCount: 0,
      maxUses: input.maxUses,
      note: input.note.trim() || "未备注",
      createdBy: state.context.user.name
    }
  });
  return toDomainInvite(row);
}

export async function deleteInviteCode(id: string): Promise<boolean> {
  const tenantId = await requireTenantId();
  const result = await prisma.inviteCode.deleteMany({ where: { id, tenantId } });
  return result.count > 0;
}

/**
 * 消费一个邀请码（注册时调用，无会话上下文）：校验存在性与剩余次数，
 * 成功后 usedCount + 1 并登记一名管理用户（User 行）。被吊销（删除）的码自然失效。
 */
export async function consumeInviteCode(
  rawCode: string,
  newUser: { name: string; username: string }
): Promise<{ ok: true; invite: InviteCode } | { ok: false; error: string }> {
  const code = rawCode.trim().toUpperCase();
  if (!code) {
    return { ok: false, error: "请输入邀请码" };
  }
  const invite = await prisma.inviteCode.findUnique({ where: { code } });
  if (!invite) {
    return { ok: false, error: "邀请码无效或已失效" };
  }
  if (invite.usedCount >= invite.maxUses) {
    return { ok: false, error: "邀请码使用次数已用尽" };
  }
  const updated = await prisma.inviteCode.update({
    where: { id: invite.id },
    data: { usedCount: { increment: 1 } }
  });
  return { ok: true, invite: toDomainInvite(updated) };
}

export async function getManagedUsers(): Promise<ManagedUser[]> {
  const tenantId = await requireTenantId();
  const users = await prisma.user.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" }
  });
  return users.map((u) => ({
    id: u.id,
    tenantId: u.tenantId,
    name: u.name,
    username: u.username,
    email: u.email,
    role: u.role as ManagedUser["role"],
    shopName: u.shopName,
    status: u.status as ManagedUser["status"],
    createdAt: u.createdAt.toISOString(),
    lastActiveAt: u.lastActiveAt.toISOString()
  }));
}

// ——————————————————————————————————————————————————————————————
// 管理历史
// ——————————————————————————————————————————————————————————————

export async function getManagementHistory(): Promise<ManagementHistoryState> {
  const { state } = await ctx();
  return {
    records: [...state.historyRecords].sort((l, r) => r.uploadAt.localeCompare(l.uploadAt)),
    reports: [...state.historyReports].sort((l, r) => r.createdAt.localeCompare(l.createdAt)),
    retention: { ...state.historyRetention }
  };
}

export async function updateManagementHistoryRetention(
  months: number
): Promise<ManagementHistoryState> {
  const { tenantId, state } = await ctx();
  const normalizedMonths = normalizeHistoryMonths(months);
  state.historyRetention = {
    ...state.historyRetention,
    months: normalizedMonths,
    updatedAt: new Date().toISOString(),
    updatedBy: state.context.user.name
  };
  state.historyRecords = pruneHistoryRecordsByMonths(state.historyRecords, normalizedMonths, new Date());
  state.historyReports = pruneHistoryReportsByMonths(state.historyReports, normalizedMonths, new Date());
  pushHistoryVersion(
    state,
    "历史保留策略更新",
    `历史数据保留期调整为 ${normalizedMonths === 0 ? "永久保留" : `最近 ${normalizedMonths} 个月`}。`
  );
  await saveWorkspace(tenantId, state);
  return {
    records: [...state.historyRecords].sort((l, r) => r.uploadAt.localeCompare(l.uploadAt)),
    reports: [...state.historyReports].sort((l, r) => r.createdAt.localeCompare(l.createdAt)),
    retention: { ...state.historyRetention }
  };
}

export async function clearManagementHistory(): Promise<ManagementHistoryState> {
  const { tenantId, state } = await ctx();
  const removed = state.historyRecords.length + state.historyReports.length;
  state.historyRecords = [];
  state.historyReports = [];
  pushHistoryVersion(state, "清空历史数据", `清空全部管理历史，移除 ${removed} 条记录与报表。`);
  await saveWorkspace(tenantId, state);
  return getManagementHistorySnapshot(state);
}

export async function deleteManagementHistoryBefore(beforeDate: string): Promise<ManagementHistoryState> {
  const { tenantId, state } = await ctx();
  const cutoff = parseDate(beforeDate);
  if (!cutoff) {
    return getManagementHistorySnapshot(state);
  }
  const before = state.historyRecords.length + state.historyReports.length;
  state.historyRecords = state.historyRecords.filter(
    (record) => new Date(record.uploadAt).getTime() >= cutoff.getTime()
  );
  state.historyReports = state.historyReports.filter(
    (report) => new Date(`${report.endDate}T23:59:59.999Z`).getTime() >= cutoff.getTime()
  );
  const after = state.historyRecords.length + state.historyReports.length;
  pushHistoryVersion(
    state,
    "按日期清理历史数据",
    `删除 ${beforeDate} 之前的历史，移除 ${before - after} 条记录与报表。`
  );
  await saveWorkspace(tenantId, state);
  return getManagementHistorySnapshot(state);
}

export async function deleteManagementHistoryRange(
  startDate: string,
  endDate: string
): Promise<ManagementHistoryState> {
  const { tenantId, state } = await ctx();
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end) {
    return getManagementHistorySnapshot(state);
  }
  const before = state.historyRecords.length + state.historyReports.length;
  const normalizedStart = start.getTime();
  const normalizedEnd = end.getTime();
  state.historyRecords = state.historyRecords.filter((record) => {
    const uploadTime = new Date(record.uploadAt).getTime();
    return uploadTime < normalizedStart || uploadTime > normalizedEnd;
  });
  state.historyReports = state.historyReports.filter((report) => {
    const reportStart = new Date(report.startDate).getTime();
    const reportEnd = new Date(`${report.endDate}T23:59:59.999Z`).getTime();
    return reportEnd < normalizedStart || reportStart > normalizedEnd;
  });
  const after = state.historyRecords.length + state.historyReports.length;
  pushHistoryVersion(
    state,
    "按区间清理历史数据",
    `删除 ${startDate} ~ ${endDate} 区间的历史，移除 ${before - after} 条记录与报表。`
  );
  await saveWorkspace(tenantId, state);
  return getManagementHistorySnapshot(state);
}

export async function saveManagementHistoryReport(input: {
  name: string;
  startDate: string;
  endDate: string;
  categories: ManagementHistoryReport["categories"];
}): Promise<ManagementHistoryReport> {
  const { tenantId, state } = await ctx();
  const report: ManagementHistoryReport = {
    id: `history-report-${Date.now()}`,
    tenantId,
    shopId: state.context.shop.id,
    cycleId: state.context.cycle.id,
    name: input.name.trim(),
    createdAt: new Date().toISOString(),
    createdBy: state.context.user.name,
    startDate: input.startDate,
    endDate: input.endDate,
    categories: [...input.categories]
  };
  state.historyReports = [report, ...state.historyReports];
  await saveWorkspace(tenantId, state);
  return report;
}

// ——————————————————————————————————————————————————————————————
// 内部工具
// ——————————————————————————————————————————————————————————————

function getManagementHistorySnapshot(state: WorkspaceData): ManagementHistoryState {
  return {
    records: [...state.historyRecords].sort((l, r) => r.uploadAt.localeCompare(l.uploadAt)),
    reports: [...state.historyReports].sort((l, r) => r.createdAt.localeCompare(l.createdAt)),
    retention: { ...state.historyRetention }
  };
}

function pushHistoryVersion(state: WorkspaceData, title: string, summary: string) {
  pushVersion(state, {
    id: `version-history-${Date.now()}`,
    cycleId: state.context.cycle.id,
    shopId: state.context.shop.id,
    kind: "history",
    title,
    createdAt: new Date().toISOString(),
    createdBy: state.context.user.name,
    summary
  });
}

function pushVersion(state: WorkspaceData, version: VersionSnapshot) {
  state.versions = pruneAdminVersionSnapshots([version, ...state.versions]);
}

function toDomainInvite(row: {
  id: string;
  tenantId: string;
  code: string;
  registrationUrl: string;
  usedCount: number;
  maxUses: number;
  note: string;
  createdBy: string;
  createdAt: Date;
}): InviteCode {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    registrationUrl: row.registrationUrl,
    usedCount: row.usedCount,
    maxUses: row.maxUses,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy
  };
}

async function generateUniqueInviteCode(): Promise<string> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 10; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const existing = await prisma.inviteCode.findUnique({ where: { code } });
    if (!existing) {
      return code;
    }
  }
  throw new Error("生成邀请码失败，请重试");
}

function normalizeHistoryMonths(months: number) {
  if (!Number.isFinite(months) || months < 0) {
    return 0;
  }
  return Math.floor(months);
}

function parseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class ImportRetentionError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ImportRetentionError";
  }
}

function matrixToGrowthProfitConfig(matrix: ProfitMarginMatrix): GrowthProfitConfigRow[] {
  return gradeRows.map((grade) => ({
    grade,
    values: Object.fromEntries(
      lifecycleColumns.map((lifecycle) => [lifecycle, matrix[grade][lifecycle]])
    ) as Record<(typeof lifecycleColumns)[number], number>
  }));
}

function cloneGrowthProfitConfig(rows: GrowthProfitConfigRow[]) {
  return rows.map((row) => ({
    grade: row.grade,
    values: { ...row.values }
  }));
}

function normalizeGrowthProfitConfig(rows: GrowthProfitConfigRow[]) {
  const byGrade = new Map(rows.map((row) => [row.grade, row]));
  return gradeRows.map((grade) => {
    const current = byGrade.get(grade);
    return {
      grade,
      values: Object.fromEntries(
        lifecycleColumns.map((lifecycle) => {
          const value = current?.values?.[lifecycle];
          return [lifecycle, Number.isFinite(value) ? Number(value) : marginMatrix[grade][lifecycle]];
        })
      ) as GrowthProfitConfigRow["values"]
    };
  });
}

function growthProfitConfigToMarginMatrix(rows: GrowthProfitConfigRow[]): ProfitMarginMatrix {
  const normalized = normalizeGrowthProfitConfig(rows);
  return Object.fromEntries(normalized.map((row) => [row.grade, { ...row.values }])) as ProfitMarginMatrix;
}

function pruneHistoryReportsByMonths(
  reports: ManagementHistoryReport[],
  months: number,
  referenceDate = new Date()
) {
  if (!Number.isFinite(months) || months <= 0) {
    return [...reports].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  const cutoff = new Date(referenceDate);
  cutoff.setMonth(cutoff.getMonth() - months);
  return [...reports]
    .filter((report) => new Date(`${report.endDate}T23:59:59.999Z`).getTime() >= cutoff.getTime())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function formatMegabytes(bytes: number) {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))}MB`;
}
