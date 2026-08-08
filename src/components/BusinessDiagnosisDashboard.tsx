import {
  BarChart3,
  Compass,
  Gauge,
  Layers3,
  LineChart,
  Search,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import type { ReactNode } from "react";
import { BusinessAiReportPanel } from "@/components/BusinessAiReportPanel";
import { CustomerReportExport } from "@/components/CustomerReportExport";
import { DiagnosisModelPolicyPanel } from "@/components/DiagnosisModelPolicyPanel";
import { StatusPill } from "@/components/StatusPill";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import type {
  BusinessCategoryQuadrant,
  BusinessCategorySummary,
  BusinessDiagnosisSnapshot,
  BusinessStrategyPriority,
  BusinessValueChainStage
} from "@/lib/business-diagnosis";
import type { AiApiConfigPublic } from "@/lib/types/domain";

const QUADRANT_META: Record<BusinessCategoryQuadrant, { tone: "good" | "warn" | "bad" | "neutral"; action: string }> = {
  增长引擎: { tone: "warn", action: "候选验证" },
  规模守成: { tone: "neutral", action: "守成" },
  潜力新星: { tone: "good", action: "小样本验证" },
  效率修复: { tone: "warn", action: "修复" },
  收缩观察: { tone: "bad", action: "观察" }
};

const PRIORITY_TONE: Record<BusinessStrategyPriority, "good" | "warn" | "bad"> = {
  P1: "bad",
  P2: "warn",
  P3: "good"
};

export function BusinessDiagnosisDashboard({
  snapshot,
  aiConfig
}: {
  snapshot: BusinessDiagnosisSnapshot;
  aiConfig: AiApiConfigPublic;
}) {
  const maxCategorySales = Math.max(...snapshot.categories.map((item) => item.paymentAmount), 1);
  const maxSearchUv = Math.max(...snapshot.market.topSearchSignals.map((item) => item.searchUv), 1);
  const maxAttributeSalesIndex = Math.max(...snapshot.market.topAttributeSignals.map((item) => item.salesIndex), 1);
  const maxPriceShare = Math.max(...snapshot.market.topPriceBands.map((item) => item.marketShare), 1);

  return (
    <div className="business-diagnosis">
      <section className="business-kpi-grid" aria-label="业务诊断概览">
        <MetricCard
          label="本店支付额"
          value={formatOptionalMoney(snapshot.summary.paymentAmount)}
          hint={snapshot.summary.storeTotalAvailable ? `${snapshot.summary.latestStoreMonth} 全店汇总口径` : "待补可靠全店汇总行"}
        />
        <MetricCard
          label="净销售额"
          value={formatOptionalMoney(snapshot.summary.netSales)}
          hint={snapshot.summary.storeTotalAvailable ? `退款率 ${formatOptionalPercent(snapshot.summary.refundRate)}` : "叶子类目访客/买家不做全店加总"}
        />
        <MetricCard
          label="支付转化"
          value={formatOptionalPercent(snapshot.summary.paymentConversionRate)}
          hint={`月累计数据值 ${formatSignedPercent(snapshot.summary.revenueGrowth)} · ${snapshot.summary.comparisonConclusionAllowed ? "证据窗允许方向判断" : "证据窗不足，仅观察"}`}
        />
        <MetricCard
          label="市场热度"
          value={formatOptionalPercent(snapshot.summary.marketSalesShare)}
          hint={snapshot.summary.marketSalesShare === null
            ? "待补市场概况表"
            : `${snapshot.summary.latestMarketMonth} 销售占比 · ${snapshot.market.conclusionAllowed ? "同期证据可用" : "非同期或未闭合，仅观察"}`}
        />
      </section>

      <section className="business-strategy-panel">
        <div className="panel-toolbar">
          <div>
            <strong>
              <Sparkles size={16} /> 诊断策略
            </strong>
            <span>仅使用已准入的本店经营证据、链路指标和市场方向信号生成</span>
          </div>
        </div>
        <div className="business-strategy-grid">
          {snapshot.strategyCards.map((card) => (
            <article className="business-strategy-card" key={card.id}>
              <header>
                <StatusPill tone={PRIORITY_TONE[card.priority]}>{card.priority}</StatusPill>
                <span>{card.model}</span>
              </header>
              <h2>{card.title}</h2>
              <p>{card.diagnosis}</p>
              <dl>
                <div>
                  <dt>对象</dt>
                  <dd>{card.target}</dd>
                </div>
                <div>
                  <dt>预期</dt>
                  <dd>{card.expectedImpact}</dd>
                </div>
              </dl>
              <div className="strategy-evidence">
                {card.evidence.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <ul>
                {card.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <CustomerReportExport snapshot={snapshot} />

      <section className="business-grid">
        <div className="business-panel">
          <div className="panel-toolbar">
            <div>
              <strong>
                <Compass size={16} /> 本店类目经营分组
              </strong>
              <span>不是 BCG：父级汇总用于总盘，叶子类目按店内规模、效率和可比趋势分组</span>
            </div>
          </div>
          <div className="business-quadrants">
            {(Object.keys(QUADRANT_META) as BusinessCategoryQuadrant[]).map((quadrant) => (
              <article key={quadrant}>
                <StatusPill tone={QUADRANT_META[quadrant].tone}>{QUADRANT_META[quadrant].action}</StatusPill>
                <strong>{quadrant}</strong>
                <span>{snapshot.quadrants[quadrant].length} 个类目</span>
              </article>
            ))}
          </div>
          <div className="business-category-list">
            {snapshot.categories.map((category) => (
              <CategoryRow category={category} maxSales={maxCategorySales} key={category.categoryName} />
            ))}
          </div>
        </div>

        <ValueChainPanel stages={snapshot.valueChain} />
      </section>

      <section className="business-grid business-market-grid">
        <div className="business-panel">
          <div className="panel-toolbar">
            <div>
              <strong>
                <LineChart size={16} /> 市场大盘趋势
              </strong>
              <span>当前先按类目大盘口径接入，后续可扩展多类目总量占比</span>
            </div>
          </div>
          <div className="market-trend-strip">
            {snapshot.market.trend.map((item) => (
              <div key={item.month}>
                <span>{item.month.slice(5)}</span>
                <i style={{ height: `${Math.max(item.salesShare * 160, 6)}px` }} />
                <b>{formatPercent(item.salesShare, 0)}</b>
              </div>
            ))}
          </div>
          <div className="business-market-note">
            <ShieldCheck size={15} />
            <span>{snapshot.market.note}</span>
          </div>
        </div>

      </section>

      <section className="business-phase-grid">
        <StrategyModelPanel snapshot={snapshot} />
        <DiagnosisModelPolicyPanel
          decisions={snapshot.modelAdmissions}
          title="业务诊断模型准入"
          description="类目经营分组、链路瓶颈和市场方向按证据运行；经典咨询模型缺直接资料时保持关闭。"
        />
      </section>

      <section className="business-report-grid">
        <QuestionnairePanel snapshot={snapshot} />
        <BusinessAiReportPanel initialReport={snapshot.aiReport} initialConfig={aiConfig} />
      </section>

      <section className="business-market-sections">
        <MarketSignalPanel
          title="价格带机会"
          icon={<BarChart3 size={16} />}
          rows={snapshot.market.topPriceBands.map((item) => ({
            label: item.priceBand,
            value: formatPercent(item.marketShare),
            hint: `供给指数 ${formatNumber(item.supplyIndex)}`,
            bar: item.marketShare / maxPriceShare
          }))}
        />
        <MarketSignalPanel
          title="卖点属性"
          icon={<Layers3 size={16} />}
          rows={snapshot.market.topAttributeSignals.slice(0, 8).map((item) => ({
            label: `${item.attribute} · ${item.value}`,
            value: formatNumber(item.salesIndex),
            hint: `同比 ${formatSignedPercent(item.yoy)}`,
            bar: item.salesIndex / maxAttributeSalesIndex
          }))}
        />
        <MarketSignalPanel
          title="搜索词分类"
          icon={<Search size={16} />}
          rows={snapshot.market.topSearchSignals.map((item) => ({
            label: item.category,
            value: formatNumber(item.searchUv),
            hint: `点击 ${formatPercent(item.clickRate)} · 成交 ${formatPercent(item.conversionRate)}`,
            bar: item.searchUv / maxSearchUv
          }))}
        />
      </section>
    </div>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="business-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function CategoryRow({ category, maxSales }: { category: BusinessCategorySummary; maxSales: number }) {
  return (
    <article className="business-category-row">
      <div>
        <strong>{category.categoryName}</strong>
        <span>{category.diagnosis}</span>
      </div>
      <div className="business-category-bar">
        <i style={{ width: `${Math.max((category.paymentAmount / maxSales) * 100, 4)}%` }} />
      </div>
      <div className="business-category-metrics">
        <span>{formatMoney(category.paymentAmount)}</span>
        <span>{formatSignedPercent(category.revenueGrowth)}{category.comparisonConclusionAllowed ? "" : " · 仅观察"}</span>
        <span>{formatPercent(category.paymentConversionRate)}</span>
      </div>
      <StatusPill tone={QUADRANT_META[category.quadrant].tone}>{category.action}</StatusPill>
    </article>
  );
}

function ValueChainPanel({ stages }: { stages: BusinessValueChainStage[] }) {
  return (
    <section className="business-panel business-value-chain">
      <div className="panel-toolbar">
        <div>
          <strong>
            <Gauge size={16} /> 价值链评分
          </strong>
          <span>流量、转化、客单、退款、组合和市场六段诊断</span>
        </div>
      </div>
      <div className="business-value-chain-list">
        {stages.map((stage) => (
          <article className={`business-value-row ${stage.status}`} key={stage.key}>
            <div>
              <strong>{stage.label}</strong>
              <span>{stage.evidence}</span>
            </div>
            <div className="business-value-score">
              <i style={{ width: `${stage.score ?? 0}%` }} />
              <b>{stage.score ?? "待补"}</b>
            </div>
            <p>{stage.action}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function StrategyModelPanel({ snapshot }: { snapshot: BusinessDiagnosisSnapshot }) {
  return (
    <section className="business-panel">
      <div className="panel-toolbar">
        <div>
          <strong>
            <Gauge size={16} /> 动作与验证网络
          </strong>
          <span>把诊断对象、前置动作、负责人、指标和复盘周期连成闭环</span>
        </div>
      </div>
      <div className="business-roadmap">
        <h3>经营动作路线图</h3>
        <div>
          {snapshot.roadmap.map((step) => (
            <article key={step.step}>
              <b>{step.step}</b>
              <div>
                <strong>{step.title}</strong>
                <span>{step.horizon} · {step.owner}</span>
                <p>{step.action}</p>
                <small>{step.metric}</small>
              </div>
              <StatusPill tone={PRIORITY_TONE[step.priority]}>{step.priority}</StatusPill>
            </article>
          ))}
        </div>
      </div>
      <div className="business-review-loop">
        <h3>动作前后复盘闭环</h3>
        {snapshot.actionReviewLoops.map((loop) => (
          <article key={loop.id}>
            <header>
              <strong>{loop.title}</strong>
              <span>{loop.owner} · {loop.cadence}</span>
            </header>
            <dl>
              <div>
                <dt>动作前</dt>
                <dd>{loop.beforeMetric}</dd>
              </div>
              <div>
                <dt>动作后</dt>
                <dd>{loop.afterTarget}</dd>
              </div>
            </dl>
            <ul>
              {loop.closedLoop.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatOptionalMoney(value: number | null) {
  return value === null ? "—" : formatMoney(value);
}

function formatOptionalPercent(value: number | null) {
  return value === null ? "—" : formatPercent(value);
}

function QuestionnairePanel({ snapshot }: { snapshot: BusinessDiagnosisSnapshot }) {
  return (
    <section className="business-panel">
      <div className="panel-toolbar">
        <div>
          <strong>
            <Search size={16} /> 半自动问卷
          </strong>
          <span>用于补齐系统数据看不到的组织、用户与动作事实</span>
        </div>
      </div>
      <div className="business-question-list">
        {snapshot.questionnaire.map((item) => (
          <article key={item.id}>
            <header>
              <StatusPill tone="neutral">{item.dimension}</StatusPill>
              <strong>{item.question}</strong>
            </header>
            <p>{item.defaultAnswer}</p>
            <span>{item.evidence}</span>
            <div>
              {item.options.map((option) => (
                <small key={option}>{option}</small>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MarketSignalPanel({
  title,
  icon,
  rows
}: {
  title: string;
  icon: ReactNode;
  rows: { label: string; value: string; hint: string; bar: number }[];
}) {
  return (
    <section className="business-panel business-signal-panel">
      <div className="panel-toolbar">
        <div>
          <strong>
            {icon}
            {title}
          </strong>
        </div>
      </div>
      <div className="business-signal-list">
        {rows.map((row) => (
          <article key={row.label}>
            <div>
              <strong>{row.label}</strong>
              <span>{row.hint}</span>
            </div>
            <div className="business-signal-bar">
              <i style={{ width: `${Math.max(row.bar * 100, 4)}%` }} />
            </div>
            <b>{row.value}</b>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatSignedPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "证据不足";
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    signDisplay: "always"
  })
    .format(value)
    .replace("+0.0%", "0.0%");
}
