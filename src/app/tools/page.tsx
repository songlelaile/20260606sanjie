import {
  CircleAlert,
  Download,
  ListChecks,
  Puzzle,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { CopyAddress } from "@/components/tools/CopyAddress";

export const metadata: Metadata = {
  title: "采集工具 · 三阶引擎"
};

// 插件元信息（升级版本只需改这里，并把新 ZIP 放进 public/downloads/）
const COLLECTOR = {
  name: "生意参谋 · 采集助手",
  version: "1.7.0",
  zipHref: "/downloads/sycm-keyword-collector-v1.7.0.zip",
  downloadName: "生意参谋采集助手-v1.7.0.zip",
  sizeLabel: "约 610 KB",
  platform: "Chrome / Edge 111+"
};

const FEATURES = [
  {
    title: "热词榜采集",
    desc: "在「市场 · 搜索排行」页，按你选好的类目与时间，随机间隔自动翻页，采全当前榜单关键词及其指标。"
  },
  {
    title: "相关词衍生",
    desc: "把每个关键词当种子词，自动逐个打开「搜索分析」抓相关词（每词最多 50 页），也支持自定义词列表。"
  },
  {
    title: "商品排行 · 分日下载",
    desc: "商品排行源数据逐天自动下载，一天一个文件，带下载清单与补下跳过。"
  },
  {
    title: "词根 + 需求分析",
    desc: "对采集到的词离线拆词根、自动判需求类型（品类/属性/人群…）；可接 AI 拆词根并永久学习、不重复调用。"
  },
  {
    title: "一键导出 Excel",
    desc: "纯前端生成 .xlsx（不依赖第三方库），多工作表，另支持 CSV / 复制，直接接入本平台「源数据」导入。"
  },
  {
    title: "抗风控设计",
    desc: "翻页采用随机间隔模拟人工；可随时停止/清空；关闭弹窗后台继续；完成弹系统通知。"
  }
];

const INSTALL_STEPS = [
  {
    title: "下载并解压",
    body: "点上方「下载插件（解压版）」，把得到的 ZIP 解压到一个固定文件夹（别放回收站/临时目录，删了插件就失效）。"
  },
  {
    title: "打开扩展管理页",
    body: "在 Chrome / Edge 地址栏粘贴下面这个地址并回车（此地址受浏览器保护，无法做成可点链接）：",
    address: "chrome://extensions/"
  },
  {
    title: "打开「开发者模式」",
    body: "在扩展管理页右上角，把「开发者模式 / Developer mode」开关打开。"
  },
  {
    title: "加载已解压的扩展",
    body: "点「加载已解压的扩展程序 / Load unpacked」，选中第 1 步解压出来、含 manifest.json 的那一层文件夹（若解压后第一层就是 manifest.json，就选这一层；若是一个同名子文件夹，则进到含 manifest.json 的那层）。加载后扩展管理页出现该插件卡片、且无红色报错，即安装成功。"
  },
  {
    title: "固定到工具栏",
    body: "安装成功后点浏览器右上角拼图图标，把「生意参谋采集助手」固定出来，方便随时打开。"
  }
];

const USAGE_STEPS = [
  "登录并进入 生意参谋 → 市场 → 搜索排行，在页面上选好类目与时间范围，让关键词表格正常显示（停在第 1 页）。",
  "点工具栏里的插件图标打开弹窗，按需调整「翻页随机间隔（默认 3~8 秒）」「最多采集页数（0=不限）」。",
  "点「开始采集」，插件自动逐页翻页收集，弹窗实时显示「已采页数 / 关键词数」；关闭弹窗不中断，后台继续。",
  "采完后点「导出 Excel」下载 .xlsx（或导出 CSV / 复制）；需要相关词时用下方「衍生采集」继续跑。",
  "把导出的报表拿到本平台「数据导入」页上传，即可进入三阶计算与看板。"
];

export default function ToolsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Toolbox"
        title="采集工具"
        description="店铺运营的浏览器辅助工具集。当前提供「生意参谋采集助手」——浏览器扩展，帮你采关键词、衍生相关词、商品排行分日下载，并对采到的词离线拆词根、判需求，再喂给本平台做分析。"
      />

      <section className="tool-card">
        <header className="tool-card-head">
          <span className="tool-card-icon">
            <Puzzle size={26} />
          </span>
          <div className="tool-card-title">
            <h2>{COLLECTOR.name}</h2>
            <div className="tool-badges">
              <span className="tool-badge">v{COLLECTOR.version}</span>
              <span className="tool-badge tool-badge-soft">{COLLECTOR.platform}</span>
              <span className="tool-badge tool-badge-soft">{COLLECTOR.sizeLabel}</span>
            </div>
          </div>
          <a
            className="button-link tool-download-btn"
            href={COLLECTOR.zipHref}
            download={COLLECTOR.downloadName}
          >
            <Download size={18} />
            下载插件（解压版）
          </a>
        </header>

        <p className="tool-lead">
          一个 Chrome Manifest V3 扩展：在生意参谋页面按随机间隔自动翻页采集关键词数据，一键导出
          Excel。仅读取你已登录账号下能看到的数据，不伪造请求、不修改任何数据。
        </p>

        <div className="tool-block">
          <div className="tool-block-label">
            <Sparkles size={15} />
            功能
          </div>
          <div className="tool-feature-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="tool-feature">
                <strong>{f.title}</strong>
                <span>{f.desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="tool-block">
          <div className="tool-block-label">
            <Download size={15} />
            安装（开发者模式加载，5 步）
          </div>
          <p className="tool-hint">
            该插件以「解压版」分发：CRX 直接从网页安装会被浏览器拦截，因此请按下面方式用「加载已解压」装入，正常可用且能随平台更新。
          </p>
          <ol className="tool-steps">
            {INSTALL_STEPS.map((step, i) => (
              <li key={step.title} className="tool-step">
                <span className="tool-step-no">{i + 1}</span>
                <div className="tool-step-body">
                  <strong>{step.title}</strong>
                  <span>{step.body}</span>
                  {step.address ? <CopyAddress value={step.address} /> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="tool-block">
          <div className="tool-block-label">
            <ListChecks size={15} />
            使用
          </div>
          <ol className="tool-steps tool-steps-plain">
            {USAGE_STEPS.map((step, i) => (
              <li key={i} className="tool-step">
                <span className="tool-step-no">{i + 1}</span>
                <div className="tool-step-body">
                  <span>{step}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="tool-notes">
          <div className="tool-note">
            <ShieldCheck size={16} />
            <span>
              <strong>邀请制 · 需登录</strong>：插件已开启邀请制。打开插件若提示登录，请用<strong>邀请码</strong>在本站注册并登录，登录后插件自动解锁——
              一个邀请码同时开通「三阶引擎 + 采集插件」（1 码 2 用）。
            </span>
          </div>
          <div className="tool-note">
            <ShieldCheck size={16} />
            <span>
              <strong>合规使用</strong>：仅供已授权用户采集自己账号下可见的数据；页数较多时建议把随机间隔调到 5~12
              秒，越接近人工越安全。
            </span>
          </div>
          <div className="tool-note tool-note-warn">
            <CircleAlert size={16} />
            <span>
              <strong>更新</strong>：换新版本时，先删掉旧的解压文件夹，把新 ZIP 解压到一个空文件夹，再到扩展管理页点该插件的「刷新 / 重新加载」（避免旧文件残留）；删除解压文件夹会使插件失效。
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
