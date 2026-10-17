import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { ROLE_HOME } from "@/lib/auth";
import { videoAssetConfigurationStatus } from "@/lib/video-assets-server";

export const dynamic = "force-dynamic";

export default async function VideoMaterialsConfigurationPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const user = await getCurrentUser();
  if (!user || user.status !== "active" || user.tenantId !== session.tenantId || user.username !== session.username) redirect("/login");
  if (session.role !== "admin" || user.authRole !== "admin") redirect(ROLE_HOME[session.role]);
  const status = await videoAssetConfigurationStatus();
  const checks = [
    ["服务器私密配置文件", status.configurationValid], ["素材状态数据库", status.databaseReady],
    ["私密原图缓存目录", status.sourceDirectoryConfigured], ["临时素材链接签名密钥", status.sourceSigningKeyConfigured],
    ["方舟 AK/SK 与同项目视频 API Key", status.accountCount > 0 && status.credentialsConfiguredCount === status.accountCount],
    ["本人核验回调", status.callbackReady], ["已启用的供应商账号和租户授权", status.enabledAccountCount > 0 && status.grantCount > 0]
  ] as const;
  return <main style={{ maxWidth: 860, margin: "32px auto", padding: 24 }}>
    <p><Link href="/management">返回管理</Link> · <Link href="/dashboards/operating-network/video">打开视频工作台</Link></p>
    <h1>视频素材自动报备 · 安全配置</h1>
    <p>系统按当前租户、用户及供应商项目隔离报备。AI 虚拟人像自动入库送审；真人人像先由本人完成官方活体核验和授权，再自动上传与查询审核结果。审核通过才提交视频。</p>
    <ul>{checks.map(([label, ready]) => <li key={label}>{ready ? "✓ 已配置" : "○ 待配置"} · {label}</li>)}</ul>
    <p><Link className="button-link" href="/management/video-materials">重新检查配置</Link></p>
    <h2>由服务器管理员完成</h2>
    <ol>
      <li>在火山方舟同一账号、同一项目中准备素材管理 AK/SK 和视频生成 API Key。<a href="https://console.volcengine.com/iam/keymanage/" target="_blank" rel="noreferrer">打开官方访问密钥管理</a></li>
      <li>按随版本提供的私密配置模板，设置服务器环境变量及权限为 0600 的配置文件。该页面只显示配置状态，不接收或回显密钥。</li>
      <li>运行随版本提供的数据库迁移及只读预检。配置明确的账号、项目、云配额和租户授权后，再启用服务。</li>
    </ol>
    <p>平台统一供应可显式开通全部租户，但每份素材仍归上传用户所有。租户自有供应商凭据须逐个绑定，不能套用平台账号报备后再用其他 API Key 生成。</p>
    <p><a href="https://docs.volcengine.com/docs/ark/guide-preview?lang=zh" target="_blank" rel="noreferrer">方舟真人素材流程</a> · <a href="https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh" target="_blank" rel="noreferrer">方舟虚拟人像素材流程</a></p>
  </main>;
}
