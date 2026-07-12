import {
  CircleAlert,
  Download,
  ListChecks,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import { PageHeader } from "@/components/PageHeader";
import { CopyAddress } from "@/components/tools/CopyAddress";

export const metadata: Metadata = {
  title: "AI 自动化工具 · 三阶引擎"
};

// 插件元信息（升级版本只需改这里，并把新 ZIP 放进 public/downloads/）
const COLLECTOR = {
  name: "少壮AI自动化",
  version: "1.8.24",
  zipHref: "/downloads/sycm-keyword-collector-v1.8.24.zip",
  downloadName: "少壮AI自动化-v1.8.24.zip",
  sizeLabel: "约 1.6 MB",
  platform: "Chrome / Edge 111+",
  iconHref: "/downloads/shaozhuang-ai-legacy-icon.png"
};

const FEATURES = [
  {
    title: "关键词与相关词采集",
    desc: "在生意参谋按类目和时间自动翻页采集关键词榜单，也可把已采关键词或自定义词表作为种子继续衍生相关词。"
  },
  {
    title: "市场与商品排行",
    desc: "市场排行商品榜自动翻页缓存全字段和图片 URL；商品排行支持按日期逐天下载、重复日期跳过和漏日补下。"
  },
  {
    title: "本地双表导入合成",
    desc: "直接上传已经做好的词根需求表与市场排行表，在浏览器本地解析、校验并生成链接清单，不必重新采集源数据。"
  },
  {
    title: "共享业务知识库",
    desc: "从插件启动界面导入 TXT、Markdown、CSV、TSV、JSON 或 Excel 业务资料，并按链接定位、主图和详情页三个范围辅助 AI 理解品牌与业务。"
  },
  {
    title: "词根语义组合定位",
    desc: "按品类、属性、人群、场景等词根需求生成合理组合，强制保留品类锚点，并将组合语义和市场证据写入链接定位。"
  },
  {
    title: "统一 API 配置",
    desc: "在插件启动界面集中配置少壮托管、ChatGPT、Nano Banana、豆包、DeepSeek、MiniMax、智谱等图文模型与端点。"
  },
  {
    title: "编号主图提词与生图",
    desc: "严格按 L001、L002、L003 顺序读取链接定位、风格、人群、差异化壁垒和核心文案，逐条提词并按编号并发生图。"
  },
  {
    title: "编号详情页提词与生图",
    desc: "按每个链接的详情定位和文案逻辑生成连续分屏提示词，绑定商品多角度图与模特，确保编号、屏号和图片结果不串位。"
  },
  {
    title: "参考图反推与主体一致性",
    desc: "拆解竞品图的风格、景深、光影、字体和模特；结合自己的商品主体多角度图，严格保持结构、比例、材质和包装一致。"
  },
  {
    title: "批量 SKU 共创编排",
    desc: "先配置商品主体与可选视觉模板，再逐条编辑、勾选和预检 SKU 任务；支持稳定编号、并发控制、停止任务、保留成功结果和失败重试。"
  },
  {
    title: "采集控制与隐私清理",
    desc: "市场排行支持中途终止、刷新页面重新采集；每个模块页脚可一键清理当前网站 Cookie 与当天浏览历史。"
  },
  {
    title: "本地导出与数据回流",
    desc: "结果保存在浏览器本地，支持 Excel 多工作表、CSV 和复制；关键词、排行、词根与链接清单可继续回流三阶引擎。"
  },
  {
    title: "登录校验与风控控制",
    desc: "接入平台账号校验，支持随机间隔、后台继续、停止/清空与完成通知，只读取已登录账号可见数据，不修改页面数据。"
  }
];

const RELEASE_NOTES = [
  "新增共享业务知识库占位与本地资料导入；知识可分别辅助链接定位、主图提示词和详情页提示词，同时不覆盖词根证据、L 编号、主体图等硬规则。",
  "重构批量 SKU 为三阶段共创流程：主体与模板 → 逐 SKU 任务映射 → 预检与所选生成，并加入稳定编号、并发控制、停止和失败重试。",
  "继续保留本地双表合成、固定 20 字段链接清单、严格按 L 编号主图/详情提词与生图、统一 API 配置、采集控制和隐私清理。"
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
    desc: "可以先采集词根需求和市场商品榜，也可直接上传已经做好的两张表；到「链接清单」确认品类锚点与词根需求后，由 AI 按语义组合生成 L 编号和固定 20 字段的链接上架清单。"
  },
  {
    title: "业务知识库",
    desc: "从插件启动界面进入「知识库」，导入品牌、品类、人群、场景、利益点、视觉与合规资料，并选择用于链接定位、主图或详情页；知识只作业务校准，不替代采集证据和主体图。"
  },
  {
    title: "清单生图",
    desc: "选择连续 L 编号和主图/详情模式，上传商品主体多角度图；插件按每条链接自己的规划顺序提词，再按编号并发生图。参考图模式会先反推并覆盖当前提示词。"
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
        description="围绕店铺经营的 AI 自动化工具集。「少壮AI自动化」v1.8.24 在关键词、排行采集与链接清单基础上，新增共享业务知识库，并将批量 SKU 重构为可编辑、可预检、可停止和可重试的共创流程。"
      />

      <section className="tool-card">
        <header className="tool-card-head">
          <span className="tool-card-icon">
            <Image
              className="tool-card-logo"
              src={COLLECTOR.iconHref}
              alt="少壮AI自动化 Logo"
              width={42}
              height={42}
            />
          </span>
          <div className="tool-card-title">
            <h2>{COLLECTOR.name}</h2>
            <div className="tool-badges">
              <span className="tool-badge">v{COLLECTOR.version}</span>
              <span className="tool-badge tool-badge-soft">当前最新版</span>
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
          一个 Chrome Manifest V3 扩展：采集关键词、相关词、市场商品榜和分日排行，也可直接导入现成词根需求表与市场排行表生成链接清单；共享知识库可辅助 AI 理解业务，再按 L 编号完成主图、详情页和 SKU 提词与生图。结果可导出 Excel / CSV / 复制。仅读取你已登录账号下能看到的数据，不伪造请求、不修改任何数据。
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
