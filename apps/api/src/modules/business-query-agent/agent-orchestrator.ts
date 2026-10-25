import { ForbiddenException, HttpException, Logger } from "@nestjs/common";
import { AGENT_ACTIVE_STATES, AgentStateManager, type AgentRunRow } from "./state-manager";
import type { AgentPrincipal } from "./query-permission.guard";
import type { AgentLlmMessage, AgentLlmPlan, AgentLlmProvider, AgentLlmUsage } from "./llm-provider";
import type { QueryFact } from "./tools/query-fact";
import { resolveAccessLevel, lowerAccessLevel, type AgentAccessLevel } from "./access-level";
import type { AgentRoleReader } from "./query-permission.guard";
import { toolRegistry } from "./tools/tool-registry";
import type { ToolCall, ToolExecutor } from "./tools/tool-executor";
import { AgentContextManager } from "./context-manager";
import type { AgentObservability } from "./observability";

/**
 * Agent orchestrator：唯一运行入口（模块设计「Agent orchestrator」行）。
 *
 * 推进 planning → querying → responding → completed；每个状态变更与事件同事务落库，
 * 异常一律收进 failed 终态。多步工具循环有轮数上限（MAX_TOOL_STEPS），run 整体有
 * AGENT_RUN_TIMEOUT_MS 超时（默认 120s）—— 这与「输入 token 不限额」是两个不同的控制项。
 * 超窗（MODEL_CONTEXT_EXCEEDED）由 provider 层映射，统一走这里的 failed 收口。
 */

const SYSTEM_PROMPT = "你是工厂业务系统的查询助手。只根据本轮工具返回的事实回答；引用数字时说明来自哪张单据；查不到就明确说查不到，不得编造业务结论。";
export const AGENT_MAX_TOOL_STEPS = 8;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

export type AgentOrchestratorOptions = { runTimeoutMs?: number; observability?: AgentObservability };

export class AgentOrchestrator {
  private readonly runTimeoutMs: number;
  private readonly observability?: AgentObservability;
  /** 内部错误的服务端堆栈日志（R-11）：只进服务端日志，不进 SSE 事件与对外信封。 */
  private readonly logger = new Logger("business-query-agent");

  constructor(
    private readonly state: AgentStateManager,
    private readonly executor: ToolExecutor,
    private readonly provider: AgentLlmProvider,
    private readonly roleReader: AgentRoleReader,
    private readonly context?: AgentContextManager,
    options?: AgentOrchestratorOptions,
  ) {
    this.runTimeoutMs = options?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.observability = options?.observability;
  }

