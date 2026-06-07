import {
  gradeRows,
  lifecycleColumns,
  marginMatrix,
  runThreeStageCalculation
} from "@/lib/algorithm/three-stage";
import { getGoldenScenario } from "@/lib/fixtures/golden-scenario";
import {
  getImportBatchesSize,
  pruneAdminVersionSnapshots,
  pruneHistoryRecordsByMonths,
  retentionPolicy,
  validateTenantDatasetSize
} from "@/lib/retention-policy";
import type {
  CalcRun,
  GrowthProfitConfigRow,
  InviteCode,
  ImportBatch,
  ImportValidationResult,
  ManagementHistoryRecord,
  ManagementHistoryReport,
  ManagementHistoryRetention,
  ManagementHistoryState,
  ManagedUser,
  PrefillItem,
  ProfitMarginMatrix,
  ReportType,
  VersionSnapshot
} from "@/lib/types/domain";

interface RuntimeStoreState {
  imports: ImportBatch[];
  currentTenantDatasetId: string | null;
  currentTenantDatasetBytes: number;
  prefillItems: PrefillItem[];
  growthProfitConfig: GrowthProfitConfigRow[];
  calcRun: CalcRun;
  versions: VersionSnapshot[];
  inviteCodes: InviteCode[];
  managedUsers: ManagedUser[];
  historyRecords: ManagementHistoryRecord[];
  historyReports: ManagementHistoryReport[];
  historyRetention: ManagementHistoryRetention;
}

const scenario = getGoldenScenario();
const initialGrowthProfitConfig = matrixToGrowthProfitConfig(marginMatrix);

const state: RuntimeStoreState = getRuntimeState();

function getRuntimeState(): RuntimeStoreState {
  const globalStore = globalThis as typeof globalThis & {
    __threeStageRuntimeStore?: RuntimeStoreState;
  };
  globalStore.__threeStageRuntimeStore ??= createInitialState();
  return globalStore.__threeStageRuntimeStore;
}

