#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CANONICAL_ROOT="${SANJIE_CANONICAL_ROOT:-/Users/shaozhuang/20260606sanjie}"
EXPECTED_VERSION="1.9.30"
EXPECTED_ZIP_SIZE_BYTES="4477082"
EXPECTED_ZIP_SHA256="c5c23ca2aefc6d4e9f45f9c63f31e58b90f2e8c45b104a627c1f8c5687a2772f"
ZIP_PATH="public/downloads/sycm-keyword-collector-v${EXPECTED_VERSION}.zip"
DMP_VERSION="2.3.59"
DMP_ZIP_SHA256="98abed5ddad3f6dd12d46d7c8d758134a0e4b699bcf53406b79c3d6eed99be27"
DMP_ZIP_PATH="private-assets/dmp/shaozhuang-dmp-unified-automation-v${DMP_VERSION}.zip"
FROZEN_DMP_V2359_PATH="private-assets/dmp/shaozhuang-dmp-unified-automation-v2.3.59.zip"
FROZEN_DMP_V2359_SHA256="98abed5ddad3f6dd12d46d7c8d758134a0e4b699bcf53406b79c3d6eed99be27"
FROZEN_DMP_V2359_SIZE_BYTES="406176"

fail() {
  echo "发布保护失败：$*" >&2
  exit 1
}

fixed_search() {
  if command -v rg >/dev/null 2>&1; then
    rg -Fq -- "$1" "$2"
  else
    grep -Fq -- "$1" "$2"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "缺少 SHA-256 校验工具（sha256sum 或 shasum）"
  fi
}

require_file() {
  [[ -f "$1" ]] || fail "缺少文件 $1"
}

require_fixed() {
  local needle="$1"
  local file="$2"
  local label="$3"
  fixed_search "$needle" "$file" || fail "${label}（${file}）"
}

forbid_fixed() {
  local needle="$1"
  local file="$2"
  local label="$3"
  if fixed_search "$needle" "$file"; then
    fail "${label}（${file}）"
  fi
}

[[ "$ROOT" == "$CANONICAL_ROOT" ]] || fail "当前目录是 ${ROOT}；只允许从唯一生产工程 ${CANONICAL_ROOT} 发版"
cd "$ROOT"

for file in \
  src/app/login/page.tsx \
  src/app/globals.css \
  src/lib/accounts.ts \
  src/middleware.ts \
  prisma/schema.prisma \
  src/app/tools/page.tsx \
  src/app/tools/tutorials/page.tsx \
  src/components/tools/ToolsSubnav.tsx \
  src/lib/tool-tutorials.ts \
  .env.example \
  src/app/tools/dmp-report/page.tsx \
  src/app/api/dmp-market-reports/route.ts \
  src/app/api/dmp-reports/route.ts \
  src/app/api/dmp-report-shares/route.ts \
  src/app/api/dmp-report-exports/route.ts \
  src/app/api/shared/dmp-reports/[token]/route.ts \
  src/app/api/management/dmp-report-share-analytics/route.ts \
  src/app/shared/dmp-reports/[token]/page.tsx \
  src/app/api/dmp-runtime/[action]/route.ts \
  src/app/api/tools/dmp/download/route.ts \
  src/components/tools/DmpBrandWatermark.tsx \
  src/components/tools/DmpGrowthReportViewModel.ts \
  src/components/tools/DmpGrowthReportViewer.tsx \
  src/components/tools/DmpGrowthReportViewer.module.css \
  src/components/tools/DmpMarketReportViewModel.ts \
  src/components/tools/DmpMarketReportViewer.tsx \
  src/components/tools/DmpMarketReportViewer.module.css \
  src/components/tools/DmpReportViewer.tsx \
  src/components/tools/DmpReportWorkspace.tsx \
  src/components/tools/DmpSharedReportClient.tsx \
  src/components/management/ManagementConsole.tsx \
  src/components/management/DmpShareAnalyticsPanel.tsx \
  src/lib/dmp-product.ts \
  src/lib/dmp-report-import.ts \
  src/lib/dmp-report-export-authorization.ts \
  src/lib/dmp-report-export-contract.ts \
  src/lib/dmp-report-format.ts \
  src/lib/dmp-report-export.ts \
  src/lib/dmp-report-store.ts \
  src/lib/dmp-public-origin.ts \
  src/lib/dmp-report-share.ts \
  src/lib/dmp-report-share-events.ts \
  src/lib/dmp-report-share-path.ts \
  src/lib/dmp-report-types.ts \
  src/lib/tool-entitlements.ts \
  public/tools/dmp-report-engine/completeness-engine.js \
  public/tools/dmp-report-engine/report-engine.js; do
  require_file "$file"
done

# 登录 UI 与密码校验基线。禁止退回没有眼睛按钮或明文直接比较的旧实现。
require_fixed "Eye, EyeOff" src/app/login/page.tsx "登录页缺少密码显示/隐藏图标"
require_fixed "password-visibility-button" src/app/login/page.tsx "登录页缺少密码显示/隐藏按钮"
require_fixed "password-visibility-button" src/app/globals.css "缺少密码显示/隐藏按钮样式"
require_fixed 'PASSWORD_HASH_PREFIX = "scrypt"' src/lib/accounts.ts "密码哈希基线不是 scrypt"
require_fixed "verifyPassword(" src/lib/accounts.ts "缺少密码哈希验证函数"
require_fixed "timingSafeEqual" src/lib/accounts.ts "密码比较缺少时序安全校验"
forbid_fixed "user.password !== password" src/lib/accounts.ts "检测到旧版明文密码直接比较"

# 数据结构基线。错误工程缺少这些模型，发布前必须立即阻断。
require_fixed "model Shop {" prisma/schema.prisma "缺少多店铺 Shop 模型"
require_fixed "model ShopCalcRun {" prisma/schema.prisma "缺少多店铺 ShopCalcRun 模型"
require_fixed "model ToolEntitlement {" prisma/schema.prisma "缺少付费工具授权模型"
require_fixed "model DmpBusinessReport {" prisma/schema.prisma "缺少达摩盘历史报告模型"
require_fixed "model DmpReportShare {" prisma/schema.prisma "缺少达摩盘官网分享模型"
require_fixed "model DmpReportHeatBucket {" prisma/schema.prisma "缺少达摩盘匿名点击热区模型"
require_fixed "model DmpReportShareSession {" prisma/schema.prisma "缺少达摩盘匿名访问会话模型"
require_fixed "model DmpReportShareEvent {" prisma/schema.prisma "缺少达摩盘匿名事件幂等模型"
require_fixed "model DmpReportExportAudit {" prisma/schema.prisma "缺少达摩盘管理员导出审计模型"
require_fixed "revokedAt" prisma/schema.prisma "达摩盘公开链接缺少管理员撤销字段"
require_file "prisma/migrations/20260815001500_tool_entitlements/migration.sql"
require_file "prisma/migrations/20260815160000_add_dmp_business_reports/migration.sql"
require_file "prisma/migrations/20260816203000_add_dmp_report_sharing/migration.sql"
require_file "prisma/migrations/20260817090000_public_dmp_share_analytics/migration.sql"
require_file "prisma/migrations/20260817160000_dmp_report_export_audit/migration.sql"
require_file "prisma/migrations/20260822093000_add_dmp_report_shop/migration.sql"
require_fixed "fingerprint" prisma/schema.prisma "达摩盘历史报告缺少幂等指纹字段"
require_fixed "tenantId_userId_fingerprint" src/lib/dmp-report-store.ts "达摩盘报告保存缺少账号内幂等约束"
require_fixed "dmpBusinessReportFingerprint" src/lib/dmp-report-store.ts "达摩盘报告保存缺少稳定指纹计算"
require_fixed 'parseArchiveReplacement' src/app/api/dmp-reports/route.ts "达摩盘报告接口缺少同商品对原子更新参数校验"
require_fixed 'mode !== "replace-latest-pair"' src/app/api/dmp-reports/route.ts "达摩盘报告接口缺少同商品对原子更新模式"
require_fixed "replaceLatestDmpGrowthReport" src/lib/dmp-report-store.ts "达摩盘报告存储缺少同店同商品对原子更新"
require_fixed "pg_advisory_xact_lock" src/lib/dmp-report-store.ts "达摩盘同商品对更新缺少并发事务锁"
require_fixed "absorbedReportIds" src/lib/dmp-report-store.ts "达摩盘同商品对更新缺少被吸收报告复核"
require_fixed "DMP_REPORT_HISTORY_STALE" src/app/api/dmp-reports/route.ts "达摩盘报告接口缺少并发历史过期恢复合同"
require_fixed "lockDmpReportTargets" src/lib/dmp-report-share.ts "达摩盘报告分享创建未参与原子替换锁协议"

