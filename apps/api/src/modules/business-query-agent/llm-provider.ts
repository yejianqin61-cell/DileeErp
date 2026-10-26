import type { AgentToolName } from "./tools/tool-registry";

/**
 * LLM provider 的最小接口（模块设计「每个模块的 Interface」LLM provider 行）。
 *
 * 只接收已授权的工具名与已过滤的事实；模型密钥只留在服务端。两个实现：
 * fake-llm-provider.ts（阶段 1 链路/无密钥环境）与 deepseek-llm-provider.ts（Phase 2）。
 */

export type AgentLlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  /**
   * 工具结果消息自包含：id 关联调用、operation + args 供 provider 原样重放 assistant tool-call
   * （AI SDK v7 的 @ai-sdk/deepseek 会把 input 对象序列化成 arguments，不能再手工 JSON.stringify）、
   * content 是 QueryFact JSON 或工具失败信封 `{error:{code,message}}`。
   */
  | { role: "tool"; id: string; tool: AgentToolName; operation: string; args: Record<string, unknown>; content: string };

/** 模型请求的一次工具调用。`id` 是工具结果往返的关联键（DeepSeek 的 toolCallId）。 */
export type AgentLlmToolCall = { id: string; tool: AgentToolName; operation: string; args: Record<string, unknown> };

export type AgentLlmPlan = { toolCalls: AgentLlmToolCall[] };

/** 模型用量（token 数由 provider 上报；编排器再补 tool_calls / answer_chunks）。 */
export type AgentLlmUsage = { model?: string; input_tokens?: number; output_tokens?: number };

/** streamAnswer 的产出：文本增量或一次用量上报。 */
export type AgentLlmStreamChunk = { type: "text"; text: string } | { type: "usage"; usage: AgentLlmUsage };

export interface AgentLlmProvider {
  /** 观测用模型标识（R-11 日志里的 model 字段；fake-provider / deepseek-chat 等）。 */
  readonly name: string;
  /** 查询步骤的一轮：模型从授权清单里挑工具（可多步，由编排器循环驱动）。 */
  plan(messages: AgentLlmMessage[], tools: readonly AgentToolName[], signal: AbortSignal): Promise<AgentLlmPlan>;
  /** 最终回答步骤：分段产出（结尾给一次 usage），逐段作为 answer_delta 落库与推送。 */
  streamAnswer(messages: AgentLlmMessage[], signal: AbortSignal): AsyncGenerator<AgentLlmStreamChunk>;
}
