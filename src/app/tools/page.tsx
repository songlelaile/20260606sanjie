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
import { SowerWorkToolCard } from "@/components/tools/SowerWorkToolCard";
import { ToolsSubnav } from "@/components/tools/ToolsSubnav";
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

// AI 插件 ZIP 公开分发；DMP ZIP 与更新包必须保持现有账号权益校验。
const COLLECTOR = {
  name: "少壮AI自动化",
  version: "1.9.84",
  zipHref: "/downloads/sycm-keyword-collector-v1.9.84.zip",
  downloadName: "少壮AI自动化-v1.9.84.zip",
  sizeLabel: "Mac 完整包约 248.4 MB",
  macHref: "/downloads/shaozhuang-ai-v1.9.84-macos-full.zip",
  macDownloadName: "少壮AI自动化-v1.9.84-Mac完整安装包.zip",
  platform: "Chrome / Edge 116+",
  iconHref: "/downloads/shaozhuang-ai-legacy-icon.png"
};

const DMP_AUTOMATION = {
  name: DMP_AUTOMATION_NAME,
  version: DMP_AUTOMATION_VERSION,
  zipHref: "/api/tools/dmp/download",
  downloadName: DMP_AUTOMATION_DOWNLOAD_NAME,
  platform: "Chrome / Edge 125+"
};

