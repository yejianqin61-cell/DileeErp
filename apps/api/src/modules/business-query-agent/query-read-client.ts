import { PrismaClient } from "@prisma/client";

/**
 * 业务查询的只读连接（模块设计「工具注册和查询执行如何划清责任」）。
 *
 * 与 agent 状态连接（agent-state-client.ts）是两组凭据：这里的目标账号在部署上只授
 * 业务表 SELECT（含 users/roles/user_roles 的角色重查列），任何写都会被数据库拒绝 ——
 * R-1 的「只读证明」就是拿这个账号验的。生产必须显式配置 `AGENT_READ_DATABASE_URL`；
 * 开发回退 DATABASE_URL 让本地不必建两套账号。
 */
export function createAgentReadClient(env: { agentReadDatabaseUrl?: string; databaseUrl?: string; nodeEnv?: string }): PrismaClient {
  const isProduction = env.nodeEnv === "production";
  if (isProduction && !env.agentReadDatabaseUrl) {
    throw new Error("生产环境必须配置 AGENT_READ_DATABASE_URL（业务表只读账号）");
  }
  const url = env.agentReadDatabaseUrl ?? env.databaseUrl;
  if (!url) throw new Error("缺少数据库连接串：需要 AGENT_READ_DATABASE_URL 或 DATABASE_URL");
  return new PrismaClient({ datasources: { db: { url } } });
}
