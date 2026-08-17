import {
  ArrowRight,
  CircleAlert,
  Download,
  ListChecks,
  LockKeyhole,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CopyAddress } from "@/components/tools/CopyAddress";
import {
  DMP_AUTOMATION_DOWNLOAD_NAME,
  DMP_AUTOMATION_NAME,
  DMP_AUTOMATION_VERSION
} from "@/lib/dmp-product";
import { getCurrentSession } from "@/lib/server-session";
import {
  getDmpAutomationAccessForSession,
  NO_DMP_AUTOMATION_ACCESS
} from "@/lib/tool-entitlements";

export const metadata: Metadata = {
  title: "AI 自动化工具 · 三阶引擎"
};

// 插件元信息（升级版本只需改这里，并把新 ZIP 放进 public/downloads/）
const COLLECTOR = {
  name: "少壮AI自动化",
  version: "1.9.23",
  zipHref: "/downloads/sycm-keyword-collector-v1.9.23.zip",
  downloadName: "少壮AI自动化-v1.9.23.zip",
  sizeLabel: "约 3.1 MB",
  platform: "Chrome / Edge 111+",
  iconHref: "/downloads/shaozhuang-ai-legacy-icon.png"
};

const DMP_AUTOMATION = {
  name: DMP_AUTOMATION_NAME,
  version: DMP_AUTOMATION_VERSION,
  zipHref: "/api/tools/dmp/download",
  downloadName: DMP_AUTOMATION_DOWNLOAD_NAME,
  platform: "Chrome / Edge 125+"
};

const DMP_DATA_GROUPS = [
  {
    title: "打爆路径自动取数",
    desc: "围绕主体商品与目标成功品，统一沉淀周期总览、日数据、渠道花费、一级/二级场景、成长阶段、基础指标和关键词样本。"
  },
  {
    title: "竞争态势店铺分析",
    desc: "支持本店同时对标最多 3 家竞店，获取基础经营、付费/免费流量结构、一级与二级渠道以及各店独立人群画像。"
  },
  {
    title: "统一官网 HTML 报告",
    desc: "取数完成后自动保存到当前授权账号，并在新的浏览器窗口打开官网 HTML 报告；支持历史追溯与无需登录的公开只读分享。"
  },
  {
    title: "人工授权与品牌保护",
    desc: "沿用管理员人工开通/续费机制，每次授权 30 天；报告创建与历史管理仅限所属官网账号，公开只读链接可免登录查看，并统一增加少壮AI自动化标题尾缀与轻水印。"
  }
];

const DMP_USAGE_STEPS = [
  {
    title: "开通并安装",
    body: "账号获得 30 天使用权限后下载 ZIP 并安装扩展；无需启动终端、Node.js 或本机服务，登录官网后即可使用云端数据能力。"
  },
  {
    title: "选择分析模式",
    body: "在一体化面板选择“打爆路径”或“竞争态势·店铺”。打爆路径填写主体商品与成功品 ID；竞争态势可按顺序添加最多 3 家竞店。"
  },
  {
    title: "检查并补漏一次",
    body: "首次取数有缺口时点击一次“精准补抓缺失数据”。北京时间 0:00–10:00 若昨天消耗尚未产出，可在 10:00–24:00 重新获取。"
  },
  {
    title: "在线查看与复盘",
    body: "插件完成采集后会自动保存报告并打开新的官网 HTML 报告窗口；可在报告中心管理历史结果并生成任何人都能打开的公开只读链接。"
  }
];