# 工具页保持登录保护；静态插件包继续允许直接下载。
require_fixed 'pathname === "/login"' src/middleware.ts "中间件缺少登录页公开规则"
require_fixed 'pathname.startsWith("/api/auth/")' src/middleware.ts "中间件缺少认证接口公开规则"
forbid_fixed 'pathname === "/tools"' src/middleware.ts "工具页被错误加入未登录公开白名单"
require_fixed "downloads/" src/middleware.ts "插件下载目录未从鉴权中间件排除"

# 教程专区必须沿用工具页登录保护，只在配置正式视频地址后生成播放器。
require_fixed '<ToolsSubnav active="overview" />' src/app/tools/page.tsx "AI 工具页缺少视频教程二级导航"
require_fixed 'href: "/tools/tutorials"' src/components/tools/ToolsSubnav.tsx "AI 工具二级导航缺少教程入口"
require_fixed '<ToolsSubnav active="tutorials" />' src/app/tools/tutorials/page.tsx "视频教程页缺少当前导航状态"
require_fixed "TOOL_TUTORIALS.length > 0" src/app/tools/tutorials/page.tsx "视频教程页缺少正式视频门禁"
require_fixed "NEXT_PUBLIC_TUTORIAL_VIDEO_URL" src/lib/tool-tutorials.ts "视频教程缺少正式视频环境变量"
require_fixed "POSTER_URL" src/lib/tool-tutorials.ts "视频教程缺少封面环境变量"
require_fixed "NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL" src/lib/tool-tutorials.ts "豆包 API 教程缺少正式视频环境变量"
require_fixed "NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL" src/lib/tool-tutorials.ts "豆包 API 教程缺少封面环境变量"
require_fixed "NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL" .env.example "环境变量示例缺少豆包 API 教程视频地址"
require_fixed "NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL" .env.example "环境变量示例缺少豆包 API 教程封面地址"
require_fixed "flatMap<ToolTutorial>" src/lib/tool-tutorials.ts "视频教程未逐条执行独立环境校验"
require_fixed "if (!videoSrc) return [];" src/lib/tool-tutorials.ts "未配置单条视频地址时仍可能展示伪视频"
require_fixed 'title: "少壮AI自动化教程"' src/lib/tool-tutorials.ts "视频教程标题不一致"
require_fixed 'trackNo: "02"' src/lib/tool-tutorials.ts "少壮 AI 自动化教程学习路径不一致"
require_fixed 'duration: "04:04"' src/lib/tool-tutorials.ts "视频教程时长不一致"
require_fixed 'slug: "configure-doubao-api"' src/lib/tool-tutorials.ts "豆包 API 教程路径标识不一致"
require_fixed 'trackNo: "01"' src/lib/tool-tutorials.ts "豆包 API 教程学习路径不一致"
require_fixed 'title: "配置豆包API"' src/lib/tool-tutorials.ts "豆包 API 教程标题不一致"
require_fixed 'category: "模型配置"' src/lib/tool-tutorials.ts "豆包 API 教程分类不一致"
require_fixed 'duration: "04:25"' src/lib/tool-tutorials.ts "豆包 API 教程时长不一致"
require_fixed 'publishedAt: "2026-08-27"' src/lib/tool-tutorials.ts "视频教程发布日期不一致"
require_fixed "TOOL_TUTORIALS.length" src/components/tools/ToolsSubnav.tsx "AI 工具二级导航教程数量不是动态统计"
require_fixed "tutorialCountByTrack" src/app/tools/tutorials/page.tsx "视频教程学习路径数量不是动态统计"
forbid_fixed 'badge: "1 条教程"' src/components/tools/ToolsSubnav.tsx "AI 工具二级导航仍硬编码一条教程"
forbid_fixed '"已上线 1 条"' src/app/tools/tutorials/page.tsx "视频教程路径仍硬编码一条教程"
require_fixed "aspect-ratio: 3 / 2;" src/app/globals.css "视频播放器不是 3:2 比例"
require_fixed "object-fit: contain;" src/app/globals.css "视频播放器未完整容纳画面"

# 工具页版本、文件与哈希必须一致，避免页面版本和下载包串版。
require_fixed "version: \"${EXPECTED_VERSION}\"" src/app/tools/page.tsx "工具页版本不是 v${EXPECTED_VERSION}"
require_fixed "sycm-keyword-collector-v${EXPECTED_VERSION}.zip" src/app/tools/page.tsx "工具页下载地址不是 v${EXPECTED_VERSION}"
require_fixed 'sizeLabel: "约 4.5 MB"' src/app/tools/page.tsx "工具页插件包大小标识不一致"
require_fixed "shaozhuang-ai-legacy-icon.png" src/app/tools/page.tsx "工具页未使用老板旧版 Logo"
require_fixed "参考成详" src/app/tools/page.tsx "工具页缺少独立参考成详卡"
require_fixed "提取当前商品详情" src/app/tools/page.tsx "参考成详缺少当前商品提取入口"
require_fixed "按照原页面顺序生成只读来源快照" src/app/tools/page.tsx "参考成详缺少只读来源快照合同"
require_fixed "每屏只突出一句可编辑的核心内容 / 描述方向" src/app/tools/page.tsx "参考成详缺少一句话分屏方向"
require_fixed "确认前可修改方向、重排、删除、复制、合并和锁定模块" src/app/tools/page.tsx "参考成详缺少确认前编辑能力"
require_fixed "多张自家商品事实卡" src/app/tools/page.tsx "参考成详缺少多事实卡说明"
require_fixed "只点一次「确认并进入批量生成」" src/app/tools/page.tsx "参考成详缺少一次确认入口"
require_fixed "系统内部自动保存 revision、核验事实与授权素材并完成显式审批" src/app/tools/page.tsx "参考成详缺少内部安全门禁"
require_fixed "不让用户反复审核" src/app/tools/page.tsx "参考成详仍可能要求重复审核"
require_fixed "5–16 个独立分屏" src/app/tools/page.tsx "参考成详分屏数量边界不正确"
require_fixed "双并发、停止、失败屏重试、刷新恢复和逐目标长详情预览" src/app/tools/page.tsx "参考成详缺少批次生命周期说明"
require_fixed "成功取得安全句柄后才标记完成" src/app/tools/page.tsx "参考成详缺少本机安全落盘门禁"
require_fixed "不同商品的事实、提示词、图片和结果严格隔离" src/app/tools/page.tsx "参考成详缺少跨商品隔离说明"
require_fixed "链接成详（L 编号）" src/app/tools/page.tsx "工具页未保留链接成详 L 编号流程"
forbid_fixed "参考图模式会先反推并覆盖当前提示词" src/app/tools/page.tsx "工具页仍展示已移除的旧参考图详情流程"
require_fixed "模型只创作无字、无商品背景" src/app/tools/page.tsx "工具页缺少 SKU 无商品背景合同"
require_fixed "字体、字号、文字位置、整体布局和商品主体位置由浏览器固定" src/app/tools/page.tsx "工具页缺少 SKU 固定版式合同"
require_fixed "仅背景色、邻近渐变和轻背景氛围可变" src/app/tools/page.tsx "工具页缺少 SKU 背景可变边界"
require_fixed "真实 JPG" src/app/tools/page.tsx "工具页缺少 SKU JPG 下载说明"
require_fixed "商品规格.jpg" src/app/tools/page.tsx "工具页缺少商品规格文件名说明"
require_fixed "不含 SKU 编号" src/app/tools/page.tsx "工具页未声明下载文件名不含 SKU 编号"
require_fixed "用户自定义最终宽×高" src/app/tools/page.tsx "工具页缺少 SKU 自定义尺寸说明"
require_fixed "每边 256–4096 px" src/app/tools/page.tsx "工具页缺少 SKU 单边尺寸范围"
require_fixed "总像素不超过 16,777,216" src/app/tools/page.tsx "工具页缺少 SKU 总像素上限"
require_fixed "等比裁切且不拉伸" src/app/tools/page.tsx "工具页缺少 SKU 底图合成边界"
require_fixed "用户指定的精确尺寸验收" src/app/tools/page.tsx "工具页缺少 SKU 最终精确像素门禁"
forbid_fixed "分日商品排行" src/app/tools/page.tsx "工具页仍宣称已移除的分日商品排行模块"
forbid_fixed "商品排行分日下载" src/app/tools/page.tsx "工具页仍展示已移除的商品排行模块"
forbid_fixed "货盘 / 无界源表" src/app/tools/page.tsx "工具页仍展示已移除的货盘/无界插件模块"
forbid_fixed "插件「商品排行」" src/app/tools/page.tsx "工具页仍指导使用已移除的商品排行入口"
forbid_fixed 'title: "商品排行"' src/app/tools/page.tsx "工具页重新出现已移除的商品排行卡片"
forbid_fixed 'title: "货盘"' src/app/tools/page.tsx "工具页重新出现已移除的货盘卡片"
forbid_fixed 'title: "无界商品"' src/app/tools/page.tsx "工具页重新出现已移除的无界商品卡片"
forbid_fixed 'title: "无界人群"' src/app/tools/page.tsx "工具页重新出现已移除的无界人群卡片"
require_file "$ZIP_PATH"
require_file "public/downloads/shaozhuang-ai-legacy-icon.png"

