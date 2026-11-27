#!/usr/bin/env bash
# 步骤 1/4：把发布包解到一个全新的候选目录并构建。
# 任一步失败 → 退出码非 0，旧版本继续运行（不切换目录）。
#
# 与标准的一处**有意差异**：标准把 `prisma migrate deploy` 放在 npm ci 之后、
# 构建之前；这里把迁移移到构建成功之后（remote-migrate.sh）。
# 理由：代码编译不过时不应该先动生产库；先构建、后迁移，失败面更小。
# 迁移仍严格发生在“切换目录之前”。
source "$(dirname "$0")/common.sh"

STAGING="${STAGING:-$DILEE_ROOT/app.release-$(date +%Y%m%d-%H%M%S)}"
MIN_FREE_GB="${MIN_FREE_GB:-6}"

# 每次构建解出一个约 2.7G 的候选目录，而切换只搬走最后一个。
# 此前没有任何脚本清理它们，实测积了 3 个共 6.8G，把根分区推到 88% ——
# 再落一次失败构建就可能写满。建新目录前先回收旧的（只动 app.release-*，
# 不碰 app.backup-*（回滚目标）与 app.failed-*（排查证据））。
reclaim_old_candidates() {
  local stale
  mapfile -t stale < <(ls -1d "$DILEE_ROOT"/app.release-* 2>/dev/null | sort)
  [ "${#stale[@]}" -gt 0 ] || return 0
  for old in "${stale[@]}"; do
    [ "$old" = "$STAGING" ] && continue
    log "回收旧候选目录：$old（$(du -sh "$old" 2>/dev/null | cut -f1)）"
    rm -rf "$old" || log "  回收失败，继续（磁盘不足由下一步拦下）"
  done
}

# 磁盘闸门：构建需要 archive 解包 + node_modules + 两个构建产物。
# 实测一次成功构建峰值约 2.7G；留 6G 余量，宁可在切换前拒绝，也不要半路 ENOSPC
# 留下一个半成品候选目录（那会让下一次构建也失败）。
require_free_disk() {
  local available_gb
  available_gb="$(df -BG --output=avail "$DILEE_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9')"
  [ -n "$available_gb" ] || { log "读不到剩余空间，跳过闸门"; return 0; }
  log "剩余空间：${available_gb}G（要求 >= ${MIN_FREE_GB}G）"
  [ "$available_gb" -ge "$MIN_FREE_GB" ] || fail "剩余空间不足：${available_gb}G < ${MIN_FREE_GB}G。清理后再部署，或调低 MIN_FREE_GB"
}

log "候选目录：$STAGING"
check_archive_layout "$ARCHIVE"
require_free_disk
reclaim_old_candidates
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf "$ARCHIVE" -C "$STAGING"

require_file "$STAGING/package.json"
require_file "$STAGING/package-lock.json"
require_file "$STAGING/apps/api/prisma/schema.prisma"
require_file "$STAGING/ecosystem.config.cjs"
require_file "$APP_DIR/.env"          # 线上 .env 是唯一真源，绝不覆盖
cp "$APP_DIR/.env" "$STAGING/.env"
if [ -d "$APP_DIR/var" ]; then cp -a "$APP_DIR/var" "$STAGING/var"; fi

if [ "$(sudo docker inspect -f '{{.State.Running}}' "$PG_CONTAINER")" != "true" ]; then
  log "PostgreSQL 容器未运行，启动它"
  sudo docker start "$PG_CONTAINER"
fi
sudo docker port "$PG_CONTAINER" 5432/tcp

cd "$STAGING"
# 校验 DATABASE_URL 必须指向 127.0.0.1:15432。
# 注意：不要用 `node -e "require('dotenv')..."`——此刻 node_modules 还没装（npm ci 在下面），
# require 会抛 "Cannot find module 'dotenv'" 让构建在 npm ci 之前就失败。这里自带极简 .env 解析。
node -e '
const fs = require("fs");
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => { const at = line.indexOf("="); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["\x27]|["\x27]$/g, "")]; })
);
const url = new URL(env.DATABASE_URL || "");
if (url.hostname !== "127.0.0.1" || url.port !== "15432") throw new Error("DATABASE_URL must use 127.0.0.1:15432");
for (const key of ["AGENT_READ_DATABASE_URL", "AGENT_STATE_DATABASE_URL", "AGENT_LLM_PROVIDER", "DEEPSEEK_API_KEY"]) {
  if (!env[key]) throw new Error(`production .env must configure ${key}`);
}
if (env.AGENT_LLM_PROVIDER !== "deepseek") throw new Error("AGENT_LLM_PROVIDER must be deepseek in production");
'

log "npm ci --include=dev"
npm ci --include=dev --no-audit --no-fund >"$BUILD_LOG" 2>&1 || { tail -40 "$BUILD_LOG"; fail "npm ci 失败"; }

log "prisma generate"
npx prisma generate --schema apps/api/prisma/schema.prisma >>"$BUILD_LOG" 2>&1 || { tail -40 "$BUILD_LOG"; fail "prisma generate 失败"; }

log "构建 API"
npm run build --workspace=@dilee/api >>"$BUILD_LOG" 2>&1 || { tail -40 "$BUILD_LOG"; fail "API 构建失败"; }

log "构建 Web"
npm run build --workspace=@dilee/web >>"$BUILD_LOG" 2>&1 || { tail -40 "$BUILD_LOG"; fail "Web 构建失败"; }

mkdir -p apps/web/.next/standalone/apps/web/.next
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
if [ -d apps/web/public ]; then cp -a apps/web/public apps/web/.next/standalone/apps/web/; fi

release="$(tr -d '\r\n' < "$RELEASE_VERSION_FILE")"
printf 'STAGING=%s\n' "$STAGING" > /tmp/dilee-staging.env
log "BUILD_OK RELEASE=$release STAGING=$STAGING"
