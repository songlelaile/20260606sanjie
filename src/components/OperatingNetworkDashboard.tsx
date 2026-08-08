import {
  Activity,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Coins,
  DatabaseZap,
  Flag,
  Gauge,
  GitBranch,
  LockKeyhole,
  Network,
  PackageSearch,
  ShieldAlert,
  Target,
  UsersRound,
  WalletCards,
  Workflow
} from "lucide-react";
import type { ReactNode } from "react";
import { CopyIdentifier } from "@/components/CopyIdentifier";
import { DiagnosisModelPolicyPanel } from "@/components/DiagnosisModelPolicyPanel";
import type { OperatingNetworkSnapshot } from "@/lib/operating-network";

export type OperatingDiagnosisFocus = "full" | "management" | "product" | "audience";

type UnknownRecord = Record<string, unknown>;
type FindingStatus = "positive" | "warning" | "critical" | "insufficient";
type ConfidenceLevel = "high" | "medium" | "low";

interface DisplayConfidence {
  score: number;
  level: ConfidenceLevel;
  reasons: string[];
}

interface DisplayFinding {
  id: string;
  title: string;
  conclusion: string;
  status: FindingStatus;
  proof: string[];
  cannotProve: string[];
  requiredData: string[];
  confidence: DisplayConfidence;
}

interface DisplayNode {
  id: string;
  title: string;
  subtitle: string;
  finding: DisplayFinding;
  values: Array<{ key: string; label: string; value: unknown }>;
  raw: UnknownRecord;
}

interface DisplayAction extends DisplayNode {
  owner: string;
  priority: "P1" | "P2" | "P3";
  status: "ready" | "blocked" | "conditional";
  dependsOn: string[];
  gateIds: string[];
  metric: string;
  stopCondition: string;
}

interface DisplayGate extends DisplayNode {
  status: "pass" | "conditional" | "fail";
  criterion: string;
}

interface DisplayMilestone extends DisplayNode {
  horizon: string;
  objective: string;
  successCriteria: string[];
  stopConditions: string[];
}

interface DisplaySnapshot {
  generatedAt: string;
  periodLabel: string;
  rootFinding: DisplayFinding;
  readiness: DisplayNode;
  outcome: DisplayNode;
  profitDrivers: DisplayNode[];
  investmentSpace: DisplayNode;
  potentialProducts: DisplayNode[];
  dimensionShortfalls: DisplayNode[];
  audienceRecommendations: DisplayNode[];
  actions: DisplayAction[];
  budgetGates: DisplayGate[];
  milestones: DisplayMilestone[];
}

const FIELD_LABELS: Record<string, string> = {
  actual: "当前值",
  actualValue: "当前值",
  actualDisplay: "当前值",
  analysisDays: "分析天数",
  availableAdBudget: "静态利润安全垫（非预算）",
  approvedBudget: "已审批预算",
  confidenceScore: "置信度",
  contribution: "贡献",
  contributionRate: "贡献占比",
  conversion: "支付转化",
  conversionRate: "支付转化",
  cost: "可归因投入成本",
  current: "当前值",
  delta: "变化",
  gap: "差距",
  economicCeiling: "静态经济承压上限",
  eligibleProductCount: "具备正向安全垫商品",
  grossProfit: "贡献利润估算",
  historicalGrossProfit: "分析窗贡献利润估算",
  historicalMarginRate: "分析窗贡献利润率",
  impact: "预期影响",
  investmentValue: "投资价值",
  marginRate: "利润率",
  monthlyGsvOpportunity: "月 GSV 机会",
  monthlyEquivalentNetSales: "30天月化净销估算",
  maxCpaEstimate: "CPA 经济边界估算",
  maxCpcProxy: "CPC 上限",
  medianRoiFloor: "ROI 底线中位数",
  netSales: "分析窗净销售额",
  netSalesTrend: "等长窗净销售变化",
  opportunity: "机会空间",
  opportunityAmount: "机会空间",
  paymentAmount: "支付额",
  promotionSpend: "同窗推广花费",
  priorityProxy: "经营影响代理分",
  productCount: "商品数",
  readyCount: "可执行项",
  refundRate: "退款率",
  staticProfitBuffer: "静态利润安全垫",
  profitBuffer: "目标利润安全垫",
  profitTrend: "等长窗利润估算变化",
  reserveBudget: "保留预算",
  roi: "点击加权报表 ROI 代理",
  roiFloor: "商品经济模型 ROI 底线",
  score: "评分",
  target: "目标值",
  targetMarginRate: "目标保留利润率",
  suggestedTestBudget: "建议测试预算",
  startingBidSuggestion: "出价方法",
  budgetStep: "预算推进方法",
  clicks: "点击样本",
  gapRate: "相对样本基准差距",
  benchmarkDisplay: "中位基准",
  value: "数值",
  visitors: "访客"
};