actual_zip_size_bytes="$(wc -c < "$ZIP_PATH" | tr -d '[:space:]')"
[[ "$actual_zip_size_bytes" == "$EXPECTED_ZIP_SIZE_BYTES" ]] || fail "v${EXPECTED_VERSION} ZIP 大小不一致：${actual_zip_size_bytes} bytes"
actual_zip_sha256="$(sha256_file "$ZIP_PATH")"
[[ "$actual_zip_sha256" == "$EXPECTED_ZIP_SHA256" ]] || fail "v${EXPECTED_VERSION} ZIP 哈希不一致：$actual_zip_sha256"
unzip -t "$ZIP_PATH" >/dev/null || fail "v${EXPECTED_VERSION} ZIP 完整性校验失败"
package_readme="$(unzip -p "$ZIP_PATH" README.md)" || fail "v${EXPECTED_VERSION} ZIP 缺少包内 README"
[[ "$package_readme" == *"# 少壮AI自动化 v${EXPECTED_VERSION}"* ]] || fail "包内 README 版本不是 v${EXPECTED_VERSION}"
[[ "$package_readme" == *"商品排行（旧分日下载模块）"* ]] || fail "包内 README 缺少旧商品排行删除说明"
[[ "$package_readme" == *"外部「市场排行 / 商品排行 / 竞品表」文件导入兼容"* ]] || fail "包内 README 缺少外部表兼容边界"
[[ "$package_readme" != *"1.9.29"* && "$package_readme" != *"1.9.28"* && "$package_readme" != *"1.9.27"* && "$package_readme" != *"1.9.26"* && "$package_readme" != *"1.9.25"* && "$package_readme" != *"1.9.23"* ]] || fail "包内 README 仍含旧版本状态"
[[ "$package_readme" == *"字体、字号、行高、文字坐标、标题框、SKU 标框、整体布局和主体位置固定"* ]] || fail "包内 README 缺少 SKU 固定版式合同"
[[ "$package_readme" == *"只允许背景主色、邻近色渐变和低对比轻纹理变化"* ]] || fail "包内 README 缺少 SKU 背景可变边界"
[[ "$package_readme" == *"文件名只使用商品规格，不包含 SKU 编号"* ]] || fail "包内 README 缺少商品规格 JPG 命名合同"
[[ "$package_readme" == *"用户自定义最终宽×高"* && "$package_readme" == *"256–4096"* && "$package_readme" == *"16,777,216"* ]] || fail "包内 README 缺少 SKU 自定义尺寸合同"
[[ "$package_readme" == *"最终 JPEG 必须解码为用户指定的精确像素"* ]] || fail "包内 README 缺少 SKU 精确像素验收"
[[ "$package_readme" != *"SHA-256"* && "$package_readme" != *"bytes"* ]] || fail "包内 README 不得嵌入包自身产物元数据"

