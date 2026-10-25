import type { AgentToolName } from "./tools/tool-registry";

/**
 * LLM provider 的最小接口（模块设计「每个模块的 Interface」LLM provider 行）。
 *
 * 只接收已授权的工具名与已过滤的事实；模型密钥只留在服务端。Phase 1 由 fake-llm-provider.ts
 * 实现以打通链路；Phase 2 的 DeepSeek 实现复用同一接口，编排器不感知具体提供商。
 */

export type AgentLlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string };

/** 模型请求的一次工具调用。参数由本项目校验（Tool executor），provider 不自行解释。 */
export type AgentLlmToolCall = { tool: AgentToolName; operation: string; args: Record<string, unknown> };

export type AgentLlmPlan = { toolCalls: AgentLlmToolCall[] };

export interface AgentLlmProvider {
  /** 查询步骤：模型只许从注册表里挑工具。 */
  plan(messages: AgentLlmMessage[], tools: readonly AgentToolName[], signal: AbortSignal): Promise<AgentLlmPlan>;
  /** 最终回答步骤：分段产出，逐段作为 answer_delta 落库与推送。 */
  streamAnswer(messages: AgentLlmMessage[], signal: AbortSignal): AsyncGenerator<string>;
}