function createInitialState(): RuntimeStoreState {
  return {
  imports: [...scenario.importBatches],
  currentTenantDatasetId: scenario.importBatches[0]?.datasetId ?? null,
  currentTenantDatasetBytes: getImportBatchesSize(scenario.importBatches),
  prefillItems: [...scenario.prefillItems],
  growthProfitConfig: initialGrowthProfitConfig,
    calcRun: runThreeStageCalculation({
    cycleId: scenario.cycle.id,
    productSourceRows: scenario.productSourceRows,
    damoProductRows: scenario.damoProductRows,
    promotionProductRows: scenario.promotionProductRows,
    audienceSourceRows: scenario.audienceSourceRows,
    prefillItems: scenario.prefillItems,
    marginMatrix
    }),
    versions: pruneAdminVersionSnapshots([...scenario.versionSnapshots]),
    historyRecords: pruneHistoryRecordsByMonths([...scenario.historyRecords], scenario.historyRetention.months, new Date()),
    historyReports: [...scenario.historyReports],
    historyRetention: { ...scenario.historyRetention },
    inviteCodes: [
    {
      id: "invite-u5x5xgu423",
      tenantId: scenario.tenant.id,
      code: "U5X5XGU423",
      registrationUrl: "/register?invite=U5X5XGU423",
      usedCount: 0,
      maxUses: 1,
      note: "永发",
      createdAt: "2026-06-04T08:27:47",
      createdBy: scenario.user.name
    },
    {
      id: "invite-ats7b7pjmy",
      tenantId: scenario.tenant.id,
      code: "ATS7B7PJMY",
      registrationUrl: "/register?invite=ATS7B7PJMY",
      usedCount: 1,
      maxUses: 3,
      note: "时之蜜",
      createdAt: "2026-06-04T08:27:32",
      createdBy: scenario.user.name
    },
    {
      id: "invite-pymajv3e6w",
      tenantId: scenario.tenant.id,
      code: "PYMAJV3E6W",
      registrationUrl: "/register?invite=PYMAJV3E6W",
      usedCount: 1,
      maxUses: 1,
      note: "倩怡",
      createdAt: "2026-06-04T08:21:56",
      createdBy: scenario.user.name
    },
    {
      id: "invite-l4pnn7yzyw",
      tenantId: scenario.tenant.id,
      code: "L4PNN7YZYW",
      registrationUrl: "/register?invite=L4PNN7YZYW",
      usedCount: 0,
      maxUses: 3,
      note: "琛誉",
      createdAt: "2026-06-02T10:32:16",
      createdBy: scenario.user.name
    },
    {
      id: "invite-dk7mksppds",
      tenantId: scenario.tenant.id,
      code: "DK7MKSPPDS",
      registrationUrl: "/register?invite=DK7MKSPPDS",
      usedCount: 3,
      maxUses: 3,
      note: "萃茂",
      createdAt: "2026-06-01T10:20:29",
      createdBy: scenario.user.name
    },
    {
      id: "invite-vvjrb-szlva",
      tenantId: scenario.tenant.id,
      code: "VVJRBSZLVA",
      registrationUrl: "/register?invite=VVJRBSZLVA",
      usedCount: 1,
      maxUses: 1,
      note: "华馨",
      createdAt: "2026-06-01T04:29:03",
      createdBy: scenario.user.name
    },
    {
      id: "invite-frbfrgc87s",
      tenantId: scenario.tenant.id,
      code: "FRBFRGC87S",
      registrationUrl: "/register?invite=FRBFRGC87S",
      usedCount: 1,
      maxUses: 1,
      note: "纽强",
      createdAt: "2026-05-29T09:58:41",
      createdBy: scenario.user.name
    },
    {
      id: "invite-buvbtvwjpa",
      tenantId: scenario.tenant.id,
      code: "BUVBTVWJPA",
      registrationUrl: "/register?invite=BUVBTVWJPA",
      usedCount: 0,
      maxUses: 1,
      note: "鲁匠师厨具旗舰店",
      createdAt: "2026-05-29T04:34:04",
      createdBy: scenario.user.name
    },
    {
      id: "invite-85gck2erh6",
      tenantId: scenario.tenant.id,
      code: "85GCK2ERH6",
      registrationUrl: "/register?invite=85GCK2ERH6",
      usedCount: 1,
      maxUses: 1,
      note: "lijiang",
      createdAt: "2026-05-29T01:55:15",
      createdBy: scenario.user.name
    },
    {
      id: "invite-n38s46sgzv",
      tenantId: scenario.tenant.id,
      code: "N38S46SGZV",
      registrationUrl: "/register?invite=N38S46SGZV",
      usedCount: 1,
      maxUses: 1,
      note: "zhouao",
      createdAt: "2026-05-29T01:36:26",
      createdBy: scenario.user.name
    }
  ],
  managedUsers: [
    {
      id: "managed-user-admin",
      tenantId: scenario.tenant.id,
      name: "运营负责人",
      username: "admin",
      email: "admin@sanjie.local",
      role: "owner",
      shopName: scenario.shop.name,
      status: "active",
      createdAt: "2026-05-01T09:00:00",
      lastActiveAt: "2026-06-06T14:00:00"
    },
    {
      id: "managed-user-operator",
      tenantId: scenario.tenant.id,
      name: "投放运营",
      username: "operator",
      email: "operator@sanjie.local",
      role: "operator",
      shopName: scenario.shop.name,
      status: "active",
      createdAt: "2026-05-18T11:20:00",
      lastActiveAt: "2026-06-05T18:32:00"
    },
    {
      id: "managed-user-viewer",
      tenantId: scenario.tenant.id,
      name: "管理观察员",
      username: "viewer",
      email: "viewer@sanjie.local",
      role: "viewer",
      shopName: scenario.shop.name,
      status: "pending",
      createdAt: "2026-06-01T10:15:00",
      lastActiveAt: "2026-06-01T10:15:00"
    }
  ]
  };
}

export function getWorkspaceContext() {
  return {
    tenant: scenario.tenant,
    user: scenario.user,
    shop: scenario.shop,
    cycle: scenario.cycle
  };
}

export function getImportBatches() {
  return state.imports;
}

