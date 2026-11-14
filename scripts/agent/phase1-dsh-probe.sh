#!/usr/bin/env bash
# Phase 1 探针：在 Node 24 下跑一次真实 headless 任务，证明完整链路可用。
#
# 密钥处理：从 /opt/dilee/app/.env 读取 DEEPSEEK_API_KEY，只在进程环境里传递，
# 不打印、不落盘、不写日志。脚本自身对密钥零回显。
#
# 为什么需要这个探针：DSH 两个包都声明 engines.node >= 24.9.0，
# 而线上是 22.23.2。能不能在 Node 24 下真正跑完一次任务，是后续所有阶段的前提。
set -uo pipefail

DSH_BIN="/opt/dilee/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/opt/node24/bin/node"
WORK="${1:-/opt/dilee/agent/probe}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

[ -x "$NODE" ] || { echo "缺少 $NODE" >&2; exit 1; }
[ -f "$DSH_BIN" ] || { echo "缺少 $DSH_BIN" >&2; exit 1; }

# 从生产 .env 取密钥，不回显
KEY="$(set -a; . /opt/dilee/app/.env; set +a; printf '%s' "${DEEPSEEK_API_KEY:-}")"
if [ -z "$KEY" ]; then
  echo "未能从 /opt/dilee/app/.env 读到 DEEPSEEK_API_KEY" >&2
  exit 1
fi
log "已取得密钥（长度 ${#KEY}，内容不回显）"

mkdir -p "$WORK"
cd "$WORK" || exit 1
printf '1+1\n' > num.txt

log "Node: $("$NODE" -v)"
log "开始 headless 任务（超时 180s）"

START=$(date +%s)
DEEPSEEK_API_KEY="$KEY" \
PATH="/opt/node24/bin:$PATH" \
timeout 180 "$NODE" "$DSH_BIN" \
  --profile headless \
  --approval-policy never \
  --permission-mode workspace-write \
  "Read num.txt in the current directory and reply with only the result of the addition." \
  > "$WORK/out.txt" 2> "$WORK/err.txt"
RC=$?
END=$(date +%s)

log "退出码=$RC 耗时=$((END-START))s"
echo "--- stdout ---"
cat "$WORK/out.txt"
echo "--- stderr（末尾 10 行）---"
tail -10 "$WORK/err.txt"

# 判定：退出码 0 且 stdout 含 2
if [ "$RC" -eq 0 ] && grep -q '2' "$WORK/out.txt"; then
  log "PROBE_OK"
  exit 0
fi
log "PROBE_FAIL"
exit 1
