import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import {
  gradeRows,
  lifecycleColumns,
  marginMatrix,
  runThreeStageCalculation
} from "@/lib/algorithm/three-stage";
import { Prisma } from "@prisma/client";
import { hashPassword } from "@/lib/accounts";
import {
  assessComparisonWindow,
  canConcludeComparison
} from "@/lib/comparison-window";
import {
  buildDashboardShareCalcRun,
  DASHBOARD_SHARE_SECTION_LABELS,
  DASHBOARD_SHARE_SECTIONS,
  normalizeDashboardShareSections
} from "@/lib/dashboard-share";
import type { BusinessDiagnosisSource } from "@/lib/business-diagnosis";
import { prisma } from "@/lib/db";
import {
  getDmpAutomationAccessForUserIds,
  NO_DMP_AUTOMATION_ACCESS
} from "@/lib/tool-entitlements";
import { resolveAiEncryptionKeySource } from "@/lib/ai-encryption-key";
import {
  DEFAULT_AI_PROVIDER,
  isAiProvider,
  resolveAiProviderBaseUrl,
  resolveAiProviderModel
} from "@/lib/ai-provider-catalog";
import { isPrefillReady } from "@/lib/prefill-status";
import { countInclusiveDays, resolveAnalysisPeriod } from "@/lib/analysis-period";
import { getActiveShopCookie, getServerSession } from "@/lib/session-server";
import {
  mapAudienceDailyRows,
  inferImportDate,
  mapImportedRows,
  mapProductDailyRows,
  mapPromotionDailyRows,
  type DailyAudienceMetricInput,
  type DailyProductMetricInput,
  type DailyPromotionMetricInput,
  type MappedSourceRows
} from "@/lib/imports/map-rows";
import { validateMappedImportRows } from "@/lib/imports/daily-dto";
import {
  addDays,
  aggregateAudienceForCycle,
  aggregateProductForCycle,
  aggregatePromotionForCycle,
  analyzeDailyTable,
  clearAllDailyMetrics,
  countAudienceWindowDays,
  countProductWindowDays,
  countProductWindowDaysByProduct,
  countPromotionWindowDays,
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
import { divideOrNull } from "@/lib/safe-math";
import { metricChange } from "@/lib/metric-change";
import {
  CALC_RUN_SCHEMA_VERSION,
  normalizeAudiencePlans,
  normalizeBreakthroughResults,
  normalizeCalcRun,
  normalizeDashboardShareSnapshot,
  normalizeInvestmentResults,
  normalizeManagementDashboard
} from "@/lib/calc-run-normalization";
import type {
  AnalysisCycle,
  AiApiConfigPublic,
  AiProvider,
  AudienceComparison,
  AudiencePlanItem,
  CalcRun,
  ComparisonMetric,
  ComparisonWindow,
  DailyTrendPoint,
  FunnelChainStep,
  FunnelStage,
  DamoProductRow,
  DashboardShareInfo,
  DashboardShareSection,
  DashboardShareSnapshot,
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
  ManagementHistoryRecord,
  ManagementHistoryReport,
  ManagementHistoryRetention,
  ManagementHistoryState,
  ManagedUser,
  PrefillItem,
  ProductTag,
  ProductSourceRow,
  ProfitMarginMatrix,
  ReportType,
  Shop,
  ShopSummary,
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
  productTags: ProductTag[];
  growthProfitConfig: GrowthProfitConfigRow[];
  // calcRun 已外置到独立 CalcRun 表（见 calcRunUpsertOp/getLatestCalcRun），不再随 blob 反复读写。
  versions: VersionSnapshot[];
  historyRecords: ManagementHistoryRecord[];
  historyReports: ManagementHistoryReport[];
  historyRetention: ManagementHistoryRetention;
  dailyRetentionDays?: number; // 分日明细保留天数（相对最新日期）；缺省视为 365，<=0 永久
  /** 业务诊断看板专用源表：本店类目月度数据 + 市场大盘数据，按当前店铺隔离。 */
  businessDiagnosisSource?: BusinessDiagnosisSource;
  /** AI API Key 配置：按当前店铺隔离，Key 加密保存，读取接口不回显明文。 */
  aiApiConfig?: StoredAiApiConfig;
}

export const DEFAULT_DAILY_RETENTION_DAYS = 365;
export const TENANT_SHOP_LIMIT = 5;

const initialGrowthProfitConfig = matrixToGrowthProfitConfig(marginMatrix);
const DEFAULT_AI_API_CONFIG: Pick<AiApiConfigPublic, "provider" | "baseUrl" | "model" | "enabled"> = {
  provider: DEFAULT_AI_PROVIDER,
  baseUrl: resolveAiProviderBaseUrl(DEFAULT_AI_PROVIDER, ""),
  model: resolveAiProviderModel(
    DEFAULT_AI_PROVIDER,
    "",
    resolveAiProviderBaseUrl(DEFAULT_AI_PROVIDER, "")
  ),
  enabled: false
};

const DEV_ENCRYPTION_FALLBACK = "sanjie-dev-insecure-secret-change-me";

interface StoredAiApiConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  enabled: boolean;
  encryptedApiKey?: string;
  apiKeyHint?: string;
  updatedAt: string;
  updatedBy: string;
}

function shareKey() {
  const dedicated = process.env.SHARE_ENCRYPTION_KEY?.trim() ?? "";
  const sessionSecret = process.env.SESSION_SECRET?.trim() ?? "";
  if (
    process.env.NODE_ENV === "production" &&
    (dedicated.length < 32 ||
      dedicated.toLowerCase().startsWith("change-me-") ||
      dedicated === DEV_ENCRYPTION_FALLBACK ||
      dedicated === sessionSecret)
  ) {
    throw new Error("SHARE_ENCRYPTION_KEY 未安全配置：生产环境必须使用独立的高强度随机值。");
  }
  return createHash("sha256").update(dedicated || sessionSecret || DEV_ENCRYPTION_FALLBACK).digest();
}

function aiKey() {
  return createHash("sha256").update(resolveAiEncryptionKeySource()).digest();
}

function hashShareToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function encryptSharePayload(payload: DashboardShareSnapshot): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", shareKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptSharePayload(value: string): DashboardShareSnapshot | null {
  const [ivB64, tagB64, dataB64] = value.split(".");
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", shareKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final()
    ]).toString("utf8");
    return normalizeDashboardShareSnapshot(JSON.parse(decrypted));
  } catch {
    return null;
  }
}

function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aiKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptSecret(value: string): string | null {
  const [ivB64, tagB64, dataB64] = value.split(".");
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", aiKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function defaultShopId(tenantId: string) {
  return `shop-${tenantId}`;
}

function defaultCycleId(shopId: string) {
  return `cycle-${shopId}`;
}

function normalizePlatform(value: string): Shop["platform"] {
  return value === "天猫" || value === "其他" ? value : "淘宝";
}

function toDomainShop(row: {
  id: string;
  tenantId: string;
  name: string;
  platform: string;
  createdAt: Date;
  updatedAt: Date;
}): ShopSummary {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    platform: normalizePlatform(row.platform),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

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
  return normalizeManagementDashboard(value);
}

/** 三阶计算结果写独立 ShopCalcRun 表的 upsert 操作（可放进 $transaction 与 blob 同事务原子写）。 */
function calcRunPayload(tenantId: string, run: CalcRun) {
  return {
    tenantId,
    runId: run.id,
    cycleId: run.cycleId,
    createdAt: run.createdAt,
    schemaVersion: CALC_RUN_SCHEMA_VERSION,
    investmentResults: asJson(run.investmentResults),
    breakthroughResults: asJson(run.breakthroughResults),
    audiencePlans: asJson(run.audiencePlans),
    managementDashboard: asJson(run.managementDashboard)
  };
}

function calcRunUpsertOp(tenantId: string, shopId: string, run: CalcRun) {
  const payload = calcRunPayload(tenantId, run);
  const updatePayload = {
    runId: payload.runId,
    cycleId: payload.cycleId,
    createdAt: payload.createdAt,
    schemaVersion: payload.schemaVersion,
    investmentResults: payload.investmentResults,
    breakthroughResults: payload.breakthroughResults,
    audiencePlans: payload.audiencePlans,
    managementDashboard: payload.managementDashboard
  };
  return prisma.shopCalcRun.upsert({
    where: { shopId },
    update: updatePayload,
    create: { shopId, ...payload }
  });
}

/** 读全量 CalcRun（请求级缓存）；无行返回空结果。供 admin/完整消费方使用。 */
const loadCalcRunFull = cache(async (tenantId: string, shopId: string): Promise<CalcRun> => {
  const row = await prisma.shopCalcRun.findFirst({ where: { tenantId, shopId } });
  if (!row) {
    return EMPTY_CALC_RUN;
  }
  return normalizeCalcRun({
    schemaVersion: row.schemaVersion,
    id: row.runId,
    cycleId: row.cycleId,
    createdAt: row.createdAt,
    ...(safeDashboard(row.managementDashboard).analysisPeriod
      ? { analysisPeriod: safeDashboard(row.managementDashboard).analysisPeriod }
      : {}),
    investmentResults: row.investmentResults,
    breakthroughResults: row.breakthroughResults,
    audiencePlans: row.audiencePlans,
    managementDashboard: safeDashboard(row.managementDashboard)
  });
});

/** 管理看板切片：只取 dashboard + investmentResults（跳过 ~96% 体积的 audiencePlans 列）。 */
export const getManagementData = cache(
  async (): Promise<{ managementDashboard: ManagementDashboard; investmentResults: ProductInvestmentResult[] }> => {
    const { tenantId, shopId } = await requireShopScope();
    const row = await prisma.shopCalcRun.findFirst({
      where: { tenantId, shopId },
      select: { managementDashboard: true, investmentResults: true }
    });
    if (!row) {
      return { managementDashboard: EMPTY_CALC_RUN.managementDashboard, investmentResults: [] };
    }
    return {
      managementDashboard: safeDashboard(row.managementDashboard),
      investmentResults: normalizeInvestmentResults(row.investmentResults)
    };
  }
);

/** 单品突破切片：只取 breakthroughResults。 */
export const getBreakthroughResults = cache(async (): Promise<ProductBreakthroughResult[]> => {
  const { tenantId, shopId } = await requireShopScope();
  const row = await prisma.shopCalcRun.findFirst({
    where: { tenantId, shopId },
    select: { breakthroughResults: true }
  });
  return normalizeBreakthroughResults(row?.breakthroughResults);
});

