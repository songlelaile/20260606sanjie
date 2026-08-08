import type {
  AdmissionMode,
  ClaimCapability,
  DiagnosisEvidenceProfile,
  DiagnosisModelId,
  ModelPortfolio
} from "@/lib/model-admission/types";

type ProfileKey = keyof DiagnosisEvidenceProfile;

export interface ModelRequirement {
  key: ProfileKey;
  label: string;
}

export interface DiagnosisModelSpec {
  modelId: DiagnosisModelId;
  portfolio: ModelPortfolio;
  displayName: string;
  summary: string;
  requirements: ModelRequirement[];
  readyMode: AdmissionMode;
  allowedClaims: ClaimCapability[];
  canProve: string[];
  cannotProve: string[];
  requiredData: string[];
}

const NO_FINANCIAL_OR_CAUSAL: ClaimCapability[] = ["unlock_financial_gate", "claim_causality"];

export const DIAGNOSIS_MODEL_REGISTRY: DiagnosisModelSpec[] = [
  spec("diagnosis-readiness", "keep_core", "数据就绪与证据边界", "先判断数据能支持哪一级结论。", [
    req("hasOperatingResults", "至少一组可识别的经营结果")
  ], "direct", ["describe"], ["当前数据覆盖与缺口"], ["业务动作的因果效果"], ["经营结果源表"]),
  spec("operating-result", "keep_core", "经营结果与健康度", "判断净销售、贡献利润和等长窗趋势。", [
    req("hasOperatingResults", "经营结果" )
  ], "direct", ["describe", "compare"], ["当前经营结果"], ["结果变化由哪个动作造成"], ["商品经营结果表"]),
  spec("profit-identity", "keep_core", "利润恒等式分解", "解释利润由哪些可观测经营项共同构成，不做因果归因。", [
    req("hasProfitEvidence", "商品与推广成本按商品ID同窗自动关联"),
    req("hasTrendComparison", "连续等长对比窗口")
  ], "direct", ["describe", "compare", "rank"], ["利润变化的描述性贡献"], ["单一动作的因果贡献"], ["连续分日商品表", "含商品ID的同窗推广花费表"]),
  spec("potential-product-pools", "keep_reworked", "潜力商品候选池", "用效率、利润和人工机会目标筛选验证对象。", [
    req("hasOpportunityTargets", "商品目标与经营结果")
  ], "proxy", ["describe", "rank", "propose_test"], ["候选商品相对优先级"], ["真实市场空间或未来销量"], ["商品目标、经营结果与同期市场映射"]),
  spec("product-bottleneck", "keep_reworked", "商品八维瓶颈", "只对有直接指标的维度定位相对短板。", [
    req("hasProductDimensions", "商品八维直接指标")
  ], "direct", ["describe", "compare", "rank", "propose_test"], ["商品当前相对短板"], ["修复动作一定带来增长"], ["商品效果表与八维字段"]),
  spec("audience-plan", "keep_reworked", "人群计划方向", "拉新、追投、收割先给结构和测试方法。", [
    req("hasAudienceSignals", "人群点击与角色信号")
  ], "proxy", ["describe", "rank", "propose_test"], ["人群方向与样本状态"], ["精确 CPC、CPA、预算或真实增量回报"], ["人群花费、成交、支付、真实转化与贡献利润"]),
  spec("investment-action-network", "keep_core", "投资闸门与动作网络", "连接投资对象、前置修复、预算审批、里程碑与止损。", [
    req("hasProfitEvidence", "贡献利润证据"),
    req("hasOpportunityTargets", "投资对象候选")
  ], "direct", ["describe", "rank", "propose_test"], ["静态经济边界与动作依赖"], ["自动获批预算或自动放量"], ["人工审批预算", "库存与现金约束"]),
  spec("effect-validation", "keep_core", "动作前后窗验证", "完整等长窗口只描述动作后的变化。", [
    req("hasClosedComparison", "完整且已闭合的动作前后窗")
  ], "direct", ["describe", "compare"], ["动作前后观察值变化"], ["动作造成了变化"], ["动作日期、作用范围与完整前后窗"]),
  spec("category-portfolio", "keep_reworked", "类目经营分组", "按规模、效率与可比趋势形成候选分组，不冒充 BCG。", [
    req("hasCategoryData", "稳定的叶子类目数据"),
    req("hasComparableCategoryPeriods", "相邻可比月份")
  ], "direct", ["describe", "compare", "rank", "propose_test"], ["店内类目相对分组"], ["相对市场份额或市场增长率"], ["连续同口径类目月表"]),
  spec("evidence-value-chain", "keep_reworked", "分阶段经营链路", "逐阶段展示直接指标和缺口，不用缺数冒充低分。", [
    req("hasCategoryData", "本店类目或商品链路数据")
  ], "direct", ["describe", "compare", "rank", "propose_test"], ["有直接字段环节的经营卡点"], ["完整组织价值链或因果瓶颈"], ["各链路直接指标"]),
  spec("market-opportunity-radar", "keep_reworked", "市场方向雷达", "同期市场信号也只进入假设与小样本验证。", [
    req("hasMarketSignals", "市场价格带、属性或搜索信号")
  ], "proxy", ["describe", "rank", "propose_test"], ["市场方向信号排序"], ["店铺已获得的市场机会"], ["同期市场表与店铺—市场类目稳定映射"]),
  spec("evidence-synthesis", "keep_reworked", "证据化经营归纳", "把已准入的内外部证据归纳为优势、约束、机会和风险。", [
    req("hasOperatingResults", "内部经营证据")
  ], "qualitative", ["describe", "rank", "propose_test"], ["已观测证据的结构化摘要"], ["独立于底层证据的新事实"], ["经营结果与必要外部证据"]),
  spec("experience-curve", "conditional", "经典经验曲线", "需要累计产量与单位成本序列后才启用。", [
    req("hasUnitCostCurve", "至少六个可比期的累计产量与单位成本")
  ], "direct", ["describe", "compare"], ["单位成本随累计经验的变化"], ["仅凭访客价值推断学习效应"], ["累计产量/订单量", "单位成本", "至少六个可比期"]),
  spec("scale-economy", "conditional", "真正规模效应", "需要规模—成本观察和固定/变动成本拆分。", [
    req("hasScaleCostStructure", "规模、固定成本与变动成本序列")
  ], "direct", ["describe", "compare"], ["单位成本与规模的关系"], ["仅凭类目集中度推断规模经济"], ["固定/变动/采购/履约成本", "至少六个规模观察点"]),
  spec("pest", "conditional", "PEST", "四个维度分别有带来源、日期和范围的直接证据后启用。", [
    req("hasMacroEvidence", "政策、经济、社会、技术直接资料")
  ], "qualitative", ["describe"], ["外部环境直接证据"], ["用店铺指标自动生成 PEST 分数"], ["政策与平台规则", "经济指标", "消费趋势", "技术变化资料"]),
  spec("porter-five-forces", "conditional", "波特五力", "每一力需要明确市场范围及直接竞争证据。", [
    req("hasCompetitionEvidence", "竞对、供应、买方、替代与进入壁垒资料")
  ], "qualitative", ["describe", "compare"], ["明确市场范围内的竞争结构"], ["用店内经营数据推断五力强度"], ["竞对份额与价格", "供应商集中度", "用户转换", "替代品与进入壁垒"]),
  spec("seven-s", "conditional", "麦肯锡 7S", "组织资料和跨角色访谈达到覆盖要求后启用。", [
    req("hasOrganizationEvidence", "组织资料与跨角色访谈")
  ], "qualitative", ["describe"], ["组织七维的访谈事实"], ["用经营结果替代组织健康诊断"], ["组织架构、制度、人员、能力与管理访谈"]),
  spec("nps", "conditional", "真实 NPS", "必须采集 0–10 分推荐意愿问卷。", [
    req("hasNpsSurvey", "有效 NPS 推荐意愿问卷")
  ], "direct", ["describe", "compare"], ["推荐者、中立者和贬损者结构"], ["用退款或转化率冒充 NPS"], ["0–10 分问卷与样本量", "问卷时间、商品和订单关联"]),
  spec("incrementality-attribution", "conditional", "增量效果归因", "需要控制组、前趋势和重叠动作检查。", [
    req("hasClosedComparison", "完整动作前后窗"),
    req("hasControlGroup", "可比控制组与前趋势")
  ], "direct", ["describe", "compare", "claim_causality"], ["受设计约束的增量效果"], ["无控制设计时宣称因果"], ["控制组", "前趋势", "重叠动作检查"]),
  retired("classic-bcg-from-target-gap", "人工目标差额伪 BCG", "人工 GSV 目标不能冒充市场增长率与相对份额。"),
  retired("proxy-nps-as-nps", "经营代理分冒充 NPS", "退款和转化只能形成售后风险信号。"),
  retired("short-window-monthly-extrapolation", "短窗外推整月结论", "短窗数据不直接判定整月目标和趋势。"),
  retired("roi-auto-scale", "ROI 自动加码", "报表 ROI 代理不能自动触发预算。"),
  retired("profit-buffer-as-budget", "利润安全垫直接当预算", "静态安全空间不是审批预算。")
];

function req(key: ProfileKey, label: string): ModelRequirement {
  return { key, label };
}

function spec(
  modelId: DiagnosisModelId,
  portfolio: Exclude<ModelPortfolio, "retire">,
  displayName: string,
  summary: string,
  requirements: ModelRequirement[],
  readyMode: AdmissionMode,
  allowedClaims: ClaimCapability[],
  canProve: string[],
  cannotProve: string[],
  requiredData: string[]
): DiagnosisModelSpec {
  return {
    modelId,
    portfolio,
    displayName,
    summary,
    requirements,
    readyMode,
    allowedClaims,
    canProve,
    cannotProve,
    requiredData
  };
}

function retired(modelId: DiagnosisModelId, displayName: string, summary: string): DiagnosisModelSpec {
  return {
    modelId,
    portfolio: "retire",
    displayName,
    summary,
    requirements: [],
    readyMode: "disabled",
    allowedClaims: [],
    canProve: [],
    cannotProve: [summary],
    requiredData: []
  };
}

export const DEFAULT_FORBIDDEN_CLAIMS = NO_FINANCIAL_OR_CAUSAL;
