#!/usr/bin/env bash
# 步骤 3/4：切换目录并重启 PM2，按标准做成功判定。
# 成功判定（标准 §成功判定）：两个进程 online；health 数据库 ok 且 data.build == RELEASE_VERSION；
# manifest 与登录页 200。
source "$(dirname "$0")/common.sh"

[ -f /tmp/dilee-staging.env ] || fail "找不到 /tmp/dilee-staging.env，请先运行 remote-build.sh"
# shellcheck disable=SC1091
source /tmp/dilee-staging.env
require_dir "$STAGING"

KEEP_BACKUPS="${KEEP_BACKUPS:-3}"   # 0 = 不清理（严格遵循标准，保留全部）
PREVIOUS="$(live_version)"
ERRLOG_BASELINE="${ERRLOG_BASELINE:-}"
if [ -z "$ERRLOG_BASELINE" ] && [ -f "$ERRLOG" ]; then ERRLOG_BASELINE="$(wc -l < "$ERRLOG")"; fi

pm2 delete dilee-api 2>/dev/null || true
pm2 delete dilee-web 2>/dev/null || true

backup="$DILEE_ROOT/app.backup-$(date +%Y%m%d-%H%M%S)"
mv "$APP_DIR" "$backup"
mv "$STAGING" "$APP_DIR"
log "已切换：$backup → $APP_DIR"

if [ "$KEEP_BACKUPS" -gt 0 ]; then
  # 只清理 app.backup-*；app.failed-* 永远保留用于排查。
  mapfile -t backups < <(ls -1d "$DILEE_ROOT"/app.backup-* 2>/dev/null | sort)
  if [ "${#backups[@]}" -gt "$KEEP_BACKUPS" ]; then
    for old in "${backups[@]:0:$(( ${#backups[@]} - KEEP_BACKUPS ))}"; do
      log "清理旧备份：$old"
      rm -rf "$old"
    done
  fi
fi

cd "$APP_DIR"
pm2 start ecosystem.config.cjs
pm2 save
sleep 5
pm2 status | grep -E "dilee-(api|web)" || true

build="$(health_build)"
release="$(cat "$RELEASE_VERSION_FILE")"
log "health build=$build release=$release"
[ "$build" = "$release" ] || fail "health 返回的 build($build) 与 RELEASE_VERSION($release) 不一致"
[ "$build" != "development" ] || fail "health 返回 development，说明不是生产构建"

manifest="$(http_code "http://127.0.0.1:${WEB_PORT}/manifest.webmanifest")"
login="$(http_code "http://127.0.0.1:${WEB_PORT}/login")"
log "manifest=$manifest login=$login"
[ "$manifest" = "200" ] || fail "manifest 非 200：$manifest"
[ "$login" = "200" ] || fail "登录页非 200：$login"

if [ -f "$ERRLOG" ]; then
  now="$(wc -l < "$ERRLOG")"
  log "错误日志行数：切换前 $ERRLOG_BASELINE → 切换后 $now"
  if [ "$now" -gt "$ERRLOG_BASELINE" ]; then
    log "警告：本次切换后错误日志有新增，请人工读栈确认（tail -n 30 $ERRLOG）"
  fi
fi

log "SWITCH_OK from=$PREVIOUS to=$release backup=$backup"