/** 人群计划切片：只取 audiencePlans（最大的一段）。 */
export const getAudiencePlans = cache(async (minClicks = 0): Promise<AudiencePlanItem[]> => {
  const { tenantId, shopId } = await requireShopScope();
  const row = await prisma.shopCalcRun.findFirst({
    where: { tenantId, shopId },
    select: { audiencePlans: true }
  });
  const all = normalizeAudiencePlans(row?.audiencePlans);
  // minClicks>0：服务端按点击门槛裁剪，人群计划页首屏 RSC 只传达阈值的计划（列以低点击噪声为主，
  // 默认门槛下省 ~86% 传输/反序列化）；需要全量时前端按钮拉 /api/dashboards/audience-plan。
  return minClicks > 0 ? all.filter((plan) => (plan.clicks ?? 0) >= minClicks) : all;
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
    productTags: [],
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

function normalizeTagName(name: unknown): string {
  return typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 24) : "";
}

function normalizeTagId(id: unknown, index: number): string {
  const raw = typeof id === "string" ? id.trim() : "";
  return /^[a-zA-Z0-9_-]{3,80}$/.test(raw) ? raw : `tag-${Date.now()}-${index}`;
}

function normalizeProductTags(tags: unknown): ProductTag[] {
  if (!Array.isArray(tags)) return [];
  const now = new Date().toISOString();
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const result: ProductTag[] = [];
  for (const [index, raw] of tags.entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const tag = raw as Partial<ProductTag>;
    const name = normalizeTagName(tag.name);
    const nameKey = name.toLowerCase();
    if (!name || seenNames.has(nameKey)) continue;
    let id = normalizeTagId(tag.id, index);
    while (seenIds.has(id)) {
      id = `tag-${Date.now()}-${index}-${seenIds.size}`;
    }
    seenIds.add(id);
    seenNames.add(nameKey);
    result.push({
      id,
      name,
      createdAt: typeof tag.createdAt === "string" && tag.createdAt ? tag.createdAt : now
    });
  }
  return result.slice(0, 80);
}

function normalizeAiProvider(value: unknown): AiProvider {
  return isAiProvider(value) ? value : DEFAULT_AI_PROVIDER;
}

function normalizeAiBaseUrl(value: unknown, provider: AiProvider): string {
  return resolveAiProviderBaseUrl(provider, value);
}

function normalizeAiModel(value: unknown, provider: AiProvider, baseUrl: string): string {
  return resolveAiProviderModel(provider, value, baseUrl);
}

function normalizeStoredAiApiConfig(config: unknown): StoredAiApiConfig | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const raw = config as Partial<StoredAiApiConfig>;
  const provider = normalizeAiProvider(raw.provider);
  const baseUrl = normalizeAiBaseUrl(raw.baseUrl, provider);
  return {
    provider,
    baseUrl,
    model: normalizeAiModel(raw.model, provider, baseUrl),
    enabled: Boolean(raw.enabled),
    encryptedApiKey: typeof raw.encryptedApiKey === "string" ? raw.encryptedApiKey : undefined,
    apiKeyHint: typeof raw.apiKeyHint === "string" ? raw.apiKeyHint : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : ""
  };
}

function toPublicAiApiConfig(config?: StoredAiApiConfig): AiApiConfigPublic {
  const provider = config?.provider ?? DEFAULT_AI_API_CONFIG.provider;
  const hasApiKey = Boolean(config?.encryptedApiKey);
  return {
    provider,
    baseUrl: config?.baseUrl ?? resolveAiProviderBaseUrl(provider, ""),
    model: config?.model ?? resolveAiProviderModel(provider, "", resolveAiProviderBaseUrl(provider, "")),
    enabled: config?.enabled ?? DEFAULT_AI_API_CONFIG.enabled,
    hasApiKey,
    // 公开状态只说明 Key 是否存在，不暴露尾号或保存人给可运行诊断的低权限角色。
    apiKeyHint: hasApiKey ? "已保存" : "",
    updatedAt: config?.updatedAt ?? "",
    updatedBy: ""
  };
}

function apiKeyHint(apiKey: string): string {
  const tail = apiKey.trim().slice(-4);
  return tail ? `•••• ${tail}` : "已保存";
}

function normalizeTagIds(ids: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(ids)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeWorkspaceData(data: WorkspaceData, context: WorkspaceContext): WorkspaceData {
  const productTags = normalizeProductTags(data.productTags);
  const allowed = new Set(productTags.map((tag) => tag.id));
  const prefillItems = Array.isArray(data.prefillItems)
    ? data.prefillItems.map((item) => ({
        ...item,
        tagIds: normalizeTagIds(item.tagIds, allowed)
      }))
    : [];
  return {
    ...data,
    context,
    prefillItems,
    productTags,
    aiApiConfig: normalizeStoredAiApiConfig(data.aiApiConfig)
  };
}

/** 由租户/店铺行派生默认上下文（cycle 以 shopId 派生，保证店铺隔离）。 */
function defaultContextFor(tenant: Tenant, user: User, shop: Shop): WorkspaceContext {
  const cycle: AnalysisCycle = {
    id: defaultCycleId(shop.id),
    tenantId: tenant.id,
    shopId: shop.id,
    name: "当前分析周期",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    status: "draft"
  };
  return { tenant, user, shop, cycle };
}

function userDomainFrom(row: {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: string;
} | null | undefined, fallback: { tenantId: string; name?: string; username?: string }): User {
  return {
    id: row?.id ?? `user-${fallback.tenantId}`,
    tenantId: fallback.tenantId,
    name: row?.name ?? fallback.name ?? fallback.username ?? "运营负责人",
    email: row?.email ?? "",
    role: (row?.role as User["role"]) ?? "operator"
  };
}

function shopDomainFrom(row: { id: string; tenantId: string; name: string; platform: string }): Shop {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    platform: normalizePlatform(row.platform)
  };
}

interface ShopScope {
  tenantId: string;
  shopId: string;
  tenant: Tenant;
  user: User;
  shop: Shop;
  cycle: AnalysisCycle;
  isAdmin: boolean;
}

async function ensureDefaultShop(input: {
  tenant: Tenant;
  user: User;
}): Promise<{ id: string; tenantId: string; name: string; platform: string; createdBy: string; createdAt: Date; updatedAt: Date }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop-default:${input.tenant.id}`}))`;
    const row = await tx.shop.upsert({
      where: { id: defaultShopId(input.tenant.id) },
      update: {},
      create: {
        id: defaultShopId(input.tenant.id),
        tenantId: input.tenant.id,
        name: input.tenant.name,
        platform: "淘宝",
        createdBy: input.user.name
      }
    });
    const [workspace, legacyWorkspace, calcRun, legacyCalcRun] = await Promise.all([
      tx.shopWorkspace.findFirst({ where: { tenantId: input.tenant.id, shopId: row.id } }),
      tx.workspace.findUnique({ where: { tenantId: input.tenant.id } }),
      tx.shopCalcRun.findFirst({ where: { tenantId: input.tenant.id, shopId: row.id } }),
      tx.calcRun.findUnique({ where: { tenantId: input.tenant.id } })
    ]);
    const shop = shopDomainFrom(row);
    const context = defaultContextFor(input.tenant, input.user, shop);
    if (!workspace && !legacyWorkspace) {
      await tx.shopWorkspace.create({
        data: {
          tenantId: input.tenant.id,
          shopId: row.id,
          data: buildInitialWorkspaceData(context) as unknown as Prisma.InputJsonValue
        }
      });
    }
    if (!calcRun) {
      await tx.shopCalcRun.create({
        data: legacyCalcRun
          ? {
              tenantId: input.tenant.id,
              shopId: row.id,
              runId: legacyCalcRun.runId,
              cycleId: legacyCalcRun.cycleId,
              createdAt: legacyCalcRun.createdAt,
              investmentResults: asJson(legacyCalcRun.investmentResults),
              breakthroughResults: asJson(legacyCalcRun.breakthroughResults),
              audiencePlans: asJson(legacyCalcRun.audiencePlans),
              managementDashboard: asJson(legacyCalcRun.managementDashboard)
            }
          : {
              shopId: row.id,
              ...calcRunPayload(input.tenant.id, EMPTY_CALC_RUN)
            }
      });
    }
    return row;
  });
}

const getShopScope = cache(async (): Promise<ShopScope> => {
  const session = await getServerSession();
  if (!session) {
    throw new Error("未登录或会话已失效");
  }
  const [tenantRow, userRow, activeShopId] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: session.tenantId } }),
    prisma.user.findUnique({ where: { username: session.username } }),
    getActiveShopCookie()
  ]);
  const databaseRole = userRow?.authRole === "admin" ? "admin" : "tenant";
  if (
    !userRow ||
    userRow.status === "disabled" ||
    userRow.tenantId !== session.tenantId ||
    databaseRole !== session.role
  ) {
    throw new Error("账号或租户归属已变更，请退出后重新登录");
  }
  const tenant: Tenant = {
    id: session.tenantId,
    name: tenantRow?.name ?? "租户",
    slug: tenantRow?.slug ?? session.tenantId
  };
  const user = userDomainFrom(userRow, session);
  let shops = await prisma.shop.findMany({
    where: { tenantId: session.tenantId },
    orderBy: { createdAt: "asc" }
  });
  if (shops.length === 0) {
    shops = [await ensureDefaultShop({ tenant, user })];
  }
  const selected = shops.find((shop) => shop.id === activeShopId) ?? shops[0];
  const shop = shopDomainFrom(selected);
  const cycle: AnalysisCycle = {
    id: defaultCycleId(shop.id),
    tenantId: tenant.id,
    shopId: shop.id,
    name: "当前分析周期",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    status: "draft"
  };
  return {
    tenantId: tenant.id,
    shopId: shop.id,
    tenant,
    user,
    shop,
    cycle,
    isAdmin: session.role === "admin"
  };
});

export async function requireShopScope(): Promise<ShopScope> {
  return getShopScope();
}

async function currentActorName(): Promise<string> {
  const session = await getServerSession();
  return session?.name ?? session?.username ?? "系统";
}