# 达摩盘插件、付费授权、受保护下载与历史报告中心必须成套发布。
require_fixed "DMP_AUTOMATION_VERSION = \"${DMP_VERSION}\"" src/lib/dmp-product.ts "达摩盘工具卡版本不是 v${DMP_VERSION}"
require_fixed 'DMP_AUTOMATION_NAME = `达摩盘一体化自动取数｜${DMP_AUTOMATION_BRAND}`' src/lib/dmp-product.ts "达摩盘官网当前产品不是一体化品牌版本"
require_fixed 'zipHref: "/api/tools/dmp/download"' src/app/tools/page.tsx "达摩盘工具卡未使用受保护下载接口"
require_fixed 'const resolvesArchiveShop = scope === "archive-shop";' src/app/api/dmp-reports/route.ts "达摩盘报告接口缺少扩展默认店铺专用路由"
require_fixed "getDmpDefaultArchiveShop" src/app/api/dmp-reports/route.ts "达摩盘默认店铺路由未使用账号内权威解析"
require_fixed "listDmpBusinessReportArchivePair" src/app/api/dmp-reports/route.ts "达摩盘商品对归档缺少账号与店铺隔离读取"
require_fixed 'archiveMode: "replace-current-report"' src/app/api/dmp-reports/route.ts "达摩盘原地重生成缺少当前报告替换模式"
require_fixed "replaceReportCreatedAt" src/app/api/dmp-reports/route.ts "达摩盘原地重生成缺少目标版本 CAS 参数"
require_fixed 'candidate.code === "DMP_REPORT_TARGET_STALE"' src/app/api/dmp-reports/route.ts "达摩盘原地重生成缺少并发过期响应码"
require_fixed "replaceCurrentDmpGrowthReport" src/lib/dmp-report-store.ts "达摩盘官网缺少当前报告原地替换事务"
require_fixed "createdAt: input.replacement.expectedCreatedAt" src/lib/dmp-report-store.ts "达摩盘当前报告替换未执行 createdAt 原子 CAS"
require_fixed 'mode: "replace-current-report" as const' src/lib/dmp-report-store.ts "达摩盘当前报告替换缺少可验收回执"
require_fixed 'readonly code = "DMP_REPORT_TARGET_STALE"' src/lib/dmp-report-store.ts "达摩盘当前报告替换缺少专用并发冲突码"
require_fixed 'orderBy: [{ createdAt: "asc" }, { id: "asc" }]' src/lib/dmp-report-store.ts "达摩盘默认店铺排序不稳定"
require_fixed 'orderBy: [{ createdAt: "asc" }, { id: "asc" }]' src/lib/store/runtime-store.ts "官网登录默认店铺排序与归档接口不一致"
require_fixed "getDmpReportAccess" src/app/tools/dmp-report/page.tsx "达摩盘报告中心缺少数据库付费授权复核"
require_fixed "listDmpBusinessReports" src/app/tools/dmp-report/page.tsx "达摩盘报告中心未加载历史报告"
forbid_fixed 'session?.role === "admin"' src/app/tools/dmp-report/page.tsx "达摩盘报告中心仍被错误限制为管理员"
require_fixed "历史报告" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心缺少历史管理"
require_fixed "复制分享链接" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心缺少官网分享入口"
forbid_fixed "分享行为与点击热区" src/components/tools/DmpReportWorkspace.tsx "普通达摩盘报告中心仍暴露分享点击分析"
forbid_fixed "DmpReportInteractionSummary" src/components/tools/DmpReportWorkspace.tsx "普通达摩盘报告中心仍加载分享分析类型"
forbid_fixed "/api/dmp-report-shares?reportId=" src/components/tools/DmpReportWorkspace.tsx "普通达摩盘报告中心仍请求分享分析数据"
require_fixed "formatDmpCell" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘报告中心未统一两位小数展示"
require_fixed '/比|率|变化|相对|CTR|贡献|百分位/i' src/lib/dmp-report-format.ts "达摩盘比率字段未统一换算为百分比"
forbid_fixed "JSON 工程" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心仍展示工程信息"
forbid_fixed "下载 Excel" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心仍开放 Excel 下载"
forbid_fixed "下载 CSV" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心仍开放 CSV 下载"
forbid_fixed "打印 / 保存 PDF" src/components/tools/DmpSharedReportClient.tsx "达摩盘分享页仍开放 PDF 下载"
require_fixed "当前版本仅支持官网在线查看，暂不提供数据下载" src/app/api/dmp-reports/route.ts "达摩盘报告接口未关闭业务数据下载"
forbid_fixed "buildDmpReportWorkbook" src/app/api/dmp-reports/route.ts "达摩盘报告接口仍能生成 Excel"
require_fixed "DmpReportViewer" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心未使用多类型统一预览组件"
require_fixed "DmpReportViewer" src/app/shared/dmp-reports/[token]/page.tsx "达摩盘分享报告未使用多类型统一预览组件"
require_fixed "DmpMarketReportViewer" src/components/tools/DmpReportViewer.tsx "达摩盘统一预览未接入类目大盘报告"
require_fixed "data-report-watermark" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘统一预览缺少全篇水印"
require_fixed "data-report-watermark" src/components/tools/DmpMarketReportViewer.tsx "达摩盘类目大盘预览缺少全篇水印"
require_fixed "background: #0d716b !important;" src/components/tools/DmpGrowthReportViewer.module.css "达摩盘官网报告表头不是统一绿色"
require_fixed "color: #fff !important;" src/components/tools/DmpGrowthReportViewer.module.css "达摩盘官网报告表头不是统一白字"
require_fixed "background-color: #edf5f3 !important;" src/components/tools/DmpGrowthReportViewer.module.css "达摩盘官网增长报告正文不是定版浅绿色"
require_fixed "color-scheme: light !important;" src/components/tools/DmpGrowthReportViewer.module.css "达摩盘官网增长报告未隔离后台深色主题"
require_fixed "data-chart-tooltip=\"svg\"" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网商品曲线缺少即时数值提示"
require_fixed "data-chart-point={series}" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网商品曲线缺少逐点悬停合同"
require_fixed "data-period={payload.period}" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网商品曲线提示缺少周期"
require_fixed "data-role={payload.role}" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网商品曲线提示缺少主体/对手角色"
require_fixed "data-value={value}" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网商品曲线提示缺少数值"
require_fixed "text-align: right;" src/components/tools/DmpGrowthReportViewer.module.css "达摩盘官网报告数值未靠右展示"
require_fixed "vertical-align: middle;" src/components/tools/DmpGrowthReportViewer.module.css "达摩盘官网报告数值未垂直居中"
require_fixed "background: var(--market-green) !important;" src/components/tools/DmpMarketReportViewer.module.css "达摩盘类目大盘表头不是统一绿色"
require_fixed "color: #fff !important;" src/components/tools/DmpMarketReportViewer.module.css "达摩盘类目大盘表头不是统一白字"
require_fixed "background: #edf5f3 !important;" src/components/tools/DmpMarketReportViewer.module.css "达摩盘类目大盘正文不是定版浅绿色"
require_fixed "td.trackHeatCell" src/components/tools/DmpMarketReportViewer.module.css "达摩盘类目价格带热力编码缺少高权重隔离"
require_fixed "text-align: right !important;" src/components/tools/DmpMarketReportViewer.module.css "达摩盘类目大盘数值未靠右展示"
require_fixed 'focusReport={query.view === "report"}' src/app/tools/dmp-report/page.tsx "达摩盘报告页不支持插件聚焦打开"
require_fixed 'body?.reportType !== "market" || body?.report?.report_type !== "market"' src/app/api/dmp-market-reports/route.ts "达摩盘类目大盘独立归档接口缺少双重类型校验"
require_fixed 'archiveDmpReport(new Request' src/app/api/dmp-market-reports/route.ts "达摩盘类目大盘归档未复用受保护存储入口"
require_fixed 'pathname.startsWith("/api/dmp-reports")' src/middleware.ts "达摩盘报告同步接口未绕过页面中间件"
require_fixed 'pathname === "/api/dmp-market-reports"' src/middleware.ts "达摩盘类目大盘归档接口未绕过页面中间件"
require_fixed 'pathname.startsWith("/api/dmp-report-shares")' src/middleware.ts "达摩盘插件分享接口未绕过页面中间件"
require_fixed 'pathname === "/api/dmp-report-exports"' src/middleware.ts "达摩盘插件导出授权接口未绕过页面中间件"
require_fixed 'const PUBLIC_DMP_REPORT_PATH = /^\/shared\/dmp-reports\/[a-f0-9]{64}$/i;' src/middleware.ts "达摩盘公开报告页未按精确高熵令牌路径放行"
require_fixed 'const PUBLIC_DMP_REPORT_EVENTS_PATH = /^\/api\/shared\/dmp-reports\/[a-f0-9]{64}$/i;' src/middleware.ts "达摩盘公开事件接口未按精确高熵令牌路径放行"
require_fixed 'request.method !== "GET" && request.method !== "HEAD"' src/middleware.ts "达摩盘公开报告页未限制为 GET/HEAD"
require_fixed 'request.method !== "POST" && request.method !== "OPTIONS"' src/middleware.ts "达摩盘公开事件接口未限制为 POST/OPTIONS"
forbid_fixed 'pathname.startsWith("/api/shared/dmp-reports")' src/middleware.ts "达摩盘匿名事件接口使用了过宽的前缀白名单"
require_fixed 'pathname.startsWith("/api/dmp-runtime/")' src/middleware.ts "达摩盘云端运行接口未绕过页面中间件"
require_fixed "x-sanjie-session" src/app/api/dmp-reports/route.ts "达摩盘报告同步接口缺少插件登录令牌"
require_fixed "x-sanjie-session" src/app/api/dmp-report-shares/route.ts "达摩盘分享接口缺少插件登录令牌"
forbid_fixed "export async function GET" src/app/api/dmp-report-shares/route.ts "普通报告所有者接口仍暴露传播分析 GET"
forbid_fixed "getDmpReportInteractionSummary" src/app/api/dmp-report-shares/route.ts "普通报告所有者仍可读取传播分析"
require_fixed "getPublicDmpSharedReport(token)" src/app/shared/dmp-reports/[token]/page.tsx "达摩盘分享页未使用公开高熵令牌读取"
forbid_fixed "getDmpReportAccess" src/app/shared/dmp-reports/[token]/page.tsx "达摩盘公开分享页仍强制官网登录"
require_fixed "tenantId: access.tenantId" src/lib/dmp-report-share.ts "达摩盘分享创建缺少租户所有者隔离"
require_fixed "userId: access.userId" src/lib/dmp-report-share.ts "达摩盘分享创建缺少用户所有者隔离"
require_fixed "revokedAt: null" src/lib/dmp-report-share.ts "达摩盘公开读取或事件写入缺少撤销状态过滤"
require_fixed "createHash(\"sha256\")" src/lib/dmp-report-share.ts "达摩盘分享令牌未做哈希落库"
require_fixed 'const DEFAULT_PUBLIC_APP_ORIGIN = "https://shaozhuangai.com"' src/lib/dmp-public-origin.ts "达摩盘分享缺少固定官网域名"
require_fixed "toPublicAppUrl(share.path)" src/app/api/dmp-report-shares/route.ts "达摩盘分享地址仍可能使用请求 Host 或内部端口"
require_fixed "recordDmpPublicShareEvent" src/app/api/shared/dmp-reports/[token]/route.ts "达摩盘公开分享页缺少匿名事件写入"
require_fixed "MAX_EVENT_BODY_BYTES = 64 * 1024" src/app/api/shared/dmp-reports/[token]/route.ts "达摩盘匿名事件请求体未限制为 64KB"
require_fixed "公开报告数据仅由只读页面提供" src/app/api/shared/dmp-reports/[token]/route.ts "达摩盘公开事件 API 仍可能泄露完整 JSON"
require_fixed "requireAdminResponse" src/app/api/management/dmp-report-share-analytics/route.ts "达摩盘传播分析 API 缺少管理员数据库复核"
require_fixed "getDmpReportShareManagementAnalytics" src/app/api/management/dmp-report-share-analytics/route.ts "达摩盘管理员传播分析 API 缺少聚合查询"
require_fixed "revokeDmpReportShare" src/app/api/management/dmp-report-share-analytics/route.ts "达摩盘管理员缺少分享撤销能力"
require_fixed "DmpShareAnalyticsPanel" src/components/management/ManagementConsole.tsx "管理员后台缺少达摩盘传播分析入口"
require_fixed "达摩盘报告传播分析" src/components/management/DmpShareAnalyticsPanel.tsx "管理员传播分析面板缺少稳定标识"
require_fixed "getDmpReportAccessFromToken" src/app/api/dmp-runtime/[action]/route.ts "达摩盘云端运行接口缺少官网登录授权"
require_fixed "getDmpAutomationAccessForSession" src/lib/dmp-report-store.ts "达摩盘历史报告缺少付费授权复核"
require_fixed "tenantId: access.tenantId, userId: access.userId" src/lib/dmp-report-store.ts "达摩盘历史报告缺少账号隔离"
require_fixed "dmpJsonImport" src/app/api/auth/me/route.ts "认证端点缺少达摩盘 JSON 权限声明"
require_fixed "dmpReportExport" src/app/api/auth/me/route.ts "认证端点缺少管理员报告导出能力声明"
require_fixed "dmpAutomation: dmpAccess.allowed" src/app/api/auth/me/route.ts "认证端点未按数据库授权控制插件"
require_fixed "authorizeAndAuditDmpReportExport" src/app/api/dmp-report-exports/route.ts "达摩盘导出接口未执行实时授权与审计"
require_fixed "dmpReportExportAudit.create" src/lib/dmp-report-export-authorization.ts "达摩盘导出授权缺少审计记录"
require_fixed "getDmpAutomationAccessForSession" src/app/api/tools/dmp/download/route.ts "达摩盘下载接口缺少数据库授权校验"
require_fixed "请联系管理员付费开通" src/app/api/tools/dmp/download/route.ts "达摩盘下载接口缺少未授权提示"
require_fixed 'DMP_AUTOMATION_ACCESS_DAYS = 30' src/lib/dmp-product.ts "达摩盘授权周期不是 30 天"
require_fixed "expiresAt" src/lib/tool-entitlements.ts "达摩盘授权缺少到期时间"
require_fixed "remainingDays" src/lib/tool-entitlements.ts "达摩盘授权缺少剩余天数"
require_fixed "dmpEntitlement: dmpAccess" src/app/api/auth/me/route.ts "认证端点未返回达摩盘授权倒计时"
require_fixed 'DMP_AUTOMATION_TOOL_CODE = "dmp-automation"' src/lib/dmp-product.ts "达摩盘产品码不稳定"
require_fixed "returnOnSpend" public/tools/dmp-report-engine/completeness-engine.js "达摩盘插件缺少付费 ROI 区间计算"
require_fixed "preferredMetricValue(previous.subject, parsed.subject)" public/tools/dmp-report-engine/completeness-engine.js "达摩盘插件仍会丢失同义指标中的付费区间"
require_fixed "subjectRange?.exact === false || competitorRange?.exact === false" public/tools/dmp-report-engine/report-engine.js "达摩盘插件仍会为区间指标伪造精确相对差"
require_fixed "contributionRatio" public/tools/dmp-report-engine/completeness-engine.js "达摩盘插件缺少付费金额占比区间计算"
require_fixed 'paidAmountShare", name: "付费金额占比", aliases: ["付费金额占比", "付费成交额占比", "付费gmv贡献率", "广告gmv贡献率", "广告归因gmv贡献率"]' public/tools/dmp-report-engine/completeness-engine.js "达摩盘付费金额占比缺少新名称及历史名称兼容"
require_fixed "const contribution = safeIntervalDivide(metrics[side].paidGmv, metrics[side].totalGmv, {" public/tools/dmp-report-engine/completeness-engine.js "达摩盘付费金额占比未按付费成交额除以总成交额安全计算"
require_fixed "calculatedDirectRoi" public/tools/dmp-report-engine/completeness-engine.js "达摩盘场景未按分配后消耗计算直接 ROI"
require_fixed "calculableMetricValue" public/tools/dmp-report-engine/completeness-engine.js "达摩盘量级区间未先转换为可计算数值"
require_fixed "transportOnlyReason" public/tools/dmp-report-engine/completeness-engine.js "达摩盘完整性引擎未忽略 OPTIONS/HEAD/redirect 传输记录"
require_fixed "classifyGrowthRecord" public/tools/dmp-report-engine/completeness-engine.js "达摩盘补抓响应未使用统一解析分类"
require_fixed '["投放", "ROI"' public/tools/dmp-report-engine/report-engine.js "达摩盘业务报告缺少 ROI"
require_fixed '投入产出比|投产比|ROI|ROAS' public/tools/dmp-report-engine/report-engine.js "达摩盘云端报告仍可能把投产比格式化为百分比"
require_fixed 'isDmpMultipleMetric' src/lib/dmp-report-format.ts "达摩盘官网报告未区分投产倍数与百分比"
require_fixed 'dmpDisplayCellText' src/lib/dmp-report-format.ts "达摩盘官网报告未解析区间对象"
require_fixed 'reconcilePaidMetricRanges' src/lib/dmp-report-import.ts "达摩盘官网报告未贯通付费成交额、ROI 与 PPC 区间"
require_fixed 'suppressIntervalMetricDifferences' src/lib/dmp-report-import.ts "达摩盘官网导出仍可能保留区间伪精确差值"
require_fixed 'rangeDividedByRange' src/lib/dmp-report-import.ts "达摩盘官网未按区间安全计算付费金额占比"
require_fixed 'ensurePaidAmountShareRows' src/lib/dmp-report-import.ts "达摩盘官网总览未补齐付费金额占比"
require_fixed 'columnIndexByAliases(periodTable, CROSS_TABLE_METRICS.totalGmv)' src/lib/dmp-report-import.ts "达摩盘官网未兼容全渠道总GMV周期列"
require_fixed 'columnIndexByAliases(periodTable, CROSS_TABLE_METRICS.paidGmv)' src/lib/dmp-report-import.ts "达摩盘官网未兼容付费GMV周期列"
require_fixed 'isDmpIntervalCell' src/components/tools/DmpGrowthReportViewModel.ts "达摩盘官网报告仍可能展示区间伪精确差值"
require_fixed "periodMetricsForItem" public/tools/dmp-report-engine/report-engine.js "达摩盘商品表未按商品 ID 匹配周期指标"
require_fixed "canonicalRenderData" public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎缺少官网预览渲染合同"
require_fixed "subject_daily_gmv" public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎缺少主体逐日 GMV 合同"
require_fixed "buildPairedDaily" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎缺少主体与对手逐日 GMV 构建"
require_fixed "METRIC_ALIAS_GROUPS" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎缺少同义指标归一"
require_fixed "buildAlignedMetrics" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎缺少全量同维指标"
require_fixed "sameComparedPeriod" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎未校验目标对手周期"
require_fixed "promotionDetailIssues" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎未审计推广明细"
require_fixed "SUBJECT_MINIMUM_PROMOTION_CONTRACT" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎缺少主体推广最低字段合同"
require_fixed "missingSubjectMinimumPromotionMetrics" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎不会阻断主体推广最低字段缺失"
require_fixed "subjectPromotionSceneIssues" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎未审计主体推广场景"
require_fixed "coreRowsWithAlignedFallback" public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎缺少核心指标同维回填"
require_fixed '["ROI", metric("subject", "roi"), metric("competitor", "roi")' public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告总览缺少主体与对手 ROI"
require_fixed '["PPC", metric("subject", "ppc"), metric("competitor", "ppc")' public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告总览缺少主体与对手 PPC"
require_fixed "spendSingleDayPartial" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎未按单日花费缺口补算"
require_fixed "dailyKeywordSpend / spend" public/tools/dmp-report-engine/completeness-engine.js "达摩盘公共完整性引擎未按同覆盖日计算关键词占比"
require_fixed "reportSpendScope" public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎缺少花费覆盖范围"
require_fixed "const overviewMetrics = CORE_METRIC_CONTRACT.map" public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎未固化双侧八指标字段"
require_fixed '"主体日GMV", "对手日GMV"' public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎缺少主体与对手分日 GMV"
require_fixed '"主体展现", "对手展现"' public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎缺少主体与对手关键词同维列"
require_fixed '"主体起始GMV", "对手起始GMV"' public/tools/dmp-report-engine/report-engine.js "达摩盘公共报告引擎缺少主体与对手成长阶段同维列"
require_fixed "DMP_GROWTH_OVERVIEW_METRICS" src/components/tools/DmpGrowthReportViewModel.ts "达摩盘官网总览缺少统一八指标映射"
require_fixed "DMP_GROWTH_METRIC_ALIASES" src/lib/dmp-report-types.ts "达摩盘官网总览未集中定义统一指标别名"
require_fixed '{ key: "paidGmv", label: "付费成交额"' src/lib/dmp-report-types.ts "达摩盘官网总览缺少付费成交额"
require_fixed '{ key: "roi", label: "ROI"' src/lib/dmp-report-types.ts "达摩盘官网总览缺少 ROI"
require_fixed '{ key: "ppc", label: "PPC"' src/lib/dmp-report-types.ts "达摩盘官网总览缺少 PPC"
require_fixed '{ key: "paidShare", label: "付费金额占比"' src/lib/dmp-report-types.ts "达摩盘官网总览缺少付费金额占比"
require_fixed "assessDmpEffectiveReportQuality" src/lib/dmp-report-quality.ts "达摩盘官网缺少服务端有效质量复核"
require_fixed "normalizeDmpCanonicalReportForUse" src/lib/dmp-report-import.ts "达摩盘官网缺少只读规范化入口"
forbid_fixed 'data-report-quality="partial"' src/components/tools/DmpGrowthReportViewer.tsx "达摩盘成长报告仍展示完整性诊断"
forbid_fixed "数据完整性提示" src/lib/dmp-report-export.ts "达摩盘导出仍展示完整性诊断"
require_fixed "effectiveDmpReportQuality" src/lib/dmp-report-share.ts "达摩盘公开分享未复核有效质量"
require_fixed "firstDisclosed" src/components/tools/DmpGrowthReportViewModel.ts "达摩盘官网总览缺少逐侧安全回退"
require_fixed "data-overview-metric" src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网未并排展示主体与目标对手指标"
require_fixed 'const TRACK_COMPACT_COLUMNS = [' src/components/tools/DmpMarketReportViewModel.ts "达摩盘官网缺少细分赛道十列紧凑表解析"
require_fixed 'TRACK_OPPORTUNITY_ARCHIVE' src/components/tools/DmpMarketReportViewModel.ts "达摩盘官网未合并货品增长机会分片"
require_fixed 'dmpMarketTrackPeriodOptions' src/components/tools/DmpMarketReportViewer.tsx "达摩盘官网缺少全部已采赛道周期选择"
require_fixed 'data-track-period-selector' src/components/tools/DmpMarketReportViewer.tsx "达摩盘官网细分赛道周期选择器缺少稳定标识"
forbid_fixed 'data-report-quality="partial"' src/components/tools/DmpMarketReportViewer.tsx "达摩盘官网市场报告仍展示完整性诊断"
forbid_fixed '缺失项不会按 0 处理' src/components/tools/DmpMarketReportViewer.tsx "达摩盘官网市场报告仍展示工程缺失提示"
forbid_fixed '部分数据报告' src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网商品报告仍展示完整性诊断"
forbid_fixed '继续补采' src/components/tools/DmpGrowthReportViewer.tsx "达摩盘官网商品报告仍展示补采工程入口"
require_fixed 'const MAX_REPORT_BYTES = 8 * 1024 * 1024' src/lib/dmp-report-store.ts "达摩盘官网类目报告容量未覆盖全周期归档"
require_fixed 'const MAX_REPORT_CELLS = 1_000_000' src/lib/dmp-report-store.ts "达摩盘官网细分赛道单元格容量不足"
require_fixed '类目大盘单表超过 ${MAX_TABLE_ROWS} 行，请按周期或属性分片后重试' src/lib/dmp-report-store.ts "达摩盘官网仍可能静默截断细分赛道行"
require_fixed 'update: effectiveQuality === "complete"' src/lib/dmp-report-store.ts "达摩盘重试报告质量未按服务端复核结果单向升级"
require_file "frozen/dmp-v2.3.59.json"
require_fixed '"packageSha256": "98abed5ddad3f6dd12d46d7c8d758134a0e4b699bcf53406b79c3d6eed99be27"' frozen/dmp-v2.3.59.json "达摩盘 v2.3.59 官网冻结凭据不一致"
require_file "$DMP_ZIP_PATH"
require_file "$FROZEN_DMP_V2359_PATH"
[[ ! -e "public/downloads/shaozhuang-dmp-unified-automation-v${DMP_VERSION}.zip" ]] || fail "达摩盘付费插件仍暴露在 public 下载目录"
[[ ! -e "public/downloads/shaozhuang-dmp-unified-automation-v2.3.59.zip" ]] || fail "达摩盘 v2.3.59 黄金包被错误暴露在 public 下载目录"
unzip -p "$DMP_ZIP_PATH" '*official-share-url.mjs' | grep -F 'normalizeOfficialShareUrl' >/dev/null || fail "达摩盘插件缺少官网分享地址规范化模块"
# Linux 的 unzip 在下游 grep -q 提前退出时会收到 SIGPIPE；配合 pipefail 会把“已命中”误判成失败。
# 这里让 grep 读完整个条目再丢弃输出，保证本机与生产机得到一致结果。
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'const CLOUD_RUNTIME_BASE = `${OFFICIAL_SITE}/api/dmp-runtime`' >/dev/null || fail "达摩盘插件未固定连接官网云端运行接口"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'DMP_CDP_CREATE_SHARE' >/dev/null || fail "达摩盘插件缺少官网分享消息"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'url.searchParams.set("scope", "archive-shop")' >/dev/null || fail "达摩盘旧竞店与分享链路未读取官网登录默认店铺"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'normalizeOfficialShareUrl' >/dev/null || fail "达摩盘插件分享地址未强制重挂生产官网"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'chrome.windows.create({ url: reportUrl, focused: true, type: "normal" })' >/dev/null || fail "达摩盘插件完成后不会新开官网 HTML 报告窗口"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'url.searchParams.set("reportId"' >/dev/null || fail "达摩盘插件未按报告编号打开官网页面"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F "\"version\": \"${DMP_VERSION}\"" >/dev/null || fail "达摩盘安装包 Manifest 版本不一致"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'OFFICIAL_REPORT_SYNC_TIMEOUT_MS = 120_000' >/dev/null || fail "达摩盘插件报告保存等待仍过短"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'OFFICIAL_REPORT_SHARE_ATTEMPTS = 2' >/dev/null || fail "达摩盘插件分享请求缺少瞬时失败重试"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'DMP_CDP_VERIFY_REPORT_EXPORT' >/dev/null || fail "达摩盘插件缺少管理员导出能力实时校验"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'DMP_CDP_AUTHORIZE_REPORT_EXPORT' >/dev/null || fail "达摩盘插件缺少管理员导出二次授权"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F '/api/dmp-report-exports' >/dev/null || fail "达摩盘插件未连接官网导出审计接口"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F '达摩盘商品机会大盘归档｜少壮AI自动化' >/dev/null || fail "达摩盘安装包缺少商品机会大盘品牌标题"
if unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -Eq '"description"|"version_name"'; then
  fail "达摩盘安装包 Manifest 仍展示执行说明"
