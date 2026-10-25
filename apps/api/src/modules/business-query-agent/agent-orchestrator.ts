import { ForbiddenException, HttpException } from "@nestjs/common";
import { AGENT_ACTIVE_STATES, AgentStateManager, type AgentRunRow } from "./state-manager";
import type { AgentPrincipal } from "./query-permission.guard";
import type { AgentLlmMessage, AgentLlmProvider } from "./llm-provider";
import type { QueryFact } from "./tools/query-fact";
import { resolveAccessLevel, lowerAccessLevel } from "./access-level";
import type { AgentRoleReader } from "./query-permission.guard";
import { toolRegistry } from "./tools/tool-registry";
import type { ToolCall, ToolExecutor } from "./tools/tool-executor";

/**
 * Agent orchestrator：唯一运行入口（模块设计「Agent orchestrator」行）。
 *
 * 推进 planning → querying → responding → completed；每个状态变更与事件同事务落库，
 * 异常一律收进 failed 终态。工具步骤有上限（Phase 2 按压测固化阈值）；八轮历史上下文
 * 是 Phase 2（R-6）的接缝 —— 这里只发本次问题。
 */

const SYSTEM_PROMPT = "你是工厂业务系统的查询助手。只根据本轮工具返回的事实回答；引用数字时说明来自哪张单据；查不到就明确说查不到，不得编造业务结论。";
const MAX_TOOL_STEPS = 8;

export class AgentOrchestrator {
  constructor(
    private readonly state: AgentStateManager,
    private readonly executor: ToolExecutor,
    private readonly provider: AgentLlmProvider,
    private readonly roleReader: AgentRoleReader,
  ) {}

  async run(run: AgentRunRow, principal: AgentPrincipal, signal: AbortSignal): Promise<void> {
    // 重读并确认仍是 planning：用户可能在编排器启动前就取消（迟到启动是无害空转）。
    const fresh = await this.state.findRun(run.id, principal.user.id);
    if (!fresh || fresh.state !== "planning") return;
    try {
      await this.queryPhase(fresh, principal, signal);
    } catch (error) {
      await this.failRun(fresh.id, principal.user.id, error);
    }
  }

  private async queryPhase(run: AgentRunRow, principal: AgentPrincipal, signal: AbortSignal): Promise<void> {
    const runId = run.id;
    const tools = toolRegistry.visibleTools(run.accessLevel as "full" | "operational");
    const messages: AgentLlmMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: run.question },
    ];

    const plan = await this.provider.plan(messages, tools, signal);
    const facts: QueryFact[] = [];
    if (plan.toolCalls.length > 0) {
      await this.state.transitionAndAppend(runId, { from: "planning", to: "querying" });
      // 一次模型请求可提多个调用，但同一 run 内按顺序执行，避免重查询同时压数据库。
      for (const call of plan.toolCalls.slice(0, MAX_TOOL_STEPS)) {
        const fact = await this.executeTool(runId, principal, call, signal);
        facts.push(fact);
        messages.push({ role: "tool", content: JSON.stringify(fact) });
      }
    }

    // 查询结束后重查角色：运行中被降权的 run 在最终回答前就地终止（模块设计）。
    await this.assertStillAuthorized(run, principal.user.id);
    await this.state.transitionAndAppend(runId, { from: plan.toolCalls.length > 0 ? "querying" : "planning", to: "responding" });

    let answer = "";
    let chunks = 0;
    for await (const text of this.provider.streamAnswer(messages, signal)) {
      signal.throwIfAborted();
      answer += text;
      chunks += 1;
      await this.state.transitionAndAppend(runId, { from: "responding", events: [{ type: "answer_delta", payload: { text } }] });
    }

    const usage = { model: "fake-provider", tool_calls: facts.length, answer_chunks: chunks };
    await this.state.transitionAndAppend(runId, {
      from: "responding",
      to: "completed",
      answer,
      usage,
      events: [{ type: "completed", payload: { answer, sources: facts.flatMap((fact) => fact.sources), usage } }],
    });
  }

  private async executeTool(runId: string, principal: AgentPrincipal, call: ToolCall, signal: AbortSignal): Promise<QueryFact> {
    await this.state.transitionAndAppend(runId, { from: "querying", events: [{ type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "running" } }] });
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
      return fact;
    } catch (error) {
      // tool_status 只发名称与失败状态，不发原始参数（工程布局「JSON 与 SSE 协议」）。
      const code = error instanceof HttpException ? (error.getResponse() as { code?: string }).code ?? "AGENT_TOOL_FAILED" : "AGENT_TOOL_FAILED";
      await this.state.transitionAndAppend(runId, { from: "querying", events: [{ type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "failed", code } }] }).catch(() => {});
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
  private async failRun(runId: string, userId: string, error: unknown): Promise<void> {
    const fresh = await this.state.findRun(runId, userId).catch(() => null);
    if (!fresh || !(AGENT_ACTIVE_STATES as readonly string[]).includes(fresh.state)) return;
    const isBusiness = error instanceof HttpException;
    const code = isBusiness ? (error.getResponse() as { code?: string }).code ?? "AGENT_RUN_FAILED" : "AGENT_INTERNAL_ERROR";
    const message = isBusiness
      ? typeof error.getResponse() === "string" ? error.message : (error.getResponse() as { message?: string }).message ?? "查询执行失败"
      : "查询执行出错，请稍后重试";
    await this.state.transitionAndAppend(runId, { from: fresh.state, to: "failed", errorCode: code, events: [{ type: "error", payload: { code, message } }] }).catch(() => {});
  }
}
