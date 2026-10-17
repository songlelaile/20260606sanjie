import Link from "next/link";
import { Download, LockKeyhole, ListChecks } from "lucide-react";
import { getServerSession } from "@/lib/session-server";
import { loadSowerWorkSessionAccess, NO_SOWER_WORK_ACCESS } from "@/lib/sower-work-entitlements";
import { SOWER_WORK_DOWNLOAD_NAME, SOWER_WORK_VERSION } from "@/lib/sower-work-product";

export async function SowerWorkToolCard() {
  const session = await getServerSession();
  const loaded = session ? await loadSowerWorkSessionAccess(session).catch(() => null) : null;
  const access = loaded?.access.entitlement ?? NO_SOWER_WORK_ACCESS;
  const label = access.allowed ? "已开通 · 剩余 " + access.remainingDays + " 天" :
    access.status === "expired" ? "授权已到期" : access.status === "revoked" ? "授权已撤销" : "当前账号未开通";
  return (
    <section className="tool-card" aria-label="Sower Work 独立采集插件">
      <header className="tool-card-head">
        <span className="tool-card-icon"><ListChecks size={27} /></span>
        <div className="tool-card-title">
          <h2>Sower Work</h2>
          <div className="tool-badges">
            <span className="tool-badge">v{SOWER_WORK_VERSION}</span>
            <span className="tool-badge tool-badge-soft">SW 采集联通插件</span>
            <span className={access.allowed ? "tool-badge tool-badge-access" : "tool-badge tool-badge-locked"}>{label}</span>
          </div>
        </div>
        <div className="tool-card-actions">
          {access.allowed ? <a className="button-link tool-download-btn" href="/api/tools/sower-work/download" download={SOWER_WORK_DOWNLOAD_NAME}>
            <Download size={17} /> 下载独立采集插件
          </a> : <span className="dmp-paid-required"><LockKeyhole size={15} /> 请联系管理员开通或续期</span>}
          {session?.role === "admin" && loaded ? <Link className="button-link" href="/management/sower-work">管理 Sower Work 授权</Link> : null}
        </div>
      </header>
      <p className="tool-lead">将当前登录平台的关键词和市场数据采集结果交给 Sower Work，按任务继续整理与处理。由官网管理员独立授权，每次开通或续期有效 30 天；其他工具权限、邀请码和模型套餐不包含此插件。</p>
      <p className="tool-hint">安装：下载后解压至固定目录，在 Chrome 扩展管理中加载已解压的扩展，再从 Sower Work 发起配对。更新时在同一目录替换插件代码后重新加载，保留原配置与历史。官网授权失效时停止新采集并保留待传队列。</p>
    </section>
  );
}
