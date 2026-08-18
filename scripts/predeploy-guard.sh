#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CANONICAL_ROOT="${SANJIE_CANONICAL_ROOT:-/Users/shaozhuang/20260606sanjie}"
EXPECTED_VERSION="1.9.23"
EXPECTED_ZIP_SHA256="5b147e48cb5ecab07f1acf70d95442985e07a2780e4946d9e6e9f966227d0609"
ZIP_PATH="public/downloads/sycm-keyword-collector-v${EXPECTED_VERSION}.zip"
DMP_VERSION="2.1.4"
DMP_ZIP_SHA256="40da0a2206b386e3088f4191c317d55c3e3e4de538bf563eddb1273ab5cc1b28"
DMP_ZIP_PATH="private-assets/dmp/shaozhuang-dmp-unified-automation-v${DMP_VERSION}.zip"

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

[[ "$ROOT" == "$CANONICAL_ROOT" ]] || fail "当前目录是 $ROOT；只允许从唯一生产工程 $CANONICAL_ROOT 发版"
cd "$ROOT"

for file in \
  src/app/login/page.tsx \
  src/app/globals.css \
  src/lib/accounts.ts \
  src/middleware.ts \
  prisma/schema.prisma \
  src/app/tools/page.tsx \
  src/app/tools/dmp-report/page.tsx \
  src/app/api/dmp-reports/route.ts \
  src/app/api/dmp-report-shares/route.ts \
  src/app/api/dmp-report-exports/route.ts \
  src/app/api/shared/dmp-reports/[token]/route.ts \
  src/app/api/management/dmp-report-share-analytics/route.ts \
  src/app/shared/dmp-reports/[token]/page.tsx \
  src/app/api/dmp-runtime/[action]/route.ts \
  src/app/api/tools/dmp/download/route.ts \
  src/components/tools/DmpBrandWatermark.tsx \
  src/components/tools/DmpReportWorkspace.tsx \
  src/components/tools/DmpSharedReportClient.tsx \
  src/components/management/ManagementConsole.tsx \
  src/components/management/DmpShareAnalyticsPanel.tsx \
  src/lib/dmp-product.ts \
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

# 工具页保持登录保护；静态插件包继续允许直接下载。
require_fixed 'pathname === "/login"' src/middleware.ts "中间件缺少登录页公开规则"
require_fixed 'pathname.startsWith("/api/auth/")' src/middleware.ts "中间件缺少认证接口公开规则"
forbid_fixed 'pathname === "/tools"' src/middleware.ts "工具页被错误加入未登录公开白名单"
require_fixed "downloads/" src/middleware.ts "插件下载目录未从鉴权中间件排除"

# 工具页版本、文件与哈希必须一致，避免页面版本和下载包串版。
require_fixed "version: \"${EXPECTED_VERSION}\"" src/app/tools/page.tsx "工具页版本不是 v${EXPECTED_VERSION}"
require_fixed "sycm-keyword-collector-v${EXPECTED_VERSION}.zip" src/app/tools/page.tsx "工具页下载地址不是 v${EXPECTED_VERSION}"
require_fixed "shaozhuang-ai-legacy-icon.png" src/app/tools/page.tsx "工具页未使用老板旧版 Logo"
require_file "$ZIP_PATH"
require_file "public/downloads/shaozhuang-ai-legacy-icon.png"

actual_zip_sha256="$(sha256_file "$ZIP_PATH")"
[[ "$actual_zip_sha256" == "$EXPECTED_ZIP_SHA256" ]] || fail "v${EXPECTED_VERSION} ZIP 哈希不一致：$actual_zip_sha256"

