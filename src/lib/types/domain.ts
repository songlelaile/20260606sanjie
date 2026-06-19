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

/**
 * 优化动作"类别" = 单品突破「三维八步·方案整改」的八个维度（运营标记动作时选它整改的突破方向），末位「其他」兜底。
 * 与 three-stage.ts 的 dimensionLabels 同源（此处用更简短的下拉文案）。这样标记的动作能直接对应到它在整改哪个突破维度，
 * 前后对比即可解读"整改 X 维度是否见效"。
 */
export const INTERVENTION_CATEGORIES = [
  "搜索展现价值",
  "搜索支付转化率",
  "平均停留时长",
  "跳失率",
  "退款率",
  "连带购买率",
  "连带类目宽度",
  "复购率",
  "其他"
] as const;

/** 运营手动标记的"优化动作"（v2 前后对比锚点）。 */
export interface Intervention {
  id: string;
  date: string; // ISO YYYY-MM-DD，动作发生日
  title: string;
  note: string;
  category: string; // 预算/主图/价格/人群/详情/其他
  productIds: string[]; // 受影响商品；空数组=整店
  createdBy: string;
  createdAt: string;
}

/** 漏斗阶段：投放→流量→成交→利润，让前后对比按因果链路分组。 */
export type FunnelStage = "投放" | "流量" | "成交" | "利润";

/** 对比口径 A：单个真实经营指标的前后变化。 */
export interface ComparisonMetric {
  key: string;
  label: string;
  unit: "money" | "int" | "rate" | "ratio"; // rate=0~1 百分比；ratio=倍数(如ROI 3.5)
  before: number;
  after: number;
  delta: number;
  deltaPct: number; // 相对变化（after-before)/|before|
  higherIsBetter: boolean;
  neutral?: boolean; // 中性指标（如推广花费=投入杠杆，不判好坏）
  group?: "经营" | "广告"; // 分组展示（向后兼容）
  stage?: FunnelStage; // 漏斗阶段分组
}

/** 投产链路的一个节点（花费→展现→点击→访客→买家→销售额→ROI），用于"环环相扣"的一行式因果展示。 */
export interface FunnelChainStep {
  key: string;
  label: string;
  before: number;
  after: number;
  deltaPct: number;
  unit: ComparisonMetric["unit"];
  higherIsBetter: boolean;
  neutral?: boolean;
}

/** 对比口径 B：单商品的计划 vs 实际。 */
export interface PlanActualRow {
  productId: string;
  productName: string;
  planMonthlyGsv: number; // 预填的月GSV机会
  actualMonthlyGsv: number; // 后窗净销额折算月度
  attainmentPct: number; // 达成率
}

/** 整店/商品集按天趋势点（对比口径 C）。含经营派生 + 推广按日，供多指标多轴下钻对比。 */
export interface DailyTrendPoint {
  date: string;
  // 经营·可加和
  netSales: number; // 净销额
  paymentAmount: number; // 销售额
  visitors: number;
  views: number; // 浏览量
  paymentBuyers: number;
  // 经营·强度（当日）；分母为 0（当日无成交/无访客）时为 null，趋势线显示断点而非误导的 0
  conversion: number | null; // 支付转化率 = 买家/访客
  aov: number | null; // 客单价 = 销售额/买家
  refundRate: number | null; // 退款率 = 退款/销售额
  uvValue: number | null; // 访客价值 = 销售额/访客
  // 广告·按日：可加和项无投放即为 0；强度项（CPC/ROI）当日无花费时为 null（断点）
  adCost: number; // 推广花费
  impressions: number; // 展现
  adClicks: number; // 点击
  cpc: number | null; // 点击成本 = 花费/点击
  adRoi: number | null; // 推广ROI（当日花费加权）
}

export interface ComparisonWindow {
  beforeStart: string;
  beforeEnd: string;
  afterStart: string;
  afterEnd: string;
  beforeDays: number;
  afterDays: number;
}

/** 一个优化动作的前后对比结果（三口径 + 投产链路）。 */
export interface InterventionComparison {
  intervention: Intervention;
  window: ComparisonWindow;
  lensA: { productScope: string; metrics: ComparisonMetric[]; chain: FunnelChainStep[] };
  lensB: { rows: PlanActualRow[] };
  lensC: { interventionDate: string; series: DailyTrendPoint[] };
}

/** 单品突破：单商品的动作前后变化（漏斗维度：净销/访客/转化/客单/退款 + 投放花费/ROI）。 */
export interface ProductComparisonRow {
  productId: string;
  productName: string;
  netBefore: number;
  netAfter: number;
  netDeltaPct: number;
  visitorsBefore: number;
  visitorsAfter: number;
  convBefore: number;
  convAfter: number;
  aovBefore: number;
  aovAfter: number;
  refundRateBefore: number;
  refundRateAfter: number;
  adCostBefore: number;
  adCostAfter: number;
  adRoiBefore: number;
  adRoiAfter: number;
}

export interface ProductComparison {
  intervention: Intervention;
  window: ComparisonWindow;
  scope: string;
  hasPromo: boolean; // 作用域内是否有推广数据（决定是否展示投放列）
  rows: ProductComparisonRow[];
}

/** 人群计划：单(计划·人群·主体)的动作前后变化（点击/ROI + 引导潜客占比/成交新客占比=拉新质量）。 */
export interface AudienceComparisonRow {
  key: string; // planId|||audienceName|||subjectId，稳定唯一
  planName: string;
  audienceName: string;
  subjectName: string;
  clicksBefore: number;
  clicksAfter: number;
  clicksDeltaPct: number;
  roiBefore: number;
  roiAfter: number;
  guidedBefore: number;
  guidedAfter: number;
  newBefore: number;
  newAfter: number;
}

export interface AudienceComparison {
  intervention: Intervention;
  window: ComparisonWindow;
  rows: AudienceComparisonRow[];
}

export interface ManagementHistoryState {
  records: ManagementHistoryRecord[];
  reports: ManagementHistoryReport[];
  retention: ManagementHistoryRetention;
}
