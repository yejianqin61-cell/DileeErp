import type { AgentLlmMessage, AgentLlmPlan, AgentLlmProvider, AgentLlmStreamChunk } from "./llm-provider";
import type { AgentToolName } from "./tools/tool-registry";

/**
 * 阶段 1 的假 provider：不外发任何数据、不调模型，用确定规则拼出回答。
 *
 * 它演示的是链路本身（工具 → 事实 → 有来源的回答）；换 DeepSeek（deepseek-llm-provider.ts）时
 * 编排器与其余代码不动。回答只引用本轮工具事实里的内容 —— 这条纪律与真 provider 相同。
 * P2-T5 给它加了可配置延迟（AGENT_FAKE_DELAY_MS），仅用于占住并发窗口做并发证据。
 */
export class FakeLlmProvider {
  readonly name = "fake-provider";

  constructor(private readonly delayMs = 0) {}

  private async pause(signal?: AbortSignal): Promise<void> {
    if (!this.delayMs) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, this.delayMs);
      const onAbort = () => finish(new Error("aborted"));
      function finish(abort?: unknown) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (abort) reject(signal?.reason ?? new Error("aborted"));
        else resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async plan(messages: AgentLlmMessage[], tools: readonly AgentToolName[], signal: AbortSignal): Promise<AgentLlmPlan> {
    await this.pause(signal);
    // 同一 run 里已经查过 order_query 就不再查（无状态判据：provider 是进程级单例，不能按 run 记状态）。
    if (messages.some((message) => message.role === "tool" && message.tool === "order_query")) return { toolCalls: [] };
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const question = lastUser?.content ?? "";
    if (!question.trim() || !tools.includes("order_query")) return { toolCalls: [] };
    // 确定性规则：拿问题里最长的连续非空白段当搜索词（订单号通常是它）。
    const keyword = question.trim().split(/\s+/).sort((a, b) => b.length - a.length)[0].slice(0, 100);
    const callId = `fake-${Math.random().toString(36).slice(2, 10)}`;
    return { toolCalls: [{ id: callId, tool: "order_query", operation: "search_orders", args: { q: keyword } }] };
  }

  async *streamAnswer(messages: AgentLlmMessage[], signal: AbortSignal): AsyncGenerator<AgentLlmStreamChunk> {
    const facts = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as { data: Record<string, unknown>[]; sources: { business_no: string }[] });
    const rows = facts.flatMap((fact) => fact.data);
    if (!rows.length) {
      await this.pause(signal);
      yield { type: "text", text: "没有查到匹配的订单。请确认单号或关键字后重新提问。" };
      yield { type: "usage", usage: { model: "fake-provider" } };
      return;
    }
    await this.pause(signal);
    signal.throwIfAborted();
    yield { type: "text", text: `根据本轮查询，找到 ${rows.length} 张订单：` };
    await this.pause(signal);
    signal.throwIfAborted();
    yield { type: "text", text: rows.map((row) => `${row.order_no}（${row.product_name}，${row.quantity}${row.unit}，状态 ${row.status}）`).join("；") + "。" };
    await this.pause(signal);
    signal.throwIfAborted();
    const sources = facts.flatMap((fact) => fact.sources.map((source) => source.business_no));
    yield { type: "text", text: `以上来自销售单 ${[...new Set(sources)].join("、")}；价格与金额未包含在当前可查范围内。` };
    yield { type: "usage", usage: { model: "fake-provider" } };
  }
}
