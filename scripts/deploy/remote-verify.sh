#!/usr/bin/env bash
# 步骤 4/4：部署后状态核验（只读，不改任何东西）。
source "$(dirname "$0")/common.sh"

echo "release:            $(live_version)"
echo "migrations applied: $(applied_migrations)（期望 >= ${EXPECTED_MIGRATIONS:-unknown}）"
echo "migrations failed:  $(failed_migrations)（必须为 0）"
echo "health:             $(curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" || echo '(failed)')"
echo "pages:"
for path in / /login /manifest.webmanifest /production /production/material-issues /warehouse /procurement /sales /finance /qc; do
  printf '  %-32s %s\n' "$path" "$(http_code "http://127.0.0.1:${WEB_PORT}${path}")"
done
echo "pm2:"
pm2 status | grep -E "dilee-(api|web)" || echo "  (未找到 PM2 进程)"
echo "errlog lines / last write:"
if [ -f "$ERRLOG" ]; then wc -l < "$ERRLOG"; stat -c '%y' "$ERRLOG"; else echo "  (无错误日志)"; fi
echo "backups:"
ls -1d "$DILEE_ROOT"/app.backup-* 2>/dev/null || echo "  (无)"
ls -1d "$DILEE_ROOT"/app.failed-* 2>/dev/null || true
echo "disk:"
df -h / | tail -1