function contextFromScope(scope: ShopScope): WorkspaceContext {
  return {
    tenant: scope.tenant,
    user: scope.user,
    shop: scope.shop,
    cycle: scope.cycle
  };
}

// ——————————————————————————————————————————————————————————————
// 工作区读写：每次请求从 DB 读取 → 内存内复用既有领域逻辑 → 写回 DB。
// ——————————————————————————————————————————————————————————————

/**
 * 加载某店铺的工作区 blob（~490KB JSON）。用 React cache() 做请求级 memo：
 * 同一请求内多次 ctx() 只反序列化一次，跨请求/跨租户不共享（cache 作用域=单次 server 请求）。
 * 写语义不受影响：每个 mutation 是「一次 ctx()→改同一 state 引用→saveWorkspace」，函数内只读一次。
 */
const loadWorkspace = cache(async (tenantId: string, shopId: string, context: WorkspaceContext): Promise<WorkspaceData> => {
  const row = await prisma.shopWorkspace.findFirst({ where: { tenantId, shopId } });
  if (row) {
    const data = row.data as unknown as WorkspaceData;
    return normalizeWorkspaceData(data, context);
  }
  // 兼容未执行迁移或旧租户的默认店铺：首次访问时把 legacy Workspace 复制进默认店铺。
  if (shopId === defaultShopId(tenantId)) {
    const legacy = await prisma.workspace.findUnique({ where: { tenantId } });
    if (legacy) {
      const data = normalizeWorkspaceData(legacy.data as unknown as WorkspaceData, context);
      await saveWorkspace(tenantId, shopId, data);
      return data;
    }
  }
  const data = buildInitialWorkspaceData(context);
  await saveWorkspace(tenantId, shopId, data);
  return data;
});

/** 写 blob 的 upsert 操作（可放进 $transaction 与 CalcRun 表同事务原子写）。 */
function workspaceUpsertOp(tenantId: string, shopId: string, data: WorkspaceData) {
  const json = data as unknown as Prisma.InputJsonValue;
  return prisma.shopWorkspace.upsert({
    where: { shopId },
    update: { data: json },
    create: { tenantId, shopId, data: json }
  });
}

async function saveWorkspace(tenantId: string, shopId: string, data: WorkspaceData): Promise<void> {
  await workspaceUpsertOp(tenantId, shopId, data);
}

/**
 * 在每租户 advisory lock + 事务内对 blob 做 read-modify-write，序列化同租户并发写——
 * 防并发导入/重试相互覆盖丢失 import 记录与版本留痕。锁内**重新读**（绕过请求级 cache 的旧快照），
 * `pg_advisory_xact_lock` 随事务提交自动释放。
 * 仅包 blob 元数据改动；分日表 upsert / prune 等重活留在锁外（ON CONFLICT 行级安全、独立表），
 * 避免长事务持锁与 5s 交互事务超时。mutate 回调必须同步、只改传入的 state。
 */
async function mutateWorkspaceLocked<T>(
  tenantId: string,
  shopId: string,
  context: WorkspaceContext,
  mutate: (state: WorkspaceData) => T
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${shopId}`}))`;
    const row = await tx.shopWorkspace.findFirst({ where: { tenantId, shopId } });
    const state = row
      ? normalizeWorkspaceData(row.data as unknown as WorkspaceData, context)
      : buildInitialWorkspaceData(context);
    const result = mutate(state);
    await tx.shopWorkspace.upsert({
      where: { shopId },
      update: { data: state as unknown as Prisma.InputJsonValue },
      create: { tenantId, shopId, data: state as unknown as Prisma.InputJsonValue }
    });
    return result;
  });
}

/** 取当前请求租户的工作区（读 cookie → 加载 blob）。 */
async function ctx(): Promise<{ tenantId: string; shopId: string; scope: ShopScope; state: WorkspaceData }> {
  const scope = await requireShopScope();
  const context: WorkspaceContext = {
    tenant: scope.tenant,
    user: scope.user,
    shop: scope.shop,
    cycle: scope.cycle
  };
  const state = await loadWorkspace(scope.tenantId, scope.shopId, context);
  return { tenantId: scope.tenantId, shopId: scope.shopId, scope, state };
}

// ——————————————————————————————————————————————————————————————
// 公开 API（保持原语义，全部改为 async；tenant 由会话内部解析）
// ——————————————————————————————————————————————————————————————

export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const { state } = await ctx();
  return state.context;
}

export async function getAiApiConfig(): Promise<AiApiConfigPublic> {
  const { state } = await ctx();
  return toPublicAiApiConfig(state.aiApiConfig);
}

export async function getAiApiRuntimeConfig(): Promise<(AiApiConfigPublic & { apiKey: string | null })> {
  const { state } = await ctx();
  const publicConfig = toPublicAiApiConfig(state.aiApiConfig);
  return {
    ...publicConfig,
    apiKey: state.aiApiConfig?.encryptedApiKey ? decryptSecret(state.aiApiConfig.encryptedApiKey) : null
  };
}

export async function updateAiApiConfig(input: {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  enabled: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}): Promise<AiApiConfigPublic> {
  const scope = await requireShopScope();
  const actor = await currentActorName();
  const now = new Date().toISOString();
  return mutateWorkspaceLocked(scope.tenantId, scope.shopId, contextFromScope(scope), (state) => {
    const previous = state.aiApiConfig;
    const provider = normalizeAiProvider(input.provider);
    const baseUrl = normalizeAiBaseUrl(input.baseUrl, provider);
    const apiKey = input.apiKey?.trim() ?? "";
    const credentialScopeChanged = Boolean(
      previous &&
        (previous.provider !== provider || normalizeEndpoint(previous.baseUrl) !== normalizeEndpoint(baseUrl))
    );
    const encryptedApiKey = input.clearApiKey
      ? undefined
      : apiKey
        ? encryptSecret(apiKey)
        : credentialScopeChanged
          ? undefined
          : previous?.encryptedApiKey;
    const source: StoredAiApiConfig = {
      provider,
      baseUrl,
      model: normalizeAiModel(input.model, provider, baseUrl),
      enabled: input.enabled && Boolean(encryptedApiKey),
      encryptedApiKey,
      apiKeyHint: input.clearApiKey || credentialScopeChanged
        ? ""
        : apiKey
          ? apiKeyHint(apiKey)
          : previous?.apiKeyHint ?? "",
      updatedAt: now,
      updatedBy: actor
    };
    state.aiApiConfig = source;
    return toPublicAiApiConfig(source);
  });
}

function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export async function getImportBatches(): Promise<ImportBatch[]> {
  const { state } = await ctx();
  return state.imports;
}

export async function getBusinessDiagnosisWorkspaceSource(): Promise<BusinessDiagnosisSource | null> {
  const { state } = await ctx();
  return state.businessDiagnosisSource ?? null;
}

export async function saveBusinessDiagnosisWorkspaceSource(input: {
  storeCategoryRows?: BusinessDiagnosisSource["storeCategoryRows"];
  market?: BusinessDiagnosisSource["market"];
  sourceNote?: string;
  fileNames?: string[];
}): Promise<BusinessDiagnosisSource> {
  const scope = await requireShopScope();
  const { tenantId, shopId } = scope;
  const actor = await currentActorName();
  const now = new Date().toISOString();
  const sizeBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  const sizeError = validateTenantDatasetSize(sizeBytes);
  if (sizeError) {
    throw new ImportRetentionError(sizeError, 413);
  }
  return mutateWorkspaceLocked(tenantId, shopId, contextFromScope(scope), (state) => {
    const base = state.businessDiagnosisSource;
    const source: BusinessDiagnosisSource = {
      generatedAt: now,
      sourceNote:
        input.sourceNote?.trim() ||
        "由数据导入页的业务诊断源表识别与合并模块生成，可继续上传本店类目或市场大盘数据增量更新。",
      storeCategoryRows: input.storeCategoryRows ?? base?.storeCategoryRows ?? [],
      market: input.market ?? base?.market ?? emptyBusinessDiagnosisMarket()
    };
    state.businessDiagnosisSource = source;
    pushVersion(state, {
      id: `version-business-source-${Date.now()}`,
      cycleId: state.context.cycle.id,
      shopId: state.context.shop.id,
      kind: "import",
      title: "业务诊断源表更新",
      createdAt: now,
      createdBy: actor,
      summary: [
        `本店类目 ${source.storeCategoryRows.length} 行`,
        `市场概况 ${source.market.overview.length} 行`,
        `来源文件 ${input.fileNames?.length ?? 0} 个`
      ].join("，")
    });
    return source;
  });
}

function emptyBusinessDiagnosisMarket(): BusinessDiagnosisSource["market"] {
  return {
    overview: [],
    priceBands: [],
    attributeSignals: [],
    searchSignals: []
  };
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
  const { tenantId, shopId, state } = await ctx();
  const range = await getProductDailyDateRange(tenantId, shopId);
  return { range, retentionDays: state.dailyRetentionDays ?? DEFAULT_DAILY_RETENTION_DAYS };
}

/** 设置分日保留天数（0=永久），并立即按新策略清理一次。 */
export async function setDailyRetentionDays(days: number): Promise<number> {
  const { tenantId, shopId, state } = await ctx();
  const clean = Number.isFinite(days) ? Math.max(0, Math.min(3650, Math.round(days))) : DEFAULT_DAILY_RETENTION_DAYS;
  state.dailyRetentionDays = clean;
  await saveWorkspace(tenantId, shopId, state);
  await pruneAllDailyMetrics(tenantId, shopId, clean);
  return 0;
}

