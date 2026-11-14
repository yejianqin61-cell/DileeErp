#!/usr/bin/env bash
# Phase 1 构建：把发布包解到候选目录，跑与生产完全相同的一组命令。
#
# 与 scripts/deploy/remote-build.sh 的差异只有两处，都是为了 Phase 1 的隔离：
#   - 目录在 /opt/dilee/agent 下，不碰 /opt/dilee/app
#   - 不写 /tmp/dilee-staging.env，避免和真实部署互相干扰
# 命令顺序与参数完全照抄，这样"能构建"这件事才等价于"生产能构建"。
set -euo pipefail

ARCHIVE="${1:?发布包}"
STAGE="${2:?候选目录}"
BUILD_LOG="${3:-/opt/dilee/agent/phase1/build.log}"
ENV_SRC="${4:-/opt/dilee/app/.env}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

NODE24=/opt/node24/bin
export PATH="$NODE24:$PATH"

log "Node: $(node -v)  npm: $(npm -v)"

rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "$ARCHIVE" -C "$STAGE"

cd "$STAGE"
for f in package.json package-lock.json apps/api/prisma/schema.prisma ecosystem.config.cjs; do
  [ -f "$f" ] || { echo "候选目录缺少 $f" >&2; exit 1; }
done

# 生产 .env 只读复制：prisma generate 要能解析 datasource url。
# 不打印内容；构建完的候选目录里不留它。
cp "$ENV_SRC" .env

log "npm ci --include=dev"
if ! npm ci --include=dev --no-audit --no-fund >"$BUILD_LOG" 2>&1; then
  tail -40 "$BUILD_LOG"; echo "npm ci 失败" >&2; exit 1
fi
log "npm ci 完成"

log "prisma generate"
if ! npx prisma generate --schema apps/api/prisma/schema.prisma >>"$BUILD_LOG" 2>&1; then
  tail -40 "$BUILD_LOG"; echo "prisma generate 失败" >&2; exit 1
fi
log "prisma generate 完成"

log "构建 API"
if ! npm run build --workspace=@dilee/api >>"$BUILD_LOG" 2>&1; then
  tail -40 "$BUILD_LOG"; echo "API 构建失败" >&2; exit 1
fi
log "API 构建完成"

log "构建 Web"
if ! npm run build --workspace=@dilee/web >>"$BUILD_LOG" 2>&1; then
  tail -40 "$BUILD_LOG"; echo "Web 构建失败" >&2; exit 1
fi
log "Web 构建完成"

log "装配 standalone"
mkdir -p apps/web/.next/standalone/apps/web/.next
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
if [ -d apps/web/public ]; then cp -a apps/web/public apps/web/.next/standalone/apps/web/; fi

# 候选目录不留密钥
rm -f .env

RELEASE="$(tr -d '\r\n' < RELEASE_VERSION)"
log "BUILD_OK release=$RELEASE stage=$STAGE"
log "候选体积 $(du -sh "$STAGE" | cut -f1)"
