import "server-only";
import { cache } from "react";
import {
  gradeRows,
  lifecycleColumns,
  marginMatrix,
  runThreeStageCalculation
} from "@/lib/algorithm/three-stage";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isPrefillReady } from "@/lib/prefill-status";
import { getServerSession, requireTenantId } from "@/lib/session-server";
import {
  mapAudienceDailyRows,
  mapImportedRows,
  mapProductDailyRows,
  mapPromotionDailyRows,
  type MappedSourceRows
} from "@/lib/imports/map-rows";
import {
  addDays,
  aggregateAudienceForCycle,
  aggregateProductForCycle,
  aggregatePromotionForCycle,
  clearAllDailyMetrics,
  getProductDailyDateRange,
  buildDailyTrendSeries,
  pruneAllDailyMetrics,
  sumAudienceWindowByGroup,
  sumProductWindow,
  sumProductWindowByProduct,
  sumPromotionWindow,
  sumPromotionWindowByProduct,
  upsertDailyAudienceMetrics,
  upsertDailyProductMetrics,
  upsertDailyPromotionMetrics,
  type PromotionWindowSum,
  type WindowSum
} from "@/lib/store/daily-metrics";
import {
  pruneAdminVersionSnapshots,
  pruneHistoryRecordsByMonths,
  retentionPolicy,
  validateTenantDatasetSize
} from "@/lib/retention-policy";
import type {
  AnalysisCycle,
  AudienceComparison,
  AudiencePlanItem,
  CalcRun,
  ComparisonMetric,
  ComparisonWindow,
  DailyTrendPoint,
  FunnelChainStep,
  FunnelStage,
  DamoProductRow,
  GrowthProfitConfigRow,
  Intervention,
  InterventionComparison,
  InviteCode,
  ManagementDashboard,
  ProductBreakthroughResult,
  ProductComparison,
  ProductInvestmentResult,
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
  // calcRun 已外置到独立 CalcRun 表（见 calcRunUpsertOp/getLatestCalcRun），不再随 blob 反复读写。
  versions: VersionSnapshot[];
  historyRecords: ManagementHistoryRecord[];
  historyReports: ManagementHistoryReport[];
  historyRetention: ManagementHistoryRetention;
  dailyRetentionDays?: number; // 分日明细保留天数（相对最新日期）；缺省视为 365，<=0 永久
}

export const DEFAULT_DAILY_RETENTION_DAYS = 365;

const initialGrowthProfitConfig = matrixToGrowthProfitConfig(marginMatrix);

/** 空计算结果（无源数据时的默认），用于 CalcRun 表无行/字段缺失时的兜底与「清空源数据」。冻结防止共享单例被原地改污染其它请求。 */
const EMPTY_CALC_RUN: CalcRun = (() => {
  const e = runThreeStageCalculation({
    cycleId: "",
    productSourceRows: [],
    damoProductRows: [],
    promotionProductRows: [],
    audienceSourceRows: [],
    prefillItems: [],
    marginMatrix
  });
  Object.freeze(e.investmentResults);
  Object.freeze(e.breakthroughResults);
  Object.freeze(e.audiencePlans);
  Object.freeze(e.managementDashboard.topProducts);
  Object.freeze(e.managementDashboard);
  return Object.freeze(e);
})();

const asJson = (v: unknown) => v as unknown as Prisma.InputJsonValue;

/** dashboard 列可能是 '{}'（列默认/回填兜底）→ topProducts 为 undefined 会让管理页 .length 崩；缺形状即回落完整零对象。 */
function safeDashboard(value: unknown): ManagementDashboard {
  const d = value as ManagementDashboard | null | undefined;
  return d && Array.isArray(d.topProducts) ? d : EMPTY_CALC_RUN.managementDashboard;
}

/** 三阶计算结果写独立 CalcRun 表的 upsert 操作（可放进 $transaction 与 blob 同事务原子写）。 */
function calcRunUpsertOp(tenantId: string, run: CalcRun) {
  const payload = {
    runId: run.id,
    cycleId: run.cycleId,
    createdAt: run.createdAt,
    investmentResults: asJson(run.investmentResults),
    breakthroughResults: asJson(run.breakthroughResults),
    audiencePlans: asJson(run.audiencePlans),
    managementDashboard: asJson(run.managementDashboard)
  };
  return prisma.calcRun.upsert({ where: { tenantId }, update: payload, create: { tenantId, ...payload } });
}

/** 读全量 CalcRun（请求级缓存）；无行返回空结果。供 admin/完整消费方使用。 */
const loadCalcRunFull = cache(async (tenantId: string): Promise<CalcRun> => {
  const row = await prisma.calcRun.findUnique({ where: { tenantId } });
  if (!row) {
    return EMPTY_CALC_RUN;
  }
  return {
    id: row.runId,
    cycleId: row.cycleId,
    createdAt: row.createdAt,
    investmentResults: row.investmentResults as unknown as ProductInvestmentResult[],
    breakthroughResults: row.breakthroughResults as unknown as ProductBreakthroughResult[],
    audiencePlans: row.audiencePlans as unknown as AudiencePlanItem[],
    managementDashboard: safeDashboard(row.managementDashboard)
  };
});