export async function clearImportBatches(options?: { keepPrefill?: boolean }): Promise<void> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  const now = new Date().toISOString();
  state.imports = [];
  state.uploadedSources = {};
  // keepPrefill：上传新数据前的"换一批源数据"。保留运营已填的分层/毛利率等参数，
  // 重新上传时按 productId 沿用（满足"多次依照已有数据展示"）。分日表保留累积，靠 upsert 覆盖同日。
  // 不传 keepPrefill：运营主动「清空源数据」，连预填参数和分日明细一并清空，回到从零体验。
  if (!options?.keepPrefill) {
    state.prefillItems = [];
    state.productTags = [];
    await clearAllDailyMetrics(tenantId, shopId);
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
    createdBy: actor,
    summary: "当前店铺源数据已清空，看板同步清空，可上传下一次最新数据。"
  });
  // 计算结果同步清空（写独立 CalcRun 表）。同事务原子写。
  await prisma.$transaction([
    calcRunUpsertOp(tenantId, shopId, EMPTY_CALC_RUN),
    workspaceUpsertOp(tenantId, shopId, state)
  ]);
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
  const scope = await requireShopScope();
  const { tenantId, shopId } = scope;
  const actor = await currentActorName();
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
    rowCount: input.validation.acceptedRowCount ?? input.validation.rowCount,
    createdAt: new Date().toISOString(),
    validation: input.validation
  };

  // 重活：商品/推广/人群分日表 upsert 放 blob 锁外（ON CONFLICT 行级安全、独立表，不碰 blob）。
  // 达摩盘是 blob 快照，留到锁内写。
  let damoSources: ReturnType<typeof mapImportedRows> | null = null;
  let didIngestDaily = false;
  if (input.validation.ok && input.parsedHeaders && input.parsedRows) {
    if (input.reportType === "product_source") {
      const mapped = mapProductDailyRows(input.parsedHeaders, input.parsedRows, inferImportDate(input.fileName));
      const checked = validateMappedImportRows(input.reportType, mapped);
      await upsertDailyProductMetrics(tenantId, shopId, checked.acceptedRows as DailyProductMetricInput[]);
      appendServerValidationIssues(input.validation, checked.rejectedCount, checked.issues);
      didIngestDaily = true;
    } else if (input.reportType === "promotion_product_source") {
      const mapped = mapPromotionDailyRows(input.parsedHeaders, input.parsedRows, inferImportDate(input.fileName));
      const checked = validateMappedImportRows(input.reportType, mapped);
      await upsertDailyPromotionMetrics(tenantId, shopId, checked.acceptedRows as DailyPromotionMetricInput[]);
      appendServerValidationIssues(input.validation, checked.rejectedCount, checked.issues);
      didIngestDaily = true;
    } else if (input.reportType === "audience_source") {
      const mapped = mapAudienceDailyRows(input.parsedHeaders, input.parsedRows, inferImportDate(input.fileName));
      const checked = validateMappedImportRows(input.reportType, mapped);
      await upsertDailyAudienceMetrics(tenantId, shopId, checked.acceptedRows as DailyAudienceMetricInput[]);
      appendServerValidationIssues(input.validation, checked.rejectedCount, checked.issues);
      didIngestDaily = true;
    } else {
      damoSources = mapImportedRows(input.reportType, input.parsedHeaders, input.parsedRows);
      const checked = validateMappedImportRows(
        input.reportType,
        damoSources.damo_product_source ?? []
      );
      damoSources = { damo_product_source: checked.acceptedRows as DamoProductRow[] };
      appendServerValidationIssues(input.validation, checked.rejectedCount, checked.issues);
    }
  }

  // blob 元数据改动放 advisory lock + 事务内（序列化同租户并发导入，防丢 import 记录/版本留痕）。
  const retention = await mutateWorkspaceLocked(tenantId, shopId, contextFromScope(scope), (state) => {
    // 分日合并不参与"单数据集"跟踪（数据在分日表，按日累积），避免改 currentTenantDatasetId 后
    // 让下一次普通上传误触 409 守卫。
    if (!input.skipDatasetGuard) {
      state.currentTenantDatasetId = input.datasetId;
      state.currentTenantDatasetBytes = input.datasetTotalBytes;
    }
    // 每个源类型各留最新一份（与数据集/其它源无关）：上传某类型只替换该类型，其它源保留。
    state.imports = [batch, ...state.imports.filter((item) => item.reportType !== input.reportType)];
    if (damoSources) {
      state.uploadedSources = { ...state.uploadedSources, ...damoSources };
    }
    pushVersion(state, {
      id: `version-import-${Date.now()}`,
      cycleId: input.cycleId,
      shopId: state.context.shop.id,
      kind: "import",
      title: `${input.validation.ok ? "通过" : "失败"}：${input.fileName}`,
      createdAt: batch.createdAt,
      createdBy: actor,
      summary: input.validation.ok
        ? `当前店铺数据集 ${formatMegabytes(input.datasetTotalBytes)}，有效 ${input.validation.acceptedRowCount ?? input.validation.rowCount} 行，隔离 ${input.validation.rejectedRowCount ?? 0} 行，${input.validation.uniqueEntityCount} 个主体。`
        : input.validation.errors.join("；")
    });
    return state.dailyRetentionDays ?? DEFAULT_DAILY_RETENTION_DAYS;
  });
  if (didIngestDaily) {
    await pruneAllDailyMetrics(tenantId, shopId, retention);
    // 大批量写入后刷新该表统计信息，避免后续看板/重算用过期统计选灾难性计划（22s 卡顿根因）。
    await analyzeDailyTable(input.reportType);
  }
  return batch;
}

function appendServerValidationIssues(
  validation: ImportValidationResult,
  rejectedCount: number,
  issues: string[]
) {
  if (rejectedCount <= 0) return;
  validation.rejectedRowCount = (validation.rejectedRowCount ?? 0) + rejectedCount;
  validation.acceptedRowCount = Math.max(0, (validation.acceptedRowCount ?? validation.rowCount) - rejectedCount);
  validation.warnings = [
    ...validation.warnings,
    `服务端二次校验隔离 ${rejectedCount} 行，其余有效行继续入库`,
    ...issues
  ];
}

/**
 * 分批导入（大文件）：浏览器端已解析+映射成分日行，这里只把一批 upsert 到对应日表。
 * 不建记录、不重算（由 finalizeImportBatch 收尾），可被调用很多次（每批一次）。
 */
export async function ingestDailyRows(
  reportType: ReportType,
  rows: unknown[]
): Promise<{ acceptedCount: number; rejectedCount: number; issues: string[] }> {
  const { tenantId, shopId } = await requireShopScope();
  const validation = validateMappedImportRows(reportType, rows);
  const accepted = validation.acceptedRows;
  let acceptedCount = 0;
  if (reportType === "product_source") {
    acceptedCount = await upsertDailyProductMetrics(tenantId, shopId, accepted as DailyProductMetricInput[]);
  }
  if (reportType === "promotion_product_source") {
    acceptedCount = await upsertDailyPromotionMetrics(tenantId, shopId, accepted as DailyPromotionMetricInput[]);
  }
  if (reportType === "audience_source") {
    acceptedCount = await upsertDailyAudienceMetrics(tenantId, shopId, accepted as DailyAudienceMetricInput[]);
  }
  return {
    acceptedCount,
    rejectedCount: validation.rejectedCount,
    issues: validation.issues
  };
}

/**
 * 分批导入收尾：分日行已 ingest 完，这里建 ImportBatch 记录 + 体积守卫的数据集跟踪 + 保留清理 + 版本留痕。
 * 达摩盘无日期 → 走快照存 blob（damoSourceRows，全量一批传来）。每个源类型各留最新一份。
 */