const MONEY_KEYS = /(amount|sales|profit|budget|cost|gsv|opportunity|aov|cpa|cpc|ceiling|buffer)/i;
const RATE_KEYS = /(rate|ratio|share|conversion|margin|refund|deltaPct|attainment)/i;
const OMIT_VALUE_KEYS = new Set([
  "id",
  "key",
  "title",
  "name",
  "label",
  "conclusion",
  "diagnosis",
  "summary",
  "description",
  "action",
  "finding",
  "confidence",
  "proof",
  "cannotProve",
  "requiredData",
  "status",
  "priority",
  "owner",
  "dependsOn",
  "gateIds",
  "metric",
  "stopCondition",
  "horizon",
  "objective",
  "successCriteria",
  "stopConditions",
  "items",
  "rows",
  "products",
  "drivers",
  "recommendations",
  "score",
  "productId",
  "productName",
  "manualGrade",
  "pool",
  "role",
  "audienceName",
  "planId",
  "dimensionKey",
  "opportunityConfidence",
  "efficiencyBadge",
  "profitBadge",
  "opportunityBadge",
  "health",
  "direction",
  "actualValue",
  "benchmarkValue"
]);

export function OperatingNetworkDashboard({
  snapshot,
  focus = "full"
}: {
  snapshot: OperatingNetworkSnapshot;
  focus?: OperatingDiagnosisFocus;
}) {
  const model = normalizeSnapshot(snapshot);
  const visibleActions = actionsForFocus(model.actions, focus);
  const visibleGates = gatesForFocus(model.budgetGates, focus);
  const actionTitleById = new Map(model.actions.map((action) => [action.id, action.title]));
  const gateTitleById = new Map(model.budgetGates.map((gate) => [gate.id, gate.title]));
  const proofCount = model.rootFinding.proof.length;
  const cannotCount = model.rootFinding.cannotProve.length;
  const missingCount = model.rootFinding.requiredData.length;
  const networkStages = [
    stage("经营结果", Activity, model.outcome.finding),
    stage("利润归因", Coins, strongestFinding(model.profitDrivers, model.investmentSpace.finding)),
    stage("投资价值", WalletCards, model.investmentSpace.finding),
    stage("潜力商品", PackageSearch, strongestFinding(model.potentialProducts, model.rootFinding)),
    stage("商品短板", Gauge, strongestFinding(model.dimensionShortfalls, model.rootFinding)),
    stage("人群计划", UsersRound, strongestFinding(model.audienceRecommendations, model.rootFinding)),
    stage("动作与验证", Workflow, strongestFinding(model.actions, model.rootFinding))
  ];

  return (
    <div className="operating-network-dashboard">
      {focus === "full" ? (
        <>
          <section className={`operating-network-hero is-${model.rootFinding.status}`}>
        <div className="operating-network-hero-copy">
          <span className="operating-network-eyebrow">
            <Network size={16} /> 经营诊断网络
          </span>
          <h2>{model.rootFinding.title}</h2>
          <p>{model.rootFinding.conclusion}</p>
          <div className="operating-network-hero-meta">
            <StatusBadge status={model.rootFinding.status} />
            <ConfidenceBadge confidence={model.rootFinding.confidence} />
            {model.periodLabel ? <span>{model.periodLabel}</span> : null}
            {model.generatedAt ? <span>生成于 {formatDateTime(model.generatedAt)}</span> : null}
          </div>
        </div>
        <div className="operating-network-proof-totals" aria-label="证据边界概览">
          <ProofTotal icon={<BadgeCheck size={17} />} label="能证明" value={proofCount} tone="proven" />
          <ProofTotal icon={<ShieldAlert size={17} />} label="不能证明" value={cannotCount} tone="unproven" />
          <ProofTotal icon={<DatabaseZap size={17} />} label="待补表" value={missingCount} tone="missing" />
        </div>
          </section>

          <section className="operating-network-spine" aria-label="经营诊断主链">
            {networkStages.map((item, index) => {
              const Icon = item.icon;
              return (
                <div className={`operating-network-stage is-${item.finding.status}`} key={item.label}>
                  <span className="operating-network-stage-icon"><Icon size={17} /></span>
                  <div>
                    <strong>{item.label}</strong>
                    <small>{confidenceLabel(item.finding.confidence.level)} · {Math.round(item.finding.confidence.score)}%</small>
                  </div>
                  {index < networkStages.length - 1 ? <ArrowRight className="operating-network-stage-arrow" size={15} /> : null}
                </div>
              );
            })}
          </section>
        </>
      ) : (
        <FocusBanner focus={focus} model={model} />
      )}

      {focus === "full" || focus === "management" ? (
        <>
          <section className="operating-network-overview-grid">
        <FindingPanel
          className="operating-network-outcome"
          icon={<BarChart3 size={17} />}
          eyebrow="01 · 经营结果"
          node={model.outcome}
          empty="当前没有可确认的经营结果。"
        />
        <FindingPanel
          className="operating-network-readiness"
          icon={<CircleDashed size={17} />}
          eyebrow="诊断就绪度"
          node={model.readiness}
          empty="当前缺少诊断就绪度信息。"
        />
          </section>

          <section className="operating-network-dual-grid">
        <NodeListPanel
          eyebrow="02 · 利润归因"
          title="利润变化由哪些经营因子共同解释"
          icon={<Coins size={17} />}
          nodes={model.profitDrivers}
          empty="暂无可以归因的利润驱动项。"
          context={<ProfitAttributionScope />}
        />
        <FindingPanel
          eyebrow="03 · 投资价值"
          icon={<WalletCards size={17} />}
          node={model.investmentSpace}
          empty="当前证据不足，暂不能给出投资空间。"
        />
          </section>
        </>
      ) : null}

      {focus === "full" || focus === "product" ? (
        <section className="operating-network-dual-grid">
        <NodeListPanel
          eyebrow="04 · 潜力商品"
          title="先筛机会，再判断是否值得放量"
          icon={<PackageSearch size={17} />}
          nodes={model.potentialProducts}
          empty="暂无同时满足机会与质量条件的商品。"
          numbered
          copyProductId
        />
        <NodeListPanel
          eyebrow="05 · 商品短板"
          title="放量前必须修复的承接环节"
          icon={<Gauge size={17} />}
          nodes={model.dimensionShortfalls}
          empty="暂无可确认的商品维度短板。"
          copyProductId
        />
        </section>
      ) : null}

      {focus === "full" || focus === "audience" ? <NodeListPanel
        eyebrow="06 · 人群计划"
        title="让人群进入对应商品与经营目标"
        icon={<UsersRound size={17} />}
        nodes={model.audienceRecommendations}
        empty="暂无具备足够样本的人群建议。"
        horizontal
      /> : null}

      <section className="operating-network-section operating-network-actions-section">
        <SectionHeading
          eyebrow="07 · 动作网络"
          title="先依赖、过闸门、到里程碑，再决定是否加码"
          icon={<GitBranch size={18} />}
          meta={`${visibleActions.length} 个当前视角动作`}
        />
        {visibleActions.length > 0 ? (
          <div className="operating-network-action-network" role="list">
            {visibleActions.map((action, index) => (
              <article className={`operating-network-action-node is-${action.status}`} role="listitem" key={action.id}>
                <div className="operating-network-action-rail" aria-hidden="true">
                  <span>{index + 1}</span>
                </div>
                <div className="operating-network-action-body">
                  <header>
                    <div>
                      <span className={`operating-network-priority is-${action.priority.toLowerCase()}`}>{action.priority}</span>
                      <ActionStatus status={action.status} />
                    </div>
                    <ConfidenceBadge confidence={action.finding.confidence} compact />
                  </header>
                  <h3>{action.title}</h3>
                  <p>{action.finding.conclusion || action.subtitle}</p>
                  <div className="operating-network-action-owner">
                    <span>负责人</span><strong>{action.owner || "待指定"}</strong>
                  </div>
                  <div className="operating-network-action-links">
                    <ActionLinkGroup
                      icon={<GitBranch size={14} />}
                      label="依赖"
                      empty="可独立启动"
                      values={action.dependsOn.map((id) => actionTitleById.get(id) ?? id)}
                    />
                    <ActionLinkGroup
                      icon={<LockKeyhole size={14} />}
                      label="闸门"
                      empty="无额外闸门"
                      values={action.gateIds.map((id) => gateTitleById.get(id) ?? id)}
                    />
                    <ActionLinkGroup
                      icon={<Target size={14} />}
                      label="验证指标"
                      values={action.metric ? [action.metric] : []}
                      empty="待定义"
                    />
                    <ActionLinkGroup
                      icon={<CircleAlert size={14} />}
                      label="止损条件"
                      values={action.stopCondition ? [action.stopCondition] : []}
                      empty="待定义"
                    />
                  </div>
                  <CompactEvidence finding={action.finding} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState text="当前没有满足证据条件的动作节点。" />
        )}
      </section>

      <section className="operating-network-verification-grid">
        <div className="operating-network-section">
          <SectionHeading
            eyebrow="预算闸门"
            title="不满足条件，就不进入放量阶段"
            icon={<LockKeyhole size={18} />}
            meta={`${visibleGates.filter((gate) => gate.status === "pass").length}/${visibleGates.length} 已通过`}
          />
          {visibleGates.length > 0 ? (
            <div className="operating-network-gates">
              {visibleGates.map((gate) => (
                <article className={`operating-network-gate is-${gate.status}`} key={gate.id}>
                  <header>
                    <GateIcon status={gate.status} />
                    <strong>{gate.title}</strong>
                    <span>{gateStatusLabel(gate.status)}</span>
                  </header>
                  <p>{gate.criterion}</p>
                  <ConfidenceBadge confidence={gate.finding.confidence} compact />
                </article>
              ))}
            </div>
          ) : (
            <EmptyState text="预算闸门尚未定义。" />
          )}
        </div>

        <div className="operating-network-section">
          <SectionHeading
            eyebrow="验证里程碑"
            title="用结果决定继续、修正或止损"
            icon={<Flag size={18} />}
            meta={`${model.milestones.length} 个节点`}
          />
          {model.milestones.length > 0 ? (
            <div className="operating-network-milestones">
              {model.milestones.map((milestone, index) => (
                <article key={milestone.id}>
                  <div className="operating-network-milestone-index">M{index + 1}</div>
                  <div>
                    <span className="operating-network-milestone-horizon">{milestone.horizon || "待排期"}</span>
                    <h3>{milestone.objective || milestone.title}</h3>
                    <CriteriaList title="成功标准" items={milestone.successCriteria} tone="good" />
                    <CriteriaList title="停止条件" items={milestone.stopConditions} tone="bad" />
                  </div>
                  <ConfidenceBadge confidence={milestone.finding.confidence} compact />
                </article>
              ))}
            </div>
          ) : (
            <EmptyState text="验证里程碑尚未形成。" />
          )}
        </div>
      </section>

      <DiagnosisModelPolicyPanel
        decisions={snapshot.modelAdmissions}
        title={focus === "full" ? "经营网络模型准入" : "当前表格后的诊断准入"}
        description="三张表保持原样；这里仅消费同一份计算结果，并按证据门槛决定哪些诊断可以运行。"
      />

      <section className="operating-network-section operating-network-evidence-ledger">
        <SectionHeading
          eyebrow="证据账本"
          title="系统结论的边界必须和建议一起交付"
          icon={<BadgeCheck size={18} />}
          meta={`置信度 ${Math.round(model.rootFinding.confidence.score)}%`}
        />
        <EvidenceBoundary finding={model.rootFinding} />
        {model.rootFinding.confidence.reasons.length > 0 ? (
          <div className="operating-network-confidence-reasons">
            <strong>置信度依据</strong>
            {model.rootFinding.confidence.reasons.map((reason) => <span key={reason}>{reason}</span>)}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function FocusBanner({
  focus,
  model
}: {
  focus: Exclude<OperatingDiagnosisFocus, "full">;
  model: DisplaySnapshot;
}) {
  const copy = {
    management: {
      title: "经营结果、利润证据与投资边界",
      description: "沿用上方经营表格结果，只增加证据边界、描述性归因和投资闸门，不改写表格数据。"
    },
    product: {
      title: "潜力商品与八维瓶颈",
      description: "沿用上方单品八维表，只把机会候选、待修短板和动作依赖连成诊断网络。"
    },
    audience: {
      title: "人群计划、经济闸门与验证",
      description: "沿用上方人群计划表；点击与报表 ROI 只作为方向信号，缺经济证据时不生成精确预算或出价。"
    }
  }[focus];
  return (
    <section className={`operating-network-focus-banner is-${model.rootFinding.status}`}>
      <div>
        <span><Network size={16} /> 表格后诊断模块</span>
        <h2>{copy.title}</h2>
        <p>{copy.description}</p>
      </div>
      <div>
        <StatusBadge status={model.rootFinding.status} />
        <ConfidenceBadge confidence={model.rootFinding.confidence} compact />
        {model.periodLabel ? <span>{model.periodLabel}</span> : null}
      </div>
    </section>
  );
}

function actionsForFocus(actions: DisplayAction[], focus: OperatingDiagnosisFocus) {
  if (focus === "full") return actions;
  const shared = new Set(["action-data", "action-profit", "action-budget-release", "action-validation"]);
  return actions.filter((action) => {
    if (shared.has(action.id)) return true;
    const category = asText(action.raw.category);
    if (focus === "audience") return category === "人群投放";
    if (focus === "product") return Boolean(category) && category !== "人群投放";
    return !category;
  });
}

function gatesForFocus(gates: DisplayGate[], focus: OperatingDiagnosisFocus) {
  if (focus === "full" || focus === "management") return gates;
  const ids = focus === "product"
    ? new Set(["gate-data", "gate-profit", "gate-product", "gate-scale"])
    : new Set(["gate-data", "gate-profit", "gate-product", "gate-audience", "gate-scale"]);
  return gates.filter((gate) => ids.has(gate.id));
}

function FindingPanel({
  node,
  eyebrow,
  icon,
  empty,
  className = ""
}: {
  node: DisplayNode;
  eyebrow: string;
  icon: ReactNode;
  empty: string;
  className?: string;
}) {
  const hasContent = Boolean(node.finding.conclusion || node.values.length || node.finding.proof.length);
  return (
    <section className={`operating-network-section ${className}`.trim()}>
      <SectionHeading eyebrow={eyebrow} title={node.title} icon={icon}>
        <ConfidenceBadge confidence={node.finding.confidence} compact />
      </SectionHeading>
      {hasContent ? (
        <>
          <p className="operating-network-conclusion"><StatusDot status={node.finding.status} />{node.finding.conclusion}</p>
          <MetricStrip values={node.values} />
          <EvidenceBoundary finding={node.finding} compact />
        </>
      ) : <EmptyState text={empty} />}
    </section>
  );
}

function NodeListPanel({
  eyebrow,
  title,
  icon,
  nodes,
  empty,
  context,
  numbered = false,
  horizontal = false,
  copyProductId = false
}: {
  eyebrow: string;
  title: string;
  icon: ReactNode;
  nodes: DisplayNode[];
  empty: string;
  context?: ReactNode;
  numbered?: boolean;
  horizontal?: boolean;
  copyProductId?: boolean;
}) {
  return (
    <section className="operating-network-section">
      <SectionHeading eyebrow={eyebrow} title={title} icon={icon} meta={`${nodes.length} 项`} />
      {context}
      {nodes.length > 0 ? (
        <div className={`operating-network-node-list${horizontal ? " is-horizontal" : ""}`} role="list">
          {nodes.map((node, index) => (
            <article className={`operating-network-list-node is-${node.finding.status}`} role="listitem" key={node.id}>
              <header>
                <div>
                  {numbered ? <b className="operating-network-rank">{index + 1}</b> : <StatusDot status={node.finding.status} />}
                  <span className="operating-network-node-title">
                    {copyProductId && asText(node.raw.productId) ? (
                      <CopyIdentifier label="商品ID" value={asText(node.raw.productId)} />
                    ) : null}
                    <strong>{node.title}</strong>
                  </span>
                </div>
                <ConfidenceBadge confidence={node.finding.confidence} compact />
              </header>
              <NodeBadges raw={node.raw} />
              <p>{node.finding.conclusion || node.subtitle}</p>
              <MetricStrip values={node.values} compact />
              <CompactEvidence finding={node.finding} />
            </article>
          ))}
        </div>
      ) : <EmptyState text={empty} />}
    </section>
  );
}

function ProfitAttributionScope() {
  return (
    <div className="operating-network-profit-scope" aria-label="利润归因成本口径">
      <div>
        <strong><CircleAlert size={15} /> 成本与利润口径</strong>
        <p>贡献利润估算 = 分析窗净销售额 × 预填商品毛利率 − 同窗推广花费。</p>
      </div>
      <dl>
        <div>
          <dt>系统直接扣减</dt>
          <dd>按商品 ID 关联、且与分析窗对齐的推广宝贝花费。</dd>
        </div>
        <div>
          <dt>取决于预填口径</dt>
          <dd>商品成本、平台扣点、税费、仓储及履约等，仅在已计入预填毛利率时进入估算。</dd>
        </div>
        <div>
          <dt>不代表财务净利润</dt>
          <dd>固定人工、组织管理和资金成本未单独扣减；因素归因是描述性分解，不是因果结论。</dd>
        </div>
      </dl>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  icon,
  meta,
  children
}: {
  eyebrow: string;
  title: string;
  icon: ReactNode;
  meta?: string;
  children?: ReactNode;
}) {
  return (
    <header className="operating-network-section-heading">
      <div>
        <span>{icon}{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {children ?? (meta ? <small>{meta}</small> : null)}
    </header>
  );
}

function MetricStrip({ values, compact = false }: { values: DisplayNode["values"]; compact?: boolean }) {
  if (values.length === 0) return null;
  return (
    <dl className={`operating-network-metrics${compact ? " is-compact" : ""}`}>
      {values.slice(0, compact ? 4 : 6).map((item) => (
        <div key={item.key}>
          <dt>{item.label}</dt>
          <dd>{formatFieldValue(item.key, item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function EvidenceBoundary({ finding, compact = false }: { finding: DisplayFinding; compact?: boolean }) {
  return (
    <div className={`operating-network-evidence${compact ? " is-compact" : ""}`}>
      <EvidenceColumn icon={<BadgeCheck size={15} />} title="能证明" items={finding.proof} tone="proven" compact={compact} />
      <EvidenceColumn icon={<ShieldAlert size={15} />} title="不能证明" items={finding.cannotProve} tone="unproven" compact={compact} />
      <EvidenceColumn icon={<DatabaseZap size={15} />} title="待补表" items={finding.requiredData} tone="missing" compact={compact} />
    </div>
  );
}

function EvidenceColumn({
  icon,
  title,
  items,
  tone,
  compact
}: {
  icon: ReactNode;
  title: string;
  items: string[];
  tone: "proven" | "unproven" | "missing";
  compact: boolean;
}) {
  const visible = items.slice(0, compact ? 2 : 5);
  return (
    <div className={`operating-network-evidence-column is-${tone}`}>
      <strong>{icon}{title}<span>{items.length}</span></strong>
      {visible.length > 0 ? (
        <ul>{visible.map((item) => <li key={item}>{item}</li>)}</ul>
      ) : (
        <p>{tone === "proven" ? "暂无充分证据" : tone === "unproven" ? "暂无越界判断" : "暂无待补数据"}</p>
      )}
    </div>
  );
}

function CompactEvidence({ finding }: { finding: DisplayFinding }) {
  return (
    <div className="operating-network-evidence-counts" aria-label="结论证据边界">
      <span className="is-proven"><BadgeCheck size={13} />能证明 {finding.proof.length}</span>
      <span className="is-unproven"><ShieldAlert size={13} />不能证明 {finding.cannotProve.length}</span>
      <span className="is-missing"><DatabaseZap size={13} />待补 {finding.requiredData.length}</span>
    </div>
  );
}

function NodeBadges({ raw }: { raw: UnknownRecord }) {
  const badges = [
    raw.manualGrade ? `策略 ${asText(raw.manualGrade)}` : "",
    asText(raw.pool),
    asText(raw.efficiencyBadge),
    asText(raw.profitBadge),
    asText(raw.opportunityBadge),
    raw.opportunityConfidence ? `机会置信 ${asText(raw.opportunityConfidence)}` : ""
  ].filter(Boolean);
  return badges.length > 0 ? (
    <div className="operating-network-node-badges">
      {badges.map((badge) => <span key={badge}>{badge}</span>)}
    </div>
  ) : null;
}

function ConfidenceBadge({ confidence, compact = false }: { confidence: DisplayConfidence; compact?: boolean }) {
  return (
    <span className={`operating-network-confidence is-${confidence.level}${compact ? " is-compact" : ""}`} title={confidence.reasons.join("；")}>
      <span><Gauge size={compact ? 12 : 14} />{confidenceLabel(confidence.level)}</span>
      <i><b style={{ width: `${confidence.score}%` }} /></i>
      <strong>{Math.round(confidence.score)}%</strong>
    </span>
  );
}

function StatusBadge({ status }: { status: FindingStatus }) {
  return <span className={`operating-network-status is-${status}`}><StatusDot status={status} />{findingStatusLabel(status)}</span>;
}

function StatusDot({ status }: { status: FindingStatus }) {
  return <i className={`operating-network-status-dot is-${status}`} aria-hidden="true" />;
}

function ProofTotal({ icon, label, value, tone }: { icon: ReactNode; label: string; value: number; tone: string }) {
  return <div className={`is-${tone}`}><span>{icon}{label}</span><strong>{value}</strong></div>;
}

function ActionStatus({ status }: { status: DisplayAction["status"] }) {
  const label = status === "ready" ? "可启动" : status === "blocked" ? "被阻塞" : "有条件";
  return <span className={`operating-network-action-status is-${status}`}>{label}</span>;
}

function ActionLinkGroup({
  icon,
  label,
  values,
  empty
}: {
  icon: ReactNode;
  label: string;
  values: string[];
  empty: string;
}) {
  return (
    <div>
      <strong>{icon}{label}</strong>
      <span>{values.length > 0 ? values.join(" → ") : empty}</span>
    </div>
  );
}

function GateIcon({ status }: { status: DisplayGate["status"] }) {
  if (status === "pass") return <CheckCircle2 size={16} />;
  if (status === "fail") return <CircleAlert size={16} />;
  return <CircleDashed size={16} />;
}

function CriteriaList({ title, items, tone }: { title: string; items: string[]; tone: "good" | "bad" }) {
  return (
    <div className={`operating-network-criteria is-${tone}`}>
      <strong>{title}</strong>
      {items.length > 0 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <span>待定义</span>}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="operating-network-empty"><CircleDashed size={16} />{text}</p>;
}

function normalizeSnapshot(snapshot: OperatingNetworkSnapshot): DisplaySnapshot {
  const raw = asRecord(snapshot);
  const rootFinding = toFinding(raw.finding, "经营网络总判断");
  return {
    generatedAt: asText(raw.generatedAt),
    periodLabel: periodText(raw.analysisPeriod),
    rootFinding,
    readiness: toNode(raw.readiness, "诊断就绪度", "readiness"),
    outcome: toNode(raw.outcome, "经营结果", "outcome"),
    profitDrivers: toNodes(raw.profitDrivers, "利润驱动"),
    investmentSpace: toNode(raw.investmentSpace, "投资空间", "investment-space"),
    potentialProducts: toNodes(raw.potentialProducts, "潜力商品"),
    dimensionShortfalls: toNodes(raw.dimensionShortfalls, "商品短板"),
    audienceRecommendations: toNodes(raw.audienceRecommendations, "人群建议"),
    actions: toNodes(raw.actions, "经营动作").map(toAction),
    budgetGates: toNodes(raw.budgetGates, "预算闸门").map(toGate),
    milestones: toNodes(raw.milestones, "验证里程碑").map(toMilestone)
  };
}

function toNodes(value: unknown, fallbackTitle: string): DisplayNode[] {
  return sectionItems(value).map((item, index) => toNode(item, `${fallbackTitle} ${index + 1}`, `${slug(fallbackTitle)}-${index + 1}`));
}

function toNode(value: unknown, fallbackTitle: string, fallbackId: string): DisplayNode {
  const raw = asRecord(value);
  const finding = toFinding(raw.finding ?? value, fallbackTitle);
  const title = firstText(raw.title, raw.name, raw.label, raw.productName, raw.audienceName, finding.title, fallbackTitle);
  const subtitle = firstText(raw.subtitle, raw.description, raw.summary, raw.diagnosis, raw.action, finding.conclusion);
  return {
    id: firstText(raw.id, raw.productId, raw.key, finding.id, fallbackId),
    title,
    subtitle,
    finding: { ...finding, title },
    values: primitiveValues(raw),
    raw
  };
}

function toAction(node: DisplayNode): DisplayAction {
  const raw = node.raw;
  return {
    ...node,
    owner: asText(raw.owner),
    priority: enumValue(raw.priority, ["P1", "P2", "P3"], "P2"),
    status: enumValue(raw.status, ["ready", "blocked", "conditional"], "conditional"),
    dependsOn: asStringArray(raw.dependsOn),
    gateIds: asStringArray(raw.gateIds),
    metric: firstText(raw.metric, raw.validationMetric),
    stopCondition: firstText(raw.stopCondition, raw.stopConditions)
  };
}

function toGate(node: DisplayNode): DisplayGate {
  return {
    ...node,
    status: enumValue(node.raw.status, ["pass", "conditional", "fail"], "conditional"),
    criterion: firstText(node.raw.criterion, node.raw.criteria, node.finding.conclusion)
  };
}

function toMilestone(node: DisplayNode): DisplayMilestone {
  return {
    ...node,
    horizon: asText(node.raw.horizon),
    objective: firstText(node.raw.objective, node.raw.title, node.finding.conclusion),
    successCriteria: asStringArray(node.raw.successCriteria),
    stopConditions: asStringArray(node.raw.stopConditions)
  };
}

function toFinding(value: unknown, fallbackTitle: string): DisplayFinding {
  const raw = asRecord(value);
  const confidenceRaw = asRecord(raw.confidence);
  const rawScore = asNumber(confidenceRaw.score);
  const normalizedScore = rawScore <= 1 && rawScore >= 0 ? rawScore * 100 : rawScore;
  return {
    id: firstText(raw.id, slug(fallbackTitle)),
    title: firstText(raw.title, raw.name, fallbackTitle),
    conclusion: firstText(raw.conclusion, raw.diagnosis, raw.summary, raw.description),
    status: enumValue(raw.status, ["positive", "warning", "critical", "insufficient"], "insufficient"),
    proof: asStringArray(raw.proof),
    cannotProve: asStringArray(raw.cannotProve),
    requiredData: asStringArray(raw.requiredData),
    confidence: {
      score: clamp(normalizedScore, 0, 100),
      level: enumValue(confidenceRaw.level, ["high", "medium", "low"], confidenceLevel(normalizedScore)),
      reasons: asStringArray(confidenceRaw.reasons)
    }
  };
}

function primitiveValues(raw: UnknownRecord) {
  return Object.entries(raw)
    .filter(([key, value]) => !OMIT_VALUE_KEYS.has(key) && isDisplayPrimitive(value))
    .map(([key, value]) => ({ key, label: FIELD_LABELS[key] ?? humanizeKey(key), value }));
}

function sectionItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const raw = asRecord(value);
  for (const key of ["items", "rows", "products", "drivers", "recommendations", "actions", "gates", "milestones"]) {
    if (Array.isArray(raw[key])) return raw[key] as unknown[];
  }
  return Object.keys(raw).length > 0 ? [raw] : [];
}

function strongestFinding(nodes: Array<{ finding: DisplayFinding }>, fallback: DisplayFinding) {
  return [...nodes]
    .sort((left, right) => severity(right.finding.status) - severity(left.finding.status) || right.finding.confidence.score - left.finding.confidence.score)[0]
    ?.finding ?? fallback;
}

function stage(label: string, icon: typeof Activity, finding: DisplayFinding) {
  return { label, icon, finding };
}

function periodText(value: unknown) {
  if (typeof value === "string") return value;
  const raw = asRecord(value);
  const label = firstText(raw.label, raw.name, raw.period);
  if (label) return label;
  const start = firstText(raw.start, raw.startDate, raw.from);
  const end = firstText(raw.end, raw.endDate, raw.to);
  return start && end ? `${start} ~ ${end}` : start || end;
}

function formatFieldValue(key: string, value: unknown) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "number") return asText(value) || "—";
  if (!Number.isFinite(value)) return "—";
  if (RATE_KEYS.test(key)) {
    const rate = Math.abs(value) <= 1 ? value : value / 100;
    return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(rate);
  }
  if (MONEY_KEYS.test(key)) {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      notation: Math.abs(value) >= 10000 ? "compact" : "standard",
      maximumFractionDigits: 1
    }).format(value);
  }
  return new Intl.NumberFormat("zh-CN", { notation: Math.abs(value) >= 10000 ? "compact" : "standard", maximumFractionDigits: 2 }).format(value);
}

function humanizeKey(value: string) {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words || "指标";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function findingStatusLabel(status: FindingStatus) {
  return status === "positive" ? "正向信号" : status === "warning" ? "需要关注" : status === "critical" ? "优先处理" : "证据不足";
}

function confidenceLabel(level: ConfidenceLevel) {
  return level === "high" ? "高置信" : level === "medium" ? "中置信" : "低置信";
}

function gateStatusLabel(status: DisplayGate["status"]) {
  return status === "pass" ? "通过" : status === "fail" ? "未通过" : "有条件";
}

function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 75) return "high";
  if (score >= 48) return "medium";
  return "low";
}

function severity(status: FindingStatus) {
  return status === "critical" ? 4 : status === "warning" ? 3 : status === "insufficient" ? 2 : 1;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const text = asText(value);
  return text ? [text] : [];
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return "";
}

function asNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isDisplayPrimitive(value: unknown) {
  return typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.trim() !== "");
}

function slug(value: string) {
  return value.toLowerCase().replace(/\s+/g, "-");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
