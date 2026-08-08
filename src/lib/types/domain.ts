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

export type AudiencePlanType = "拉新" | "追投" | "收割" | "观察";

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

export type AiProvider =
  | "shaozhuang"
  | "openai"
  | "deepseek"
  | "doubao"
  | "minimax"
  | "zhipu"
  | "dashscope"
  | "custom";

export interface AiApiConfigPublic {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyHint: string;
  updatedAt: string;
  updatedBy: string;
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

export interface ShopSummary extends Shop {
  createdAt: string;
  updatedAt: string;
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
  visitors: number | null;
  views: number | null;
  averageStaySeconds: number | null;
  bounceRate: number | null;
  orderBuyers: number | null;
  paymentBuyers: number | null;
  paymentAmount: number | null;
  productPaymentConversionRate: number | null;
  refundAmount: number | null;
  visitorValue: number | null;
  searchGuidedPaymentConversionRate: number | null;
  searchGuidedVisitors: number | null;
  /** 本次聚合窗内该商品实际出现的不同日期数。 */
  observedDays?: number;
}

export interface DamoProductRow {
  productId: string;
  productName: string;
  growthStage: Lifecycle;
  paymentAmount: number | null;
  ipv: number | null;
  marketingIpv: number | null;
  marketingSpend: number | null;
  marketingRoi: number | null;
  paymentConversionRate: number | null;
  repurchaseRate: number | null;
  freeSearchClickRate: number | null;
  unitPrice: number | null;
  attachPurchaseCount: number | null;
  attachPurchaseRate: number | null;
  attachCategoryWidth: number | null;
}

export interface PromotionProductRow {
  date: string;
  subjectId: string;
  subjectName: string;
  impressions: number | null;
  clicks: number | null;
  cost: number | null;
  ctr: number | null;
  averageClickCost: number | null;
  roi: number | null;
  /** 本次聚合窗内该推广主体实际出现的不同日期数。 */
  observedDays?: number;
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
  clicks: number | null;
  roi: number | null;
  guidedVisitorCount: number | null;
  guidedPotentialCustomerRatio: number | null;
  newCustomerCount: number | null;
  newCustomerRatio: number | null;
  /** 本次聚合窗内该计划·人群·主体实际出现的不同日期数。 */
  observedDays?: number;
}

export interface PrefillItem {
  id: string;
  cycleId: string;
  productId: string;
  productCode: string;
  productName: string;
  /** 自定义商品类别标签，按店铺维护。 */
  tagIds?: string[];
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

export interface ProductTag {
  id: string;
  name: string;
  createdAt: string;
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
  /** 可以进入归一化/计算链路的行数；坏行被隔离但不阻断整批。 */
  acceptedRowCount?: number;
  /** 缺少主键、可靠日期等核心结构而被隔离的行数。 */
  rejectedRowCount?: number;
  /** 可选字段为空或格式异常的单元格数；这些字段按 null 处理。 */
  fieldIssueCount?: number;
  uniqueEntityCount: number;
  duplicateEntityIds: string[];
  dateValues: string[];
  /** 分日报表实际出现的不同日期数与首尾自然日数；用于识别中间缺日。 */
  dateObservedDays?: number;
  dateExpectedDays?: number;
  warnings: string[];
  errors: string[];
}

export interface ProductInvestmentResult {
  productId: string;
  productName: string;
  tagIds?: string[];
  lifecycle: Lifecycle;
  grade: ProductGrade;
  grossMarginRate: number;
  attackDefenseMarginRate: number;
  monthlyGsvOpportunity: number;
  plannedGrossProfit: number;
  historicalPpc: number | null;
  historicalAov: number | null;
  /**
   * 规划测算所用的 AOV/转化率是否为估算值（该商品无历史成交，回退到同分层或全店中位数）。
   * 冷启期新品必然如此；结果可用，但必须在界面上标注为估算，不能与实测值混为一谈。
   */
  planningBasis?: "observed" | "estimated";
  /** 估算来源说明（如"同 S 层 12 个商品客单价中位数"），供界面与 AI 报告解释口径。 */
  planningBasisNote?: string;
  plannedMonthlyOrders: number | null;
  plannedMonthlyTraffic: number | null;
  monthlyPaidEstimate: number | null;
  netSales: number | null;
  historicalGrossProfitWithoutPromotion: number | null;
  historicalGrossProfit: number | null;
  historicalMarginRate: number | null;
  /** 同一分析窗内是否存在可关联的推广成本；false/缺失时不得把贡献利润用于投资放行。 */
  profitEvidenceAvailable?: boolean;
  /** 与商品分析窗对齐的推广花费；旧快照可能没有该字段。 */
  promotionSpend?: number | null;
  remainingAdBudget: number | null;
  salesGap: number | null;
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
  value: number | null;
  threshold: number | null;
  /** false 表示该维度对应源表未关联成功；旧快照没有此字段时视为未知。 */
  available?: boolean;
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
  clicks: number | null;
  roi: number | null;
  guidedPotentialCustomerRatio: number | null;
  newCustomerRatio: number | null;
  /** 人群投放主体，保留后才能稳定关联到商品诊断与投资方案。 */
  subjectId?: string;
  subjectName: string;
  observedDays?: number;
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
  monthlyNetSales: number | null;
  monthlyProfitEstimate: number | null;
  monthlyGsvOpportunity: number;
  marketSalesGap: number | null;
  /**
   * 全店历史毛利率。仅由"同窗推广成本可关联"的商品构成（分子分母同步口径）；
   * 无任何证据完整商品时为 null，不得显示成 0%。
   */
  historicalMarginRate: number | null;
  plannedProfit: number;
  availableAdBudget: number | null;
  plannedMarginRate: number;
  /** 参与利润口径的商品数（证据完整）与被排除数，供看板显式提示，避免"未知"被当成 0。 */
  profitEvidenceProductCount: number;
  profitEvidenceMissingCount: number;
  /** 证据完整商品的净销额合计——historicalMarginRate 的分母，与 monthlyNetSales 不同。 */
  profitEvidenceNetSales: number | null;
  /** 高销售额但毛利率<=0 的问题商品：不能因为不进 TopProducts 榜单就从看板消失。 */
  negativeMarginProducts: ProductInvestmentResult[];
  topProducts: ProductInvestmentResult[];
  /** 本次计算实际使用的商品日期窗；随 dashboard JSON 持久化，避免旧结果误配新上传周期。 */
  analysisPeriod?: { start: string; end: string };
}

export interface CalcRun {
  schemaVersion?: number;
  id: string;
  cycleId: string;
  createdAt: string;
  analysisPeriod?: { start: string; end: string };
  investmentResults: ProductInvestmentResult[];
  breakthroughResults: ProductBreakthroughResult[];
  audiencePlans: AudiencePlanItem[];
  managementDashboard: ManagementDashboard;
}

export interface DashboardShareSnapshot {
  title: string;
  sourceTenantName: string;
  sourceShopName: string;
  createdAt: string;
  createdBy: string;
  sections?: DashboardShareSection[];
  calcRun: CalcRun;
  prefill?: DashboardSharePrefillSnapshot;
}

export type DashboardShareSection = "management" | "breakthrough" | "audience" | "prefill";

export interface DashboardSharePrefillSnapshot {
  cycleId: string;
  items: PrefillItem[];
  tags: ProductTag[];
}

export interface DashboardShareInfo {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  sections?: DashboardShareSection[];
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
export type MetricChangeStatus = import("@/lib/metric-change").MetricChangeStatus;

/** 对比口径 A：单个真实经营指标的前后变化。 */
export interface ComparisonMetric {
  key: string;
  label: string;
  unit: "money" | "int" | "rate" | "ratio"; // rate=0~1 百分比；ratio=倍数(如ROI 3.5)
  before: number | null;
  after: number | null;
  delta: number | null;
  deltaPct: number | null; // 仅常规可比变化有比例；新增/消失/不可用均为 null
  changeStatus: MetricChangeStatus;
  higherIsBetter: boolean;
  neutral?: boolean; // 中性指标（如推广花费=投入杠杆，不判好坏）
  group?: "经营" | "广告"; // 分组展示（向后兼容）
  stage?: FunnelStage; // 漏斗阶段分组
}

/** 投产链路的一个节点（花费→展现→点击→访客→买家→销售额→ROI），用于一行式描述性展示。 */
export interface FunnelChainStep {
  key: string;
  label: string;
  before: number | null;
  after: number | null;
  deltaPct: number | null;
  changeStatus: MetricChangeStatus;
  unit: ComparisonMetric["unit"];
  higherIsBetter: boolean;
  neutral?: boolean;
}

/** 对比口径 B：单商品的计划 vs 实际。 */
export interface PlanActualRow {
  productId: string;
  productName: string;
  planMonthlyGsv: number; // 预填的月GSV机会
  actualMonthlyGsv: number | null; // 后窗净销额折算月度
  /** 达成率；未设定月GSV目标时为 null（"未设目标"），不得显示成 0% 的"完全未达标"。 */
  attainmentPct: number | null;
}

/** 整店/商品集按天趋势点（对比口径 C）。含经营派生 + 推广按日，供多指标多轴下钻对比。 */
export interface DailyTrendPoint {
  date: string;
  // 经营·可加和
  netSales: number | null; // 净销额
  paymentAmount: number | null; // 销售额
  visitors: number | null;
  views: number | null; // 浏览量
  paymentBuyers: number | null;
  // 经营·强度（当日）；分母为 0（当日无成交/无访客）时为 null，趋势线显示断点而非误导的 0
  conversion: number | null; // 支付转化率 = 买家/访客
  aov: number | null; // 客单价 = 销售额/买家
  refundRate: number | null; // 退款率 = 退款/销售额
  uvValue: number | null; // 访客价值 = 销售额/访客
  // 广告·按日：可加和项无投放即为 0；强度项（CPC/ROI）当日无花费时为 null（断点）
  adCost: number | null; // 推广花费
  impressions: number | null; // 展现
  adClicks: number | null; // 点击
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
  coverage: ComparisonWindowCoverage;
}

export type ComparisonWindowStatus = "ready" | "observation" | "insufficient";

export interface ComparisonWindowSideCoverage {
  expectedDays: number;
  observedDays: number;
  coverageRatio: number;
  calendarClosed: boolean;
  complete: boolean;
}

/** 主数据源在动作前后窗的覆盖情况；非 ready 时不得输出涨跌结论。 */
export interface ComparisonWindowCoverage {
  status: ComparisonWindowStatus;
  asOfDate: string;
  message: string;
  before: ComparisonWindowSideCoverage;
  after: ComparisonWindowSideCoverage;
}

/** 一个优化动作的前后对比结果（三口径 + 投产链路）。 */
export interface InterventionComparison {
  intervention: Intervention;
  window: ComparisonWindow;
  lensA: { productScope: string; metrics: ComparisonMetric[]; chain: FunnelChainStep[] };
  lensB: { rows: PlanActualRow[] };
  lensC: { interventionDate: string; series: DailyTrendPoint[] };
}

/**
 * 单品突破：单商品的动作前后变化（漏斗维度：净销/访客/转化/客单/退款 + 投放花费/ROI）。
 *
 * 强度类指标（转化率/客单价/退款率/ROI）分母为 0 时一律为 null——新品未上架、断货、
 * 当天无投放都会出现该情况，显示成 0 会被误读成"转化崩溃"。可加和项（净销额/访客/
 * 花费）同样保留 null；只有完整源窗口内确认“未发生”时，计算层才可解释为真实 0。
 */
export interface ProductComparisonRow {
  productId: string;
  productName: string;
  netBefore: number | null;
  netAfter: number | null;
  netDeltaPct: number | null;
  netChangeStatus: MetricChangeStatus;
  visitorsBefore: number | null;
  visitorsAfter: number | null;
  /** 该商品在前/后窗内实际有分日记录的天数；日均值以此为分母，而非整店口径天数。 */
  observedDaysBefore: number;
  observedDaysAfter: number;
  convBefore: number | null;
  convAfter: number | null;
  aovBefore: number | null;
  aovAfter: number | null;
  refundRateBefore: number | null;
  refundRateAfter: number | null;
  adCostBefore: number | null;
  adCostAfter: number | null;
  adRoiBefore: number | null;
  adRoiAfter: number | null;
}

export interface ProductComparison {
  intervention: Intervention;
  window: ComparisonWindow;
  scope: string;
  hasPromo: boolean; // 作用域内是否有推广数据（决定是否展示投放列）
  rows: ProductComparisonRow[];
}

/** 人群计划：单(计划·人群·主体)的动作前后变化（点击/点击加权报表ROI代理 + 引导潜客占比/成交新客占比）。 */
export interface AudienceComparisonRow {
  /** planId/audienceName/subjectId 的转义拼接（见 runtime-store 的 keyOf），稳定唯一。 */
  key: string;
  planName: string;
  audienceName: string;
  subjectName: string;
  clicksBefore: number | null;
  clicksAfter: number | null;
  clicksDeltaPct: number | null;
  clicksChangeStatus: MetricChangeStatus;
  /** 点击加权强度指标：该侧无点击时为 null（无法计算），不得当作 0。 */
  roiBefore: number | null;
  roiAfter: number | null;
  guidedBefore: number | null;
  guidedAfter: number | null;
  newBefore: number | null;
  newAfter: number | null;
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