  async run(run: AgentRunRow, principal: AgentPrincipal, signal: AbortSignal): Promise<void> {
    // 重读并确认仍是 planning：用户可能在编排器启动前就取消（迟到启动是无害空转）。
    const fresh = await this.state.findRun(run.id, principal.user.id);
    if (!fresh || fresh.state !== "planning") return;
    // run 级超时：模型卡死/工具循环失控不得长期占用并发许可（R-11）。用户取消仍即时生效。
    const composed = this.runTimeoutMs > 0 && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, AbortSignal.timeout(this.runTimeoutMs)])
      : signal;
    const startedAt = Date.now();
    try {
      await this.queryPhase(fresh, principal, composed);
    } catch (error) {
      await this.failRun(fresh.id, principal.user.id, error, startedAt);
    }
  }

  private async queryPhase(run: AgentRunRow, principal: AgentPrincipal, signal: AbortSignal): Promise<void> {
    const runId = run.id;
    const startedAt = Date.now();
    const tools = toolRegistry.visibleTools(run.accessLevel as "full" | "operational");
    const history = this.context
      ? await this.context.history(principal.user.id, run.sessionId, run.accessLevel as AgentAccessLevel)
      : [];
    const messages: AgentLlmMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: run.question },
    ];

    const facts: QueryFact[] = [];
    let executed = 0;
    let modelSteps = 0;
    const planOnce = async (): Promise<AgentLlmPlan> => {
      const planStartedAt = Date.now();
      const plan = await this.provider.plan(messages, tools, signal);
      this.observability?.record(runId, { kind: "model_step", user_id: principal.user.id, access_level: run.accessLevel, model: this.provider.name ?? "unknown", step: ++modelSteps, duration_ms: Date.now() - planStartedAt, tool_calls: plan.toolCalls.length });
      return plan;
    };

    const firstPlan = await planOnce();
    if (firstPlan.toolCalls.length > 0) {
      await this.state.transitionAndAppend(runId, { from: "planning", to: "querying" });
      // 多步循环：每轮 plan 可提出多个调用，同一 run 内按顺序执行；轮数与总数受 MAX_TOOL_STEPS 约束。
      let calls = firstPlan.toolCalls;
      while (calls.length > 0 && executed < AGENT_MAX_TOOL_STEPS) {
        for (const call of calls) {
          if (executed >= AGENT_MAX_TOOL_STEPS) break;
          const fact = await this.executeTool(runId, principal, call, signal);
          facts.push(fact);
          messages.push({ role: "tool", id: call.id, tool: call.tool, args: call.args, content: JSON.stringify(fact) });
          executed += 1;
        }
        if (executed >= AGENT_MAX_TOOL_STEPS) break;
        const next = await planOnce();
        calls = next.toolCalls;
      }
    }

    // 查询结束后重查角色：运行中被降权的 run 在最终回答前就地终止（模块设计）。
    await this.assertStillAuthorized(run, principal.user.id);
    await this.state.transitionAndAppend(runId, { from: facts.length > 0 || executed > 0 ? "querying" : "planning", to: "responding" });

    let answer = "";
    let chunks = 0;
    let providerUsage: AgentLlmUsage | null = null;
    for await (const chunk of this.provider.streamAnswer(messages, signal)) {
      signal.throwIfAborted();
      if (chunk.type === "usage") {
        providerUsage = chunk.usage;
        continue;
      }
      answer += chunk.text;
      chunks += 1;
      await this.state.transitionAndAppend(runId, { from: "responding", events: [{ type: "answer_delta", payload: { text: chunk.text } }] });
    }

    const usage = { ...providerUsage, tool_calls: facts.length, answer_chunks: chunks };
    await this.state.transitionAndAppend(runId, {
      from: "responding",
      to: "completed",
      answer,
      usage,
      events: [{ type: "completed", payload: { answer, sources: facts.flatMap((fact) => fact.sources), usage } }],
    });
    this.observability?.record(runId, {
      kind: "run_completed",
      user_id: principal.user.id,
      access_level: run.accessLevel,
      model: this.provider.name ?? "unknown",
      duration_ms: Date.now() - startedAt,
      usage: { input_tokens: (usage.input_tokens as number | undefined), output_tokens: (usage.output_tokens as number | undefined), tool_calls: usage.tool_calls, answer_chunks: usage.answer_chunks },
    });
  }

  private async executeTool(runId: string, principal: AgentPrincipal, call: ToolCall, signal: AbortSignal): Promise<QueryFact> {
    await this.state.transitionAndAppend(runId, { from: "querying", events: [{ type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "running" } }] });
    const startedAt = Date.now();
    try {
      const fact = await this.executor.execute(call, principal, signal);
      const asOf = new Date().toISOString();
      await this.state.transitionAndAppend(runId, {
        from: "querying",
        events: [
          { type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "completed" } },
          { type: "source", payload: { sources: fact.sources, as_of: asOf } },
        ],
      });
      this.observability?.record(runId, { kind: "tool_executed", user_id: principal.user.id, access_level: principal.accessLevel, operation: call.operation, status: "completed", result_rows: Array.isArray(fact.data) ? fact.data.length : 1, duration_ms: Date.now() - startedAt });
      return fact;
    } catch (error) {
      // tool_status 只发名称与失败状态，不发原始参数（工程布局「JSON 与 SSE 协议」）。
      const code = error instanceof HttpException ? (error.getResponse() as { code?: string }).code ?? "AGENT_TOOL_FAILED" : "AGENT_TOOL_FAILED";
      await this.state.transitionAndAppend(runId, { from: "querying", events: [{ type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "failed", code } }] }).catch(() => {});
      this.observability?.record(runId, { kind: "tool_executed", user_id: principal.user.id, access_level: principal.accessLevel, operation: call.operation, status: "failed", result_rows: 0, duration_ms: Date.now() - startedAt, error_code: code });
      throw error;
    }
  }

  private async assertStillAuthorized(run: AgentRunRow, userId: string): Promise<void> {
    const roleKeys = await this.roleReader.readActiveRoleKeys(userId);
    const current = resolveAccessLevel(roleKeys);
    if (current === "denied") {
      throw new ForbiddenException({ code: "AGENT_ACCESS_REVOKED", message: "当前账号已无可用角色，本次查询被终止", details: [] });
    }
    if (lowerAccessLevel(current, run.accessLevel as "full" | "operational") !== run.accessLevel) {
      throw new ForbiddenException({ code: "AGENT_ACCESS_REVOKED", message: "当前档位已降低，本次查询被终止", details: [] });
    }
  }

  /** 任何异常都收进 failed 终态；run 已被取消等终态时保持原状。非业务异常只留稳定文案。 */
  private async failRun(runId: string, userId: string, error: unknown, startedAt: number): Promise<void> {
    const fresh = await this.state.findRun(runId, userId).catch(() => null);
    if (!fresh || !(AGENT_ACTIVE_STATES as readonly string[]).includes(fresh.state)) return;
    const isBusiness = error instanceof HttpException;
    const isTimeout = typeof error === "object" && error !== null && (error as { name?: string }).name === "TimeoutError";
    const code = isBusiness ? (error.getResponse() as { code?: string }).code ?? "AGENT_RUN_FAILED" : isTimeout ? "AGENT_RUN_TIMEOUT" : "AGENT_INTERNAL_ERROR";
    if (!isBusiness) {
      // AGENT_INTERNAL_ERROR 对外只有稳定文案；堆栈留在服务端日志里供排查。
      this.logger.error(`run ${runId} 内部错误（code=${code}）`, error instanceof Error ? error.stack : String(error));
    }
    const message = isBusiness
      ? typeof error.getResponse() === "string" ? error.message : (error.getResponse() as { message?: string }).message ?? "查询执行失败"
      : isTimeout
        ? "本次回答超时，请重试"
        : "查询执行出错，请稍后重试";
    await this.state.transitionAndAppend(runId, { from: fresh.state, to: "failed", errorCode: code, events: [{ type: "error", payload: { code, message } }] }).catch(() => {});
    this.observability?.record(runId, { kind: "run_failed", user_id: userId, access_level: fresh.accessLevel, error_code: code, duration_ms: Date.now() - startedAt });
  }
}
