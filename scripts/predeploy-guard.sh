#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CANONICAL_ROOT="${SANJIE_CANONICAL_ROOT:-/Users/shaozhuang/20260606sanjie}"
EXPECTED_VERSION="1.8.98"
EXPECTED_ZIP_SHA256="5c3db6ff60ecaa37047bc9908d137157448051acb2e31bb25b1a96371944ed4f"
ZIP_PATH="public/downloads/sycm-keyword-collector-v${EXPECTED_VERSION}.zip"

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
  src/app/tools/page.tsx; do
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

echo "发布保护通过：工程、登录、密码哈希、数据库模型、工具页与插件包均匹配 v${EXPECTED_VERSION}。"

if [[ "${1:-}" == "--full" ]]; then
  npm run typecheck
  npm run lint
  npm test
  npm run build
  echo "完整质量门通过：typecheck、lint、test、build 全部成功。"
fi
