#!/usr/bin/env bash
# 给 Agent 状态账号补授新建表的权限。
#
# 为什么需要这个脚本（2026-11-28 实测事故）：P2 阶段 4 建了 agent_gap_candidates /
# agent_gap_reports 两张表，迁移只给了超级用户 dilee，忘了给 agent_state。
# 运行时的写入异常被 agent-orchestrator.ts 的 .catch(warn) 吞掉，于是线上候选永远是 0 条，
# 而权限证明脚本又只探 sales_orders/agent_sessions，一路绿 —— 闭环在生产是 0%。
# 阶段 4 总结当时写的是「上线前要手工授」，这一步没有落成代码，也就没有执行。
#
# 幂等：重复执行无副作用（GRANT 本身幂等）。
# 用法：bash scripts/grant-agent-state-tables.sh
# 校验：node scripts/verify-agent-database-privileges.mjs（需要两组连接串）
source "$(dirname "$0")/../deploy/common.sh" 2>/dev/null || {
  DILEE_ROOT="${DILEE_ROOT:-/opt/dilee}"
  PG_CONTAINER="${PG_CONTAINER:-app-postgres-1}"
  log()  { printf '%s %s\n' "[$(date '+%F %T')]" "$*"; }
  fail() { printf '%s FAIL: %s\n' "[$(date '+%F %T')]" "$*" >&2; exit 1; }
}

STATE_ROLE="${STATE_ROLE:-agent_state}"

# 每一张「Agent 运行时新写的表」都要登记在这里。
# 加表时同步改两处：这里，和 scripts/verify-agent-database-privileges.mjs 的 GAP_TABLES。
TABLES=(
  agent_gap_candidates
  agent_gap_reports
)

psql_root() { sudo docker exec "$PG_CONTAINER" psql -U dilee -d dilee_erp -tAc "$1"; }

for table in "${TABLES[@]}"; do
  exists="$(psql_root "select 1 from information_schema.tables where table_name='${table}' and table_schema='public'")"
  [ "$exists" = "1" ] || fail "表 ${table} 不存在。先执行迁移：npx prisma migrate deploy"
done

for table in "${TABLES[@]}"; do
  log "GRANT SELECT, INSERT, UPDATE ON ${table} TO ${STATE_ROLE}"
  psql_root "GRANT SELECT, INSERT, UPDATE ON \"${table}\" TO ${STATE_ROLE}" > /dev/null || fail "授权失败：${table}"
done

log "校验（以 ${STATE_ROLE} 身份实际读一次）"
for table in "${TABLES[@]}"; do
  out="$(sudo docker exec "$PG_CONTAINER" psql -U dilee -d dilee_erp -tAc "SET ROLE ${STATE_ROLE}; SELECT count(*) FROM \"${table}\"")" \
    || fail "${STATE_ROLE} 仍读不到 ${table}"
  log "  ${table}: ${out} 行"
done

log "GRANT_OK tables=${#TABLES[@]} role=${STATE_ROLE}"
log "下一步：node scripts/verify-agent-database-privileges.mjs 应输出含这些表的 AGENT_DATABASE_PRIVILEGE_OK"