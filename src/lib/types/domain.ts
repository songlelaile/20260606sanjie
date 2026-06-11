export type Role = "owner" | "admin" | "operator" | "viewer";

export type ReportType =
  | "product_source"
  | "damo_product_source"
  | "promotion_product_source"
  | "audience_source";

export type ImportStatus = "uploaded" | "validated" | "failed";

export type Lifecycle =
  | "冷启期"
  | "新品成长期"
  | "成长期"
  | "新品打爆期"
  | "爆品期"
  | "平销期";

export type ProductGrade = "S" | "A" | "B" | "C";

export type AudiencePlanType = "拉新" | "追投" | "收割";

export type ProfitMarginMatrix = Record<ProductGrade, Record<Lifecycle, number>>;

export interface GrowthProfitConfigRow {
  grade: ProductGrade;
  values: Record<Lifecycle, number>;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
}

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: Role;
}

export interface InviteCode {
  id: string;
  tenantId: string;
  code: string;
  registrationUrl: string;
  usedCount: number;
  maxUses: number;
  note: string;
  createdAt: string;
  createdBy: string;
}

export type ManagedUserStatus = "active" | "pending" | "disabled";

export interface ManagedUser {
  id: string;
  tenantId: string;
  name: string;
  username: string;
  email: string;
  role: Role;
  shopName: string;
  status: ManagedUserStatus;
  createdAt: string;
  lastActiveAt: string;
}

export interface Shop {
  id: string;
  tenantId: string;
  name: string;
  platform: "淘宝" | "天猫" | "其他";
}

export interface AnalysisCycle {
  id: string;
  tenantId: string;
  shopId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "draft" | "ready" | "calculated";
}

export interface ProductSourceRow {
  date: string;
  productId: string;
  productName: string;
  visitors: number;
  views: number;
  averageStaySeconds: number;
  bounceRate: number;
  orderBuyers: number;
  paymentBuyers: number;
  paymentAmount: number;
  productPaymentConversionRate: number;
  refundAmount: number;
  visitorValue: number;
  searchGuidedPaymentConversionRate: number;
  searchGuidedVisitors: number;
}

export interface DamoProductRow {
  productId: string;
  productName: string;
  growthStage: Lifecycle;
  paymentAmount: number;
  ipv: number;
  marketingIpv: number;
  marketingSpend: number;
  marketingRoi: number;
  paymentConversionRate: number;
  repurchaseRate: number;
  freeSearchClickRate: number;
  unitPrice: number;
  attachPurchaseCount: number;
  attachPurchaseRate: number;
  attachCategoryWidth: number;
}

export interface PromotionProductRow {
  date: string;
  subjectId: string;
  subjectName: string;
  impressions: number;
  clicks: number;
  cost: number;
  ctr: number;
  averageClickCost: number;
  roi: number;
}

export interface AudienceSourceRow {
  dateRange: string;
  sceneId: string;
  sceneName: string;
  planId: string;
  planName: string;
  audienceName: string;
  subjectId: string;
  subjectName: string;
  clicks: number;
  roi: number;
  guidedVisitorCount: number;
  guidedPotentialCustomerRatio: number;
  newCustomerCount: number;
  newCustomerRatio: number;
}

export interface PrefillItem {
  id: string;
  cycleId: string;
  productId: string;
  productCode: string;
  productName: string;
  /** 空串表示运营尚未填写分层（仅占位，不参与三阶计算）。 */
  grade: ProductGrade | "";
  monthlyGsvOpportunity: number;
  grossMarginRate: number;
  paidVisitorRatio: number;
  imageUrl?: string;
  competitorConversionExpectation?: number;
  benchmarkProductId?: string;
  audienceStrategy?: string;
}

export interface ImportBatch {
  id: string;
  cycleId: string;
  datasetId: string;
  reportType: ReportType;
  fileName: string;
  fileSizeBytes: number;
  status: ImportStatus;
  rowCount: number;
  createdAt: string;
  validation: ImportValidationResult;
}

