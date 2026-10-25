import { HttpException } from "@nestjs/common";
import { generateText, jsonSchema, stepCountIs, streamText, tool as defineTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { AgentLlmMessage, AgentLlmPlan, AgentLlmProvider, AgentLlmStreamChunk } from "./llm-provider";
import { mapModelError } from "./model-errors";
import { AGENT_TOOLS, type AgentToolName } from "./tools/tool-registry";

/**
 * DeepSeek provider（R-4）：模型协议、参数解析与消息组装交给 AI SDK，
 * 本项目保留三件事 —— 工具**不**在 SDK 内执行（plan 只取一轮 toolCalls，执行走 Tool executor）、
 * 最终回答才流式、错误只以稳定码出这个文件。
 *
 * plan 是单步的：generateText + stopWhen(1)，多步由编排器循环驱动（每轮结果经 tool 消息回传，
 * 这里的 toModelMessages 负责把自包含的工具结果消息合成 DeepSeek 要求的
 * assistant(tool_calls) + tool(tool_result) 对）。
 */

export type DeepSeekProviderConfig = { apiKey: string; baseURL?: string; model?: string; timeoutMs?: number };

const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  order_query: "按单号关键字搜索销售订单，或查询某张订单的非财务进展",
  sales_query: "查询某张订单的销售单、客户、BOM 与退货（非财务字段）",
  procurement_query: "查询某张订单的采购计划、采购单、到货与来料质检",
  production_query: "查询某张订单的生产单、工序进度、报工与外加工流转",
  warehouse_query: "查询原料库存余额、库存流水、领退报废与成品出入库质检",
  finance_query: "查询某张订单的应收、应付、收付款、对账、成本利润与人工（仅财务档）",
};

/** 领域工具统一输入形状：以 operation 分发；执行侧（Tool executor）按 operation 严格校验。 */
const DOMAIN_INPUT_SCHEMA = jsonSchema<{ operation: string; order_no?: string; q?: string; page?: number }>({
  type: "object",
  properties: {
    operation: { type: "string", description: "要执行的内部查询能力，例如 search_orders" },
    order_no: { type: "string", description: "当前订单号；除 search_orders 外必填" },
    q: { type: "string", description: "搜索关键字；仅 search_orders 使用" },
    page: { type: "number", description: "页码，从 1 开始" },
  },
  required: ["operation"],
  additionalProperties: false,
});

export class DeepSeekLlmProvider implements AgentLlmProvider {
  private readonly timeoutMs: number;
  private readonly modelName: string;
  private readonly model: LanguageModel;

  constructor(config: DeepSeekProviderConfig & { modelOverride?: LanguageModel }) {
    this.modelName = config.model ?? "deepseek-chat";
    this.model = config.modelOverride ?? createDeepSeek({ apiKey: config.apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })(this.modelName);
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  private composeSignal(signal: AbortSignal): AbortSignal {
    return this.timeoutMs > 0 && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : signal;
  }

  /** 自包含工具结果消息 → DeepSeek 要求的 assistant(tool_calls) + tool(tool_result) 消息对。 */
  private toModelMessages(messages: AgentLlmMessage[]): ModelMessage[] {
    const result: ModelMessage[] = [];
    for (const message of messages) {
      if (message.role === "tool") {
        result.push({
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: JSON.stringify(message.args ?? {}) }],
        } as ModelMessage);
        let parsed: unknown = message.content;
        try {
          parsed = JSON.parse(message.content);
        } catch {
          // content 恒为本项目写入的 JSON；解析失败时按原文传，模型侧仍可读。
        }
        result.push({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: message.id, toolName: message.tool, output: { type: "json", value: parsed } }],
        } as ModelMessage);
        continue;
      }
      result.push({ role: message.role, content: message.content });
    }
    return result;
  }

  private toolSetFor(tools: readonly AgentToolName[]): ToolSet {
    const set: ToolSet = {};
    for (const name of tools) {
      set[name] = defineTool({ description: TOOL_DESCRIPTIONS[name], inputSchema: DOMAIN_INPUT_SCHEMA });
    }
    return set;
  }

  async plan(messages: AgentLlmMessage[], tools: readonly AgentToolName[], signal: AbortSignal): Promise<AgentLlmPlan> {
    try {
      const result = await generateText({
        model: this.model,
        messages: this.toModelMessages(messages),
        tools: this.toolSetFor(tools),
        toolChoice: "auto",
        stopWhen: stepCountIs(1),
        abortSignal: this.composeSignal(signal),
      });
      const toolCalls = [];
      for (const call of result.toolCalls) {
        if (!tools.includes(call.toolName as AgentToolName)) continue; // 未授权工具名直接丢弃
        const parsed = (typeof call.input === "string" ? safeParse(call.input) : call.input) as { operation?: unknown } | null;
        const operation = typeof parsed?.operation === "string" ? parsed.operation : "";
        if (!operation) continue;
        const { operation: _omitted, ...rest } = parsed as Record<string, unknown>;
        toolCalls.push({ id: call.toolCallId, tool: call.toolName as AgentToolName, operation, args: rest });
      }
      return { toolCalls };
    } catch (error) {
      throw mapModelError(error);
    }
  }

  async *streamAnswer(messages: AgentLlmMessage[], signal: AbortSignal): AsyncGenerator<AgentLlmStreamChunk> {
    try {
      const result = streamText({
        model: this.model,
        messages: this.toModelMessages(messages),
        abortSignal: this.composeSignal(signal),
      });
      for await (const delta of result.textStream) {
        yield { type: "text", text: delta };
      }
      const usage = await result.usage;
      yield { type: "usage", usage: { model: this.modelName, input_tokens: usage.inputTokens ?? undefined, output_tokens: usage.outputTokens ?? undefined } };
    } catch (error) {
      throw mapModelError(error);
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