export async function finalizeImportBatch(input: {
  cycleId: string;
  datasetId: string;
  datasetTotalBytes: number;
  reportType: ReportType;
  fileName: string;
  fileSizeBytes: number;
  validation: ImportValidationResult;
  /** 实际入库的映射行数（人群/推广会把多原始行并成更少键）；缺省回落识别行数。 */
  ingestedRowCount?: number;
  damoSourceRows?: DamoProductRow[];
}): Promise<ImportBatch> {
  const scope = await requireShopScope();
  const { tenantId, shopId } = scope;
  const actor = await currentActorName();
  const batch: ImportBatch = {
    id: `import-${input.reportType}-${Date.now()}`,
    cycleId: input.cycleId,
    datasetId: input.datasetId,
    reportType: input.reportType,
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes,
    status: input.validation.ok ? "validated" : "failed",
    rowCount: input.ingestedRowCount ?? input.validation.rowCount,
    createdAt: new Date().toISOString(),
    validation: input.validation
  };
  // blob 元数据改动放 advisory lock + 事务内（序列化同租户并发导入，防丢 import 记录/版本留痕）。
  const retention = await mutateWorkspaceLocked(tenantId, shopId, contextFromScope(scope), (state) => {
    state.currentTenantDatasetId = input.datasetId;
    state.currentTenantDatasetBytes = input.datasetTotalBytes;
    state.imports = [batch, ...state.imports.filter((item) => item.reportType !== input.reportType)];
    // 达摩盘快照入 blob（无日期，不进分日表）；仅校验通过才覆盖，避免坏数据冲掉既有快照。
    if (input.reportType === "damo_product_source" && input.validation.ok && input.damoSourceRows) {
      state.uploadedSources = {
        ...state.uploadedSources,
        damo_product_source: input.damoSourceRows
      };
    }
    pushVersion(state, {
      id: `version-import-${Date.now()}`,
      cycleId: input.cycleId,
      shopId: state.context.shop.id,
      kind: "import",
      title: `${input.validation.ok ? "通过" : "失败"}：${input.fileName}`,
      createdAt: batch.createdAt,
      createdBy: actor,
      summary: input.validation.ok
        ? `识别 ${input.validation.rowCount} 行，${input.validation.uniqueEntityCount} 个主体（分批上传）。`
        : input.validation.errors.join("；")
    });
    return state.dailyRetentionDays ?? DEFAULT_DAILY_RETENTION_DAYS;
  });
  // 分日行已 ingest 入库；按保留策略清理一次放锁外（独立表、删除幂等，不必持 blob 锁）。
  if (input.reportType !== "damo_product_source" && input.validation.ok) {
    await pruneAllDailyMetrics(tenantId, shopId, retention);
    // 大批量写入后刷新该表统计信息，避免后续看板/重算用过期统计选灾难性计划（22s 卡顿根因）。
    await analyzeDailyTable(input.reportType);
  }
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

export async function getProductTags(): Promise<ProductTag[]> {
  const { state } = await ctx();
  return [...state.productTags].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export async function getGrowthProfitConfig(): Promise<GrowthProfitConfigRow[]> {
  const { state } = await ctx();
  return cloneGrowthProfitConfig(state.growthProfitConfig);
}

export async function updateGrowthProfitConfig(
  cycleId: string,
  rows: GrowthProfitConfigRow[]
): Promise<GrowthProfitConfigRow[]> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  state.growthProfitConfig = normalizeGrowthProfitConfig(rows);
  pushVersion(state, {
    id: `version-profit-config-${Date.now()}`,
    cycleId,
    shopId: state.context.shop.id,
    kind: "profit_config",
    title: "V9 增长利润配置更新",
    createdAt: new Date().toISOString(),
    createdBy: actor,
    summary: "更新 SAB 分层与生命周期对应的增长利润率矩阵。"
  });
  await saveWorkspace(tenantId, shopId, state);
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
  "imageUrl",
  "tagIds"
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
  items: PrefillItem[],
  tags?: ProductTag[]
): Promise<PrefillItem[]> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  if (tags) {
    state.productTags = normalizeProductTags(tags);
  }
  const allowedTags = new Set(state.productTags.map((tag) => tag.id));
  const byId = new Map(items.map((item) => [item.id, item]));
  state.prefillItems = state.prefillItems.map((item) =>
    item.cycleId === cycleId && byId.has(item.id)
      ? {
          ...item,
          ...pickEditablePrefillFields(byId.get(item.id)!),
          tagIds: normalizeTagIds(byId.get(item.id)!.tagIds, allowedTags)
        }
      : item
  );
  pushVersion(state, {
    id: `version-prefill-${Date.now()}`,
    cycleId,
    shopId: state.context.shop.id,
    kind: "prefill",
    title: "预填写参数更新",
    createdAt: new Date().toISOString(),
    createdBy: actor,
    summary: `更新 ${items.length} 个商品的分层、GSV、毛利、标签或付费访客参数。`
  });
  const result = state.prefillItems.filter((item) => item.cycleId === cycleId);
  await saveWorkspace(tenantId, shopId, state);
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
      tagIds: prev?.tagIds ?? [],
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
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  if (cycleId && cycleId !== state.context.cycle.id) {
    throw new Error("分析周期不存在或不属于当前店铺");
  }
  const cid = cycleId ?? state.context.cycle.id;
  const analysisRange = resolveAnalysisPeriod(state.context.cycle, state.imports);
  // 商品/推广/人群走 v2 分日表 → 周期聚合；达摩盘是快照仍读 blob。
  const [
    productSourceRows,
    promotionProductRows,
    audienceSourceRows,
    productObservedDays,
    promotionObservedDays,
    audienceObservedDays
  ] = await Promise.all([
    aggregateProductForCycle(tenantId, shopId, analysisRange),
    aggregatePromotionForCycle(tenantId, shopId, analysisRange),
    aggregateAudienceForCycle(tenantId, shopId, analysisRange),
    countProductWindowDays(tenantId, shopId, null, analysisRange.start, analysisRange.end),
    // 以店铺层的全部已入库推广分日数据判断覆盖，不再要求每个商品每天都有推广记录。
    countPromotionWindowDays(tenantId, shopId, null, analysisRange.start, analysisRange.end),
    countAudienceWindowDays(tenantId, shopId, null, analysisRange.start, analysisRange.end)
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
    marginMatrix: growthProfitConfigToMarginMatrix(state.growthProfitConfig),
    analysisPeriod: { start: analysisRange.start, end: analysisRange.end },
    promotionSourceWindowComplete:
      promotionObservedDays === countInclusiveDays(analysisRange.start, analysisRange.end),
    sourceObservedDays: {
      product: productObservedDays,
      promotion: promotionObservedDays,
      audience: audienceObservedDays
    }
  });
  pushVersion(state, {
    id: `version-calc-${Date.now()}`,
    cycleId: cid,
    shopId: state.context.shop.id,
    kind: "calculation",
    title: "三阶评估算法重新运行",
    createdAt: run.createdAt,
    createdBy: actor,
    summary: `生成 ${run.investmentResults.length} 个商品结果和 ${run.audiencePlans.length} 条人群计划。`
  });
  // calcRun 写独立表；blob 只存 prefill 派生 + 版本留痕（小）。同事务原子写，避免半写不一致。
  await prisma.$transaction([calcRunUpsertOp(tenantId, shopId, run), workspaceUpsertOp(tenantId, shopId, state)]);
  return run;
}

export async function getLatestCalcRun(): Promise<CalcRun> {
  const { tenantId, shopId } = await requireShopScope();
  return loadCalcRunFull(tenantId, shopId);
}

/** 整店分日趋势（覆盖全部已有分日数据区间），供管理看板 KPI「分日趋势」视图。无数据返回 null。 */
export async function getStoreDailyTrend(scopeProductIds?: string[]): Promise<{
  series: DailyTrendPoint[];
  start: string;
  end: string;
} | null> {
  // 只需 tenantId/shopId（来自 cookie），不读 490KB blob。
  const { tenantId, shopId } = await requireShopScope();
  const range = await getProductDailyDateRange(tenantId, shopId);
  if (!range) {
    return null;
  }
  const series = await buildDailyTrendSeries(
    tenantId,
    shopId,
    range.start,
    range.end,
    scopeProductIds && scopeProductIds.length > 0 ? scopeProductIds : null
  );
  return { series, start: range.start, end: range.end };
}

export async function getShopSwitcherData(): Promise<{
  shops: ShopSummary[];
  activeShopId: string;
  limit: number | null;
  canCreate: boolean;
  isAdmin: boolean;
}> {
  const scope = await requireShopScope();
  const rows = await prisma.shop.findMany({
    where: { tenantId: scope.tenantId },
    orderBy: { createdAt: "asc" }
  });
  const shops = rows.map(toDomainShop);
  const limit = scope.isAdmin ? null : TENANT_SHOP_LIMIT;
  return {
    shops,
    activeShopId: scope.shopId,
    limit,
    canCreate: scope.isAdmin || shops.length < TENANT_SHOP_LIMIT,
    isAdmin: scope.isAdmin
  };
}

export async function validateShopForCurrentTenant(shopId: string): Promise<ShopSummary | null> {
  const { tenantId } = await requireShopScope();
  const row = await prisma.shop.findFirst({ where: { id: shopId, tenantId } });
  return row ? toDomainShop(row) : null;
}

export async function createShop(input: {
  name: string;
  platform?: string;
}): Promise<{ ok: true; shop: ShopSummary } | { ok: false; error: string; status: number }> {
  const scope = await requireShopScope();
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) {
    return { ok: false, error: "店铺名称需为 1 到 40 个字符", status: 400 };
  }
  const actor = await currentActorName();
  const platform = normalizePlatform(input.platform ?? "淘宝");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop-limit:${scope.tenantId}`}))`;
    const count = await tx.shop.count({ where: { tenantId: scope.tenantId } });
    if (!scope.isAdmin && count >= TENANT_SHOP_LIMIT) {
      return { ok: false, error: `租户账号最多可管理 ${TENANT_SHOP_LIMIT} 个店铺`, status: 403 };
    }

    const row = await tx.shop.create({
      data: {
        id: `shop-${randomBytes(8).toString("hex")}`,
        tenantId: scope.tenantId,
        name,
        platform,
        createdBy: actor
      }
    });
    const shop = shopDomainFrom(row);
    const context = defaultContextFor(scope.tenant, scope.user, shop);
    const data = buildInitialWorkspaceData(context);
    await tx.shopWorkspace.create({
      data: {
        tenantId: scope.tenantId,
        shopId: shop.id,
        data: data as unknown as Prisma.InputJsonValue
      }
    });
    await tx.shopCalcRun.create({
      data: {
        shopId: shop.id,
        ...calcRunPayload(scope.tenantId, EMPTY_CALC_RUN)
      }
    });

    return { ok: true, shop: toDomainShop(row) };
  });
}

export async function updateShop(input: {
  shopId: string;
  name: string;
  platform?: string;
}): Promise<{ ok: true; shop: ShopSummary } | { ok: false; error: string; status: number }> {
  const scope = await requireShopScope();
  const shopId = input.shopId.trim();
  const name = input.name.trim();
  if (!shopId) {
    return { ok: false, error: "店铺不存在", status: 404 };
  }
  if (name.length < 1 || name.length > 40) {
    return { ok: false, error: "店铺名称需为 1 到 40 个字符", status: 400 };
  }
  const existing = await prisma.shop.findFirst({
    where: { id: shopId, tenantId: scope.tenantId }
  });
  if (!existing) {
    return { ok: false, error: "店铺不存在", status: 404 };
  }
  const row = await prisma.shop.update({
    where: { id: existing.id },
    data: {
      name,
      ...(input.platform ? { platform: normalizePlatform(input.platform) } : {})
    }
  });
  return { ok: true, shop: toDomainShop(row) };
}

export async function deleteShop(
  rawShopId: string
): Promise<
  | { ok: true; deletedShopId: string; activeShopId: string; shops: ShopSummary[] }
  | { ok: false; error: string; status: number }
> {
  const scope = await requireShopScope();
  const shopId = rawShopId.trim();
  if (!shopId) {
    return { ok: false, error: "店铺不存在", status: 404 };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop-delete:${scope.tenantId}`}))`;
    const shop = await tx.shop.findFirst({
      where: { id: shopId, tenantId: scope.tenantId }
    });
    if (!shop) {
      return { ok: false, error: "店铺不存在", status: 404 };
    }
    const count = await tx.shop.count({ where: { tenantId: scope.tenantId } });
    if (count <= 1) {
      return { ok: false, error: "至少保留 1 个店铺", status: 400 };
    }
    const fallback = await tx.shop.findFirst({
      where: { tenantId: scope.tenantId, id: { not: shopId } },
      orderBy: { createdAt: "asc" }
    });
    await Promise.all([
      tx.dailyProductMetric.deleteMany({ where: { tenantId: scope.tenantId, shopId } }),
      tx.dailyPromotionMetric.deleteMany({ where: { tenantId: scope.tenantId, shopId } }),
      tx.dailyAudienceMetric.deleteMany({ where: { tenantId: scope.tenantId, shopId } }),
      tx.intervention.deleteMany({ where: { tenantId: scope.tenantId, shopId } })
    ]);
    await tx.shop.delete({ where: { id: shopId } });
    const rows = await tx.shop.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { createdAt: "asc" }
    });
    const activeShopId = fallback?.id ?? rows[0]?.id;
    if (!activeShopId) {
      return { ok: false, error: "删除后没有可用店铺", status: 500 };
    }
    return {
      ok: true,
      deletedShopId: shopId,
      activeShopId,
      shops: rows.map(toDomainShop)
    };
  });
}