fi
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F 'official-local-report.js' >/dev/null || fail "达摩盘安装包缺少官网报告壳桥接"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F 'official-local-report.css' >/dev/null || fail "达摩盘安装包缺少官网报告壳样式"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F '"use_dynamic_url": true' >/dev/null || fail "达摩盘本机报告页未使用动态扩展地址"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'DMP_DIRECT_PREPARE_OFFICIAL_FRAME' >/dev/null || fail "达摩盘插件缺少官网报告壳启动门禁"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'DMP_DIRECT_GET_REPORT_FOR_FRAME' >/dev/null || fail "达摩盘插件缺少隔离报告读取门禁"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'tools/dmp-report?source=dmp-extension#launch=' >/dev/null || fail "达摩盘插件未从官网地址打开本机报告"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'scheduleStoredReportArchive("worker-wake")' >/dev/null || fail "达摩盘插件缺少后台唤醒自动补归档"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'url.searchParams.set("scope", "archive-shop")' >/dev/null || fail "达摩盘商品与类目归档未读取官网登录默认店铺"
unzip -p "$DMP_ZIP_PATH" '*direct-popup.js' | grep -F '报告将由官网按当前账号自动归档并打开' >/dev/null || fail "达摩盘弹窗缺少默认同步并打开官网报告提示"
if unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' '*service-worker.js' | grep -Eq 'sanjie_active_shop|activeShopExplicit|/api/shops|ensureManualOfficialArchivePage'; then
  fail "达摩盘插件仍在本地识别活动店铺或预热官网页面"
