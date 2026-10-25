import type { AgentLlmProvider } from "./llm-provider";
import { DeepSeekLlmProvider } from "./deepseek-llm-provider";
import { FakeLlmProvider } from "./fake-llm-provider";

/**
 * 按 env 选 provider（模块设计：第一版只 fake / deepseek 两个实现，不为假设中的其他
 * provider 先造适配层）。生产环境由 validate-environment 强制 deepseek + 密钥。
 */
export type AgentLlmProviderConfig = {
  provider?: string;
  fakeDelayMs?: number;
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  deepseekModel?: string;
  timeoutMs?: number;
};

export function createAgentLlmProvider(config: AgentLlmProviderConfig): AgentLlmProvider {
  const kind = config.provider ?? "fake";
  if (kind === "deepseek") {
    if (!config.deepseekApiKey) throw new Error("AGENT_LLM_PROVIDER=deepseek 需要配置 DEEPSEEK_API_KEY");
    return new DeepSeekLlmProvider({ apiKey: config.deepseekApiKey, baseURL: config.deepseekBaseUrl, model: config.deepseekModel, timeoutMs: config.timeoutMs });
  }
  if (kind !== "fake") throw new Error(`未知 AGENT_LLM_PROVIDER：${kind}（支持 fake / deepseek）`);
  return new FakeLlmProvider(config.fakeDelayMs ?? 0);
}