const FEATURES = [
  {
    title: "经营数据采集与市场证据",
    desc: "从生意参谋采集关键词、相关词、市场商品榜和分日商品排行；没有生意参谋市场榜时，也可按淘宝销量采集 Top300 商品卡。持续执行广告识别、成交语义与价格边界复核，减少真实商品误过滤和证据误算。"
  },
  {
    title: "词根、需求与商业任务",
    desc: "合并热词榜和衍生词，去重后拆解品类、属性、人群、场景、功能、风格、规格等词根，并结合流量、转化、利润、新品、截流或套装目标形成可追溯的经营任务。"
  },
  {
    title: "链接策略与规模化清单",
    desc: "将词根需求、市场证据和商业任务组合成稳定 L 编号，输出固定 20 字段链接上架清单；AI 负责五个营销企划与文案字段，商品标题只提供可选排序建议，插件在本地完成词根白名单、精确 60 字符和其余字段。"
  },
  {
    title: "AI 业务知识中枢",
    desc: "通过三步共创、文件导入或 Obsidian 实时连接，让 AI 理解产品、品牌、受众、使用场景、核心卖点、差异化壁垒、文案语气、视觉规范与合规边界；链接、主图和详情分别路由，展示命中来源和实际入模顺序。"
  },
  {
    title: "统一模型与账号配置",
    desc: "在一个入口集中配置少壮托管、ChatGPT、Nano Banana、豆包、DeepSeek、MiniMax、智谱等图文模型和端点；链接规划、视觉分析、提示词与图片编辑按任务调用同一账号配置。"
  },
  {
    title: "编号主图视觉生产",
    desc: "严格按 L001、L002、L003 等链接编号读取定位、关键词、场景、差异化和核心文案；明确产品名可从当前链接清单自动采用，无需重复填写确认。提示词和生图按每个编号独立执行，失败只影响当前 L。"
  },
  {
    title: "编号详情页叙事生产",
    desc: "按每个链接的详情定位和文案逻辑生成连续分屏方案，以“问题—功能证据—用户利益—差异化—信任说明”组织说服顺序；每一屏都是独立工位，稳定按 L 号和屏号落位，部分失败不会拖住整批。"
  },
  {
    title: "标题精确 60 字符",
    desc: "先只用热词榜完整词根求解；热词根数学上无法补齐时，才借鉴当前 L 实际命中的市场排行标题。店铺、品牌、促销、风险表述和非品类纯字母数字词不会进入补齐池。"
  },
  {
    title: "少壮图片实验室",
    desc: "批量查看淘宝商品主图，人工打标、分类和导出商品数据；可调用视觉与图片编辑 API 完成文字识别、翻译排版和整图除字，并把成功生图自动留存在当前账号的本机成果档案。"
  },
  {
    title: "SKU 与爆款裂变",
    desc: "批量 SKU 支持稳定编号、属性映射、视觉模板、并发控制、停止和失败重试；爆款裂变以参考风格和当前同款商品为双重约束，批量生成同系列差异化视觉方向。"
  },
  {
    title: "参考流转、修复与拼接",
    desc: "原图、译图和除字图可一键流转到主图、详情、SKU 或裂变工作台；生成结果支持引导重生、局部改文案和主体修复。风格焕新更换方案后，旧图自动归入本机历史并立即释放当前工位。"
  },
  {
    title: "本地资产与三阶回流",
    desc: "关键词、排行、词根、链接清单、分类商品数据和图片结果优先保存在浏览器本地，可导出 Excel、CSV、JSON 或 ZIP；编号批量成果按真实 L 范围归为一个项目，每个链接保留独立图片身份，并支持检索、预览、下载和 7 天回收站。"
  },
  {
    title: "安全边界与可控执行",
    desc: "只读取当前登录账号可见数据，不修改网页业务数据；知识库不替代词根、市场证据和商品主体图，API Key 不进入任务记录，关键批次支持停止、恢复、来源追踪和失败闭锁。"
  }
];

