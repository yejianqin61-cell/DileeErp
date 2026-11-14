#!/usr/bin/env bash
# 只读诊断：构建期间是否会连生产库。
set -u
echo "=== 生产库当前连接（只读查询） ==="
sudo docker exec app-postgres-1 psql -U dilee -d dilee_erp -tAc \
  "select count(*) || ' connections' from pg_stat_activity where datname='dilee_erp'"
echo
echo "=== 连接明细（应用名/来源） ==="
sudo docker exec app-postgres-1 psql -U dilee -d dilee_erp -tAc \
  "select coalesce(application_name,'(none)') || ' | ' || coalesce(client_addr::text,'local') || ' | ' || state from pg_stat_activity where datname='dilee_erp' and pid <> pg_backend_pid()"
echo
echo "=== 构建进程里有没有指向 15432 的连接 ==="
if command -v ss >/dev/null 2>&1; then
  ss -tnp 2>/dev/null | grep -E ':15432' | grep -v 'dilee-api\|node apps/api' | head -20 || echo "  (无)"
else
  echo "  (ss 不可用)"
fi
echo
echo "=== 构建期间占用内存前 5 的进程 ==="
ps -eo pid,rss,comm --sort=-rss | head -6