# 达摩盘插件、付费授权、受保护下载与历史报告中心必须成套发布。
require_fixed "DMP_AUTOMATION_VERSION = \"${DMP_VERSION}\"" src/lib/dmp-product.ts "达摩盘工具卡版本不是 v${DMP_VERSION}"
require_fixed 'DMP_AUTOMATION_NAME = `达摩盘一体化自动取数｜${DMP_AUTOMATION_BRAND}`' src/lib/dmp-product.ts "达摩盘官网当前产品不是一体化品牌版本"
require_fixed 'zipHref: "/api/tools/dmp/download"' src/app/tools/page.tsx "达摩盘工具卡未使用受保护下载接口"
require_fixed "getDmpReportAccess" src/app/tools/dmp-report/page.tsx "达摩盘报告中心缺少数据库付费授权复核"
require_fixed "listDmpBusinessReports" src/app/tools/dmp-report/page.tsx "达摩盘报告中心未加载历史报告"
forbid_fixed 'session?.role === "admin"' src/app/tools/dmp-report/page.tsx "达摩盘报告中心仍被错误限制为管理员"
require_fixed "达摩盘 → 打爆路径 / 竞争态势分析" src/components/tools/DmpReportWorkspace.tsx "达摩盘双报告使用路径不正确"
require_fixed "历史生成报告" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心缺少历史管理"
require_fixed "复制分享链接" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心缺少官网分享入口"
require_fixed "管理员传播分析" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心缺少管理员分析去向说明"
forbid_fixed "分享行为与点击热区" src/components/tools/DmpReportWorkspace.tsx "普通达摩盘报告中心仍暴露分享点击分析"
forbid_fixed "DmpReportInteractionSummary" src/components/tools/DmpReportWorkspace.tsx "普通达摩盘报告中心仍加载分享分析类型"
forbid_fixed "/api/dmp-report-shares?reportId=" src/components/tools/DmpReportWorkspace.tsx "普通达摩盘报告中心仍请求分享分析数据"
require_fixed "formatDmpCell" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心未统一两位小数展示"
require_fixed '/比|率|变化|相对|CTR|贡献|百分位/i' src/lib/dmp-report-format.ts "达摩盘比率字段未统一换算为百分比"
forbid_fixed "JSON 工程" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心仍展示工程信息"
forbid_fixed "下载 Excel" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心仍开放 Excel 下载"
forbid_fixed "下载 CSV" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心仍开放 CSV 下载"
forbid_fixed "打印 / 保存 PDF" src/components/tools/DmpSharedReportClient.tsx "达摩盘分享页仍开放 PDF 下载"
require_fixed "当前版本仅支持官网在线查看，暂不提供数据下载" src/app/api/dmp-reports/route.ts "达摩盘报告接口未关闭业务数据下载"
forbid_fixed "buildDmpReportWorkbook" src/app/api/dmp-reports/route.ts "达摩盘报告接口仍能生成 Excel"
require_fixed "DmpBrandWatermark" src/components/tools/DmpReportWorkspace.tsx "达摩盘报告中心缺少少壮AI自动化轻水印"
require_fixed "DmpBrandWatermark" src/app/shared/dmp-reports/[token]/page.tsx "达摩盘分享报告缺少少壮AI自动化轻水印"
require_fixed 'focusReport={query.view === "report"}' src/app/tools/dmp-report/page.tsx "达摩盘报告页不支持插件聚焦打开"
require_fixed 'pathname.startsWith("/api/dmp-reports")' src/middleware.ts "达摩盘报告同步接口未绕过页面中间件"
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
require_fixed "getDmpBusinessReport(access, reportId)" src/lib/dmp-report-share.ts "达摩盘分享创建缺少报告所有者隔离"
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
require_fixed "contributionRatio" public/tools/dmp-report-engine/completeness-engine.js "达摩盘插件缺少付费 GMV 贡献率区间计算"
require_fixed "calculatedDirectRoi" public/tools/dmp-report-engine/completeness-engine.js "达摩盘场景未按分配后消耗计算直接 ROI"
require_fixed "calculableMetricValue" public/tools/dmp-report-engine/completeness-engine.js "达摩盘量级区间未先转换为可计算数值"
require_fixed "transportOnlyReason" public/tools/dmp-report-engine/completeness-engine.js "达摩盘完整性引擎未忽略 OPTIONS/HEAD/redirect 传输记录"
require_fixed "classifyGrowthRecord" public/tools/dmp-report-engine/completeness-engine.js "达摩盘补抓响应未使用统一解析分类"
require_fixed '["投放", "ROI"' public/tools/dmp-report-engine/report-engine.js "达摩盘业务报告缺少 ROI"
require_fixed '投入产出比|投产比|ROI|ROAS' public/tools/dmp-report-engine/report-engine.js "达摩盘云端报告仍可能把投产比格式化为百分比"
require_fixed 'isDmpMultipleMetric' src/lib/dmp-report-format.ts "达摩盘官网报告未区分投产倍数与百分比"
require_fixed "periodMetricsForItem" public/tools/dmp-report-engine/report-engine.js "达摩盘商品表未按商品 ID 匹配周期指标"
require_file "$DMP_ZIP_PATH"
[[ ! -e "public/downloads/shaozhuang-dmp-unified-automation-v${DMP_VERSION}.zip" ]] || fail "达摩盘付费插件仍暴露在 public 下载目录"
unzip -p "$DMP_ZIP_PATH" '*official-share-url.mjs' | grep -F 'normalizeOfficialShareUrl' >/dev/null || fail "达摩盘插件缺少官网分享地址规范化模块"
# Linux 的 unzip 在下游 grep -q 提前退出时会收到 SIGPIPE；配合 pipefail 会把“已命中”误判成失败。
# 这里让 grep 读完整个条目再丢弃输出，保证本机与生产机得到一致结果。
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'const CLOUD_RUNTIME_BASE = `${OFFICIAL_SITE}/api/dmp-runtime`' >/dev/null || fail "达摩盘插件未固定连接官网云端运行接口"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'DMP_CDP_CREATE_SHARE' >/dev/null || fail "达摩盘插件缺少官网分享消息"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'normalizeOfficialShareUrl' >/dev/null || fail "达摩盘插件分享地址未强制重挂生产官网"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'chrome.windows.create({ url: reportUrl, focused: true, type: "normal" })' >/dev/null || fail "达摩盘插件完成后不会新开官网 HTML 报告窗口"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'url.searchParams.set("reportId"' >/dev/null || fail "达摩盘插件未按报告编号打开官网页面"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F "\"version\": \"${DMP_VERSION}\"" >/dev/null || fail "达摩盘安装包 Manifest 版本不一致"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'OFFICIAL_REPORT_SYNC_TIMEOUT_MS = 120_000' >/dev/null || fail "达摩盘插件报告保存等待仍过短"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'OFFICIAL_REPORT_SHARE_ATTEMPTS = 2' >/dev/null || fail "达摩盘插件分享请求缺少瞬时失败重试"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'DMP_CDP_VERIFY_REPORT_EXPORT' >/dev/null || fail "达摩盘插件缺少管理员导出能力实时校验"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F 'DMP_CDP_AUTHORIZE_REPORT_EXPORT' >/dev/null || fail "达摩盘插件缺少管理员导出二次授权"
unzip -p "$DMP_ZIP_PATH" '*service-worker.js' | grep -F '/api/dmp-report-exports' >/dev/null || fail "达摩盘插件未连接官网导出审计接口"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F '达摩盘一体化自动取数｜少壮AI自动化' >/dev/null || fail "达摩盘安装包缺少品牌标题"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F '生成免登录官网报告' >/dev/null || fail "达摩盘安装包仍是旧的受控分享说明"
unzip -p "$DMP_ZIP_PATH" '*manifest.json' | grep -F '管理员受审计的内部 XLSX' >/dev/null || fail "达摩盘安装包缺少管理员隐藏导出说明"
unzip -p "$DMP_ZIP_PATH" '*report-engine.js' | grep -F '投入产出比|投产比|ROI|ROAS' >/dev/null || fail "达摩盘安装包仍可能把投产比格式化为百分比"
unzip -p "$DMP_ZIP_PATH" '*overlay.js' | grep -F 'INTERNAL_EXPORT_VISIBLE_MS = 600_000' >/dev/null || fail "达摩盘插件隐藏导出入口不是 10 分钟短时授权"
unzip -p "$DMP_ZIP_PATH" '*overlay.js' | grep -F 'button.dataset.role = "internal-export"' >/dev/null || fail "达摩盘插件缺少动态管理员导出入口"
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

echo "发布保护通过：工程、登录、密码哈希、数据库模型、AI 工具页、少壮AI v${EXPECTED_VERSION} 与达摩盘 v${DMP_VERSION} 插件包均匹配。"

if [[ "${1:-}" == "--full" ]]; then
  npm run typecheck
  npm run lint
  npm test
  npm run build
  echo "完整质量门通过：typecheck、lint、test、build 全部成功。"
fi
