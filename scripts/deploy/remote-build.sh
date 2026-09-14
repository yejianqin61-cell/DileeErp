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

log "候选目录：$STAGING"
check_archive_layout "$ARCHIVE"
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
node -e "require('dotenv').config(); const u = new URL(process.env.DATABASE_URL || ''); if (u.hostname !== '127.0.0.1' || u.port !== '15432') throw new Error('DATABASE_URL must use 127.0.0.1:15432');"

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
