#!/usr/bin/env bash
# 回滚：把当前 app 挪成 app.failed-<ts>，再把指定/最新的备份恢复为 app。
# 用法：bash remote-rollback.sh [备份目录名]   （默认取最新的 app.backup-*）
# 标准 §回滚：保留失败目录与备份目录用于排查，不动数据库容器/卷。
source "$(dirname "$0")/common.sh"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(ls -1d "$DILEE_ROOT"/app.backup-* 2>/dev/null | sort | tail -1 || true)"
fi
[ -n "$TARGET" ] || fail "没有可用的 app.backup-* 目录"
require_dir "$TARGET"

log "回滚目标：$TARGET（当前版本 $(live_version)）"
pm2 delete dilee-api 2>/dev/null || true
pm2 delete dilee-web 2>/dev/null || true

failed="$DILEE_ROOT/app.failed-$(date +%Y%m%d-%H%M%S)"
mv "$APP_DIR" "$failed"
mv "$TARGET" "$APP_DIR"
log "已回滚：$failed → $APP_DIR"

cd "$APP_DIR"
pm2 start ecosystem.config.cjs
pm2 save
sleep 5
pm2 status | grep -E "dilee-(api|web)" || true

build="$(health_build)"
release="$(cat "$RELEASE_VERSION_FILE" 2>/dev/null || echo '(unknown)')"
log "health build=$build release=$release"
[ "$build" = "$release" ] || fail "回滚后 health build($build) 与 RELEASE_VERSION($release) 不一致"
[ "$(http_code "http://127.0.0.1:${WEB_PORT}/login")" = "200" ] || fail "回滚后登录页非 200"

log "ROLLBACK_OK release=$release failed_dir=$failed"