export interface ImportValidationResult {
  ok: boolean;
  reportType: ReportType;
  receivedHeaders: string[];
  requiredHeaders: string[];
  missingHeaders: string[];
  extraHeaders: string[];
  rowCount: number;
  uniqueEntityCount: number;
  duplicateEntityIds: string[];
  dateValues: string[];
  warnings: string[];
  errors: string[];
}

export interface ProductInvestmentResult {
  productId: string;
  productName: string;
  lifecycle: Lifecycle;
  grade: ProductGrade;
  grossMarginRate: number;
  attackDefenseMarginRate: number;
  monthlyGsvOpportunity: number;
  plannedGrossProfit: number;
  historicalPpc: number;
  historicalAov: number;
  plannedMonthlyOrders: number;
  plannedMonthlyTraffic: number;
  monthlyPaidEstimate: number;
  netSales: number;
  historicalGrossProfitWithoutPromotion: number;
  historicalGrossProfit: number;
  historicalMarginRate: number;
  remainingAdBudget: number;
  salesGap: number;
}

export interface BreakthroughDimensionScore {
  key:
    | "searchDisplayValue"
    | "searchPaymentConversionRate"
    | "averageStaySeconds"
    | "bounceRate"
    | "refundRate"
    | "attachPurchaseRate"
    | "attachCategoryWidth"
    | "repurchaseRate";
  label: string;
  value: number;
  threshold: number;
  passed: boolean;
  higherIsBetter: boolean;
}

export interface ProductBreakthroughResult {
  productId: string;
  productCode: string;
  productName: string;
  lifecycle: Lifecycle;
  grade: ProductGrade;
  dimensions: BreakthroughDimensionScore[];
  score: number;
  solutionCode: string;
  solution: string;
}

export interface AudiencePlanItem {
  type: AudiencePlanType;
  sceneName: string;
  planId: string;
  planName: string;
  audienceName: string;
  clicks: number;
  roi: number;
  guidedPotentialCustomerRatio: number;
  newCustomerRatio: number;
  subjectName: string;
}

export type HistoryDataKey =
  | "product"
  | "promotionProduct"
  | "promotionContent"
  | "keyword"
  | "audience";

export interface ManagementHistoryRecord {
  id: string;
  tenantId: string;
  shopId: string;
  cycleId: string;
  uploadAt: string;
  dataRangeStart: string;
  dataRangeEnd: string;
  counts: Record<HistoryDataKey, number>;
  note: string;
  reportName?: string;
}

export interface ManagementHistoryReport {
  id: string;
  tenantId: string;
  shopId: string;
  cycleId: string;
  name: string;
  createdAt: string;
  createdBy: string;
  startDate: string;
  endDate: string;
  categories: HistoryDataKey[];
}

export interface ManagementHistoryRetention {
  tenantId: string;
  months: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ManagementDashboard {
  productCount: number;
  monthlyNetSales: number;
  monthlyProfitEstimate: number;
  monthlyGsvOpportunity: number;
  marketSalesGap: number;
  historicalMarginRate: number;
  plannedProfit: number;
  availableAdBudget: number;
  plannedMarginRate: number;
  topProducts: ProductInvestmentResult[];
}

export interface CalcRun {
  id: string;
  cycleId: string;
  createdAt: string;
  investmentResults: ProductInvestmentResult[];
  breakthroughResults: ProductBreakthroughResult[];
  audiencePlans: AudiencePlanItem[];
  managementDashboard: ManagementDashboard;
}

export interface VersionSnapshot {
  id: string;
  cycleId: string;
  shopId: string;
  kind: "import" | "prefill" | "profit_config" | "calculation" | "history";
  title: string;
  createdAt: string;
  createdBy: string;
  summary: string;
}

export interface ManagementHistoryState {
  records: ManagementHistoryRecord[];
  reports: ManagementHistoryReport[];
  retention: ManagementHistoryRetention;
}