export async function createDashboardShare(input?: {
  sections?: DashboardShareSection[];
}): Promise<DashboardShareInfo> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  const run = await loadCalcRunFull(tenantId, shopId);
  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  const sections = normalizeDashboardShareSections(input?.sections);
  const title =
    sections.length === DASHBOARD_SHARE_SECTIONS.length
      ? `${state.context.shop.name} 全部看板快照`
      : `${state.context.shop.name} ${sections.map((section) => DASHBOARD_SHARE_SECTION_LABELS[section]).join("、")}快照`;
  const payload: DashboardShareSnapshot = {
    title,
    sourceTenantName: state.context.tenant.name,
    sourceShopName: state.context.shop.name,
    createdAt: now,
    createdBy: actor,
    sections,
    calcRun: buildDashboardShareCalcRun(run, sections),
    prefill: sections.includes("prefill")
      ? {
          cycleId: state.context.cycle.id,
          items: state.prefillItems.filter((item) => item.cycleId === state.context.cycle.id),
          tags: state.productTags
        }
      : undefined
  };
  const row = await prisma.dashboardShare.create({
    data: {
      tenantId,
      shopId,
      tokenHash: hashShareToken(token),
      title,
      encryptedPayload: encryptSharePayload(payload),
      createdBy: actor
    }
  });
  return {
    id: row.id,
    title,
    url: `/shared/dashboards/${token}`,
    createdAt: row.createdAt.toISOString(),
    sections
  };
}

export async function getDashboardShareSnapshot(token: string): Promise<DashboardShareSnapshot | null> {
  const clean = token.trim();
  if (!/^[a-f0-9]{64}$/i.test(clean)) {
    return null;
  }
  const row = await prisma.dashboardShare.findUnique({
    where: { tokenHash: hashShareToken(clean) }
  });
  if (!row) {
    return null;
  }
  return decryptSharePayload(row.encryptedPayload);
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
  const { tenantId } = await requireShopScope();
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
  const { tenantId } = await requireShopScope();
  const actor = await currentActorName();
  const code = await generateUniqueInviteCode();
  const row = await prisma.inviteCode.create({
    data: {
      tenantId,
      code,
      registrationUrl: `/login?invite=${code}`,
      usedCount: 0,
      maxUses: input.maxUses,
      note: input.note.trim() || "未备注",
      createdBy: actor
    }
  });
  return toDomainInvite(row);
}

export async function deleteInviteCode(id: string): Promise<boolean> {
  const { tenantId } = await requireShopScope();
  const result = await prisma.inviteCode.deleteMany({ where: { id, tenantId } });
  return result.count > 0;
}

/**
 * 消费一个邀请码（注册时调用，无会话上下文）：校验存在性与剩余次数，
 * 成功后 usedCount + 1。被吊销（删除）的码自然失效。
 */
export async function consumeInviteCode(rawCode: string): Promise<{ ok: true; invite: InviteCode } | { ok: false; error: string }> {
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
  const consumed = await prisma.inviteCode.updateMany({
    where: { id: invite.id, usedCount: { lt: invite.maxUses } },
    data: { usedCount: { increment: 1 } }
  });
  if (consumed.count === 0) {
    return { ok: false, error: "邀请码使用次数已用尽" };
  }
  const updated = await prisma.inviteCode.findUnique({ where: { id: invite.id } });
  if (!updated) {
    return { ok: false, error: "邀请码无效或已失效" };
  }
  return { ok: true, invite: toDomainInvite(updated) };
}

export async function getManagedUsers(): Promise<ManagedUser[]> {
  const scope = await requireShopScope();
  const users = await prisma.user.findMany({
    where: scope.isAdmin ? {} : { tenantId: scope.tenantId },
    orderBy: { createdAt: "desc" }
  });
  const dmpAccessByUserId = await getDmpAutomationAccessForUserIds(users.map((user) => user.id));
  return users.map((u) => ({
    id: u.id,
    tenantId: u.tenantId,
    name: u.name,
    username: u.username,
    email: u.email,
    role: u.role as ManagedUser["role"],
    shopName: u.shopName,
    status: u.status as ManagedUser["status"],
    dmpAutomationAccess: dmpAccessByUserId.get(u.id) ?? { ...NO_DMP_AUTOMATION_ACCESS },
    createdAt: u.createdAt.toISOString(),
    lastActiveAt: u.lastActiveAt.toISOString()
  }));
}

type ManagedUserActionResult =
  | { ok: true }
  | { ok: false; error: string; status: number };

/** 校验目标用户可被当前管理员操作：非本人、非管理员账号；管理账号可跨租户管理租户账号。 */
async function guardManagedUserAction(id: string): Promise<ManagedUserActionResult> {
  const scope = await requireShopScope();
  const session = await getServerSession();
  if (!session || !scope.isAdmin) {
    return { ok: false, error: "仅管理员可执行此操作", status: 403 };
  }
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
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

/** 重置租户成员密码：生成 10 位临时密码并写库，明文仅随本次响应返回一次。 */
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
  await prisma.user.update({ where: { id }, data: { password: hashPassword(password) } });
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
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  const normalizedMonths = normalizeHistoryMonths(months);
  state.historyRetention = {
    ...state.historyRetention,
    months: normalizedMonths,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  };
  state.historyRecords = pruneHistoryRecordsByMonths(state.historyRecords, normalizedMonths, new Date());
  state.historyReports = pruneHistoryReportsByMonths(state.historyReports, normalizedMonths, new Date());
  pushHistoryVersion(
    state,
    "历史保留策略更新",
    `历史数据保留期调整为 ${normalizedMonths === 0 ? "永久保留" : `最近 ${normalizedMonths} 个月`}。`,
    actor
  );
  await saveWorkspace(tenantId, shopId, state);
  return {
    records: [...state.historyRecords].sort((l, r) => r.uploadAt.localeCompare(l.uploadAt)),
    reports: [...state.historyReports].sort((l, r) => r.createdAt.localeCompare(l.createdAt)),
    retention: { ...state.historyRetention }
  };
}

export async function clearManagementHistory(): Promise<ManagementHistoryState> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  const removed = state.historyRecords.length + state.historyReports.length;
  state.historyRecords = [];
  state.historyReports = [];
  pushHistoryVersion(state, "清空历史数据", `清空全部管理历史，移除 ${removed} 条记录与报表。`, actor);
  await saveWorkspace(tenantId, shopId, state);
  return getManagementHistorySnapshot(state);
}

export async function deleteManagementHistoryBefore(beforeDate: string): Promise<ManagementHistoryState> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
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
    `删除 ${beforeDate} 之前的历史，移除 ${before - after} 条记录与报表。`,
    actor
  );
  await saveWorkspace(tenantId, shopId, state);
  return getManagementHistorySnapshot(state);
}

export async function deleteManagementHistoryRange(
  startDate: string,
  endDate: string
): Promise<ManagementHistoryState> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
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
    `删除 ${startDate} ~ ${endDate} 区间的历史，移除 ${before - after} 条记录与报表。`,
    actor
  );
  await saveWorkspace(tenantId, shopId, state);
  return getManagementHistorySnapshot(state);
}

