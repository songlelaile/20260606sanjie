import { z } from "zod";
import type { ReportType } from "@/lib/types/domain";
import type {
  DailyAudienceMetricInput,
  DailyProductMetricInput,
  DailyPromotionMetricInput
} from "@/lib/imports/map-rows";
import type { DamoProductRow } from "@/lib/types/domain";

const identifier = z.string().trim().min(1).max(300);
const text = z.string().max(1000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const metric = z.number().finite().nullable();
const ratio = metric.refine((value) => value === null || (value >= 0 && value <= 1), {
  message: "比例必须在 0 到 1 之间"
});

const productSchema = z.object({
  productId: identifier,
  date: isoDate,
  productName: text,
  visitors: metric,
  views: metric,
  averageStaySeconds: metric,
  bounceRate: ratio,
  paymentBuyers: metric,
  paymentAmount: metric,
  productPaymentConversionRate: ratio,
  refundAmount: metric,
  searchGuidedPaymentConversionRate: ratio,
  searchGuidedVisitors: metric
});

const promotionSchema = z.object({
  subjectId: identifier,
  date: isoDate,
  subjectName: text,
  impressions: metric,
  clicks: metric,
  cost: metric,
  roi: metric
});

const audienceSchema = z.object({
  date: isoDate,
  sceneId: text,
  sceneName: text,
  planId: identifier,
  planName: text,
  audienceName: identifier,
  subjectId: identifier,
  subjectName: text,
  clicks: metric,
  roi: metric,
  guidedPotentialCustomerRatio: ratio,
  newCustomerRatio: ratio
});

const damoSchema = z.object({
  productId: identifier,
  productName: text,
  growthStage: z.enum(["冷启期", "新品成长期", "成长期", "新品打爆期", "爆品期", "平销期"]),
  paymentAmount: metric,
  ipv: metric,
  marketingIpv: metric,
  marketingSpend: metric,
  marketingRoi: metric,
  paymentConversionRate: ratio,
  repurchaseRate: ratio,
  freeSearchClickRate: ratio,
  unitPrice: metric,
  attachPurchaseCount: metric,
  attachPurchaseRate: ratio,
  attachCategoryWidth: metric
});

type MappedRow = DailyProductMetricInput | DailyPromotionMetricInput | DailyAudienceMetricInput | DamoProductRow;

export interface MappedRowValidationResult {
  acceptedRows: MappedRow[];
  rejectedCount: number;
  issues: string[];
}

/** 服务端对浏览器映射后的 DTO 逐行复验；坏行隔离，不让一行拖垮整批。 */
export function validateMappedImportRows(reportType: ReportType, rows: unknown[]): MappedRowValidationResult {
  const schema = reportType === "product_source"
    ? productSchema
    : reportType === "promotion_product_source"
      ? promotionSchema
      : reportType === "audience_source"
        ? audienceSchema
        : damoSchema;
  const acceptedRows: MappedRow[] = [];
  const issues: string[] = [];
  let rejectedCount = 0;
  for (const [index, row] of rows.entries()) {
    const parsed = schema.safeParse(row);
    if (parsed.success) {
      acceptedRows.push(parsed.data as MappedRow);
      continue;
    }
    rejectedCount += 1;
    if (issues.length < 20) {
      issues.push(
        `映射行 ${index + 1}：${parsed.error.issues.map((issue) => `${issue.path.join(".") || "row"} ${issue.message}`).join("、")}`
      );
    }
  }
  return { acceptedRows, rejectedCount, issues };
}
