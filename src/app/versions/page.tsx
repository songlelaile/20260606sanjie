import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { formatDateTime } from "@/lib/format";
import { getRetentionStatus, getVersions, getWorkspaceContext } from "@/lib/store/runtime-store";

export default function VersionsPage() {
  const { cycle } = getWorkspaceContext();
  const versions = getVersions(cycle.id);
  const retention = getRetentionStatus();

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
        {versions.map((version) => (
          <article key={version.id} className="timeline-item">
            <div>
              <StatusPill tone={version.kind === "calculation" ? "good" : "neutral"}>
                {version.kind}
              </StatusPill>
              <time>{formatDateTime(version.createdAt)}</time>
            </div>
            <h2>{version.title}</h2>
            <p>{version.summary}</p>
            <small>创建人：{version.createdBy}</small>
          </article>
        ))}
      </section>
    </>
  );
}
