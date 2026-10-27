import { ForbiddenException, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { AGENT_ACTIVE_STATES, AgentStateManager, type AgentRunRow } from "./state-manager";
import type { AgentPrincipal } from "./query-permission.guard";
import type { AgentLlmMessage, AgentLlmPlan, AgentLlmProvider, AgentLlmToolCall, AgentLlmUsage } from "./llm-provider";
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
 * 异常一律收进 failed 终态。多步工具循环有轮数与调用总数上限（默认 4 轮 / 16 次调用），
 * run 整体有 AGENT_RUN_TIMEOUT_MS 超时（默认 120s）—— 这与「输入 token 不限额」是两个不同的控制项。
 * 超窗（MODEL_CONTEXT_EXCEEDED）由 provider 层映射，统一走这里的 failed 收口。
 *
 * 工具级失败分两类（2026-10-26 线上 ORDER_NOT_FOUND 修复）：
 *   - 可回传失败（订单不存在、参数不合法、未注册、档位不允许、未先搜索）：作为 tool 结果
 *     回喂模型，让它在下一轮改参数/先 search_orders；受失败预算约束，防死循环；
 *   - 致命失败（撤权、取消、超时、非业务异常）：仍直接收进 failed 终态。
 */

const SYSTEM_PROMPT = "你是工厂业务系统的查询助手。只根据本轮工具返回的事实回答；引用数字时说明来自哪张单据；查不到就明确说查不到，不得编造业务结论。订单号必须先用 order_query 的 search_orders 取得精确值并原样使用（包含产品名、后缀与空格），不得根据用户输入猜测或截断。";
export const AGENT_MAX_TOOL_STEPS = 16;
export const AGENT_MAX_PLAN_STEPS = 4;
export const AGENT_MAX_RECOVERABLE_TOOL_FAILURES = 3;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/** 可回传给模型自纠的工具级失败码；其余异常一律终止本轮。 */
const RECOVERABLE_TOOL_ERROR_CODES = new Set([
  "ORDER_NOT_FOUND",
  "ORDER_SEARCH_REQUIRED",
  "AGENT_TOOL_ARGUMENT_INVALID",
  "AGENT_TOOL_UNKNOWN",
  "AGENT_OPERATION_NOT_IMPLEMENTED",
  "AGENT_TOOL_FORBIDDEN",
]);

/**
 * 入参取证（R-5）：只把「模型实际传了什么」写进**事件表**，不写进观测日志。
 *
 * 为什么分开：日志的既有红线是「不含业务值」，而排查口径问题的第一步恰恰要知道模型传了
 * 哪个单号/检索词。事件表本来就存 question/answer，权限口径相同，所以业务值放在这里不扩大
 * 暴露面；观测日志保持原样。前端也收不到——传输层把 tool_args 当内部事件跳过。
 */
const TOOL_ARG_DIGEST_KEYS = ["order_no", "q", "page", "order_ref"] as const;
const TOOL_ARG_DIGEST_MAX_CHARS = 100;

type ToolOutcome = { ok: true; fact: QueryFact } | { ok: false; code: string; message: string };

function httpErrorCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  if (typeof response !== "object" || response === null) return null;
  const code = (response as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function httpErrorMessage(error: HttpException, fallback: string): string {
  const response = error.getResponse();
  if (typeof response === "string") return response || fallback;
  const message = (response as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

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
    /** 本轮 search_orders 返回过的精确 order_no：根查询只允许使用这里的值。 */
    const searchedOrderNos = new Set<string>();
    let attempted = 0;
    let modelSteps = 0;
    let recoverableFailures = 0;
    const planOnce = async (): Promise<AgentLlmPlan> => {
      const planStartedAt = Date.now();
      const plan = await this.provider.plan(messages, tools, signal);
      this.observability?.record(runId, { kind: "model_step", user_id: principal.user.id, access_level: run.accessLevel, model: this.provider.name ?? "unknown", step: ++modelSteps, duration_ms: Date.now() - planStartedAt, tool_calls: plan.toolCalls.length });
      return plan;
    };

    const firstPlan = await planOnce();
    if (firstPlan.toolCalls.length > 0) {
      await this.state.transitionAndAppend(runId, { from: "planning", to: "querying" });
      // 多步循环：每轮 plan 可提出多个调用，同一 run 内按顺序执行；轮数与调用总数分别受上限约束。
      let calls = firstPlan.toolCalls;
      while (calls.length > 0 && attempted < AGENT_MAX_TOOL_STEPS && modelSteps < AGENT_MAX_PLAN_STEPS) {
        for (const call of calls) {
          if (attempted >= AGENT_MAX_TOOL_STEPS) {
            this.dropCall(runId, principal, call, "call_budget");
            continue;
          }
          attempted += 1;
          await this.appendToolArgs(runId, call);
          const guard = this.searchGuardViolation(call, searchedOrderNos);
          const outcome = guard
            ? await this.rejectBeforeExecution(runId, principal, call, guard.code, guard.message)
            : await this.executeTool(runId, principal, call, signal);
          if (outcome.ok) {
            facts.push(outcome.fact);
            this.rememberSearchedOrderNos(searchedOrderNos, outcome.fact);
            messages.push({ role: "tool", id: call.id, tool: call.tool, operation: call.operation, args: call.args, content: JSON.stringify(outcome.fact) });
            continue;
          }
          // 可回传失败：错误信封进 tool 消息，模型下一轮可改参数或先搜索；受失败预算约束。
          recoverableFailures += 1;
          messages.push({ role: "tool", id: call.id, tool: call.tool, operation: call.operation, args: call.args, content: JSON.stringify({ error: { code: outcome.code, message: outcome.message } }) });
          if (recoverableFailures >= AGENT_MAX_RECOVERABLE_TOOL_FAILURES) {
            throw new HttpException({ code: "AGENT_TOOL_RETRIES_EXHAUSTED", message: "工具连续失败，本次查询无法继续，请换个问法或稍后重试", details: [] }, HttpStatus.UNPROCESSABLE_ENTITY);
          }
        }
        if (attempted >= AGENT_MAX_TOOL_STEPS || modelSteps >= AGENT_MAX_PLAN_STEPS) break;
        const next = await planOnce();
        calls = next.toolCalls;
      }
    }

    // 查询结束后重查角色：运行中被降权的 run 在最终回答前就地终止（模块设计）。
    await this.assertStillAuthorized(run, principal.user.id);
    await this.state.transitionAndAppend(runId, { from: facts.length > 0 || attempted > 0 ? "querying" : "planning", to: "responding" });

    let answer = "";
    let chunks = 0;
    let providerUsage: AgentLlmUsage | null = null;
    for await (const chunk of this.provider.streamAnswer(messages, signal, tools)) {
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

  /**
   * 根查询的运行时守卫：非 search_orders 的 operation 只能使用**本轮** search_orders 返回的精确
   * order_no。命中即返回可回传失败 ORDER_SEARCH_REQUIRED，不触达数据库 —— 提示词是概率行为，
   * 这里才是「先搜索再根查询」的契约。
   */
  private searchGuardViolation(call: AgentLlmToolCall, searchedOrderNos: Set<string>): { code: string; message: string } | null {
    if (call.operation === "search_orders") return null;
    const raw = call.args?.order_no;
    const orderNo = typeof raw === "string" ? raw.trim() : "";
    if (!orderNo) {
      return { code: "ORDER_SEARCH_REQUIRED", message: "缺少 order_no。请先调用 order_query 的 search_orders，再原样使用返回的精确 order_no 查询该订单" };
    }
    if (!searchedOrderNos.has(orderNo)) {
      return { code: "ORDER_SEARCH_REQUIRED", message: "order_no 不是本轮 search_orders 返回的精确值。请先调用 search_orders，并原样复制返回的 order_no（含产品名、后缀与空格）" };
    }
    return null;
  }

  /** 记录本轮 search_orders 的精确单号，作为后续根查询的白名单。 */
  private rememberSearchedOrderNos(target: Set<string>, fact: QueryFact): void {
    if (fact.operation !== "search_orders") return;
    const rows = Array.isArray(fact.data) ? fact.data : [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const orderNo = (row as { order_no?: unknown }).order_no;
      if (typeof orderNo === "string" && orderNo.trim().length > 0) target.add(orderNo.trim());
    }
  }

  /** 入参取证：写一条内部事件，浏览器收不到；写失败不影响主流程（取证不该拖垮问答）。 */
  private async appendToolArgs(runId: string, call: AgentLlmToolCall): Promise<void> {
    const args = this.digestToolArgs(call.args);
    if (Object.keys(args).length === 0) return;
    await this.state.transitionAndAppend(runId, {
      from: "querying",
      events: [{ type: "tool_args", payload: { tool: call.tool, operation: call.operation, args } }],
    }).catch(() => {});
  }

  /** 白名单 + 截断：只留定位问题需要的那四个键，长文本切到 100 字符。 */
  private digestToolArgs(raw: Record<string, unknown> | undefined): Record<string, unknown> {
    const digest: Record<string, unknown> = {};
    if (!raw) return digest;
    for (const key of TOOL_ARG_DIGEST_KEYS) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      digest[key] = typeof value === "string" ? value.slice(0, TOOL_ARG_DIGEST_MAX_CHARS) : value;
    }
    return digest;
  }

  private dropCall(runId: string, principal: AgentPrincipal, call: AgentLlmToolCall, reason: "call_budget" | "plan_budget"): void {
    // 丢弃的调用只记 operation 与原因，不记参数（R-11 脱敏）。
    this.logger.warn(`run ${runId} 丢弃工具调用 ${call.tool}/${call.operation}（${reason}）`);
    this.observability?.record(runId, { kind: "tool_dropped", user_id: principal.user.id, access_level: principal.accessLevel, operation: call.operation, reason });
  }

  /** 不触达数据库的运行时拒绝：仍发 running/failed 两个 tool_status，前端步骤与真实执行一致。 */
  private async rejectBeforeExecution(runId: string, principal: AgentPrincipal, call: AgentLlmToolCall, code: string, message: string): Promise<ToolOutcome> {
    await this.state.transitionAndAppend(runId, {
      from: "querying",
      events: [
        { type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "running" } },
        { type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "failed", code } },
      ],
    }).catch(() => {});
    this.observability?.record(runId, { kind: "tool_executed", user_id: principal.user.id, access_level: principal.accessLevel, operation: call.operation, status: "failed", result_rows: 0, duration_ms: 0, error_code: code });
    return { ok: false, code, message };
  }

  private async executeTool(runId: string, principal: AgentPrincipal, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
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
      return { ok: true, fact };
    } catch (error) {
      // tool_status 只发名称与失败状态，不发原始参数（工程布局「JSON 与 SSE 协议」）。
      const code = httpErrorCode(error) ?? "AGENT_TOOL_FAILED";
      const message = error instanceof HttpException ? httpErrorMessage(error, "查询执行失败") : "查询执行失败，请稍后重试";
      await this.state.transitionAndAppend(runId, { from: "querying", events: [{ type: "tool_status", payload: { tool: call.tool, operation: call.operation, status: "failed", code } }] }).catch(() => {});
      this.observability?.record(runId, { kind: "tool_executed", user_id: principal.user.id, access_level: principal.accessLevel, operation: call.operation, status: "failed", result_rows: 0, duration_ms: Date.now() - startedAt, error_code: code });
      // 可回传失败交给循环回喂模型；其余（撤权/取消/超时/非业务异常）终止本轮。
      if (error instanceof HttpException && RECOVERABLE_TOOL_ERROR_CODES.has(code)) return { ok: false, code, message };
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
