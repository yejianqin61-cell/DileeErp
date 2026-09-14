#!/usr/bin/env bash
# 步骤 2/4：在候选目录上执行 Prisma 迁移（必须在切换之前）。
# 期望迁移数由本地驱动传入（= 仓库 migrations 目录数），用于“确实都应用了”的硬校验。
source "$(dirname "$0")/common.sh"

[ -f /tmp/dilee-staging.env ] || fail "找不到 /tmp/dilee-staging.env，请先运行 remote-build.sh"
# shellcheck disable=SC1091
source /tmp/dilee-staging.env
require_dir "$STAGING"

EXPECTED="${EXPECTED_MIGRATIONS:-0}"
before="$(applied_migrations)"
log "迁移前已应用：$before（期望达到：$EXPECTED）"

cd "$STAGING"
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

after="$(applied_migrations)"
failed="$(failed_migrations)"
log "迁移后已应用：$after，失败残留：$failed"
[ "$failed" = "0" ] || fail "存在失败迁移记录（finished_at IS NULL），需先 migrate resolve 处理：见交接文档 §3"
if [ "$EXPECTED" -gt 0 ] && [ "$after" -lt "$EXPECTED" ]; then
  fail "迁移数不足：已应用 $after < 期望 $EXPECTED"
fi

log "MIGRATE_OK applied=$after"
