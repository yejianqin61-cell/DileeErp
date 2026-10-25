import { Inject, Injectable, Module, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PrismaClient } from "@prisma/client";
import { createAgentStateClient } from "./agent-state-client";
import { createAgentReadClient } from "./query-read-client";
import { AgentStateManager } from "./state-manager";
import { ConcurrencyGate } from "./concurrency-gate";
import { AgentContextManager } from "./context-manager";
import { createAgentLlmProvider } from "./llm-provider-factory";
import type { AgentLlmProvider } from "./llm-provider";
import { AGENT_LLM_PROVIDER } from "./agent-tokens";
import { ToolExecutor } from "./tools/tool-executor";
import { FakeLlmProvider } from "./fake-llm-provider";
import { AgentOrchestrator } from "./agent-orchestrator";
import { StreamTransport } from "./stream-transport";
import { BusinessQueryAgentController } from "./business-query-agent.controller";
import type { AgentRoleReader } from "./query-permission.guard";

import { AGENT_READ_CLIENT, AGENT_ROLE_READER, AGENT_STATE_CLIENT } from "./agent-tokens";

/**
 * 角色重查走**只读连接**（模块设计：users/roles/user_roles 的过滤条件内聚在这里，
 * 只取 role.key，不读密码哈希；user 的停用/软删也在这条 where 里复核）。
 */
function roleReaderOf(client: PrismaClient): AgentRoleReader {
  return {
    async readActiveRoleKeys(userId: string): Promise<string[]> {
      const rows = await client.userRole.findMany({
        where: { userId, user: { isActive: true, deletedAt: null }, role: { deletedAt: null } },
        select: { role: { select: { key: true } } },
      });
      return rows.map((row) => row.role.key);
    },
  };
}

/** 两组连接的关闭与重启恢复：遗留活动 run 在启动时标 failed/INTERRUPTED（模块设计）。 */
@Injectable()
export class AgentLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly state: AgentStateManager,
    @Inject(AGENT_STATE_CLIENT) private readonly stateClient: PrismaClient,
    @Inject(AGENT_READ_CLIENT) private readonly readClient: PrismaClient,
  ) {}

  async onModuleInit() {
    // 表可能还没迁移（首次部署 migrate deploy 之前起服务）：失败只告警，不拦启动。
    await this.state.failInterrupted().catch((error) => console.warn(`[business-query-agent] 重启恢复失败：${error instanceof Error ? error.message : String(error)}`));
  }

  async onApplicationShutdown() {
    await Promise.allSettled([this.stateClient.$disconnect(), this.readClient.$disconnect()]);
  }
}

/**
 * 业务查询 Agent 模块。只对外暴露控制器：两组 Prisma client（只读/状态）、工具执行器
 * 都不 export —— 其他业务模块拿不到模型可达的查询路径。
 *
 * 带接口参数的服务（ToolExecutor/AgentOrchestrator/StreamTransport 的 roleReader 等）
 * 全部用工厂注入：Nest 解析不了 interface token。
 */
@Module({
  controllers: [BusinessQueryAgentController],
  providers: [
    {
      provide: AGENT_STATE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createAgentStateClient({
        agentStateDatabaseUrl: config.get<string>("AGENT_STATE_DATABASE_URL"),
        databaseUrl: config.get<string>("DATABASE_URL"),
        nodeEnv: config.get<string>("NODE_ENV"),
      }),
    },
    {
      provide: AGENT_READ_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createAgentReadClient({
        agentReadDatabaseUrl: config.get<string>("AGENT_READ_DATABASE_URL"),
        databaseUrl: config.get<string>("DATABASE_URL"),
        nodeEnv: config.get<string>("NODE_ENV"),
      }),
    },
    { provide: AGENT_ROLE_READER, inject: [AGENT_READ_CLIENT], useFactory: roleReaderOf },
    { provide: AgentStateManager, inject: [AGENT_STATE_CLIENT], useFactory: (client: PrismaClient) => new AgentStateManager(client as never) },
    ConcurrencyGate,
    AgentContextManager,
    { provide: ToolExecutor, inject: [AGENT_READ_CLIENT, AGENT_ROLE_READER], useFactory: (client: PrismaClient, roleReader: AgentRoleReader) => new ToolExecutor(client as never, roleReader) },
    {
      provide: AGENT_LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createAgentLlmProvider({
        provider: config.get<string>("AGENT_LLM_PROVIDER"),
        fakeDelayMs: Number(config.get<string>("AGENT_FAKE_DELAY_MS") ?? 0) || 0,
        deepseekApiKey: config.get<string>("DEEPSEEK_API_KEY"),
        deepseekBaseUrl: config.get<string>("DEEPSEEK_BASE_URL"),
        deepseekModel: config.get<string>("DEEPSEEK_MODEL"),
        timeoutMs: Number(config.get<string>("AGENT_LLM_TIMEOUT_MS") ?? 0) || undefined,
      }),
    },
    { provide: AgentOrchestrator, inject: [AgentStateManager, ToolExecutor, AGENT_LLM_PROVIDER, AGENT_ROLE_READER, AgentContextManager, ConfigService], useFactory: (state: AgentStateManager, executor: ToolExecutor, provider: AgentLlmProvider, roleReader: AgentRoleReader, context: AgentContextManager, config: ConfigService) => new AgentOrchestrator(state, executor, provider, roleReader, context, { runTimeoutMs: Number(config.get<string>("AGENT_RUN_TIMEOUT_MS") ?? 0) || undefined }) },
    { provide: StreamTransport, inject: [AgentStateManager, AGENT_ROLE_READER], useFactory: (state: AgentStateManager, roleReader: AgentRoleReader) => new StreamTransport(state, roleReader) },
    AgentLifecycle,
  ],
})
export class BusinessQueryAgentModule {}
