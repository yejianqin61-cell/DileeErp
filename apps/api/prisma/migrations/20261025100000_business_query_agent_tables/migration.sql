-- 业务查询 Agent 自有三张表（2026-10-25）
--
-- 依据：docs/design/business-query-agent-v0-module-design-2026-10-25.md「API 权限与数据表」
-- 与 docs/design/business-query-agent-v0-architecture-2026-10-23.md「会话、成本与可观测性」。
--
-- 三条边界：
--   · Agent 对业务表一律只读，这三张 agent_* 表是它唯一可写的数据 —— 所以**不与任何业务表
--     建外键**（user_id / session_id 只是逻辑引用），也不动业务表一行。
--   · 「单用户单活动 run」是**部分**唯一索引：同一用户在 planning/querying/responding 状态下
--     全库只能有一行（跨会话也成立）。应用层的先查只是先行拦截，这个索引才是并发竞态的
--     最后闸门。Prisma 表达不了部分索引，它只存在于本迁移 —— schema.prisma 的 AgentRun
--     注释与 test/unit/agent-tables-migration.test.cjs 守着它，改动必须三边同步。
--   · question / answer / payload 可能含业务信息：按财务数据的口径管权限与保留期；
--     会话查询一律带 user_id 条件。
--
-- 建表时库里没有历史行，不需要 sales_orders 那种「先查重复再建唯一索引」的守卫。
-- 部署顺序：先 prisma migrate deploy，再发代码（表比代码多列不影响旧代码）。

CREATE TABLE "agent_sessions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_runs" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "client_message_id" VARCHAR(64) NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT,
  "access_level" VARCHAR(20) NOT NULL,
  "state" VARCHAR(20) NOT NULL,
  "error_code" VARCHAR(60),
  "usage" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_run_events" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_runs_session_id_client_message_id_key" ON "agent_runs"("session_id", "client_message_id");
CREATE INDEX "agent_runs_user_id_state_idx" ON "agent_runs"("user_id", "state");
CREATE UNIQUE INDEX "agent_run_events_run_id_seq_key" ON "agent_run_events"("run_id", "seq");
CREATE INDEX "agent_sessions_user_id_idx" ON "agent_sessions"("user_id");

-- 活动 run 的部分唯一索引（单用户单活动 run 的最后闸门，见文件头）。
CREATE UNIQUE INDEX "agent_runs_user_active_key" ON "agent_runs"("user_id")
  WHERE "state" IN ('planning', 'querying', 'responding');
