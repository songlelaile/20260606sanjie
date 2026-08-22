import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { DmpReportAccess } from "@/lib/dmp-report-store";
import { validateImportRows } from "@/lib/imports/contracts";
import { mapAudienceDailyRows, mapProductDailyRows, mapPromotionDailyRows } from "@/lib/imports/map-rows";
import { matrixFromRawBody } from "@/lib/dmp-source-normalizer";
import {
  upsertDailyAudienceMetrics,
  upsertDailyProductMetrics,
  upsertDailyPromotionMetrics
} from "@/lib/store/daily-metrics";
import { buildInitialWorkspaceData } from "@/lib/store/runtime-store";
import type { ImportBatch, ImportValidationResult, ReportType } from "@/lib/types/domain";

const ALLOWED_TYPES = new Set<ReportType>(["product_source", "promotion_product_source", "audience_source"]);
const ITEM_ID = /^\d{6,20}$/;

export interface DmpSourceMatrixInput {
  access: DmpReportAccess;
  shopId?: string;
  reportType: ReportType;
  acquisitionMode: string;
  day?: string;
  expectedStart?: string;
  expectedEnd?: string;
  headers?: string[];
  rows?: unknown[][];
  rawBody?: unknown;
  fileName?: string;
  fileSizeBytes?: number;
}

export async function ingestDmpSourceMatrix(input: DmpSourceMatrixInput) {
  if (!ALLOWED_TYPES.has(input.reportType)) throw new Error("经营数据类型不受支持");
  const shop = input.shopId
    ? await prisma.shop.findFirst({ where: { id: input.shopId, tenantId: input.access.tenantId } })
    : await prisma.shop.findFirst({ where: { tenantId: input.access.tenantId }, orderBy: { createdAt: "asc" } });
  if (!shop) throw new Error("当前账号没有可用店铺，或插件选择的店铺已失效");

  const matrix = input.headers?.length && input.rows?.length
    ? { headers: input.headers.map(String), rows: input.rows }
    : matrixFromRawBody(input.rawBody, input.reportType, input.day);
  if (!matrix || matrix.rows.length === 0) throw new Error("接口或页面中没有可解析的经营明细");

  const validation = validateImportRows(input.reportType, matrix.headers, matrix.rows, { fallbackDate: input.day });
  if (!validation.ok) throw new Error(validation.errors.join("；") || "经营数据校验未通过");

  let accepted = 0;
  let products: Array<{ productId: string; productName: string }> = [];
  if (input.reportType === "product_source") {
    const mapped = mapProductDailyRows(matrix.headers, matrix.rows, input.day);
    if (!mapped.length) throw new Error("生意参谋数据没有可入库的商品行");
    accepted = await upsertDailyProductMetrics(input.access.tenantId, shop.id, mapped);
    products = uniqueProducts(mapped.map((row) => ({ productId: row.productId, productName: row.productName })));
  } else if (input.reportType === "promotion_product_source") {
    const mapped = mapPromotionDailyRows(matrix.headers, matrix.rows, input.day);
    if (!mapped.length) throw new Error("无界商品数据没有可入库的主体行");
    accepted = await upsertDailyPromotionMetrics(input.access.tenantId, shop.id, mapped);
  } else {
    const mapped = mapAudienceDailyRows(matrix.headers, matrix.rows, input.day);
    if (!mapped.length) throw new Error("无界人群数据没有可入库的主体行");
    accepted = await upsertDailyAudienceMetrics(input.access.tenantId, shop.id, mapped);
  }

  const batch = await updateWorkspaceSource({
    access: input.access,
    shopId: shop.id,
    reportType: input.reportType,
    acquisitionMode: input.acquisitionMode,
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes ?? 0,
    expectedStart: input.expectedStart,
    expectedEnd: input.expectedEnd,
    validation,
    accepted,
    products
  });
  return { batch, accepted, products };
}

