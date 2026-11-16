#!/usr/bin/env bash
# pm2 用的启动包装：与仓库既有 scripts/pm2-api-start.sh 同一模式。
#
# 为什么不直接 `pm2 start src/main.ts --import tsx`：
# pm2 会把 script 之后的参数交给被启动的脚本，而不是 node。
# 用 bash 包装 + exec，参数边界清楚，且与 ERP 两个进程的启动方式一致。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

set -a
# shellcheck disable=SC1090
. "$APP_DIR/.env"
set +a

for key in FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_BOT_OPEN_ID; do
  value="$(eval "printf '%s' \"\${$key:-}\"")"
  : "${value:?$key must be set in $APP_DIR/.env}"
done

export PATH="/opt/node24/bin:$PATH"
exec node --import tsx src/main.ts