const FEATURES = [
  {
    title: "创作功能统一进入官网",
    desc: "v1.9.84 官网模块统一导航：主图、详情、批量 SKU、爆款裂变、服装、买家秀与种草图、产品精修、生成视频统一打开官网对应模块。关键词、市场排行和链接清单继续在插件处理，插件不再单独提供创作页面。原插件配置、历史和素材保留；素材需在官网手动上传，不会自动跨端导入，官网按当前账号与模块的已上线能力使用。"
  },
  {
    title: "模型适配引导重生",
    desc: "按当前模型适配：gpt-image-2 使用结构化修复方案；gpt-image-2.5-sunburst（Image-2.5-sunburst）使用独立“修改 / 保留 / 证据”编辑方案，根据模型使用修复指令、参考图和蒙版；保留圈选范围外的原图，修复结果另存为新图。"
  },
  {
    title: "历史图片视频：先检查本机图库连接",
    desc: "插件本机历史按只读方式查看和下载，保留原账号记录与已归档原件，不提供旧工作台删除或恢复操作。读取原件需连接这台设备的图库服务；未连接或超时显示启动与恢复说明，已有记录仍可查看。127.0.0.1 指向当前设备，插件 ZIP 不会安装或启动图库助手，同账号也不会自动同步另一台电脑的文件。跨设备图片可复制已有档案夹恢复，视频请先在原电脑下载已生成原件后复制。"
  },
  {
    title: "场景延展：从产品细节到完整场景",
    desc: "在爆款裂变的案例裂变、风格焕新之后进入场景延展。上传同一产品多角度原图，可生成微观、近观、远观与可选超远观；支持材料、家具、日用品、珠宝饰品、美妆和服装，尽量保持原款式、颜色、材质、纹理与比例。原图与结果可并排对比，最多生成 20 张，比例与清晰度选项和风格焕新一致。"
  },
  {
    title: "跨版本永久图片视频档案",
    desc: "已归档的插件生成原件按原账号保存在“少壮AI成果档案/少壮跨版本档案-v1”，升级后保留原账号历史与原件。本次跳转不自动同步官网结果到插件永久档案，按官网现有保存和下载方式操作。未安装助手时显示待补存，也可继续使用共享文件夹备份；视频补存只读取已有结果，不重新提交生成。"
  },
  {
    title: "经营数据采集与市场证据",
    desc: "从生意参谋采集关键词、相关词和市场商品榜；没有生意参谋市场榜时，也可按淘宝销量采集 Top300 商品卡。持续执行广告识别、成交语义与价格边界复核，减少真实商品误过滤和证据误算。"
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
    desc: "通过三步共创或文件导入，让 AI 理解产品、品牌、受众、使用场景、核心卖点、差异化壁垒、文案语气、视觉规范与合规边界；插件中的知识库与配置继续保留；打开官网创作时不会自动跨端传入知识库内容。"
  },
  {
    title: "统一模型与账号配置",
    desc: "在一个入口集中配置少壮托管、ChatGPT、Nano Banana、豆包、DeepSeek、MiniMax、智谱等图文模型和端点；插件使用已有本机配置；官网创作使用官网当前账号设置，不会自动搬入插件的 API Key 或 Base URL。"
  },
  {
    title: "编号主图视觉生产",
    desc: "链接清单保留 L001、L002、L003 等编号及定位、关键词、场景、差异化和核心文案。主图创作进入官网主图模块；需要清单或商品主体图时，先从插件导出，再由用户在官网上传并核对，插件不会自动跨端传入。"
  },
  {
    title: "链接成详（L 编号）",
    desc: "链接成详进入官网详情模块，以当前已上线能力为准；链接清单与主体素材需由用户在官网手动上传，不会自动跨端导入。既有 L001、L002、L003 等清单定位与分屏规则可作为创作参考。"
  },
  {
    title: "标题精确 60 字符",
    desc: "先只用热词榜完整词根求解；热词根数学上无法补齐时，才借鉴当前 L 实际命中的市场排行标题。店铺、品牌、促销、风险表述和非品类纯字母数字词不会进入补齐池。"
  },
  {
    title: "少壮图片实验室",
    desc: "批量查看淘宝商品主图，人工打标、分类和导出商品数据；可调用视觉与图片编辑 API 完成文字识别、翻译排版和整图除字，成功生图按当前账号归档；安装本机档案助手后，原件会同步保存到永久档案。"
  },
  {
    title: "对象 SKU 复刻、主体替换与自定义尺寸",
    desc: "批量 SKU 入口跳转官网，按官网当前已上线能力操作；目标和参考图需由用户手动上传，不会自动携带插件已摘取的对象 SKU。既有对象 SKU 复刻规则：支持摘取淘宝/天猫当前公开 SKU 并批量生成，也支持用户自定义最终宽×高：每边 256–4096 px、总像素不超过 16,777,216。用户选定的对象 / 参考 SKU 原图会冻结为不可变视觉基底；每个任务只替换其中的商品主体，画布比例与尺寸、整体版式、背景、光影、文字、价格、卖点、装饰和其他可见细节保持原样，不得重新设计、改色、重排或增删。最终真实 JPG 会重新解码并按用户指定的精确尺寸验收；下载文件名只使用生成时冻结的业务 SKU 标题，不含 SKU01、SKU03 等技术 SKU 编号，同名自动追加 -2、-3。"
  },
  {
    title: "参考流转、修复与拼接",
    desc: "从插件的参考入口打开官网主图、详情、SKU 或裂变对应模块。先在插件下载所需原图、译图或除字图，再在官网手动上传；不会自动携带图片或预填创作内容。修复与拼接按官网当前已上线能力操作。"
  },
  {
    title: "本地资产与三阶回流",
    desc: "关键词、排行、词根、链接清单和分类商品数据保存在浏览器本地，可导出 Excel、CSV、JSON 或 ZIP；图片视频原件支持通过本机档案助手永久保存，未安装助手时显示待补存。已有编号成果、图片身份与历史档案保留；升级后的插件历史按只读方式查看和下载，不会自动跨端迁移。"
  },
  {
    title: "安全边界与可控执行",
    desc: "只读取当前登录账号可见数据，不修改网页业务数据；知识库不替代词根、市场证据和商品主体图，API Key 不进入任务记录，关键批次支持停止、恢复、来源追踪和失败闭锁。"
  }
];

