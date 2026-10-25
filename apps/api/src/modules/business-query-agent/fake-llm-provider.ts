import type { AgentLlmMessage, AgentLlmPlan, AgentLlmProvider } from "./llm-provider";
import type { AgentToolName } from "./tools/tool-registry";

/**
 * 阶段 1 的假 provider：不外发任何数据、不调模型，用确定规则拼出回答。
 *
 * 它演示的是链路本身（工具 → 事实 → 有来源的回答）；换 DeepSeek（Phase 2）时
 * 编排器与其余代码不动。回答只引用本轮工具事实里的内容 —— 这条纪律与真 provider 相同。
 */
export class FakeLlmProvider implements AgentLlmProvider {
  async plan(messages: AgentLlmMessage[], tools: readonly AgentToolName[]): Promise<AgentLlmPlan> {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const question = lastUser?.content ?? "";
    if (!question.trim() || !tools.includes("order_query")) return { toolCalls: [] };
    // 确定性规则：拿问题里最长的连续非空白段当搜索词（订单号通常是它）。
    const keyword = question.trim().split(/\s+/).sort((a, b) => b.length - a.length)[0].slice(0, 100);
    return { toolCalls: [{ tool: "order_query", operation: "search_orders", args: { q: keyword } }] };
  }

  async *streamAnswer(messages: AgentLlmMessage[], signal: AbortSignal): AsyncGenerator<string> {
    const facts = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as { data: Record<string, unknown>[]; sources: { business_no: string }[] });
    const rows = facts.flatMap((fact) => fact.data);
    if (!rows.length) {
      yield "没有查到匹配的订单。请确认单号或关键字后重新提问。";
      return;
    }
    signal.throwIfAborted();
    yield `根据本轮查询，找到 ${rows.length} 张订单：`;
    signal.throwIfAborted();
    yield rows.map((row) => `${row.order_no}（${row.product_name}，${row.quantity}${row.unit}，状态 ${row.status}）`).join("；") + "。";
    signal.throwIfAborted();
    const sources = facts.flatMap((fact) => fact.sources.map((source) => source.business_no));
    yield `以上来自销售单 ${[...new Set(sources)].join("、")}；价格与金额未包含在当前可查范围内。`;
  }
}
