#!/usr/bin/env bash
# 启动飞书工单机器人（服务器常驻）。
#
# 为什么用独立 pm2 应用名而不是塞进 ecosystem.config.cjs：
# 那份 ecosystem 是 ERP 生产进程的配置，随发布包上线、被部署脚本管理。
# 把机器人塞进去会让「部署 ERP」和「重启机器人」互相牵连 —— 一次 ERP 发布就会重启机器人，
# 而机器人重启期间飞书事件会 FAIL（这次踩到的 app not online 就是这个形状）。
# 所以两者分开：ERP 归 ERP，机器人归机器人。
set -euo pipefail

APP_DIR=/opt/dilee/agent/ticket-agent
ENV_FILE="$APP_DIR/.env"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

cd "$APP_DIR"
[ -f "$ENV_FILE" ] || { echo "缺少 $ENV_FILE" >&2; exit 1; }

# 校验三个必需变量存在（只打印长度，不打印值）
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
for key in FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_BOT_OPEN_ID; do
  value="$(eval "printf '%s' \"\${$key:-}\"")"
  [ -n "$value" ] || { echo "缺少 $key" >&2; exit 1; }
  echo "  $key 长度 ${#value}"
done

export PATH="/opt/node24/bin:$PATH"
log "Node: $(node -v)"

# 先跑探针确认凭据可用，再常驻。
# 这样凭据失效时，失败信息是「探针失败」，而不是一个沉默的重连循环。
if ! node --import tsx scripts/bot-probe.ts > /tmp/ticket-probe.log 2>&1; then
  tail -20 /tmp/ticket-probe.log
  echo "探针失败，不启动常驻进程" >&2
  exit 1
fi
log "探针通过"

log "用 pm2 常驻启动"
pm2 delete dilee-ticket-bot >/dev/null 2>&1 || true
pm2 start "$APP_DIR/scripts/run-bot.sh" \
  --name dilee-ticket-bot \
  --interpreter /bin/bash \
  --cwd "$APP_DIR"
pm2 save >/dev/null

sleep 5
pm2 jlist > /tmp/bot-pm2.json 2>/dev/null || true
/opt/node24/bin/node -e '
  try {
    const a = require("/tmp/bot-pm2.json");
    for (const x of a) if (x.name === "dilee-ticket-bot") {
      console.log("  status=" + x.pm2_env.status, "restarts=" + (x.pm2_env.restart_time || 0));
    }
  } catch { console.log("  (pm2 状态读取失败)"); }
' 2>/dev/null || true

log "最近日志"
tail -12 /home/ubuntu/.pm2/logs/dilee-ticket-bot-out.log 2>/dev/null || true

log "BOT_STARTED"