/** 管理看板切片：只取 dashboard + investmentResults（跳过 ~96% 体积的 audiencePlans 列）。 */
export const getManagementData = cache(
  async (): Promise<{ managementDashboard: ManagementDashboard; investmentResults: ProductInvestmentResult[] }> => {
    const tenantId = await requireTenantId();
    const row = await prisma.calcRun.findUnique({
      where: { tenantId },
      select: { managementDashboard: true, investmentResults: true }
    });
    if (!row) {
      return { managementDashboard: EMPTY_CALC_RUN.managementDashboard, investmentResults: [] };
    }
    return {
      managementDashboard: safeDashboard(row.managementDashboard),
      investmentResults: row.investmentResults as unknown as ProductInvestmentResult[]
    };
  }
);

/** 单品突破切片：只取 breakthroughResults。 */
export const getBreakthroughResults = cache(async (): Promise<ProductBreakthroughResult[]> => {
  const tenantId = await requireTenantId();
  const row = await prisma.calcRun.findUnique({ where: { tenantId }, select: { breakthroughResults: true } });
  return (row?.breakthroughResults as unknown as ProductBreakthroughResult[]) ?? [];
});

/** 人群计划切片：只取 audiencePlans（最大的一段）。 */
export const getAudiencePlans = cache(async (): Promise<AudiencePlanItem[]> => {
  const tenantId = await requireTenantId();
  const row = await prisma.calcRun.findUnique({ where: { tenantId }, select: { audiencePlans: true } });
  return (row?.audiencePlans as unknown as AudiencePlanItem[]) ?? [];
});

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

/**
 * 加载某租户的工作区 blob（~490KB JSON）。用 React cache() 做请求级 memo：
 * 同一请求内多次 ctx() 只反序列化一次，跨请求/跨租户不共享（cache 作用域=单次 server 请求）。
 * 写语义不受影响：每个 mutation 是「一次 ctx()→改同一 state 引用→saveWorkspace」，函数内只读一次。
 */
const loadWorkspace = cache(async (tenantId: string): Promise<WorkspaceData> => {
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
});

/** 写 blob 的 upsert 操作（可放进 $transaction 与 CalcRun 表同事务原子写）。 */
function workspaceUpsertOp(tenantId: string, data: WorkspaceData) {
  const json = data as unknown as Prisma.InputJsonValue;
  return prisma.workspace.upsert({
    where: { tenantId },
    update: { data: json },
    create: { tenantId, data: json }
  });
}

