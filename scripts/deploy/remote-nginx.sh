#!/usr/bin/env bash
# 边缘（nginx）配置安装 + **实测上传体积**核验。幂等：每次部署都跑一遍，漂移会被拉回。
#
# 为什么需要这个脚本（2026-11-12 真实故障）：
#   nginx 的 client_max_body_size 默认 1m，站点配置里一直没写。销售单 Excel 补录传
#   1.5MB 的 .xls 时，nginx 在转发前就 413，请求根本没进 API —— 服务端日志一条都没有，
#   浏览器只看到「读取失败」。这层以前既不在仓库里、也没有任何检查，
#   所以「部署成功」和「这个功能能用」是两件事。
#
# 本脚本做三件事，任何一件不满足就 fail（部署脚本会据此终止）：
#   1. 把仓库里的 scripts/deploy/nginx-dilee.conf 装到 /etc/nginx/sites-available/dilee 并启用；
#   2. nginx -t + reload（有变化才 reload）；
#   3. **真发一个 PROBE_BYTES 的上传包过边缘**，断言不是 413 —— 这才是「用户能不能传」的判据。
#
# 用法：bash remote-nginx.sh            安装 + 核验
#      bash remote-nginx.sh --verify-only  只核验，不改任何文件
set -euo pipefail
source "$(dirname "$0")/common.sh"

SITE=dilee
AVAIL="/etc/nginx/sites-available/$SITE"
ENABLED="/etc/nginx/sites-enabled/$SITE"
CONF_SRC="${CONF_SRC:-$APP_DIR/scripts/deploy/nginx-dilee.conf}"
EDGE_URL="${EDGE_URL:-http://127.0.0.1}"
# 探针体积（字节）＝**产品承诺的单文件上限 10MB**（用户 2026-11-12 明确）。
# 为什么不取个"够用就好"的小值（比如 2MB）：探针的作用是证明「承诺成立」，不是「比 1m 大」。
# 只传 2MB 时，把边缘悄悄调回 5m（或应用调回 2MB）也照样绿 —— 那正是这次故障的形态：
# 人人都以为上限是 10MB，实际链路上最窄的那一段说了算。
PROBE_BYTES="${PROBE_BYTES:-10485760}"
# 探针打到一个不写库、且未登录必 401 的接口：401 = 请求确实穿过了边缘到达 API。
PROBE_PATH="${PROBE_PATH:-/api/v1/sales-orders/import-preview}"

verify_only=false
[ "${1:-}" = "--verify-only" ] && verify_only=true

if [ "$verify_only" != true ]; then
  log "1. 安装边缘配置（$CONF_SRC -> $AVAIL）"
  require_file "$CONF_SRC"
  if sudo cmp -s "$CONF_SRC" "$AVAIL" 2>/dev/null; then
    log "   已是最新，跳过写入"
  else
    sudo cp "$CONF_SRC" "$AVAIL"
    sudo chmod 644 "$AVAIL"
    log "   已写入 $AVAIL"
    changed=true
  fi
  if [ ! -e "$ENABLED" ] || [ "$(readlink -f "$ENABLED")" != "$(readlink -f "$AVAIL")" ]; then
    sudo ln -sfn "$AVAIL" "$ENABLED"
    log "   已启用站点 $ENABLED"
    changed=true
  fi
  log "2. 语法检查"
  sudo nginx -t
  if [ "${changed:-false}" = true ]; then
    log "   配置有变化，平滑重载"
    sudo systemctl reload nginx
  else
    log "   配置无变化，不重载"
  fi
fi

echo "边缘实际上限（应 >= 应用上传上限）："
sudo nginx -T 2>/dev/null | grep -n 'client_max_body_size' | sed 's/^/  /' || echo "  !! 没读到 client_max_body_size（等于用 nginx 默认 1m）"

log "3. 实测：发一个 ${PROBE_BYTES} 字节的上传包过边缘"
probe=/tmp/dilee-upload-probe.bin
head -c "$PROBE_BYTES" /dev/zero > "$probe"

# 为什么要重试：`systemctl reload` 是**平滑**重载，旧 worker 会继续把手上/新接的连接做完
# （实测：重载后立刻探测仍可能落到旧 worker 上，回的还是 1m 时代的 413 —— 本脚本第一版
# 就因此把一次成功的修复判成了失败）。所以「413」在开头的几次里按「还没切完」处理。
PROBE_ATTEMPTS="${PROBE_ATTEMPTS:-5}"
PROBE_INTERVAL="${PROBE_INTERVAL:-2}"
status=""
for attempt in $(seq 1 "$PROBE_ATTEMPTS"); do
  # 退出码非 0（连接失败/超时）也留下来当 000：那时用户看到的是同一句「读取失败」。
  status=$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
    -X POST "${EDGE_URL}${PROBE_PATH}" -F "file=@${probe}" || true)
  echo "  第 ${attempt}/${PROBE_ATTEMPTS} 次：POST ${EDGE_URL}${PROBE_PATH}  ->  HTTP ${status}"
  [ "$status" != "413" ] && break
  [ "$attempt" = "$PROBE_ATTEMPTS" ] || sleep "$PROBE_INTERVAL"
done

if [ "$status" = "413" ]; then
  rm -f "$probe"
  fail "边缘仍然 413：${PROBE_BYTES} 字节的上传被 nginx 挡在门外（client_max_body_size 还是默认的 1m？）"
fi
if [ "$status" = "000" ]; then
  rm -f "$probe"
  fail "边缘不可达：${EDGE_URL}${PROBE_PATH} 没有响应（nginx 未运行或站点未启用）"
fi
if [ "$status" != "401" ]; then
  rm -f "$probe"
  fail "探针期望 401（未登录但请求确实到达 API），实际 HTTP ${status} —— 边缘到 API 的链路不对，请人工确认"
fi
rm -f "$probe"
log "OK：边缘放行了 ${PROBE_BYTES} 字节的上传，且请求确实到达 API（401）"
