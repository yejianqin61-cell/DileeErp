export function validateEnvironment(config: Record<string, unknown>) {
  const port = config.PORT ?? 3001;
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error("PORT 必须是 1 到 65535 的整数");
  if (config.NODE_ENV === "production" && !config.DATABASE_URL) throw new Error("生产环境必须配置 DATABASE_URL");
  if (config.DATABASE_URL) {
    try { new URL(String(config.DATABASE_URL)); } catch { throw new Error("DATABASE_URL 格式无效"); }
  }
  return { ...config, PORT: Number(port) };
}