fi
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'runDirectSupplementPass' >/dev/null || fail "达摩盘插件缺少付费指标与推广明细自动补抓"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'chrome.runtime.onInstalled?.addListener' >/dev/null || fail "达摩盘插件升级后不会自动补归档"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'chrome.runtime.onStartup?.addListener' >/dev/null || fail "达摩盘插件启动后不会自动补归档"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'chrome.cookies.onChanged?.addListener' >/dev/null || fail "达摩盘插件登录恢复后不会自动补归档"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'async function synchronizeArchiveOutboxEntry(state, entry, options = {})' >/dev/null || fail "达摩盘后台补归档缺少静默队列同步"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'autoOpened: false' >/dev/null || fail "达摩盘后台补归档仍会自动弹出报告"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'function rolling7TrackMatrixContractComplete(value)' >/dev/null || fail "达摩盘类目归档缺少细分赛道矩阵完整性检查"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'const matrixComplete = Boolean(categoryComplete && track && rolling7TrackMatrixContractComplete(track));' >/dev/null || fail "达摩盘细分赛道矩阵完整性未纳入三层归档合同"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'const opportunityComplete = Boolean(matrixComplete && rolling7TrackOpportunityContractComplete(track));' >/dev/null || fail "达摩盘货品机会完整性未与矩阵合同联动"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'const ROLLING7_TRACK_CONTRACT_VERSION = 3' >/dev/null || fail "达摩盘细分赛道完整性合同不是最新版本"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'function rolling7TrackLatestContract(value, options = {})' >/dev/null || fail "达摩盘细分赛道缺少本轮精确合同"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'payload.archiveMode = "replace-latest-pair"' >/dev/null || fail "达摩盘商品报告未请求官网原子更新"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'payload.archiveMode = "replace-current-report"' >/dev/null || fail "达摩盘插件原地重生成未请求同 ID 替换"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'payload.replaceReportCreatedAt = currentReplacement.reportCreatedAt' >/dev/null || fail "达摩盘插件原地重生成未携带目标版本"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'DMP_REPORT_TARGET_STALE' >/dev/null || fail "达摩盘插件缺少当前报告并发过期识别"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'payload.replaceReportId = historyRetention.replaceReportId' >/dev/null || fail "达摩盘商品报告未冻结最新更新目标"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'DMP_REPORT_HISTORY_STALE' >/dev/null || fail "达摩盘商品报告缺少官网历史过期识别"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'resetStaleGrowthArchivePreparation' >/dev/null || fail "达摩盘商品报告缺少过期冻结体安全重建"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'function rolling7TrackMatrixShapeComplete(value)' >/dev/null || fail "达摩盘细分赛道缺少可展示矩阵形状门禁"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'authoritativePropertyMetadataCaptured' >/dev/null || fail "达摩盘细分赛道没有区分权威属性全集与已观察矩阵"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'function rolling7TrackSnapshotMatchesTarget(value, targetRequest = null)' >/dev/null || fail "达摩盘赛道缓存未绑定精确周期和目标日期"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'readyWhen: value => value?.marketTrackTemplateReady === true' >/dev/null || fail "达摩盘赛道懒加载模板没有稳定等待"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'const retained = {' >/dev/null || fail "达摩盘本轮赛道失败时不会保留最后有效矩阵"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'latestAttempt: {' >/dev/null || fail "达摩盘本轮赛道失败没有独立记录最近尝试"
unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'SANJIE_MARKET_NORMALIZED_REPORT_MAX_BYTES = 8 * 1024 * 1024' >/dev/null || fail "达摩盘类目报告上传容量不足"
if unzip -p "$DMP_ZIP_PATH" '*direct-service-worker.js' | grep -F 'SANJIE_IMPORT_ENABLED' >/dev/null; then
  fail "达摩盘插件仍保留已淘汰的导入占位开关"