async function saveWorkspace(tenantId: string, data: WorkspaceData): Promise<void> {
  await workspaceUpsertOp(tenantId, data);
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
      // 每个源类型各留最新，可独立上传，无需先清空。
      mustClearBeforeNewUpload: false
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

/** 分日数据概况 + 保留设置（导入页展示）。 */
export async function getDailyDataStatus(): Promise<{
  range: { start: string; end: string; days: number } | null;
  retentionDays: number;
}> {
  const { tenantId, state } = await ctx();
  const range = await getProductDailyDateRange(tenantId);
  return { range, retentionDays: state.dailyRetentionDays ?? DEFAULT_DAILY_RETENTION_DAYS };
}

/** 设置分日保留天数（0=永久），并立即按新策略清理一次。 */
export async function setDailyRetentionDays(days: number): Promise<number> {
  const { tenantId, state } = await ctx();
  const clean = Number.isFinite(days) ? Math.max(0, Math.min(3650, Math.round(days))) : DEFAULT_DAILY_RETENTION_DAYS;
  state.dailyRetentionDays = clean;
  await saveWorkspace(tenantId, state);
  await pruneAllDailyMetrics(tenantId, clean);
  return 0;
}

export async function clearImportBatches(options?: { keepPrefill?: boolean }): Promise<void> {
  const { tenantId, state } = await ctx();
  const now = new Date().toISOString();
  state.imports = [];
  state.uploadedSources = {};
  // keepPrefill：上传新数据前的"换一批源数据"。保留运营已填的分层/毛利率等参数，
  // 重新上传时按 productId 沿用（满足"多次依照已有数据展示"）。分日表保留累积，靠 upsert 覆盖同日。
  // 不传 keepPrefill：运营主动「清空源数据」，连预填参数和分日明细一并清空，回到从零体验。
  if (!options?.keepPrefill) {
    state.prefillItems = [];
    await clearAllDailyMetrics(tenantId);
  }
  state.currentTenantDatasetId = null;
  state.currentTenantDatasetBytes = 0;
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
  // 计算结果同步清空（写独立 CalcRun 表）。同事务原子写。
  await prisma.$transaction([calcRunUpsertOp(tenantId, EMPTY_CALC_RUN), workspaceUpsertOp(tenantId, state)]);
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
  // 分日合并导入（生意参谋多日表）走分日 upsert、天然累积，不受"仅保留最新一次数据集"约束。
  skipDatasetGuard?: boolean;
}): Promise<ImportBatch> {
  const { tenantId, state } = await ctx();
  if (!input.skipDatasetGuard) {
    const preflightError = validateImportDatasetWriteOn({
      datasetTotalBytes: input.datasetTotalBytes
    });
    if (preflightError) {
      throw new ImportRetentionError(preflightError.message, preflightError.status);
    }
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
  // 分日合并不参与"单数据集"跟踪（数据在分日表，按日累积），避免改 currentTenantDatasetId 后
  // 让下一次普通上传误触 409 守卫。
  if (!input.skipDatasetGuard) {
    state.currentTenantDatasetId = input.datasetId;
    state.currentTenantDatasetBytes = input.datasetTotalBytes;
  }
  // 每个源类型各留最新一份（与数据集/其它源无关）：上传某类型只替换该类型，其它源保留。
  state.imports = [batch, ...state.imports.filter((item) => item.reportType !== input.reportType)];
  if (input.validation.ok && input.parsedHeaders && input.parsedRows) {
    // 商品/推广/人群落 v2 分日表（按日 upsert 累积），不进 blob；达摩盘无日期、保持快照留 blob。
    const retention = state.dailyRetentionDays ?? DEFAULT_DAILY_RETENTION_DAYS;
    if (input.reportType === "product_source") {
      await upsertDailyProductMetrics(
        tenantId,
        mapProductDailyRows(input.parsedHeaders, input.parsedRows)
      );
      await pruneAllDailyMetrics(tenantId, retention);
    } else if (input.reportType === "promotion_product_source") {
      await upsertDailyPromotionMetrics(
        tenantId,
        mapPromotionDailyRows(input.parsedHeaders, input.parsedRows)
      );
      await pruneAllDailyMetrics(tenantId, retention);
    } else if (input.reportType === "audience_source") {
      await upsertDailyAudienceMetrics(
        tenantId,
        mapAudienceDailyRows(input.parsedHeaders, input.parsedRows)
      );
      await pruneAllDailyMetrics(tenantId, retention);
    } else {
      // damo_product_source：当期快照，留 blob。
      state.uploadedSources = {
        ...state.uploadedSources,
        ...mapImportedRows(input.reportType, input.parsedHeaders, input.parsedRows)
      };
    }
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

function validateImportDatasetWriteOn(input: { datasetTotalBytes: number }) {
  // 仅校验单次上传体积上限；不再要求"先清空"——每个源类型各留最新一份，可任意单独上传、不分先后、互不覆盖。
  const sizeError = validateTenantDatasetSize(input.datasetTotalBytes);
  if (sizeError) {
    return { ok: false as const, status: 413, message: sizeError };
  }
  return null;
}

/** 上传前置校验（路由会单独调用）。 */
export async function validateImportDatasetWrite(input: {
  datasetId: string;
  datasetTotalBytes: number;
}) {
  return validateImportDatasetWriteOn(input);
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

function derivePrefillItems(
  cycleId: string,
  productRows: ProductSourceRow[],
  _damoRows: DamoProductRow[],
  existing: PrefillItem[]
): PrefillItem[] {
  const existingById = new Map(
    existing.filter((item) => item.cycleId === cycleId).map((item) => [item.productId, item])
  );
  return productRows.map((product, index) => {
    const prev = existingById.get(product.productId);
    return {
      id: prev?.id ?? `prefill-upload-${index + 1}`,
      cycleId,
      productId: product.productId,
      productCode: prev?.productCode ?? product.productId,
      productName: product.productName,
      // 分层/月GSV机会/毛利率默认均为未填写（空或 0 仅占位），由运营填写后才纳入三阶计算。
      grade: prev?.grade ?? "",
      monthlyGsvOpportunity: prev?.monthlyGsvOpportunity ?? 0,
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
  // 商品/推广/人群走 v2 分日表 → 周期聚合；达摩盘是快照仍读 blob。
  const [productSourceRows, promotionProductRows, audienceSourceRows] = await Promise.all([
    aggregateProductForCycle(tenantId),
    aggregatePromotionForCycle(tenantId),
    aggregateAudienceForCycle(tenantId)
  ]);
  const damoProductRows = state.uploadedSources.damo_product_source ?? [];

  let prefillItems: PrefillItem[];
  if (productSourceRows.length > 0) {
    prefillItems = derivePrefillItems(cid, productSourceRows, damoProductRows, state.prefillItems);
    const others = state.prefillItems.filter((item) => item.cycleId !== cid);
    state.prefillItems = [...others, ...prefillItems];
  } else {
    prefillItems = state.prefillItems.filter((item) => item.cycleId === cid);
  }

  // 仅「已填写」(分层+毛利率+月GSV机会齐全) 的商品进入三阶计算；未填写的仅占位展示，不参与。
  const readyPrefillItems = prefillItems.filter(isPrefillReady);

  const run = runThreeStageCalculation({
    cycleId: cid,
    productSourceRows,
    damoProductRows,
    promotionProductRows,
    audienceSourceRows,
    prefillItems: readyPrefillItems,
    marginMatrix: growthProfitConfigToMarginMatrix(state.growthProfitConfig)
  });
  pushVersion(state, {
    id: `version-calc-${Date.now()}`,
    cycleId: cid,
    shopId: state.context.shop.id,
    kind: "calculation",
    title: "三阶评估算法重新运行",
    createdAt: run.createdAt,
    createdBy: state.context.user.name,
    summary: `生成 ${run.investmentResults.length} 个商品结果和 ${run.audiencePlans.length} 条人群计划。`
  });
  // calcRun 写独立表；blob 只存 prefill 派生 + 版本留痕（小）。同事务原子写，避免半写不一致。
  await prisma.$transaction([calcRunUpsertOp(tenantId, run), workspaceUpsertOp(tenantId, state)]);
  return run;
}

export async function getLatestCalcRun(): Promise<CalcRun> {
  const tenantId = await requireTenantId();
  return loadCalcRunFull(tenantId);
}

/** 整店分日趋势（覆盖全部已有分日数据区间），供管理看板 KPI「分日趋势」视图。无数据返回 null。 */
export async function getStoreDailyTrend(): Promise<{
  series: DailyTrendPoint[];
  start: string;
  end: string;
} | null> {
  // 只需 tenantId（来自 cookie），不读 490KB blob。
  const tenantId = await requireTenantId();
  const range = await getProductDailyDateRange(tenantId);
  if (!range) {
    return null;
  }
  const series = await buildDailyTrendSeries(tenantId, range.start, range.end, null);
  return { series, start: range.start, end: range.end };
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

type ManagedUserActionResult =
  | { ok: true }
  | { ok: false; error: string; status: number };

/** 校验目标用户可被当前管理员操作：同租户、非本人、非管理员账号。 */
async function guardManagedUserAction(id: string): Promise<ManagedUserActionResult> {
  const tenantId = await requireTenantId();
  const session = await getServerSession();
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.tenantId !== tenantId) {
    return { ok: false, error: "用户不存在", status: 404 };
  }
  if (session && user.username === session.username) {
    return { ok: false, error: "不能对当前登录的账号执行此操作", status: 400 };
  }
  if (user.authRole === "admin") {
    return { ok: false, error: "不能操作管理员账号", status: 403 };
  }
  return { ok: true };
}

/** 禁用/启用租户成员。禁用后该账号无法登录。 */
export async function setManagedUserStatus(
  id: string,
  status: "active" | "disabled"
): Promise<ManagedUserActionResult> {
  const guard = await guardManagedUserAction(id);
  if (!guard.ok) {
    return guard;
  }
  await prisma.user.update({ where: { id }, data: { status } });
  return { ok: true };
}

/** 删除租户成员（硬删除，账号即刻失效）。 */
export async function deleteManagedUser(id: string): Promise<ManagedUserActionResult> {
  const guard = await guardManagedUserAction(id);
  if (!guard.ok) {
    return guard;
  }
  await prisma.user.delete({ where: { id } });
  return { ok: true };
}

/**
 * 重置租户成员密码：生成 10 位临时密码并写库，明文仅随本次响应返回一次。
 * （沿用演示版明文密码存储；生产应改加盐哈希并强制首登修改。）
 */
export async function resetManagedUserPassword(
  id: string
): Promise<{ ok: true; password: string } | { ok: false; error: string; status: number }> {
  const guard = await guardManagedUserAction(id);
  if (!guard.ok) {
    return guard;
  }
  // 去掉易混淆字符（0O1lI），降低口头/抄写传达出错率。
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const { randomInt } = await import("node:crypto");
  let password = "";
  for (let index = 0; index < 10; index += 1) {
    password += alphabet[randomInt(alphabet.length)];
  }
  await prisma.user.update({ where: { id }, data: { password } });
  return { ok: true, password };
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

// ——————————————————————————————————————————————————————————————
// v2 阶段3：优化动作前后对比引擎（三口径）
// ——————————————————————————————————————————————————————————————

function comparisonMetric(
  key: string,
  label: string,
  unit: ComparisonMetric["unit"],
  before: number,
  after: number,
  higherIsBetter: boolean
): ComparisonMetric {
  const delta = after - before;
  const deltaPct = before !== 0 ? delta / Math.abs(before) : after !== 0 ? (after > 0 ? 1 : -1) : 0;
  return { key, label, unit, before, after, delta, deltaPct, higherIsBetter };
}

/**
 * 漏斗对比引擎：把口径A的前后变化按 投放→流量→成交→利润 四阶段串成因果链。
 * - 可加和项（花费/展现/点击/访客/浏览/买家/销售额/净销）取"日均"，窗口长度不同也可比；
 * - 强度量（CPC/CPM/转化率/客单价/访客价值/退款率/各类ROI/花费占比）由前后窗各自的求和重算，不受窗长影响；
 * - 无投放数据时跳过广告相关卡片，避免一排 0；
 * - "综合ROI"=销售额/花费仅在 scoped（指定商品集，分子分母同口径）时展示；整店作用域下分子含自然流量，
 *   与广告花费不同口径，会被误读为广告投产比，故不展示，仅保留"推广ROI"。
 */
function buildFunnelMetrics(
  pb: WindowSum,
  pa: WindowSum,
  qb: PromotionWindowSum,
  qa: PromotionWindowSum,
  beforeDays: number,
  afterDays: number,
  hasPromo: boolean,
  scoped: boolean
): ComparisonMetric[] {
  const bd = beforeDays > 0 ? beforeDays : 1;
  const ad = afterDays > 0 ? afterDays : 1;
  // 强度量（不除窗长，由各自求和重算）
  const net = (s: WindowSum) => s.paymentAmount - s.refundAmount;
  const conv = (s: WindowSum) => (s.visitors > 0 ? s.paymentBuyers / s.visitors : 0);
  const aov = (s: WindowSum) => (s.paymentBuyers > 0 ? s.paymentAmount / s.paymentBuyers : 0);
  const uv = (s: WindowSum) => (s.visitors > 0 ? s.paymentAmount / s.visitors : 0);
  const refundRate = (s: WindowSum) => (s.paymentAmount > 0 ? s.refundAmount / s.paymentAmount : 0);
  const cpc = (s: PromotionWindowSum) => (s.clicks > 0 ? s.cost / s.clicks : 0);
  const cpm = (s: PromotionWindowSum) => (s.impressions > 0 ? (s.cost / s.impressions) * 1000 : 0);
  const adRoi = (s: PromotionWindowSum) => (s.cost > 0 ? s.roiCost / s.cost : 0);
  const costRatio = (p: WindowSum, q: PromotionWindowSum) => (p.paymentAmount > 0 ? q.cost / p.paymentAmount : 0);
  const overallRoi = (p: WindowSum, q: PromotionWindowSum) => (q.cost > 0 ? p.paymentAmount / q.cost : 0);

  const out: ComparisonMetric[] = [];
  const push = (
    m: ComparisonMetric,
    stage: FunnelStage,
    opts?: { ad?: boolean; neutral?: boolean }
  ) => {
    out.push({
      ...m,
      stage,
      group: opts?.ad ? "广告" : "经营",
      ...(opts?.neutral ? { neutral: true } : {})
    });
  };

  // ① 投放：投入与单位成本
  if (hasPromo) {
    push(comparisonMetric("adCost", "日均推广花费", "money", qb.cost / bd, qa.cost / ad, true), "投放", { ad: true, neutral: true });
    push(comparisonMetric("impressions", "日均展现", "int", qb.impressions / bd, qa.impressions / ad, true), "投放", { ad: true, neutral: true });
    push(comparisonMetric("adClicks", "日均点击", "int", qb.clicks / bd, qa.clicks / ad, true), "投放", { ad: true, neutral: true });
    push(comparisonMetric("cpc", "点击成本 CPC", "money", cpc(qb), cpc(qa), false), "投放", { ad: true });
    push(comparisonMetric("cpm", "千次展现成本 CPM", "money", cpm(qb), cpm(qa), false), "投放", { ad: true });
  }
  // ② 流量：到店与流量质量
  push(comparisonMetric("visitors", "日均访客", "int", pb.visitors / bd, pa.visitors / ad, true), "流量");
  push(comparisonMetric("views", "日均浏览量", "int", pb.views / bd, pa.views / ad, true), "流量");
  push(comparisonMetric("uvValue", "访客价值", "money", uv(pb), uv(pa), true), "流量");
  // ③ 成交：转化与产出
  push(comparisonMetric("paymentBuyers", "日均支付买家", "int", pb.paymentBuyers / bd, pa.paymentBuyers / ad, true), "成交");
  push(comparisonMetric("conversion", "支付转化率", "rate", conv(pb), conv(pa), true), "成交");
  push(comparisonMetric("aov", "客单价", "money", aov(pb), aov(pa), true), "成交");
  push(comparisonMetric("paymentAmount", "日均销售额", "money", pb.paymentAmount / bd, pa.paymentAmount / ad, true), "成交");
  // ④ 利润：净产出与投产效率
  push(comparisonMetric("netSales", "日均净销额", "money", net(pb) / bd, net(pa) / ad, true), "利润");
  push(comparisonMetric("refundRate", "退款率", "rate", refundRate(pb), refundRate(pa), false), "利润");
  if (hasPromo) {
    push(comparisonMetric("adRoi", "推广ROI", "ratio", adRoi(qb), adRoi(qa), true), "利润", { ad: true });
    push(comparisonMetric("costRatio", "花费占比", "rate", costRatio(pb, qb), costRatio(pa, qa), false), "利润", { ad: true });
    if (scoped) {
      push(comparisonMetric("overallRoi", "综合ROI", "ratio", overallRoi(pb, qb), overallRoi(pa, qa), true), "利润", { ad: true });
    }
  }
  return out;
}

/**
 * 投产链路：把漏斗关键节点抽成一行 花费→展现→点击→访客→买家→销售额→ROI，
 * 让"动作如何沿链路传导"一眼可见（无投放则退化为 访客→买家→销售额→净销额）。
 */
function buildFunnelChain(
  pb: WindowSum,
  pa: WindowSum,
  qb: PromotionWindowSum,
  qa: PromotionWindowSum,
  beforeDays: number,
  afterDays: number,
  hasPromo: boolean
): FunnelChainStep[] {
  const bd = beforeDays > 0 ? beforeDays : 1;
  const ad = afterDays > 0 ? afterDays : 1;
  const relPct = (after: number, before: number) =>
    before !== 0 ? (after - before) / Math.abs(before) : after !== 0 ? (after > 0 ? 1 : -1) : 0;
  const step = (
    key: string,
    label: string,
    before: number,
    after: number,
    unit: ComparisonMetric["unit"],
    higherIsBetter: boolean,
    neutral = false
  ): FunnelChainStep => ({ key, label, before, after, deltaPct: relPct(after, before), unit, higherIsBetter, neutral });

  const steps: FunnelChainStep[] = [];
  if (hasPromo) {
    steps.push(step("adCost", "推广花费", qb.cost / bd, qa.cost / ad, "money", true, true));
    steps.push(step("impressions", "展现", qb.impressions / bd, qa.impressions / ad, "int", true, true));
    steps.push(step("adClicks", "点击", qb.clicks / bd, qa.clicks / ad, "int", true, true));
  }
  steps.push(step("visitors", "访客", pb.visitors / bd, pa.visitors / ad, "int", true));
  steps.push(step("paymentBuyers", "支付买家", pb.paymentBuyers / bd, pa.paymentBuyers / ad, "int", true));
  steps.push(step("paymentAmount", "销售额", pb.paymentAmount / bd, pa.paymentAmount / ad, "money", true));
  if (hasPromo) {
    const roiB = qb.cost > 0 ? qb.roiCost / qb.cost : 0;
    const roiA = qa.cost > 0 ? qa.roiCost / qa.cost : 0;
    steps.push(step("adRoi", "推广ROI", roiB, roiA, "ratio", true));
  } else {
    steps.push(step("netSales", "净销额", (pb.paymentAmount - pb.refundAmount) / bd, (pa.paymentAmount - pa.refundAmount) / ad, "money", true));
  }
  return steps;
}

/**
 * 计算一个优化动作的前后对比（三口径）。动作日 D 计入"后窗"（变更当天即生效）。
 * 前窗 [D-before, D-1]，后窗 [D, D+after-1]。productIds 为空=整店。
 */
export async function buildInterventionComparison(
  id: string,
  beforeDays = 7,
  afterDays = 7
): Promise<InterventionComparison | null> {
  // blob 加载与 intervention 查询无依赖 → 并行省一个 RTT。
  const [{ tenantId, state }, iv] = await Promise.all([
    ctx(),
    prisma.intervention.findUnique({ where: { id } })
  ]);
  if (!iv || iv.tenantId !== tenantId) {
    return null;
  }
  const affected = Array.isArray(iv.productIds) ? (iv.productIds as string[]) : [];
  const scopeIds = affected.length > 0 ? affected : null;

  const beforeStart = addDays(iv.date, -beforeDays);
  const beforeEnd = addDays(iv.date, -1);
  const afterStart = iv.date;
  const afterEnd = addDays(iv.date, afterDays - 1);

  // 口径 A：真实经营前后（日均/费率）+ 广告维度（推广花费/ROI/CPC）
  const [beforeSum, afterSum, beforePromo, afterPromo] = await Promise.all([
    sumProductWindow(tenantId, scopeIds, beforeStart, beforeEnd),
    sumProductWindow(tenantId, scopeIds, afterStart, afterEnd),
    sumPromotionWindow(tenantId, scopeIds, beforeStart, beforeEnd),
    sumPromotionWindow(tenantId, scopeIds, afterStart, afterEnd)
  ]);
  // 有推广数据才追加广告维度，避免无投放租户出现一排 0。
  const hasPromo =
    beforePromo.cost + afterPromo.cost + beforePromo.impressions + afterPromo.impressions > 0;
  const metrics = buildFunnelMetrics(beforeSum, afterSum, beforePromo, afterPromo, beforeDays, afterDays, hasPromo, scopeIds !== null);
  const chain = buildFunnelChain(beforeSum, afterSum, beforePromo, afterPromo, beforeDays, afterDays, hasPromo);

  // 口径 B：计划 vs 实际（按受影响商品；整店则取所有有计划的商品）
  const cid = state.context.cycle.id;
  const planById = new Map(
    state.prefillItems.filter((p) => p.cycleId === cid).map((p) => [p.productId, p])
  );
  const targetIds = affected.length > 0 ? affected : [...planById.keys()];
  const afterByProduct = await sumProductWindowByProduct(
    tenantId,
    targetIds.length > 0 ? targetIds : null,
    afterStart,
    afterEnd
  );
  const lensBRows = targetIds
    .map((pid) => {
      const plan = planById.get(pid);
      const a = afterByProduct.get(pid) ?? { paymentAmount: 0, refundAmount: 0, visitors: 0, views: 0, paymentBuyers: 0 };
      const actualNet = a.paymentAmount - a.refundAmount;
      const actualMonthlyGsv = afterDays > 0 ? (actualNet / afterDays) * 30 : 0;
      const planMonthlyGsv = plan?.monthlyGsvOpportunity ?? 0;
      return {
        productId: pid,
        productName: plan?.productName ?? pid,
        planMonthlyGsv,
        actualMonthlyGsv,
        attainmentPct: planMonthlyGsv > 0 ? actualMonthlyGsv / planMonthlyGsv : 0
      };
    })
    .filter((r) => r.planMonthlyGsv > 0 || r.actualMonthlyGsv > 0)
    .sort((l, r) => r.actualMonthlyGsv - l.actualMonthlyGsv);

  // 口径 C：整店（或商品集）按天趋势，覆盖 [前窗起, 后窗止]；经营派生 + 推广按日 join。
  const series = await buildDailyTrendSeries(tenantId, beforeStart, afterEnd, scopeIds);

  const intervention: Intervention = {
    id: iv.id,
    date: iv.date,
    title: iv.title,
    note: iv.note,
    category: iv.category,
    productIds: affected,
    createdBy: iv.createdBy,
    createdAt: iv.createdAt.toISOString()
  };

  return {
    intervention,
    window: { beforeStart, beforeEnd, afterStart, afterEnd, beforeDays, afterDays },
    lensA: { productScope: affected.length > 0 ? `${affected.length} 个商品` : "整店", metrics, chain },
    lensB: { rows: lensBRows },
    lensC: {
      interventionDate: iv.date,
      series
    }
  };
}

/**
 * 公共：加载动作 + 计算前后窗 + 作用域；找不到返回 null。
 * withState=false 时跳过 490KB blob 加载（仅需 tenantId 的路径，如人群对比）。
 * tenant/blob 加载与 intervention 查询无依赖，并行省一个 RTT。
 */
async function loadInterventionWindow(
  id: string,
  beforeDays: number,
  afterDays: number,
  withState = true
): Promise<{
  tenantId: string;
  state: WorkspaceData | null;
  affected: string[];
  scopeIds: string[] | null;
  window: ComparisonWindow;
  intervention: Intervention;
} | null> {
  const [base, iv] = await Promise.all([
    withState
      ? ctx()
      : requireTenantId().then((tenantId) => ({ tenantId, state: null as WorkspaceData | null })),
    prisma.intervention.findUnique({ where: { id } })
  ]);
  const { tenantId, state } = base;
  if (!iv || iv.tenantId !== tenantId) {
    return null;
  }
  const affected = Array.isArray(iv.productIds) ? (iv.productIds as string[]) : [];
  const window: ComparisonWindow = {
    beforeStart: addDays(iv.date, -beforeDays),
    beforeEnd: addDays(iv.date, -1),
    afterStart: iv.date,
    afterEnd: addDays(iv.date, afterDays - 1),
    beforeDays,
    afterDays
  };
  return {
    tenantId,
    state,
    affected,
    scopeIds: affected.length > 0 ? affected : null,
    window,
    intervention: {
      id: iv.id,
      date: iv.date,
      title: iv.title,
      note: iv.note,
      category: iv.category,
      productIds: affected,
      createdBy: iv.createdBy,
      createdAt: iv.createdAt.toISOString()
    }
  };
}

const rel = (after: number, before: number) =>
  before !== 0 ? (after - before) / Math.abs(before) : after !== 0 ? (after > 0 ? 1 : -1) : 0;

/** 单品突破视角：受影响商品（整店则取后窗销额 Top30）的动作前后变化。 */
export async function buildProductComparison(
  id: string,
  beforeDays = 7,
  afterDays = 7
): Promise<ProductComparison | null> {
  const ctxw = await loadInterventionWindow(id, beforeDays, afterDays);
  if (!ctxw) {
    return null;
  }
  const { tenantId, affected, scopeIds, window, intervention } = ctxw;
  const state = ctxw.state!; // withState=true（默认）→ 非空
  const [beforeByP, afterByP, beforePromoByP, afterPromoByP] = await Promise.all([
    sumProductWindowByProduct(tenantId, scopeIds, window.beforeStart, window.beforeEnd),
    sumProductWindowByProduct(tenantId, scopeIds, window.afterStart, window.afterEnd),
    sumPromotionWindowByProduct(tenantId, scopeIds, window.beforeStart, window.beforeEnd),
    sumPromotionWindowByProduct(tenantId, scopeIds, window.afterStart, window.afterEnd)
  ]);
  // 与 overview 严格同口径（cost+impressions，不含 clicks）：基于实际投放量判定而非分组是否存在，
  // 既避免全 0 推广行导致"一排 0"的投放列，也避免"仅有点击、花费/展现为 0"时两视图门控不一致。
  const hasPromo = [...beforePromoByP.values(), ...afterPromoByP.values()].some(
    (p) => p.cost + p.impressions > 0
  );
  const cid = state.context.cycle.id;
  const nameById = new Map(
    state.prefillItems.filter((p) => p.cycleId === cid).map((p) => [p.productId, p.productName])
  );
  const ids = new Set<string>([...beforeByP.keys(), ...afterByP.keys()]);
  const bd = beforeDays > 0 ? beforeDays : 1;
  const ad = afterDays > 0 ? afterDays : 1;
  const zero = { paymentAmount: 0, refundAmount: 0, visitors: 0, views: 0, paymentBuyers: 0 };
  const zeroPromo = { cost: 0, clicks: 0, impressions: 0, roiCost: 0 };
  let rows = [...ids].map((pid) => {
    const b = beforeByP.get(pid) ?? zero;
    const a = afterByP.get(pid) ?? zero;
    const pbp = beforePromoByP.get(pid) ?? zeroPromo;
    const pap = afterPromoByP.get(pid) ?? zeroPromo;
    const netBefore = (b.paymentAmount - b.refundAmount) / bd;
    const netAfter = (a.paymentAmount - a.refundAmount) / ad;
    return {
      productId: pid,
      productName: nameById.get(pid) ?? pid,
      netBefore,
      netAfter,
      netDeltaPct: rel(netAfter, netBefore),
      visitorsBefore: b.visitors / bd,
      visitorsAfter: a.visitors / ad,
      convBefore: b.visitors > 0 ? b.paymentBuyers / b.visitors : 0,
      convAfter: a.visitors > 0 ? a.paymentBuyers / a.visitors : 0,
      aovBefore: b.paymentBuyers > 0 ? b.paymentAmount / b.paymentBuyers : 0,
      aovAfter: a.paymentBuyers > 0 ? a.paymentAmount / a.paymentBuyers : 0,
      refundRateBefore: b.paymentAmount > 0 ? b.refundAmount / b.paymentAmount : 0,
      refundRateAfter: a.paymentAmount > 0 ? a.refundAmount / a.paymentAmount : 0,
      adCostBefore: pbp.cost / bd,
      adCostAfter: pap.cost / ad,
      adRoiBefore: pbp.cost > 0 ? pbp.roiCost / pbp.cost : 0,
      adRoiAfter: pap.cost > 0 ? pap.roiCost / pap.cost : 0
    };
  });
  rows.sort((l, r) => r.netAfter - l.netAfter);
  let scope: string;
  if (affected.length > 0) {
    scope = `${affected.length} 个商品`;
  } else {
    const total = rows.length;
    if (total > 30) {
      rows = rows.slice(0, 30);
      scope = `整店 Top30（共 ${total} 个）`;
    } else {
      scope = `整店 ${total} 个商品`;
    }
  }
  return { intervention, window, scope, hasPromo, rows };
}

/** 人群计划视角：受影响主体（整店则全部）的 (计划·人群) 动作前后变化（点击 Top30）。 */
export async function buildAudienceComparison(
  id: string,
  beforeDays = 7,
  afterDays = 7
): Promise<AudienceComparison | null> {
  // 人群对比不读 state → withState=false，跳过 490KB blob 加载。
  const ctxw = await loadInterventionWindow(id, beforeDays, afterDays, false);
  if (!ctxw) {
    return null;
  }
  const { tenantId, scopeIds, window, intervention } = ctxw;
  const [beforeG, afterG] = await Promise.all([
    sumAudienceWindowByGroup(tenantId, scopeIds, window.beforeStart, window.beforeEnd),
    sumAudienceWindowByGroup(tenantId, scopeIds, window.afterStart, window.afterEnd)
  ]);
  const keyOf = (planId: string, audienceName: string, subjectId: string) =>
    `${planId}|||${audienceName}|||${subjectId}`;
  const beforeMap = new Map(beforeG.map((g) => [keyOf(g.planId, g.audienceName, g.subjectId), g]));
  const afterMap = new Map(afterG.map((g) => [keyOf(g.planId, g.audienceName, g.subjectId), g]));
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const bd = beforeDays > 0 ? beforeDays : 1;
  const ad = afterDays > 0 ? afterDays : 1;
  const rows = [...keys]
    .map((k) => {
      const b = beforeMap.get(k);
      const a = afterMap.get(k);
      const ref = a ?? b!;
      const clicksBefore = (b?.clicks ?? 0) / bd;
      const clicksAfter = (a?.clicks ?? 0) / ad;
      return {
        key: k,
        planName: ref.planName ?? ref.planId,
        audienceName: ref.audienceName,
        subjectName: ref.subjectName ?? ref.subjectId,
        clicksBefore,
        clicksAfter,
        clicksDeltaPct: rel(clicksAfter, clicksBefore),
        roiBefore: b && b.clicks > 0 ? b.roiClicks / b.clicks : 0,
        roiAfter: a && a.clicks > 0 ? a.roiClicks / a.clicks : 0,
        guidedBefore: b && b.clicks > 0 ? b.guidedW / b.clicks : 0,
        guidedAfter: a && a.clicks > 0 ? a.guidedW / a.clicks : 0,
        newBefore: b && b.clicks > 0 ? b.newW / b.clicks : 0,
        newAfter: a && a.clicks > 0 ? a.newW / a.clicks : 0
      };
    })
    .sort((l, r) => r.clicksAfter - l.clicksAfter)
    .slice(0, 30);
  return { intervention, window, rows };
}