const INSTALL_STEPS = [
  {
    title: "下载并解压",
    body: "Mac 用户下载上方完整安装包并全部解压到长期保留的固定文件夹，保持「加载已解压」「安装器」和「安装本机助手.command」在同一层。不要直接选择 ZIP，也不要放在临时目录。"
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
    body: "点「加载已解压的扩展程序 / Load unpacked」，Mac 完整包只选「加载已解压」文件夹；普通插件包选择含 manifest.json 的那一层。不要加载外层安装包或「安装器」。已有用户保留原插件，按下方更新步骤操作。"
  },
  {
    title: "安装本机助手并固定插件",
    body: "确认 Chrome 中插件已启用后，Mac 用户双击完整包外层的「安装本机助手.command」，按提示完成更新与永久档案组件安装。最后从浏览器拼图菜单固定「少壮AI自动化」。"
  }
];

const REFERENCE_DETAIL_STEPS = [
  {
    title: "提取同行详情",
    body: "粘贴淘宝 / 天猫 / 1688 同行商品 URL，或在商品页点击「摘取详情页面」。淘宝 / 天猫从“图文详情”开始，在“店铺推荐”之前停止，并排除紧前最后一整张详情图；1688 从“商品详情”开始，在“【平台活动下价格】”之前停止。从页面任意位置启动后先回到顶部，再逐屏等待图片加载并识别结束标记。完成后打开待导入预览，点击“导入本次摘取”才进入批量详情。插件只扫描当前登录账号可见、页面已公开加载的正文，按原页面顺序形成只读来源快照；未找到结束标记时提示重试，不提交不完整详情。"
  },
  {
    title: "分析并整理结构框架",
    body: "将只读快照按来源顺序分析为 5–16 个最终分屏，每屏只保留一句可编辑的核心内容 / 描述方向。普通 warning、确定性 fallback 和 partial 会自动整理；受阻模块自动跳过，全部模块都受阻时仍会阻断。确认前可修改方向、重排、删除、复制或合并。"
  },
  {
    title: "绑定主体与可选模特",
    body: "每个商品目标至少绑定 1 张自有或已授权的主体图并确认素材权利；模特图完全可选，并以独立角色进入任务。新链不创建、不选择、不审核事实卡，同行原图、原文和竞品事实不会成为自家事实或生成素材。"
  },
  {
    title: "一次锁定进入批量",
    body: "只点一次「锁定结构并进入批量」即可保存不可变 revision，并自动建立绑定当前全部已授权主体与可选模特的默认目标。正式来源、至少一个安全模块、授权、视觉服务商能力、精确 revision / 账号 / 任务身份和防重复计费仍是硬门禁。"
  },
  {
    title: "批量生成、恢复与归档",
    body: "每个目标生成 5–16 个独立分屏；支持双并发、停止、失败屏重试、刷新恢复和逐目标长详情预览。结果先写入当前账号的本机图片档案，取得安全完成权威后才标记完成；不同商品的主体、模特、提示词、图片和结果严格隔离。"
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
    desc: "从插件启动界面进入「知识库」，可用三步引导建立产品、品牌、受众、场景、卖点、差异化、文案、视觉和合规底稿，也可导入文件；选择作用域后先核对命中数、来源顺序和事实依据，再进入正式生产。"
  },
  {
    title: "链接成详（L 编号）与清单生图",
    desc: "在插件选好 L 编号并导出链接清单，点击主图或详情入口进入官网对应模块。由用户在官网上传清单和商品主体多角度图，核对提示词与参数后手动开始；插件不会自动跨端导入清单、素材或创作草稿。"
  },
  {
    title: "少壮图片实验室",
    desc: "在淘宝搜索页打开少壮图片实验室，重新扫描后人工勾选商品主图；可按标签批量归类并查看店铺、平台、价格和页面付款人数，导出分类 Excel，也可调用已配置 API 生成译图或除字图并下载本地 ZIP。"
  },
  {
    title: "图片参考流转",
    desc: "在商品缩略图或大图预览旁选择主图、详情、SKU 或裂变参考入口，打开官网对应模块。先在插件下载所需原图、译图或除字图，再在官网手动上传；不会自动携带图片或预填创作内容。确认提示词和参数后，再由你手动发起生成。"
  },
  {
    title: "三阶源表回流",
    desc: "将关键词、衍生词、词根需求，以及市场排行、商品榜或竞品表等已有导出文件上传到本平台「数据导入」，即可进入三阶计算、业务诊断和看板复盘。"
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
        description="围绕电商增长，把市场机会、商品策略、视觉生产与经营分析连接成一套可持续使用的 AI 工作台。"
      />

      <ToolsSubnav active="overview" />

      <SowerWorkToolCard />

      <section className="tool-card dmp-tool-card">
        <header className="tool-card-head">
          <span className="tool-card-icon dmp-tool-icon">
            <ListChecks size={27} />
          </span>
          <div className="tool-card-title">
            <h2>{DMP_AUTOMATION.name}</h2>
            <div className="tool-badges">
              <span className="tool-badge">v{DMP_AUTOMATION.version}</span>
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
            href={COLLECTOR.macHref}
            download={COLLECTOR.macDownloadName}
          >
            <Download size={18} />
            下载 Mac 完整安装包
          </a>
        </header>

        <p className="tool-hint">
          Mac 完整包适用于 macOS 13.5+ 的 Chrome，包含插件、更新助手、永久档案助手及运行环境，无需另装 Node、Python 或 Xcode。
          <a href={COLLECTOR.zipHref} download={COLLECTOR.downloadName}>仅下载插件（约 6.6 MB，Chrome / Edge）</a>。
          Windows 尚无本机助手安装器。尚未完成全新 Mac 的系统安装拦截验收；这是安装场景的验收边界。
        </p>

        <p className="tool-lead">
          少壮AI自动化是一套围绕电商经营生产的工作台：先采集关键词与市场商品证据，拆解词根和真实需求，再结合商业目标与业务知识生成稳定的链接策略；商品标题由本地白名单求解器优先使用热词榜完整词根，在确实无法补齐 60 字符时才安全借鉴命中的市场标题。主图、详情、批量 SKU、爆款裂变、服装、买家秀与种草图、产品精修及生成视频的入口统一打开官网对应模块，按官网当前已上线功能操作。关键词、市场排行和链接清单继续在插件处理；需要清单或素材时由用户在官网上传，不会自动跨端导入。已有本机历史和原件保留。系统只读取当前账号可见数据，不修改网页业务数据，也不会让知识库或市场标题覆盖商品主体、品类锚点和真实证据。
        </p>

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
            <Sparkles size={15} />
            参考成详
          </div>
          <article className="tool-usage-card" aria-labelledby="reference-detail-title">
            <span className="tool-usage-no">新</span>
            <div>
              <strong id="reference-detail-title">
                只读来源 + 结构框架 + 主体 / 模特批量生成
              </strong>
              <p>
                参考成详的创作在官网对应模块进行，不替代链接成详的 L 编号流程。已有采集快照和主体素材需由用户在官网上传，不会自动跨端导入；下列步骤说明该功能的既有来源与生成规则；其中“本机图片档案”指官网当前浏览器环境，不代表自动同步到插件永久档案助手。从一个同行商品详情建立只读来源快照，系统自动整理 warning、fallback、partial 和可跳过的 blocked 模块；无需事实卡审核，上传已授权主体与可选模特后，一次锁定即可进入批量生成。
              </p>
            </div>
          </article>
          <ol className="tool-steps">
            {REFERENCE_DETAIL_STEPS.map((step, index) => (
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

        <div className="tool-block">
          <div className="tool-block-label">
            <Download size={15} />
            首次安装（开发者模式加载，5 步）
          </div>
          <p className="tool-hint">
            Mac 完整包已附带安装器，解压后按以下步骤启用插件和安装助手。已有插件请保留原目录和原扩展记录，直接按下方「更新与恢复」操作。
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

        <div className="tool-block" id="update-help">
          <div className="tool-block-label">
            <ListChecks size={15} />
            已安装用户：更新与恢复
          </div>
          <p className="tool-hint">
            先结束采集和生成任务并保存内容，再确认 Chrome 当前加载的实际安装目录。请勿卸载扩展或移动原目录；更新后在原扩展卡片核对版本、扩展 ID、API、Base URL 与本机图视频档案。
          </p>
          <p className="tool-hint">
            v1.9.84 官网模块统一导航，并补齐 gpt-image-2.5-sunburst 的引导重生方案。官网当前账号的既有方舟素材自动送审与视频衔接：完成当前账号素材权限配置后，参考图审核通过再生成视频。自动素材区最多 50 张，满额清理最早且未被任务使用的素材；绑定素材单独保留，最多 50 张，可自行选择与解除绑定。两区共同遵守方舟账号云配额，Entry 云端合计最多 50 张。视频默认关闭可见水印；未配置素材权限的账号保留原有图生视频接口，不会自动使用其他账号付费。保留原图、本机永久档案与随包离线升级。检测到新版本不等于已经写入完成，请以重启后的实际版本和更新回执为准。
          </p>
          <div className="tool-usage-grid">
            <article className="tool-usage-card">
              <span className="tool-usage-no">1</span>
              <div>
                <strong>Mac：安装助手并在原目录升级</strong>
                <p>
                  下载并完整解压 Mac 安装包，保持原插件启用，双击「安装本机助手.command」。安装器会查找原插件并安装更新与永久档案组件，无需逐台准备修复文件；多份插件时按提示选择。v1.9.67–v1.9.74 可按提示安排包内离线升级；安装包还包含 v1.9.77、v1.9.80、v1.9.81 与当前版本的离线材料。安装器会先校验当前版本与兼容性，再按提示处理。保存工作后完全退出 Chrome，重新打开，核对“更新成功 · v{COLLECTOR.version}”，并确认原扩展的实际版本。
                </p>
              </div>
            </article>
            <article className="tool-usage-card">
              <span className="tool-usage-no">2</span>
              <div>
                <strong>普通插件包与更早版本</strong>
                <p>
                  仅下载插件的用户，先备份原目录程序文件，再把 ZIP 内文件合并覆盖到 Chrome 当前加载的这个原目录，在原扩展卡片点“重新加载”。v1.9.63 等更早版本可能因新增权限显示 MANIFEST_SCOPE_CHANGED，不能使用此次离线升级材料。不要卸载扩展或替换整个文件夹。
                </p>
                <p>
                  如果原目录位于 UnpackedExtensions，网页更新器无法取得写入权限；符合上述版本范围的 Mac 用户使用完整包安装器处理。安装器不修改 Chrome 安全策略，不修改 Chrome 配置、API 与图视频历史数据，失败时回滚，不搬动目录。
                </p>
              </div>
            </article>
          </div>
        </div>

        <div className="tool-block">
          <div className="tool-block-label">
            <ListChecks size={15} />
            使用
          </div>
          <p className="tool-hint">
            按当前要完成的动作选择对应路径。关键词、市场排行和链接清单使用插件现有配置；创作入口打开官网，登录后核对官网当前账号的配置与模块状态，再上传所需素材。
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
              <strong>已有用户更新</strong>：本次是 v{COLLECTOR.version} 官网模块统一导航。若旧版仍提示 UPDATE_FAILED，可使用 Mac 完整包中的安装器进行离线升级；首次安装助手需要在每台 Mac 上运行一次。请保留原扩展记录，升级后核对版本、ID、模型/API、Base URL 和图视频历史。达摩盘更新仍需在当前浏览器登录官网，并拥有有效授权。
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