fi
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F 'data-report-watermark' >/dev/null || fail "达摩盘本机报告缺少全篇水印"
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F '少壮AI自动化 · shaozhuangai.com' >/dev/null || fail "达摩盘本机报告水印品牌不一致"
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F 'Array.from({ length: 54 }' >/dev/null || fail "达摩盘本机报告水印未覆盖全篇"
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F '.table-shell thead th{color:#fff!important;background:#0d716b!important' >/dev/null || fail "达摩盘本机报告表头不是统一绿色白字"
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F '.table-shell tbody td{background-color:#fff}' >/dev/null || fail "达摩盘本机报告表格正文缺少明确浅色背景"
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F 'tbody tr:nth-child(even)>td{background-color:#f9fbfb}' >/dev/null || fail "达摩盘本机报告表格缺少浅色隔行背景"
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F 'data-chart-point' >/dev/null || fail "达摩盘本机商品曲线缺少逐点悬停"
unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -F 'data-chart-tooltip' >/dev/null || fail "达摩盘本机商品曲线缺少数值提示层"
unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -F 'data-chart-point' >/dev/null || fail "达摩盘本机类目曲线缺少逐点悬停"
unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -F 'const TRACK_ARCHIVE_TABLE_PREFIX = "细分赛道矩阵-"' >/dev/null || fail "达摩盘类目报告缺少按属性稳定命名的细分赛道归档表"
if unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -F 'name: "细分赛道数据状态"' >/dev/null; then
  fail "达摩盘类目报告仍对用户展示赛道完整性诊断"
fi
if unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -Eq '细分赛道数据待补采|货品增长机会待补采|变化值为分值绝对差'; then
  fail "达摩盘类目报告仍展示补采或计算逻辑"
fi
if unzip -p "$DMP_ZIP_PATH" 'html-writer.js' | grep -Eq '<ul class="data-notice">|<p class="section-note">|<small class="metric-scope">'; then
  fail "达摩盘商品报告仍展示工程口径或缺失诊断"
