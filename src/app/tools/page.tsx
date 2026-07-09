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
  title: "AI 自动化工具 · 三阶引擎"
};

// 插件元信息（升级版本只需改这里，并把新 ZIP 放进 public/downloads/）
const COLLECTOR = {
  name: "少壮AI自动化",
  version: "1.8.5",
  zipHref: "/downloads/sycm-keyword-collector-v1.8.5.zip",
  downloadName: "少壮AI自动化-v1.8.5.zip",
  sizeLabel: "约 814 KB",
  platform: "Chrome / Edge 111+"
};

const FEATURES = [
  {
    title: "关键词榜单采集",
    desc: "在「生意参谋 · 市场 · 搜索排行」按类目和时间自动翻页，采集关键词、搜索人气、点击率、转化等指标。"
  },
  {
    title: "相关词衍生采集",
    desc: "把已采关键词或自定义词表当种子词，逐词进入「搜索分析」抓相关词，支持最多页数、停止续采和单独导出。"
  },
  {
    title: "商品排行分日下载",
    desc: "在「商品排行」按日期逐天点页面自带下载，一天一个文件，带下载清单，重复日期跳过、缺失日期可补下。"
  },
  {
    title: "市场排行商品榜",
    desc: "在「市场排行 · 商品」自动翻页拦接口缓存，采集商品榜全字段和图片 URL，并拼成 Excel 源表。"
  },
  {
    title: "词根需求分析",
    desc: "合并去重关键词，离线拆词根、判断品类/属性/人群/场景等需求类型，AI 结果可学习沉淀。"
  },
  {
    title: "链接清单企划",
    desc: "结合需求分析与市场排行商品榜，用 AI 生成 9 表链接矩阵、上架节奏、标题方向和竞品验证清单。"
  },
  {
    title: "清单生图",
    desc: "基于链接清单沉淀卖点、人群、场景、规格和视觉方向，输出可交给设计或生图工具使用的图片清单与提示词。"
  },
  {
    title: "三阶与货盘源表下载",
    desc: "面向三阶引擎 BI、货盘 BI 和无界报表的源数据采集入口持续接入，结果可回到本平台数据导入。"
  },
  {
    title: "本地导出与数据管理",
    desc: "采集结果保存在浏览器本地，支持 Excel 多工作表、CSV、复制到剪贴板，便于直接上传或留档。"
  },
  {
    title: "登录校验与风控控制",
    desc: "接入平台账号校验，支持随机间隔、后台继续、随时停止/清空、完成通知，只读取可见数据，不修改页面数据。"
  }
];

const RELEASE_NOTES = [
  "升级到 v1.8.5 插件包，下载链接已替换为新版解压包。",
  "强化关键词采集、相关词衍生、市场排行商品榜、商品排行分日下载到本平台数据导入的整套回流路径。",
  "继续保留词根需求分析、链接清单企划和清单生图流程，适合从采集源表一路推进到 AI 企划素材。"
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
    body: "安装成功后点浏览器右上角拼图图标，把「少壮AI自动化」固定出来，方便随时打开。"
  }
];

const USAGE_GROUPS = [
  {
    title: "关键词榜单采集",
    desc: "进入 生意参谋 → 市场 → 搜索排行，选好类目和时间范围并停在第 1 页；打开插件「关键词」，设置随机间隔、页数和数据来源后开始采集，完成后导出 Excel / CSV 或复制。"
  },
  {
    title: "相关词衍生采集",
    desc: "关键词采完后，在「关键词」页下方设置每词页数、时间范围和只跑前 N 个词；也可以一行一个粘贴自定义种子词，逐词进入搜索分析抓相关词。"
  },
  {
    title: "词根需求分析",
    desc: "把关键词和衍生词合并去重后，点击「关键词合并去重 + 生成词根 + 需求分析」；右上设置里配置 AI 后，可增强拆词根、判需求和本机学习沉淀。"
  },
  {
    title: "市场排行商品榜",
    desc: "进入 生意参谋 → 市场排行 → 商品，打开插件「市场排行」，选择时间范围后开始采集；插件会翻页缓存商品榜字段和图片 URL，用于竞品池与链接清单。"
  },
  {
    title: "链接清单企划",
    desc: "先完成词根需求分析和市场排行商品榜，再到「链接清单」填写类目、目标链接数和参与需求类型；配置 AI Key 后生成 9 表链接矩阵、标题方向和验证清单。"
  },
  {
    title: "清单生图",
    desc: "基于链接清单里的卖点、人群、场景、规格和竞品参考，整理图片清单与生图提示词；结果可交给设计排期或外部生图工具继续产图。"
  },
  {
    title: "商品排行分日下载",
    desc: "进入 生意参谋 → 商品 → 商品排行，先关闭浏览器下载前询问；在插件「商品排行」填写起止日期后按天下载，一天一个文件，漏日可按下载清单补下。"
  },
  {
    title: "三阶源表回流",
    desc: "将关键词、衍生词、词根需求、市场排行和商品排行等导出文件上传到本平台「数据导入」，即可进入三阶计算、业务诊断和看板复盘。"
  },
  {
    title: "货盘 / 无界源表",
    desc: "货盘、无界商品、无界人群属于异步源表接入口，按插件页提示进入对应后台页触发采集或下载；当前以插件内实际开放状态为准，产出的源表同样回流数据导入。"
  }
];

export default function ToolsPage() {
  return (
    <>
      <PageHeader
        eyebrow="AI Toolbox"
        title="AI 自动化工具"
        description="围绕店铺经营的 AI 自动化工具集。当前提供「少壮AI自动化」v1.8.5 浏览器扩展，覆盖关键词榜单采集、相关词衍生、商品排行分日下载、市场排行商品榜、词根需求识别、链接清单企划、清单生图和源表回流分析。"
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
          一个 Chrome Manifest V3 扩展：面向生意参谋、市场排行、商品排行和本平台三阶引擎的数据回流场景，按随机间隔自动采集关键词、相关词、商品榜和分日排行数据，并把需求分析继续转成链接清单企划与清单生图素材，一键导出
          Excel / CSV / 复制。仅读取你已登录账号下能看到的数据，不伪造请求、不修改任何数据。
        </p>

        <div className="tool-block">
          <div className="tool-block-label">
            <Sparkles size={15} />
            v{COLLECTOR.version} 更新说明
          </div>
          <div className="tool-feature-grid">
            {RELEASE_NOTES.map((note) => (
              <div key={note} className="tool-feature">
                <span>{note}</span>
              </div>
            ))}
          </div>
        </div>

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
          <p className="tool-hint">
            不同任务不用从头到尾全部执行，按当前要完成的动作选择对应路径；涉及 AI 企划的功能，先在插件右上设置里填好可用的 AI Key。
          </p>
          <div className="tool-usage-grid">
            {USAGE_GROUPS.map((usage, index) => (
              <article key={usage.title} className="tool-usage-card">
                <span className="tool-usage-no">{index + 1}</span>
                <div>
                  <strong>{usage.title}</strong>
                  <p>{usage.desc}</p>
                </div>
              </article>
            ))}
          </div>
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
