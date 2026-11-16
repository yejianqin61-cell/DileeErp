#!/usr/bin/env bash
# 更新 /opt/dilee/agent/ticket-agent 的源码并安全重启机器人。
#
# 为什么不用 deploy-ticket-agent.sh：那是**首次安装**脚本，会 rm -rf 整个目录，
# 把 .env（凭据）和 node_modules 一起删掉。日常更新只需要替换源码。
# 本脚本先备份、再替换、再跑类型检查与全量测试，全过了才重启 ——
# 失败时旧进程还在跑，不会出现「机器人没了」。
#
# 用法：bash update-ticket-agent.sh /tmp/ticket-agent-src.tar.gz
set -euo pipefail

ARCHIVE="${1:?用法: $0 <tar.gz>}"
DEST=/opt/dilee/agent/ticket-agent
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/dilee/agent/ticket-agent.backup-$STAMP"
STAGE="$(mktemp -d /tmp/ticket-agent-stage-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

[ -f "$ARCHIVE" ] || { echo "找不到上传包：$ARCHIVE" >&2; exit 1; }
[ -f "$DEST/.env" ] || { echo "缺少 $DEST/.env，拒绝覆盖" >&2; exit 1; }

log "解包到临时目录"
tar -xzf "$ARCHIVE" -C "$STAGE"
[ -d "$STAGE/ticket-agent/src" ] || { echo "包内缺少 ticket-agent/src" >&2; exit 1; }

log "备份现有版本：$BACKUP"
cp -a "$DEST" "$BACKUP"

log "替换源码（保留 .env 与 node_modules）"
for item in src test scripts package.json package-lock.json tsconfig.json; do
  [ -e "$STAGE/ticket-agent/$item" ] || { echo "包内缺少 $item" >&2; exit 1; }
  rm -rf "$DEST/$item"
  cp -a "$STAGE/ticket-agent/$item" "$DEST/$item"
done

cd "$DEST"
export PATH="/opt/node24/bin:$PATH"
log "Node: $(node -v)"

log "安装依赖（无新增依赖时应秒级完成）"
npm install --no-audit --no-fund 2>&1 | tail -3

log "类型检查"
npx tsc --noEmit -p tsconfig.json && echo "  typecheck OK"

log "全量测试"
node --import tsx --test test/*.test.ts 2>&1 | tail -8

log "重启机器人"
pm2 restart dilee-ticket-bot --update-env >/dev/null
sleep 5
pm2 list | grep -E 'dilee-ticket-bot|name' || true
log "最近日志"
tail -10 /home/ubuntu/.pm2/logs/dilee-ticket-bot-out.log 2>/dev/null || true

log "UPDATE_OK backup=$BACKUP"
