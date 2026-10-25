import { PrismaClient } from "@prisma/client";

/**
 * Agent 自有状态表（agent_sessions / agent_runs / agent_run_events）的独立连接。
 *
 * 模块设计「工具注册和查询执行如何划清责任」：agent 会话状态走**另一组**只可读写 agent_*
 * 表的凭据，与业务只读连接（query-read-client.ts）分开。生产环境必须显式配置
 * `AGENT_STATE_DATABASE_URL`（部署时 GRANT 该账号只能写 agent_* 表）；开发环境回退
 * DATABASE_URL 并打日志提醒，让本地不用建两套账号也能跑。
 */
export function createAgentStateClient(env: { agentStateDatabaseUrl?: string; databaseUrl?: string; nodeEnv?: string }): PrismaClient {
  const isProduction = env.nodeEnv === "production";
  if (isProduction && !env.agentStateDatabaseUrl) {
    throw new Error("生产环境必须配置 AGENT_STATE_DATABASE_URL（只可读写 agent_* 表的独立账号）");
  }
  const url = env.agentStateDatabaseUrl ?? env.databaseUrl;
  if (!url) throw new Error("缺少数据库连接串：需要 AGENT_STATE_DATABASE_URL 或 DATABASE_URL");
  return new PrismaClient({ datasources: { db: { url } } });
}
