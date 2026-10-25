export function validateEnvironment(config: Record<string, unknown>) {
  const port = config.PORT ?? 3001;
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error("PORT 必须是 1 到 65535 的整数");
  if (config.NODE_ENV === "production" && !config.DATABASE_URL) throw new Error("生产环境必须配置 DATABASE_URL");
  if (config.NODE_ENV === "production") {
    // 业务查询 Agent 的两组独立凭据（docs/design/business-query-agent-v0-module-design-2026-10-25.md）：
    // 只读账号管业务查询与角色重查，状态账号只读写 agent_* 表。生产缺任何一个都不许起服务 ——
    // 回退到 DATABASE_URL 等于把「业务表只读」这条边界拆掉。
    if (!config.AGENT_READ_DATABASE_URL) throw new Error("生产环境必须配置 AGENT_READ_DATABASE_URL（业务表只读账号）");
    if (!config.AGENT_STATE_DATABASE_URL) throw new Error("生产环境必须配置 AGENT_STATE_DATABASE_URL（Agent 状态表账号）");
    // 模型（工程布局「外部模型假设」）：生产必须走 DeepSeek 且有密钥 —— 静默回退到假 provider
    // 会让线上用户拿到演示答案而不自知。
    if (config.AGENT_LLM_PROVIDER !== "deepseek") throw new Error("生产环境必须配置 AGENT_LLM_PROVIDER=deepseek");
    if (!config.DEEPSEEK_API_KEY) throw new Error("生产环境必须配置 DEEPSEEK_API_KEY");
  }
  if (config.DATABASE_URL) {
    try { new URL(String(config.DATABASE_URL)); } catch { throw new Error("DATABASE_URL 格式无效"); }
  }
  return { ...config, PORT: Number(port) };
}