const RELEASE_NOTES = [
  "v1.9.23 将编号批量成果按真实 L 范围归档：L001–L030 会形成一个项目，每个链接保留一张独立图片及自己的 L 号、画面职责和版本，不再拆成 30 个技术批次。",
  "当前链接清单已明确产品名称、品类和硬属性，且已匹配真实主体图时直接进入生产；不再要求用户重复填写同一个商品名或额外勾选事实确认。",
  "产品名称仍保留安全边界：用户补充优先，其次采用链接清单中的确定性名称；占位名称、未确认的 AI 识图结果、主体图缺失或跨主体素材不会被自动放行。",
  "本机成果档案改用稳定业务项目归组；同一方案的首轮生成、缺图续跑、整组重跑和引导重生会进入同一项目，卡片按画面职责显示 V1、V2 等版本。",
  "风格焕新扩展为 24 套视觉风格，并加入热门与风格大类筛选；目标商品统一按“用户填写 → 智能识别 → 默认名称”取值，任务、提示词与档案名称保持一致。",
  "v1.9.23 已完成 685/685 项自动化回归；ZIP 包内版本、压缩完整性、敏感文件排除和正式哈希均已核验，旧版下载与回滚目录继续保留。"
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
    desc: "有生意参谋市场榜时继续按原流程采集；没有时，可在淘宝搜索填写关键词并按销量降序采集 Top300。插件会打开或复用淘宝页，逐页同步进度与预计剩余时间，采集店铺名、标题、收货人数、天猫/淘宝、入口价格，用于和词根共同判断链接清单。"
  },
  {
    title: "链接清单企划",
    desc: "可以先采集词根需求和市场商品榜，也可直接上传已经做好的两张表；AI 逐 L 生成五个必填营销字段，商品标题由插件先用热词根精确求解，必要时再借鉴已命中的市场标题，最终输出固定 20 列。"
  },
  {
    title: "业务知识库",
    desc: "从插件启动界面进入「知识库」，可用三步引导建立产品、品牌、受众、场景、卖点、差异化、文案、视觉和合规底稿，也可导入文件或连接 Obsidian；选择作用域后先核对命中数、来源顺序和事实依据，再进入正式生产。"
  },
  {
    title: "清单生图",
    desc: "选择连续 L 编号和主图/详情模式，上传商品主体多角度图；插件按每条链接自己的规划顺序提词，再按编号并发生图。参考图模式会先反推并覆盖当前提示词；生成后可在结果卡点击“引导重生”，标注局部并锁定其他区域后精确修复。"
  },
  {
    title: "少壮图片实验室",
    desc: "在淘宝搜索页打开少壮图片实验室，重新扫描后人工勾选商品主图；可按标签批量归类并查看店铺、平台、价格和页面付款人数，导出分类 Excel，也可调用已配置 API 生成译图或除字图并下载本地 ZIP。"
  },
  {
    title: "图片参考流转",
    desc: "在商品缩略图或大图预览旁点击「导入参考」，选择主图、详情、SKU 或裂变参考；插件会把当前原图、译图或除字图带到对应工作台并预填正确位置，确认提示词和参数后再由你手动发起生成。"
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

export default async function ToolsPage() {
  const session = await getCurrentSession();
  const dmpAccess = session
    ? await getDmpAutomationAccessForSession(session).catch(() => ({
        ...NO_DMP_AUTOMATION_ACCESS
      }))
    : { ...NO_DMP_AUTOMATION_ACCESS };
  const dmpAccessLabel = dmpAccess.allowed
    ? `当前账号已开通 · 剩余 ${dmpAccess.remainingDays} 天`
    : dmpAccess.status === "expired"
      ? "30 天授权已到期"
      : "当前账号未开通";

  return (
    <>
      <PageHeader
        eyebrow="AI Toolbox"
        title="AI 自动化工具"
        description="围绕电商增长，把市场机会、商品策略、视觉生产与经营复盘连接成一套可持续使用的 AI 工作台。"
      />

      <section className="tool-card dmp-tool-card">
        <header className="tool-card-head">
          <span className="tool-card-icon dmp-tool-icon">
            <ListChecks size={27} />
          </span>
          <div className="tool-card-title">
            <h2>{DMP_AUTOMATION.name}</h2>
            <div className="tool-badges">
              <span className="tool-badge">v{DMP_AUTOMATION.version}</span>
              <span className="tool-badge tool-badge-soft">打爆路径 + 竞争态势店铺</span>
              <span className="tool-badge tool-badge-soft">自动打开官网 HTML</span>
              <span className="tool-badge tool-badge-soft">{DMP_AUTOMATION.platform}</span>
              <span className="tool-badge tool-badge-paid">付费工具 · 数据库授权</span>
              <span className={dmpAccess.allowed ? "tool-badge tool-badge-access" : "tool-badge tool-badge-locked"}>
                {dmpAccessLabel}
              </span>
            </div>
          </div>
          <div className="tool-card-actions">
            {dmpAccess.allowed ? (
              <a
                className="button-link tool-download-btn dmp-tool-secondary"
                href={DMP_AUTOMATION.zipHref}
                download={DMP_AUTOMATION.downloadName}
              >
                <Download size={17} />
                下载插件
              </a>
            ) : (
              <span className="dmp-paid-required">
                <LockKeyhole size={15} /> 请联系管理员付费开通/续费
              </span>
            )}
            {dmpAccess.allowed ? (
              <Link className="button-link tool-download-btn" href="/tools/dmp-report" prefetch={false}>
                打开报告中心 <ArrowRight size={17} />
              </Link>
            ) : null}
          </div>
        </header>

        <p className="tool-lead">
          一个扩展统一完成达摩盘打爆路径与竞争态势店铺分析。取数结束后自动保存并打开官网 HTML 报告，帮助经营团队查看经营差距、投放结构、渠道来源与人群画像；普通报告中心仅提供官网在线查看，不展示业务数据下载入口。
        </p>

        <div className="dmp-tool-capabilities">
          {DMP_DATA_GROUPS.map((group) => (
            <div key={group.title}><strong>{group.title}</strong><span>{group.desc}</span></div>
          ))}
        </div>

        <div className="tool-block">
          <div className="tool-block-label">
            <ListChecks size={15} />
            如何使用
          </div>
          <ol className="tool-steps tool-steps-plain">
            {DMP_USAGE_STEPS.map((step, index) => (
              <li key={step.title} className="tool-step">
                <span className="tool-step-no">{index + 1}</span>
                <div className="tool-step-body">
                  <strong>{step.title}</strong>
                  <span>{step.body}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

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
          少壮AI自动化是一套围绕电商经营生产的 Chrome 工作台：先采集关键词与市场商品证据，拆解词根和真实需求，再结合商业目标与业务知识生成稳定的 L 编号链接策略；商品标题由本地白名单求解器优先使用热词榜完整词根，在确实无法补齐 60 字符时才安全借鉴命中的市场标题。随后沿用同一商品身份、定位和证据，完成主图、详情页、批量 SKU 与爆款裂变的提示词和图片生产；成功图片按账号留存在本机成果档案。系统只读取当前账号可见数据，不修改网页业务数据，也不会让知识库或市场标题覆盖商品主体、品类锚点和真实证据。
        </p>

        <div className="tool-block">
          <div className="tool-block-label">
            <Sparkles size={15} />
            v{COLLECTOR.version} 整体能力
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
            功能模块
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