export async function saveManagementHistoryReport(input: {
  name: string;
  startDate: string;
  endDate: string;
  categories: ManagementHistoryReport["categories"];
}): Promise<ManagementHistoryReport> {
  const { tenantId, shopId, state } = await ctx();
  const actor = await currentActorName();
  const report: ManagementHistoryReport = {
    id: `history-report-${Date.now()}`,
    tenantId,
    shopId: state.context.shop.id,
    cycleId: state.context.cycle.id,
    name: input.name.trim(),
    createdAt: new Date().toISOString(),
    createdBy: actor,
    startDate: input.startDate,
    endDate: input.endDate,
    categories: [...input.categories]
  };
  state.historyReports = [report, ...state.historyReports];
  await saveWorkspace(tenantId, shopId, state);
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

function pushHistoryVersion(state: WorkspaceData, title: string, summary: string, actor?: string) {
  pushVersion(state, {
    id: `version-history-${Date.now()}`,
    cycleId: state.context.cycle.id,
    shopId: state.context.shop.id,
    kind: "history",
    title,
    createdAt: new Date().toISOString(),
    createdBy: actor ?? state.context.user.name,
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
  before: number | null,
  after: number | null,
  higherIsBetter: boolean
): ComparisonMetric {
  const change = metricChange(before, after);
  return {
    key,
    label,
    unit,
    before,
    after,
    delta: change.delta,
    deltaPct: change.rate,
    changeStatus: change.status,
    higherIsBetter
  };
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
  const daily = (value: number | null, days: number) => value === null ? null : value / days;
  // 强度量（不除窗长，由各自求和重算）
  const net = (s: WindowSum) => s.paymentAmount !== null && s.refundAmount !== null ? s.paymentAmount - s.refundAmount : null;
  const divideMetric = (numerator: number | null, denominator: number | null) =>
    numerator === null || denominator === null ? null : divideOrNull(numerator, denominator);
  const conv = (s: WindowSum) => divideMetric(s.paymentBuyers, s.visitors);
  const aov = (s: WindowSum) => divideMetric(s.paymentAmount, s.paymentBuyers);
  const uv = (s: WindowSum) => divideMetric(s.paymentAmount, s.visitors);
  const refundRate = (s: WindowSum) => divideMetric(s.refundAmount, s.paymentAmount);
  const cpc = (s: PromotionWindowSum) => divideMetric(s.cost, s.clicks);
  const cpm = (s: PromotionWindowSum) => {
    const value = divideMetric(s.cost, s.impressions);
    return value === null ? null : value * 1000;
  };
  const adRoi = (s: PromotionWindowSum) => divideMetric(s.roiCost, s.cost);
  const costRatio = (p: WindowSum, q: PromotionWindowSum) => divideMetric(q.cost, p.paymentAmount);
  const overallRoi = (p: WindowSum, q: PromotionWindowSum) => divideMetric(p.paymentAmount, q.cost);

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
    push(comparisonMetric("adCost", "日均推广花费", "money", daily(qb.cost, bd), daily(qa.cost, ad), true), "投放", { ad: true, neutral: true });
    push(comparisonMetric("impressions", "日均展现", "int", daily(qb.impressions, bd), daily(qa.impressions, ad), true), "投放", { ad: true, neutral: true });
    push(comparisonMetric("adClicks", "日均点击", "int", daily(qb.clicks, bd), daily(qa.clicks, ad), true), "投放", { ad: true, neutral: true });
    push(comparisonMetric("cpc", "点击成本 CPC", "money", cpc(qb), cpc(qa), false), "投放", { ad: true });
    push(comparisonMetric("cpm", "千次展现成本 CPM", "money", cpm(qb), cpm(qa), false), "投放", { ad: true });
  }
  // ② 流量：到店与流量质量
  push(comparisonMetric("visitors", "日均访客", "int", daily(pb.visitors, bd), daily(pa.visitors, ad), true), "流量");
  push(comparisonMetric("views", "日均浏览量", "int", daily(pb.views, bd), daily(pa.views, ad), true), "流量");
  push(comparisonMetric("uvValue", "访客价值", "money", uv(pb), uv(pa), true), "流量");
  // ③ 成交：转化与产出
  push(comparisonMetric("paymentBuyers", "日均支付买家", "int", daily(pb.paymentBuyers, bd), daily(pa.paymentBuyers, ad), true), "成交");
  push(comparisonMetric("conversion", "支付转化率", "rate", conv(pb), conv(pa), true), "成交");
  push(comparisonMetric("aov", "客单价", "money", aov(pb), aov(pa), true), "成交");
  push(comparisonMetric("paymentAmount", "日均销售额", "money", daily(pb.paymentAmount, bd), daily(pa.paymentAmount, ad), true), "成交");
  // ④ 利润：净产出与投产效率
  push(comparisonMetric("netSales", "日均净销额", "money", daily(net(pb), bd), daily(net(pa), ad), true), "利润");
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
  const daily = (value: number | null, days: number) => value === null ? null : value / days;
  const step = (
    key: string,
    label: string,
    before: number | null,
    after: number | null,
    unit: ComparisonMetric["unit"],
    higherIsBetter: boolean,
    neutral = false
  ): FunnelChainStep => {
    const change = metricChange(before, after);
    return { key, label, before, after, deltaPct: change.rate, changeStatus: change.status, unit, higherIsBetter, neutral };
  };

  const steps: FunnelChainStep[] = [];
  if (hasPromo) {
    steps.push(step("adCost", "推广花费", daily(qb.cost, bd), daily(qa.cost, ad), "money", true, true));
    steps.push(step("impressions", "展现", daily(qb.impressions, bd), daily(qa.impressions, ad), "int", true, true));
    steps.push(step("adClicks", "点击", daily(qb.clicks, bd), daily(qa.clicks, ad), "int", true, true));
  }
  steps.push(step("visitors", "访客", daily(pb.visitors, bd), daily(pa.visitors, ad), "int", true));
  steps.push(step("paymentBuyers", "支付买家", daily(pb.paymentBuyers, bd), daily(pa.paymentBuyers, ad), "int", true));
  steps.push(step("paymentAmount", "销售额", daily(pb.paymentAmount, bd), daily(pa.paymentAmount, ad), "money", true));
  if (hasPromo) {
    const roiB = qb.cost !== null && qb.roiCost !== null ? divideOrNull(qb.roiCost, qb.cost) : null;
    const roiA = qa.cost !== null && qa.roiCost !== null ? divideOrNull(qa.roiCost, qa.cost) : null;
    steps.push(step("adRoi", "推广ROI", roiB, roiA, "ratio", true));
  } else {
    const netBefore = pb.paymentAmount !== null && pb.refundAmount !== null ? pb.paymentAmount - pb.refundAmount : null;
    const netAfter = pa.paymentAmount !== null && pa.refundAmount !== null ? pa.paymentAmount - pa.refundAmount : null;
    steps.push(step("netSales", "净销额", daily(netBefore, bd), daily(netAfter, ad), "money", true));
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
  const [{ tenantId, shopId, state }, iv] = await Promise.all([
    ctx(),
    prisma.intervention.findUnique({ where: { id } })
  ]);
  if (!iv || iv.tenantId !== tenantId || iv.shopId !== shopId) {
    return null;
  }
  const affected = Array.isArray(iv.productIds) ? (iv.productIds as string[]) : [];
  const scopeIds = affected.length > 0 ? affected : null;

  const beforeStart = addDays(iv.date, -beforeDays);
  const beforeEnd = addDays(iv.date, -1);
  const afterStart = iv.date;
  const afterEnd = addDays(iv.date, afterDays - 1);

  // 口径 A：真实经营前后（日均/费率）+ 广告维度（推广花费/ROI/CPC）
  const [
    beforeSum,
    afterSum,
    beforePromo,
    afterPromo,
    beforeProductDays,
    afterProductDays,
    beforePromotionDays,
    afterPromotionDays
  ] = await Promise.all([
    sumProductWindow(tenantId, shopId, scopeIds, beforeStart, beforeEnd),
    sumProductWindow(tenantId, shopId, scopeIds, afterStart, afterEnd),
    sumPromotionWindow(tenantId, shopId, scopeIds, beforeStart, beforeEnd),
    sumPromotionWindow(tenantId, shopId, scopeIds, afterStart, afterEnd),
    countProductWindowDays(tenantId, shopId, scopeIds, beforeStart, beforeEnd),
    countProductWindowDays(tenantId, shopId, scopeIds, afterStart, afterEnd),
    countPromotionWindowDays(tenantId, shopId, scopeIds, beforeStart, beforeEnd),
    countPromotionWindowDays(tenantId, shopId, scopeIds, afterStart, afterEnd)
  ]);
  // 无推广时只比较经营源；只要存在推广量，就要求推广源也完整覆盖，避免缺日把成本低估。
  const hasPromo =
    (beforePromo.cost ?? 0) + (afterPromo.cost ?? 0) +
    (beforePromo.impressions ?? 0) + (afterPromo.impressions ?? 0) > 0;
  const beforeObservedDays = hasPromo ? Math.min(beforeProductDays, beforePromotionDays) : beforeProductDays;
  const afterObservedDays = hasPromo ? Math.min(afterProductDays, afterPromotionDays) : afterProductDays;
  const window: ComparisonWindow = {
    beforeStart,
    beforeEnd,
    afterStart,
    afterEnd,
    beforeDays,
    afterDays,
    coverage: assessComparisonWindow({
      interventionDate: iv.date,
      beforeEnd,
      afterEnd,
      beforeExpectedDays: beforeDays,
      afterExpectedDays: afterDays,
      beforeObservedDays,
      afterObservedDays
    })
  };
  const canConclude = canConcludeComparison(window.coverage);
  // 有推广数据才追加广告维度，避免无投放租户出现一排 0。
  // 未闭合/缺日时从结果层禁用涨跌输出；ready 时也以实际覆盖天数为日均分母。
  const metrics = canConclude
    ? buildFunnelMetrics(
        beforeSum,
        afterSum,
        beforePromo,
        afterPromo,
        window.coverage.before.observedDays,
        window.coverage.after.observedDays,
        hasPromo,
        scopeIds !== null
      )
    : [];
  const chain = canConclude
    ? buildFunnelChain(
        beforeSum,
        afterSum,
        beforePromo,
        afterPromo,
        window.coverage.before.observedDays,
        window.coverage.after.observedDays,
        hasPromo
      )
    : [];

  // 口径 B：计划 vs 实际（按受影响商品；整店则取所有有计划的商品）
  const cid = state.context.cycle.id;
  const planById = new Map(
    state.prefillItems.filter((p) => p.cycleId === cid).map((p) => [p.productId, p])
  );
  const targetIds = affected.length > 0 ? affected : [...planById.keys()];
  const afterByProduct = canConclude
    ? await sumProductWindowByProduct(
        tenantId,
        shopId,
        targetIds.length > 0 ? targetIds : null,
        afterStart,
        afterEnd
      )
    : new Map<string, WindowSum>();
  const lensBRows = canConclude
    ? targetIds
        .map((pid) => {
          const plan = planById.get(pid);
          const a = afterByProduct.get(pid) ?? { paymentAmount: 0, refundAmount: 0, visitors: 0, views: 0, paymentBuyers: 0 };
          const actualNet = a.paymentAmount !== null && a.refundAmount !== null
            ? a.paymentAmount - a.refundAmount
            : null;
          const actualMonthlyGsv =
            actualNet !== null && window.coverage.after.observedDays > 0
              ? (actualNet / window.coverage.after.observedDays) * 30
              : null;
          const planMonthlyGsv = plan?.monthlyGsvOpportunity ?? 0;
          return {
            productId: pid,
            productName: plan?.productName ?? pid,
            planMonthlyGsv,
            actualMonthlyGsv,
            // 未设目标 → null（"未设目标"），不能显示成 0% 让运营误以为"完全未达标"。
            attainmentPct: planMonthlyGsv > 0 && actualMonthlyGsv !== null ? actualMonthlyGsv / planMonthlyGsv : null
          };
        })
        .filter((r) => r.planMonthlyGsv > 0 || (r.actualMonthlyGsv ?? 0) > 0)
        .sort((l, r) => (r.actualMonthlyGsv ?? Number.NEGATIVE_INFINITY) - (l.actualMonthlyGsv ?? Number.NEGATIVE_INFINITY))
    : [];

  // 口径 C：整店（或商品集）按天趋势，覆盖 [前窗起, 后窗止]；经营派生 + 推广按日 join。
  const series = canConclude
    ? await buildDailyTrendSeries(tenantId, shopId, beforeStart, afterEnd, scopeIds)
    : [];

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
    window,
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
  withState = true,
  coverageSource: "product" | "audience" = "product"
): Promise<{
  tenantId: string;
  shopId: string;
  state: WorkspaceData | null;
  affected: string[];
  scopeIds: string[] | null;
  window: ComparisonWindow;
  intervention: Intervention;
} | null> {
  const [base, iv] = await Promise.all([
    withState
      ? ctx()
      : requireShopScope().then((scope) => ({ tenantId: scope.tenantId, shopId: scope.shopId, state: null as WorkspaceData | null })),
    prisma.intervention.findUnique({ where: { id } })
  ]);
  const { tenantId, shopId, state } = base;
  if (!iv || iv.tenantId !== tenantId || iv.shopId !== shopId) {
    return null;
  }
  const affected = Array.isArray(iv.productIds) ? (iv.productIds as string[]) : [];
  const beforeStart = addDays(iv.date, -beforeDays);
  const beforeEnd = addDays(iv.date, -1);
  const afterStart = iv.date;
  const afterEnd = addDays(iv.date, afterDays - 1);
  const countDays = coverageSource === "audience" ? countAudienceWindowDays : countProductWindowDays;
  const scopeIds = affected.length > 0 ? affected : null;
  const [beforeObservedDays, afterObservedDays] = await Promise.all([
    countDays(tenantId, shopId, scopeIds, beforeStart, beforeEnd),
    countDays(tenantId, shopId, scopeIds, afterStart, afterEnd)
  ]);
  const window: ComparisonWindow = {
    beforeStart,
    beforeEnd,
    afterStart,
    afterEnd,
    beforeDays,
    afterDays,
    coverage: assessComparisonWindow({
      interventionDate: iv.date,
      beforeEnd,
      afterEnd,
      beforeExpectedDays: beforeDays,
      afterExpectedDays: afterDays,
      beforeObservedDays,
      afterObservedDays
    })
  };
  return {
    tenantId,
    shopId,
    state,
    affected,
    scopeIds,
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
  const { tenantId, shopId, affected, scopeIds, window, intervention } = ctxw;
  const state = ctxw.state!; // withState=true（默认）→ 非空
  if (!canConcludeComparison(window.coverage)) {
    return {
      intervention,
      window,
      scope: affected.length > 0 ? `${affected.length} 个商品` : "整店",
      hasPromo: false,
      rows: []
    };
  }
  const [
    beforeByP,
    afterByP,
    beforePromoByP,
    afterPromoByP,
    beforePromotionDays,
    afterPromotionDays,
    beforeDaysByP,
    afterDaysByP
  ] = await Promise.all([
    sumProductWindowByProduct(tenantId, shopId, scopeIds, window.beforeStart, window.beforeEnd),
    sumProductWindowByProduct(tenantId, shopId, scopeIds, window.afterStart, window.afterEnd),
    sumPromotionWindowByProduct(tenantId, shopId, scopeIds, window.beforeStart, window.beforeEnd),
    sumPromotionWindowByProduct(tenantId, shopId, scopeIds, window.afterStart, window.afterEnd),
    countPromotionWindowDays(tenantId, shopId, scopeIds, window.beforeStart, window.beforeEnd),
    countPromotionWindowDays(tenantId, shopId, scopeIds, window.afterStart, window.afterEnd),
    countProductWindowDaysByProduct(tenantId, shopId, scopeIds, window.beforeStart, window.beforeEnd),
    countProductWindowDaysByProduct(tenantId, shopId, scopeIds, window.afterStart, window.afterEnd)
  ]);
  // 与 overview 严格同口径（cost+impressions，不含 clicks）：基于实际投放量判定而非分组是否存在，
  // 既避免全 0 推广行导致"一排 0"的投放列，也避免"仅有点击、花费/展现为 0"时两视图门控不一致。
  const hasPromo = [...beforePromoByP.values(), ...afterPromoByP.values()].some(
    (p) => (p.cost ?? 0) + (p.impressions ?? 0) > 0
  );
  const effectiveWindow: ComparisonWindow = hasPromo
    ? {
        ...window,
        coverage: assessComparisonWindow({
          interventionDate: intervention.date,
          beforeEnd: window.beforeEnd,
          afterEnd: window.afterEnd,
          beforeExpectedDays: window.beforeDays,
          afterExpectedDays: window.afterDays,
          beforeObservedDays: Math.min(window.coverage.before.observedDays, beforePromotionDays),
          afterObservedDays: Math.min(window.coverage.after.observedDays, afterPromotionDays)
        })
      }
    : window;
  if (!canConcludeComparison(effectiveWindow.coverage)) {
    return {
      intervention,
      window: effectiveWindow,
      scope: affected.length > 0 ? `${affected.length} 个商品` : "整店",
      hasPromo,
      rows: []
    };
  }
  const cid = state.context.cycle.id;
  const nameById = new Map(
    state.prefillItems.filter((p) => p.cycleId === cid).map((p) => [p.productId, p.productName])
  );
  const ids = new Set<string>([...beforeByP.keys(), ...afterByP.keys()]);
  const zero = { paymentAmount: 0, refundAmount: 0, visitors: 0, views: 0, paymentBuyers: 0 };
  const zeroPromo = { cost: 0, clicks: 0, impressions: 0, roiCost: 0 };
  let rows = [...ids].map((pid) => {
    const b = beforeByP.get(pid) ?? zero;
    const a = afterByP.get(pid) ?? zero;
    const pbp = beforePromoByP.get(pid) ?? zeroPromo;
    const pap = afterPromoByP.get(pid) ?? zeroPromo;
    // 日均分母用该商品**自身**覆盖天数：新品上架/中途下架/缺货商品不应按整店天数摊薄。
    // 该商品完全没有分日记录时由零对象表达“确认无活动”；记录存在但字段缺失时保持 null。
    const bd = beforeDaysByP.get(pid) ?? 0;
    const ad = afterDaysByP.get(pid) ?? 0;
    const daily = (value: number | null, days: number) => value === null || days <= 0 ? null : value / days;
    const beforeNetTotal = b.paymentAmount !== null && b.refundAmount !== null ? b.paymentAmount - b.refundAmount : null;
    const afterNetTotal = a.paymentAmount !== null && a.refundAmount !== null ? a.paymentAmount - a.refundAmount : null;
    const netBefore = daily(beforeNetTotal, bd);
    const netAfter = daily(afterNetTotal, ad);
    const netChange = metricChange(netBefore, netAfter);
    const ratio = (numerator: number | null, denominator: number | null) =>
      numerator === null || denominator === null ? null : divideOrNull(numerator, denominator);
    return {
      productId: pid,
      productName: nameById.get(pid) ?? pid,
      netBefore,
      netAfter,
      netDeltaPct: netChange.rate,
      netChangeStatus: netChange.status,
      visitorsBefore: daily(b.visitors, bd),
      visitorsAfter: daily(a.visitors, ad),
      observedDaysBefore: bd,
      observedDaysAfter: ad,
      // 强度指标：分母为 0 = 无法计算，返回 null 让展示层渲染"—"，不得显示 0。
      convBefore: ratio(b.paymentBuyers, b.visitors),
      convAfter: ratio(a.paymentBuyers, a.visitors),
      aovBefore: ratio(b.paymentAmount, b.paymentBuyers),
      aovAfter: ratio(a.paymentAmount, a.paymentBuyers),
      refundRateBefore: ratio(b.refundAmount, b.paymentAmount),
      refundRateAfter: ratio(a.refundAmount, a.paymentAmount),
      adCostBefore: daily(pbp.cost, bd),
      adCostAfter: daily(pap.cost, ad),
      adRoiBefore: ratio(pbp.roiCost, pbp.cost),
      adRoiAfter: ratio(pap.roiCost, pap.cost)
    };
  });
  rows.sort((l, r) => (r.netAfter ?? Number.NEGATIVE_INFINITY) - (l.netAfter ?? Number.NEGATIVE_INFINITY));
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
  return { intervention, window: effectiveWindow, scope, hasPromo, rows };
}

/** 人群计划视角：受影响主体（整店则全部）的 (计划·人群) 动作前后变化（点击 Top30）。 */
export async function buildAudienceComparison(
  id: string,
  beforeDays = 7,
  afterDays = 7
): Promise<AudienceComparison | null> {
  // 人群对比不读 state → withState=false，跳过 490KB blob 加载。
  const ctxw = await loadInterventionWindow(id, beforeDays, afterDays, false, "audience");
  if (!ctxw) {
    return null;
  }
  const { tenantId, shopId, scopeIds, window, intervention } = ctxw;
  if (!canConcludeComparison(window.coverage)) {
    return { intervention, window, rows: [] };
  }
  const [beforeG, afterG] = await Promise.all([
    sumAudienceWindowByGroup(tenantId, shopId, scopeIds, window.beforeStart, window.beforeEnd),
    sumAudienceWindowByGroup(tenantId, shopId, scopeIds, window.afterStart, window.afterEnd)
  ]);
  // 字段本身可能含分隔符，先转义再拼接，避免不同(计划·人群·主体)被错误合并成同一行。
  const escapeKeyPart = (value: string) => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const keyOf = (planId: string, audienceName: string, subjectId: string) =>
    [planId, audienceName, subjectId].map(escapeKeyPart).join("|||");
  const beforeMap = new Map(beforeG.map((g) => [keyOf(g.planId, g.audienceName, g.subjectId), g]));
  const afterMap = new Map(afterG.map((g) => [keyOf(g.planId, g.audienceName, g.subjectId), g]));
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const bd = window.coverage.before.observedDays;
  const ad = window.coverage.after.observedDays;
  const rows = [...keys]
    .map((k) => {
      const b = beforeMap.get(k);
      const a = afterMap.get(k);
      const ref = a ?? b!;
      const clicksBefore = b ? (b.clicks === null ? null : b.clicks / bd) : 0;
      const clicksAfter = a ? (a.clicks === null ? null : a.clicks / ad) : 0;
      const clickChange = metricChange(clicksBefore, clicksAfter);
      const weighted = (value: number | null, clicks: number | null) =>
        value === null || clicks === null ? null : divideOrNull(value, clicks);
      return {
        key: k,
        planName: ref.planName ?? ref.planId,
        audienceName: ref.audienceName,
        subjectName: ref.subjectName ?? ref.subjectId,
        clicksBefore,
        clicksAfter,
        clicksDeltaPct: clickChange.rate,
        clicksChangeStatus: clickChange.status,
        // 点击加权强度指标：该侧无点击 = 无法计算，返回 null（不是"ROI 为 0"）。
        roiBefore: b ? weighted(b.roiClicks, b.clicks) : null,
        roiAfter: a ? weighted(a.roiClicks, a.clicks) : null,
        guidedBefore: b ? weighted(b.guidedW, b.clicks) : null,
        guidedAfter: a ? weighted(a.guidedW, a.clicks) : null,
        newBefore: b ? weighted(b.newW, b.clicks) : null,
        newAfter: a ? weighted(a.newW, a.clicks) : null
      };
    })
    .sort((l, r) => (r.clicksAfter ?? Number.NEGATIVE_INFINITY) - (l.clicksAfter ?? Number.NEGATIVE_INFINITY))
    .slice(0, 30);
  return { intervention, window, rows };
}
