#!/usr/bin/env bash
# 服务器端部署脚本共用配置与助手。
# 依据：.agent/deployment/server-incremental-deployment-standard.md（生产部署唯一标准）。
# 这些脚本只做“标准里写明的动作”，不擅自改数据库、不删数据库容器/卷。
set -euo pipefail

DILEE_ROOT="${DILEE_ROOT:-/opt/dilee}"
APP_DIR="$DILEE_ROOT/app"
RELEASE_VERSION_FILE="RELEASE_VERSION"
PG_CONTAINER="${PG_CONTAINER:-app-postgres-1}"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"
ARCHIVE="${ARCHIVE:-/tmp/DileeErp-latest.tar.gz}"
BUILD_LOG="${BUILD_LOG:-/tmp/dilee-remote-build.log}"
ERRLOG="${ERRLOG:-/home/ubuntu/.pm2/logs/dilee-api-error.log}"

log()  { printf '%s %s\n' "[$(date '+%F %T')]" "$*"; }
fail() { printf '%s FAIL: %s\n' "[$(date '+%F %T')]" "$*" >&2; exit 1; }

require_file() { [ -f "$1" ] || fail "缺少文件：$1"; }
require_dir()  { [ -d "$1" ] || fail "缺少目录：$1"; }

# 标准要求：包内直接出现这些条目，出现 .android/.claude/AppData/Users 等立即停止。
check_archive_layout() {
  local archive="$1"
  require_file "$archive"
  local entries
  entries="$(tar -tzf "$archive" | head -400)"
  for expected in ./package.json ./package-lock.json ./apps/ ./ecosystem.config.cjs ./scripts/; do
    printf '%s\n' "$entries" | grep -qx -- "$expected" || fail "发布包缺少顶层条目：$expected"
  done
  if printf '%s\n' "$entries" | grep -Eq '^\./(\.android|\.claude|AppData|Users|\.pnpm-store|\.dsh-meow)/'; then
    fail "发布包出现禁止目录（.android/.claude/AppData/Users/.pnpm-store/.dsh-meow）"
  fi
}

applied_migrations() {
  sudo docker exec "$PG_CONTAINER" psql -U dilee -d dilee_erp -tAc \
    "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null"
}

failed_migrations() {
  sudo docker exec "$PG_CONTAINER" psql -U dilee -d dilee_erp -tAc \
    "select count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null"
}

live_version() { cat "$APP_DIR/$RELEASE_VERSION_FILE" 2>/dev/null || echo "(unknown)"; }

health_build() {
  curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.build' 2>/dev/null || echo "(health-failed)"
}

http_code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$1"; }
