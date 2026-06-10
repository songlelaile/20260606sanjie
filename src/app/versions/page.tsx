import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { formatDateTime } from "@/lib/format";
import { getRetentionStatus, getVersions, getWorkspaceContext } from "@/lib/store/runtime-store";
import type { VersionSnapshot } from "@/lib/types/domain";

const KIND_LABEL: Record<VersionSnapshot["kind"], string> = {
  import: "数据导入",
  prefill: "预填写",
  profit_config: "利润配置",
  calculation: "算法运行",
  history: "历史数据"
};

const KIND_TONE: Record<VersionSnapshot["kind"], "good" | "neutral" | "warn"> = {
  import: "neutral",
  prefill: "neutral",
  profit_config: "warn",
  calculation: "good",
  history: "warn"
};

export const dynamic = "force-dynamic";

export default async function VersionsPage() {
  const { cycle } = await getWorkspaceContext();
  const versions = await getVersions(cycle.id);
  const retention = await getRetentionStatus();

  return (
    <>
      <PageHeader
        eyebrow="Version Snapshots"
        title="版本留痕"
        description="每次导入、预填写参数修改、算法运行都会留下快照；管理账号按店铺保留最近版本，超出自动清理。"
      />
      <div className="retention-strip">
        <b>管理回滚保留</b>
        <span>最多 {retention.policy.adminMaxRollbackShops} 个店铺</span>
        <span>每店最近 {retention.policy.adminMaxVersionsPerShop} 次</span>
        <span>当前 {retention.adminRollback.shopCount} 个店铺</span>
      </div>
      <section className="timeline">
        {versions.length === 0 ? (
          <p className="empty-state">
            暂无版本留痕，完成一次导入、预填写或算法运行后会自动生成快照。
          </p>
        ) : (
          versions.map((version) => (
            <article key={version.id} className="timeline-item">
              <div>
                <StatusPill tone={KIND_TONE[version.kind]}>{KIND_LABEL[version.kind]}</StatusPill>
                <time dateTime={version.createdAt}>{formatDateTime(version.createdAt)}</time>
              </div>
              <h2>{version.title}</h2>
              <p>{version.summary}</p>
              <small>创建人：{version.createdBy}</small>
            </article>
          ))
        )}
      </section>
    </>
  );
}