async function updateWorkspaceSource(input: {
  access: DmpReportAccess;
  shopId: string;
  reportType: ReportType;
  acquisitionMode: string;
  fileName?: string;
  fileSizeBytes: number;
  expectedStart?: string;
  expectedEnd?: string;
  validation: ImportValidationResult;
  accepted: number;
  products: Array<{ productId: string; productName: string }>;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.access.tenantId}:${input.shopId}`}))`;
    const workspace = await tx.shopWorkspace.findFirst({ where: { tenantId: input.access.tenantId, shopId: input.shopId } });
    const data = workspace
      ? JSON.parse(JSON.stringify(workspace.data)) as Record<string, unknown>
      : await initialWorkspaceData(tx, input.access, input.shopId);
    const imports = Array.isArray(data.imports) ? data.imports as unknown as ImportBatch[] : [];
    const previous = imports.find((item) => item.reportType === input.reportType);
    const dateValues = [...new Set([...(previous?.validation.dateValues ?? []), ...input.validation.dateValues])].sort();
    const expectedStart = input.expectedStart || dateValues[0] || "";
    const expectedEnd = input.expectedEnd || dateValues.at(-1) || "";
    const expectedDays = inclusiveDays(expectedStart, expectedEnd) || input.validation.dateExpectedDays || dateValues.length;
    const mergedValidation: ImportValidationResult = {
      ...input.validation,
      rowCount: Number(previous?.rowCount || 0) + input.accepted,
      acceptedRowCount: Number(previous?.validation.acceptedRowCount || 0) + input.accepted,
      uniqueEntityCount: input.reportType === "product_source"
        ? new Set(input.products.map((item) => item.productId)).size
        : Math.max(previous?.validation.uniqueEntityCount || 0, input.validation.uniqueEntityCount),
      dateValues,
      dateObservedDays: dateValues.length,
      dateExpectedDays: expectedDays,
      warnings: [...new Set(input.validation.warnings)],
      errors: []
    };
    const cycleId = String((data.context as { cycle?: { id?: string } } | undefined)?.cycle?.id || `cycle-${input.shopId}`);
    const now = new Date().toISOString();
    const batch: ImportBatch = {
      id: `import-${input.reportType}-${Date.now()}`,
      cycleId,
      datasetId: `plugin-${input.reportType}-${Date.now()}`,
      reportType: input.reportType,
      fileName: input.fileName || `${sourceLabel(input.reportType)}_${input.acquisitionMode}`,
      fileSizeBytes: Number(previous?.fileSizeBytes || 0) + input.fileSizeBytes,
      status: "validated",
      rowCount: mergedValidation.rowCount,
      createdAt: now,
      validation: mergedValidation
    };
    data.imports = [batch, ...imports.filter((item) => item.reportType !== input.reportType)];

    if (input.reportType === "product_source" && input.products.length) {
      const items = Array.isArray(data.prefillItems) ? data.prefillItems as Array<Record<string, unknown>> : [];
      const byId = new Map(items.map((item) => [String(item.productId || ""), item]));
      for (const product of input.products) {
        const current = byId.get(product.productId);
        if (current) {
          current.productName = product.productName;
          continue;
        }
        const next: Record<string, unknown> = {
          id: `prefill-sycm-${product.productId}`,
          cycleId,
          productId: product.productId,
          productCode: product.productId,
          productName: product.productName,
          tagIds: [],
          grade: "",
          monthlyGsvOpportunity: 0,
          grossMarginRate: 0,
          paidVisitorRatio: 0.3,
          benchmarkProductId: ""
        };
        items.push(next);
        byId.set(product.productId, next);
      }
      data.prefillItems = items;
    }

    await tx.shopWorkspace.upsert({
      where: { shopId: input.shopId },
      update: { data: data as Prisma.InputJsonValue },
      create: { tenantId: input.access.tenantId, shopId: input.shopId, data: data as Prisma.InputJsonValue }
    });
    return batch;
  });
}

async function initialWorkspaceData(tx: Prisma.TransactionClient, access: DmpReportAccess, shopId: string) {
  const [tenant, user, shop] = await Promise.all([
    tx.tenant.findUnique({ where: { id: access.tenantId } }),
    tx.user.findUnique({ where: { id: access.userId } }),
    tx.shop.findFirst({ where: { id: shopId, tenantId: access.tenantId } })
  ]);
  if (!tenant || !user || !shop) throw new Error("当前店铺的三阶工作区初始化失败");
  const platform = shop.platform === "天猫" || shop.platform === "其他" ? shop.platform : "淘宝";
  return JSON.parse(JSON.stringify(buildInitialWorkspaceData({
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    user: {
      id: user.id,
      tenantId: user.tenantId,
      name: user.name,
      email: user.email,
      role: user.role === "owner" || user.role === "admin" || user.role === "viewer" ? user.role : "operator"
    },
    shop: { id: shop.id, tenantId: shop.tenantId, name: shop.name, platform },
    cycle: {
      id: `cycle-${shop.id}`,
      tenantId: tenant.id,
      shopId: shop.id,
      name: "当前分析周期",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      status: "draft"
    }
  }))) as Record<string, unknown>;
}

function uniqueProducts(items: Array<{ productId: string; productName: string }>) {
  const byId = new Map<string, { productId: string; productName: string }>();
  for (const item of items) if (ITEM_ID.test(item.productId)) byId.set(item.productId, item);
  return [...byId.values()].slice(0, 500);
}

function inclusiveDays(start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 0;
  const left = Date.parse(`${start}T00:00:00Z`);
  const right = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(left) && Number.isFinite(right) && right >= left ? Math.round((right - left) / 86_400_000) + 1 : 0;
}

function sourceLabel(reportType: ReportType) {
  if (reportType === "product_source") return "生意参谋商品";
  if (reportType === "promotion_product_source") return "无界推广商品";
  return "无界推广人群";
}
