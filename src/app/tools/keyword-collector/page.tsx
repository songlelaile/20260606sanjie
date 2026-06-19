import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";

const VERSION = "1.4.1";
const ZIP_URL = `/downloads/sycm-keyword-v${VERSION}.zip`;
const CRX_URL = `/downloads/sycm-keyword-v${VERSION}.crx`;

export const metadata: Metadata = {
  title: "关键词采集助手 — 三阶引擎",
  description: "生意参谋搜索排行热词采集与搜索分析相关词衍生，一键导出 Excel。"
};

const features: Array<{ title: string; desc: string }> = [
  { title: "热词榜采集", desc: "市场·搜索排行，随机间隔自动翻页采全部关键词，可选 30天 / 7天 等时间范围。" },
  { title: "相关词衍生", desc: "逐个关键词打开搜索分析，按 30 天抓相关词，最多每词 50 页。" },
  { title: "一键导出", desc: "导出 Excel / CSV / 复制，排名补全、指标干净规范。" },
  { title: "稳定可控", desc: "随机点击防风控、随时停止 / 清空、关弹窗后台继续、完成系统通知。" }
];

const installSteps: string[] = [
  "下载下方「解压版」并解压，得到一个含 manifest.json 的文件夹。",
  "Chrome 地址栏输入 chrome://extensions/ 回车。",
  "打开右上角「开发者模式」。",
  "点「加载已解压的扩展程序」，选择刚解压出来的文件夹。",
  "工具栏出现橙色「词」图标即安装成功（点拼图图标可固定到工具栏）。"
];

const usageSteps: string[] = [
  "登录并进入 生意参谋 → 市场 → 搜索排行，选好类目和时间。",
  "点插件图标 →「开始采集」自动翻页采全部热词 → 导出 Excel。",
  "需要相关词时用「衍生采集」：用已采的词或自定义词作种子，按 30 天逐词抓相关词导出。"
];

export default function KeywordCollectorPage() {
  return (
    <div className="kw-tool">
      <PageHeader
        eyebrow="Chrome 插件 · 工具"
        title="生意参谋关键词采集助手"
        description="搜索排行热词采集 · 搜索分析相关词衍生 · 一键导出 Excel"
        actions={
          <>
            <a className="button-link" href={ZIP_URL} download>
              下载解压版
            </a>
            <a className="button-link outline-button" href={CRX_URL} download>
              CRX
            </a>
          </>
        }
      />

      <section className="kw-features" aria-label="功能特性">
        {features.map((f) => (
          <div className="kw-feat panel-shell" key={f.title}>
            <strong>{f.title}</strong>
            <span>{f.desc}</span>
          </div>
        ))}
      </section>

      <section className="panel-shell kw-panel">
        <p className="management-section-label">下载安装（推荐解压版）</p>
        <div className="kw-dl">
          <a className="button-link" href={ZIP_URL} download>
            ⬇ 下载解压版（.zip · 约 220KB）
          </a>
          <a className="button-link outline-button" href={CRX_URL} download>
            ⬇ CRX 安装包
          </a>
          <span className="kw-ver">v{VERSION}</span>
        </div>
        <ol className="kw-steps">
          {installSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="kw-note">
          现代 Chrome 默认禁止从网页直接安装 CRX（双击会提示「无法添加来自此网站的程序」），普通用户请用「解压版 +
          加载已解压」最稳；CRX 主要给企业策略部署。解压后的文件夹请保留不要删，需 Chrome / Edge 111 及以上版本。
        </p>
      </section>

      <section className="panel-shell kw-panel">
        <p className="management-section-label">安装后怎么用</p>
        <ol className="kw-steps">
          {usageSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}
