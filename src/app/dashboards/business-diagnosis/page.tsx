import { AiApiConfigPanel } from "@/components/AiApiConfigPanel";
import { BusinessDiagnosisDashboard } from "@/components/BusinessDiagnosisDashboard";
import { PageHeader } from "@/components/PageHeader";
import { DatabaseZap, Sparkles, UploadCloud } from "lucide-react";
import Link from "next/link";
import { buildBusinessDiagnosisSnapshot, type BusinessDiagnosisSource } from "@/lib/business-diagnosis";
import { getAiApiConfig, getBusinessDiagnosisWorkspaceSource } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function BusinessDiagnosisPage() {
  const [source, aiConfig] = await Promise.all([getBusinessDiagnosisWorkspaceSource(), getAiApiConfig()]);
  const hasSourceData = hasBusinessDiagnosisSourceData(source);
  const snapshot = hasSourceData && source ? buildBusinessDiagnosisSnapshot(source) : null;

  return (
    <>
      <PageHeader
        eyebrow="Business Diagnosis"
        title="业务诊断・经营证据、类目机会与动作验证"
        description="保留本店类目与市场信号的可观测诊断；经典模型只有在专门数据满足后才解锁，不再用经营代理指标自动评分。"
      />
      {snapshot ? <BusinessDiagnosisDashboard snapshot={snapshot} aiConfig={aiConfig} /> : <BusinessDiagnosisEmptyState />}
    </>
  );
}

function hasBusinessDiagnosisSourceData(source: BusinessDiagnosisSource | null): source is BusinessDiagnosisSource {
  if (!source) return false;
  return (
    source.storeCategoryRows.length > 0 ||
    source.market.overview.length > 0 ||
    source.market.priceBands.length > 0 ||
    source.market.attributeSignals.length > 0 ||
    source.market.searchSignals.length > 0
  );
}

function BusinessDiagnosisEmptyState() {
  return (
    <section className="business-empty-state">
      <div className="business-empty-icon">
        <DatabaseZap size={28} />
      </div>
      <div className="business-empty-copy">
        <strong>暂无业务诊断数据</strong>
        <p>
          先在「数据导入」上传本店类目月度表和市场大盘数据。识别到真实源表后，这里会展示经营结果、类目机会、链路瓶颈、动作验证和模型准入状态。
        </p>
      </div>
      <div className="business-empty-actions">
        <Link className="button-link business-empty-link" href="/imports">
          <UploadCloud size={16} />
          去导入数据
        </Link>
        <AiApiConfigPanel variant="inline" />
        <button type="button" className="management-primary-button business-empty-start" disabled>
          <Sparkles size={16} />
          开始诊断
        </button>
        <span className="business-empty-start-hint">上传并识别业务诊断源表后可启动 AI 诊断。</span>
      </div>
    </section>
  );
}
