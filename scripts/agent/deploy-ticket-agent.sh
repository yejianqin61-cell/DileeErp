#!/usr/bin/env bash
# 把 ticket-agent 从上传包安装到服务器。
#
# 为什么单独建这个脚本而不是走发布包：
# ticket-agent 不是 ERP 的一部分，它不该随 ERP 发布包上线。
# 它有自己的依赖树（@larksuiteoapi/node-sdk），装在自己的 node_modules 里，
# 根 package-lock.json 不变，所以生产 npm ci 完全不受影响。
set -euo pipefail

ARCHIVE="${1:-/tmp/ticket-agent-upload.tar.gz}"
DEST="/opt/dilee/agent/ticket-agent"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

[ -f "$ARCHIVE" ] || { echo "找不到上传包：$ARCHIVE" >&2; exit 1; }

log "清理旧目录并解包"
sudo rm -rf "$DEST"
# 包内顶层是 ticket-agent/，所以解到父目录
tar -xzf "$ARCHIVE" -C /opt/dilee/agent

[ -f "$DEST/package.json" ] || { echo "解包后缺少 package.json：$DEST" >&2; exit 1; }
log "已解包到 $DEST"

cd "$DEST"
export PATH="/opt/node24/bin:$PATH"

log "Node: $(node -v)  npm: $(npm -v)"

log "安装依赖（仅装到本目录 node_modules）"
npm install --no-audit --no-fund 2>&1 | tail -6

log "类型检查"
npx tsc --noEmit -p tsconfig.json && echo "  typecheck OK"

log "运行测试"
node --import tsx --test test/*.test.ts 2>&1 | tail -10

log "依赖体积 $(du -sh node_modules | cut -f1)"
log "PROBE_READY 可运行 scripts/bot-probe.ts"
