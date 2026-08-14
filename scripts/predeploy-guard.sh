#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CANONICAL_ROOT="${SANJIE_CANONICAL_ROOT:-/Users/shaozhuang/20260606sanjie}"
EXPECTED_VERSION="1.9.18"
EXPECTED_ZIP_SHA256="ea82ed62b4c995ce1de3cb94730b576974f78639ea79ac0cc5e0f29c56074f1f"
ZIP_PATH="public/downloads/sycm-keyword-collector-v${EXPECTED_VERSION}.zip"
DMP_VERSION="0.9.16"
DMP_ZIP_SHA256="6e7cd68c6887291b4031f88c8dfc8a87668071b76bb5fdde2534208d36940c7d"
DMP_ZIP_PATH="private-assets/dmp/shaozhuang-dmp-automation-v${DMP_VERSION}.zip"

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
  src/app/api/tools/dmp/download/route.ts \
  src/components/tools/DmpReportWorkspace.tsx \
  src/lib/dmp-product.ts \
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
require_file "prisma/migrations/20260815001500_tool_entitlements/migration.sql"

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

# 达摩盘插件、付费授权、受保护下载、管理员 JSON 工程入口与本地解析引擎必须成套发布。
require_fixed "DMP_AUTOMATION_VERSION = \"${DMP_VERSION}\"" src/lib/dmp-product.ts "达摩盘工具卡版本不是 v${DMP_VERSION}"
require_fixed 'zipHref: "/api/tools/dmp/download"' src/app/tools/page.tsx "达摩盘工具卡未使用受保护下载接口"
require_fixed 'session?.role === "admin"' src/app/tools/dmp-report/page.tsx "达摩盘 JSON 页面缺少管理员角色校验"
require_fixed "getDmpAutomationAccessForSession" src/app/tools/dmp-report/page.tsx "达摩盘 JSON 页面缺少数据库付费授权复核"
require_fixed "dmpJsonImport" src/app/api/auth/me/route.ts "认证端点缺少达摩盘 JSON 权限声明"
require_fixed "dmpAutomation: dmpAccess.allowed" src/app/api/auth/me/route.ts "认证端点未按数据库授权控制插件"
require_fixed "getDmpAutomationAccessForSession" src/app/api/tools/dmp/download/route.ts "达摩盘下载接口缺少数据库授权校验"
require_fixed "请联系管理员付费使用" src/app/api/tools/dmp/download/route.ts "达摩盘下载接口缺少未授权提示"
require_fixed 'DMP_AUTOMATION_TOOL_CODE = "dmp-automation"' src/lib/dmp-product.ts "达摩盘产品码不稳定"
require_fixed "file.text()" src/components/tools/DmpReportWorkspace.tsx "达摩盘 JSON 未在浏览器本地解析"
require_file "$DMP_ZIP_PATH"
[[ ! -e "public/downloads/shaozhuang-dmp-automation-v${DMP_VERSION}.zip" ]] || fail "达摩盘付费插件仍暴露在 public 下载目录"

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