fi
unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -F 'const TRACK_ARCHIVE_MAX_ROWS = 5000' >/dev/null || fail "达摩盘细分赛道归档缺少安全分片上限"
unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -F '"搜索潜力", "成交潜力", "拉新潜力", "蓝海指数"' >/dev/null || fail "达摩盘细分赛道矩阵不是固定十列紧凑合同"
unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -F 'archiveTablesFromAtomicGroups' >/dev/null || fail "达摩盘货品增长机会归档缺少原子分片"
unzip -p "$DMP_ZIP_PATH" '*rolling7-html-writer.js' | grep -F -- '-分片${String' >/dev/null || fail "达摩盘细分赛道归档缺少稳定分片命名"
unzip -p "$DMP_ZIP_PATH" '*rolling7-report.js' | grep -F 'bindChartTooltips' >/dev/null || fail "达摩盘本机类目曲线未绑定悬停交互"
unzip -p "$DMP_ZIP_PATH" 'modes/competition-shop/html-writer.js' | grep -F '.table-shell thead th,.extra-table thead th{color:#fff!important;background:#0d716b!important' >/dev/null || fail "达摩盘竞争态势报告表头不是统一绿色白字"
unzip -p "$DMP_ZIP_PATH" 'modes/competition-shop/html-writer.js' | grep -F '.table-shell tbody td,.extra-table tbody td{background-color:#fff}' >/dev/null || fail "达摩盘竞争态势报告正文未使用浅色背景"
unzip -p "$DMP_ZIP_PATH" 'modes/competition-shop/html-writer.js' | grep -F '.numeric{text-align:right;vertical-align:middle;font-variant-numeric:tabular-nums}' >/dev/null || fail "达摩盘竞争态势报告数值未垂直居中靠右"
unzip -p "$DMP_ZIP_PATH" '*report-engine.js' | grep -F 'canonicalRenderData' >/dev/null || fail "达摩盘安装包缺少官网预览渲染合同"
unzip -p "$DMP_ZIP_PATH" '*report-engine.js' | grep -F 'subject_daily_gmv' >/dev/null || fail "达摩盘安装包缺少主体逐日 GMV 合同"
unzip -p "$DMP_ZIP_PATH" '*direct-core.js' | grep -F 'sanitizeRenderData' >/dev/null || fail "达摩盘安装包未校验官网预览渲染数据"
unzip -p "$DMP_ZIP_PATH" '*completeness-engine.js' | grep -F 'costPerClick(allocated, click)' >/dev/null || fail "达摩盘场景 CPC 未按分配花费与点击区间计算"
unzip -p "$DMP_ZIP_PATH" '*completeness-engine.js' | grep -F 'returnOnSpend(directDealAmount, allocated)' >/dev/null || fail "达摩盘场景 ROI 未按成交额区间与分配花费计算"
unzip -p "$DMP_ZIP_PATH" '*completeness-engine.js' | grep -F 'const closureGroups = new Map()' >/dev/null || fail "达摩盘场景分配缺少比例与金额闭合校验"
unzip -p "$DMP_ZIP_PATH" '*completeness-engine.js' | grep -F 'SUBJECT_MINIMUM_PROMOTION_CONTRACT' >/dev/null || fail "达摩盘安装包缺少主体推广消耗、费比、ROI、PPC 最低合同"
unzip -p "$DMP_ZIP_PATH" '*completeness-engine.js' | grep -F 'missingSubjectMinimumPromotionMetrics' >/dev/null || fail "达摩盘安装包不会阻断主体最低投放指标缺失"
unzip -p "$DMP_ZIP_PATH" '*completeness-engine.js' | grep -F 'paidAmountShare", name: "付费金额占比", aliases: ["付费金额占比", "付费成交额占比", "付费gmv贡献率", "广告gmv贡献率", "广告归因gmv贡献率"]' >/dev/null || fail "达摩盘安装包未兼容付费金额占比历史名称"
unzip -p "$DMP_ZIP_PATH" '*completeness-engine.js' | grep -F 'const contribution = safeIntervalDivide(metrics[side].paidGmv, metrics[side].totalGmv, {' >/dev/null || fail "达摩盘安装包付费金额占比公式不正确"
unzip -p "$DMP_ZIP_PATH" 'competition-item-supplement.js' | grep -F 'const AGGREGATE_DIRECT_FIELDS = Object.freeze(new Set(["paidGmv", "roi"]));' >/dev/null || fail "达摩盘安装包未固定对手 30 日汇总直取字段"
unzip -p "$DMP_ZIP_PATH" 'completeness-engine.js' | grep -F 'preferAggregateDirect: daysInclusive(period.startDate, period.endDate) === 30' >/dev/null || fail "达摩盘安装包未把汇总直取限制为精确 30 天"
unzip -p "$DMP_ZIP_PATH" 'report-engine.js' | grep -F 'const periodDirect = side === "competitor" && ["paidGmv", "roi"].includes(key)' >/dev/null || fail "达摩盘安装包未优先读取目标对手汇总直取值"
unzip -p "$DMP_ZIP_PATH" 'report-engine.js' | grep -F '分日表不调用本函数中的 periodDirectMetrics' >/dev/null || fail "达摩盘安装包未锁定汇总与逐日分源边界"
require_fixed 'preferAggregateDirect: daysInclusive(period.startDate, period.endDate) === 30' public/tools/dmp-report-engine/completeness-engine.js "达摩盘官网引擎未把汇总直取限制为精确 30 天"
require_fixed 'const periodDirect = side === "competitor" && ["paidGmv", "roi"].includes(key)' public/tools/dmp-report-engine/report-engine.js "达摩盘官网引擎未优先读取目标对手汇总直取值"
require_fixed '分日表不调用本函数中的 periodDirectMetrics' public/tools/dmp-report-engine/report-engine.js "达摩盘官网引擎未锁定汇总与逐日分源边界"
cmp -s <(unzip -p "$DMP_ZIP_PATH" 'completeness-engine.js') public/tools/dmp-report-engine/completeness-engine.js || fail "达摩盘 ZIP 与官网完整性引擎不一致"
cmp -s <(unzip -p "$DMP_ZIP_PATH" 'report-engine.js') public/tools/dmp-report-engine/report-engine.js || fail "达摩盘 ZIP 与官网报告引擎不一致"
unzip -p "$DMP_ZIP_PATH" '*report-engine.js' | grep -F 'const overviewMetrics = CORE_METRIC_CONTRACT.map' >/dev/null || fail "达摩盘安装包未把双侧八指标写入报告门禁"
unzip -p "$DMP_ZIP_PATH" '*report-engine.js' | grep -F '投入产出比|投产比|ROI|ROAS' >/dev/null || fail "达摩盘安装包仍可能把投产比格式化为百分比"
unzip -p "$DMP_ZIP_PATH" '*direct-main.js' | grep -F 'indexCardTemplates' >/dev/null || fail "达摩盘安装包未采集同页全部核心指标卡"
if unzip -p "$DMP_ZIP_PATH" '*direct-popup.html' | grep -Eq 'XLSX|下载 HTML|清除本地结果'; then
  fail "达摩盘打爆路径弹窗仍暴露已移除的下载或清理入口"
fi
if unzip -p "$DMP_ZIP_PATH" '*overlay.js' | grep -Eq 'download-excel|download-html|download-csv|data-excel|data-html'; then
  fail "达摩盘插件仍暴露业务数据下载按钮"
fi
if unzip -p "$DMP_ZIP_PATH" '*overlay.js' | grep -E '覆盖商品、周期、投放、场景与关键词等经营数据|自动添加 1–3 家竞店并完成近 7 天、近 30 天|当前不提供业务数据下载' >/dev/null; then
  fail "达摩盘插件仍展示已删除的操作区说明"
fi
if unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -Eq '127\.0\.0\.1|localhost'; then
  fail "达摩盘插件仍包含本机服务权限"
fi

actual_dmp_zip_sha256="$(sha256_file "$DMP_ZIP_PATH")"
[[ "$actual_dmp_zip_sha256" == "$DMP_ZIP_SHA256" ]] || fail "达摩盘 v${DMP_VERSION} ZIP 哈希不一致：$actual_dmp_zip_sha256"
actual_frozen_dmp_v2359_sha256="$(sha256_file "$FROZEN_DMP_V2359_PATH")"
[[ "$actual_frozen_dmp_v2359_sha256" == "$FROZEN_DMP_V2359_SHA256" ]] || fail "达摩盘 v2.3.59 黄金回滚包哈希不一致：$actual_frozen_dmp_v2359_sha256"
actual_frozen_dmp_v2359_size="$(wc -c < "$FROZEN_DMP_V2359_PATH" | tr -d '[:space:]')"
[[ "$actual_frozen_dmp_v2359_size" == "$FROZEN_DMP_V2359_SIZE_BYTES" ]] || fail "达摩盘 v2.3.59 黄金回滚包大小不一致：$actual_frozen_dmp_v2359_size"

echo "发布保护通过：工程、登录、密码哈希、数据库模型、AI 工具页、少壮AI v${EXPECTED_VERSION} 与达摩盘 v${DMP_VERSION} 插件包均匹配。"

if [[ "${1:-}" == "--full" ]]; then
  npm run typecheck
  npm run lint
  npm test
  npm run build
  echo "完整质量门通过：typecheck、lint、test、build 全部成功。"
fi