export function getRetentionStatus() {
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

export function clearImportBatches() {
  const now = new Date().toISOString();
  state.imports = [];
  state.currentTenantDatasetId = null;
  state.currentTenantDatasetBytes = 0;
  addVersionSnapshot({
    id: `version-import-clear-${Date.now()}`,
    cycleId: scenario.cycle.id,
    shopId: scenario.shop.id,
    kind: "import",
    title: "清空源数据",
    createdAt: now,
    createdBy: scenario.user.name,
    summary: "租户端当前源数据已清空，可上传下一次最新数据。"
  });
}

export function addImportBatch(input: {
  cycleId: string;
  datasetId: string;
  datasetTotalBytes: number;
  reportType: ReportType;
  fileName: string;
  fileSizeBytes: number;
  validation: ImportValidationResult;
}) {
  const preflightError = validateImportDatasetWrite({
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
  addVersionSnapshot({
    id: `version-import-${Date.now()}`,
    cycleId: input.cycleId,
    shopId: scenario.shop.id,
    kind: "import",
    title: `${input.validation.ok ? "通过" : "失败"}：${input.fileName}`,
    createdAt: batch.createdAt,
    createdBy: scenario.user.name,
    summary: input.validation.ok
      ? `当前租户数据集 ${formatMegabytes(input.datasetTotalBytes)}，识别 ${input.validation.rowCount} 行，${input.validation.uniqueEntityCount} 个主体。`
      : input.validation.errors.join("；")
  });
  return batch;
}

export function validateImportDatasetWrite(input: { datasetId: string; datasetTotalBytes: number }) {
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

export function getImportBatch(id: string) {
  return state.imports.find((batch) => batch.id === id);
}

export function getPrefillItems(cycleId = scenario.cycle.id) {
  return state.prefillItems.filter((item) => item.cycleId === cycleId);
}

export function getGrowthProfitConfig() {
  return cloneGrowthProfitConfig(state.growthProfitConfig);
}

export function updateGrowthProfitConfig(cycleId: string, rows: GrowthProfitConfigRow[]) {
  state.growthProfitConfig = normalizeGrowthProfitConfig(rows);
  addVersionSnapshot({
    id: `version-profit-config-${Date.now()}`,
    cycleId,
    shopId: scenario.shop.id,
    kind: "profit_config",
    title: "V9 增长利润配置更新",
    createdAt: new Date().toISOString(),
    createdBy: scenario.user.name,
    summary: "更新 SAB 分层与生命周期对应的增长利润率矩阵。"
  });
  return getGrowthProfitConfig();
}

export function updatePrefillItems(cycleId: string, items: PrefillItem[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  state.prefillItems = state.prefillItems.map((item) =>
    item.cycleId === cycleId && byId.has(item.id) ? { ...item, ...byId.get(item.id) } : item
  );
  addVersionSnapshot({
    id: `version-prefill-${Date.now()}`,
    cycleId,
    shopId: scenario.shop.id,
    kind: "prefill",
    title: "预填写参数更新",
    createdAt: new Date().toISOString(),
    createdBy: scenario.user.name,
    summary: `更新 ${items.length} 个商品的分层、GSV、毛利或付费访客参数。`
  });
  return getPrefillItems(cycleId);
}

export function runCalculation(cycleId = scenario.cycle.id) {
  state.calcRun = runThreeStageCalculation({
    cycleId,
    productSourceRows: scenario.productSourceRows,
    damoProductRows: scenario.damoProductRows,
    promotionProductRows: scenario.promotionProductRows,
    audienceSourceRows: scenario.audienceSourceRows,
    prefillItems: getPrefillItems(cycleId),
    marginMatrix: growthProfitConfigToMarginMatrix(state.growthProfitConfig)
  });
  addVersionSnapshot({
    id: `version-calc-${Date.now()}`,
    cycleId,
    shopId: scenario.shop.id,
    kind: "calculation",
    title: "三阶评估算法重新运行",
    createdAt: state.calcRun.createdAt,
    createdBy: scenario.user.name,
    summary: `生成 ${state.calcRun.investmentResults.length} 个商品结果和 ${state.calcRun.audiencePlans.length} 条人群计划。`
  });
  return state.calcRun;
}

export function getLatestCalcRun() {
  return state.calcRun;
}

export function getVersions(cycleId = scenario.cycle.id) {
  return state.versions.filter((version) => version.cycleId === cycleId);
}

export function getInviteCodes() {
  return state.inviteCodes;
}

export function createInviteCode(input: { note: string; maxUses: number }) {
  const code = generateInviteCode();
  const invite: InviteCode = {
    id: `invite-${code.toLowerCase()}`,
    tenantId: scenario.tenant.id,
    code,
    registrationUrl: `/register?invite=${code}`,
    usedCount: 0,
    maxUses: input.maxUses,
    note: input.note.trim() || "未备注",
    createdAt: new Date().toISOString(),
    createdBy: scenario.user.name
  };
  state.inviteCodes = [invite, ...state.inviteCodes];
  return invite;
}

export function deleteInviteCode(id: string) {
  const before = state.inviteCodes.length;
  state.inviteCodes = state.inviteCodes.filter((invite) => invite.id !== id);
  return state.inviteCodes.length < before;
}

export function getManagedUsers() {
  return state.managedUsers;
}

export function getManagementHistory(): ManagementHistoryState {
  return {
    records: [...state.historyRecords].sort((left, right) => right.uploadAt.localeCompare(left.uploadAt)),
    reports: [...state.historyReports].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    retention: { ...state.historyRetention }
  };
}

export function updateManagementHistoryRetention(months: number) {
  const normalizedMonths = normalizeHistoryMonths(months);
  state.historyRetention = {
    ...state.historyRetention,
    months: normalizedMonths,
    updatedAt: new Date().toISOString(),
    updatedBy: scenario.user.name
  };
  state.historyRecords = pruneHistoryRecordsByMonths(
    state.historyRecords,
    normalizedMonths,
    new Date()
  );
  state.historyReports = pruneHistoryReportsByMonths(
    state.historyReports,
    normalizedMonths,
    new Date()
  );
  return getManagementHistory();
}

export function clearManagementHistory() {
  state.historyRecords = [];
  state.historyReports = [];
  return getManagementHistory();
}

export function deleteManagementHistoryBefore(beforeDate: string) {
  const cutoff = parseDate(beforeDate);
  if (!cutoff) {
    return getManagementHistory();
  }
  state.historyRecords = state.historyRecords.filter(
    (record) => new Date(record.uploadAt).getTime() >= cutoff.getTime()
  );
  state.historyReports = state.historyReports.filter(
    (report) => new Date(`${report.endDate}T23:59:59.999Z`).getTime() >= cutoff.getTime()
  );
  return getManagementHistory();
}

export function deleteManagementHistoryRange(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end) {
    return getManagementHistory();
  }
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
  return getManagementHistory();
}

export function saveManagementHistoryReport(input: {
  name: string;
  startDate: string;
  endDate: string;
  categories: ManagementHistoryReport["categories"];
}) {
  const report: ManagementHistoryReport = {
    id: `history-report-${Date.now()}`,
    tenantId: scenario.tenant.id,
    shopId: scenario.shop.id,
    cycleId: scenario.cycle.id,
    name: input.name.trim(),
    createdAt: new Date().toISOString(),
    createdBy: scenario.user.name,
    startDate: input.startDate,
    endDate: input.endDate,
    categories: [...input.categories]
  };
  state.historyReports = [report, ...state.historyReports];
  return report;
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

function addVersionSnapshot(version: VersionSnapshot) {
  state.versions = pruneAdminVersionSnapshots([version, ...state.versions]);
}

function generateInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 10; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  if (state.inviteCodes.some((invite) => invite.code === code)) {
    return generateInviteCode();
  }
  return code;
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
          return [
            lifecycle,
            Number.isFinite(value) ? Number(value) : marginMatrix[grade][lifecycle]
          ];
        })
      ) as GrowthProfitConfigRow["values"]
    };
  });
}

function growthProfitConfigToMarginMatrix(rows: GrowthProfitConfigRow[]): ProfitMarginMatrix {
  const normalized = normalizeGrowthProfitConfig(rows);
  return Object.fromEntries(
    normalized.map((row) => [row.grade, { ...row.values }])
  ) as ProfitMarginMatrix;
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
