import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * Agent 自有状态（session / run / event）的唯一写入点。
 *
 * 三条不变量（模块设计「每个模块的 Interface」State manager 行）：
 *   1. 状态变更与事件在**同一事务**提交 —— 前端重放事件流即可重建状态，不依赖内存。
 *   2. `transitionAndAppend` 以「当前状态 = from」为条件更新：取消后迟到的模型增量、
 *      降权后的旧工具结果，都因为条件不匹配写不进终态 run。
 *   3. 终态不可离开；seq 在事务内分配，`(run_id, seq)` 唯一索引兜底并发。
 */

export const AGENT_ACTIVE_STATES = ["planning", "querying", "responding"] as const;
export const AGENT_TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;

/** SSE 事件类型固定 8 种（工程布局「JSON 与 SSE 协议」），别的 type 一律拒收。 */
export const AGENT_EVENT_TYPES = ["state", "tool_status", "answer_delta", "source", "usage", "completed", "cancelled", "error"] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
export type AgentRunEventInput = { type: AgentEventType; payload: Record<string, unknown> };

/** 状态迁移条件不满足（已终态、被取消、并发改写）。控制器把它映射成 409。 */
export class AgentStateTransitionError extends Error {
  constructor(readonly runId: string, readonly from: string, readonly to: string) {
    super(`run ${runId} 状态 ${from} 不允许迁移到 ${to}`);
    this.name = "AgentStateTransitionError";
  }
}

/** 状态管理器依赖的最小存储面：注入真实 PrismaClient（agent 状态连接）或内存假对象。 */
export type AgentStateStore = Pick<PrismaClient, "agentSession" | "agentRun" | "agentRunEvent" | "$transaction">;

const TRANSITIONS: Record<string, readonly string[]> = {
  planning: ["querying", "responding", "failed", "cancelled"],
  querying: ["responding", "failed", "cancelled"],
  responding: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** run 行（非空）：findFirst 的可空返回在查询处收窄，状态管理器的流转方法只收已确认存在的行。 */
export type AgentRunRow = NonNullable<Awaited<ReturnType<AgentStateStore["agentRun"]["findFirst"]>>>;

export class AgentStateManager {
  constructor(private readonly prisma: AgentStateStore) {}

  async createSession(userId: string) {
    return this.prisma.agentSession.create({ data: { id: randomUUID(), userId } });
  }

  /** 会话列表只按本人查：这里不给「全量会话」留入口。 */
  async listSessions(userId: string) {
    return this.prisma.agentSession.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  }

  async findSession(sessionId: string, userId: string) {
    return this.prisma.agentSession.findFirst({ where: { id: sessionId, userId } });
  }

  /** 某会话下的本人 run（快照恢复用）；降权可见性由调用方按档位过滤。 */
  async listRuns(sessionId: string, userId: string): Promise<AgentRunRow[]> {
    return this.prisma.agentRun.findMany({ where: { sessionId, userId }, orderBy: { createdAt: "asc" } });
  }

  /** 归属校验以 userId + 资源 ID 双条件查询（模块设计：不先取出他人会话再过滤）。查不到返回 null。 */
  async findRun(runId: string, userId: string): Promise<AgentRunRow | null> {
    return this.prisma.agentRun.findFirst({ where: { id: runId, userId } });
  }

  async findRunByIdempotencyKey(sessionId: string, clientMessageId: string): Promise<AgentRunRow | null> {
    return this.prisma.agentRun.findFirst({ where: { sessionId, clientMessageId } });
  }

  async hasActiveRun(userId: string): Promise<boolean> {
    const run = await this.prisma.agentRun.findFirst({ where: { userId, state: { in: [...AGENT_ACTIVE_STATES] } }, select: { id: true } });
    return run !== null;
  }

  /** 建 planning run 并写首个 state 事件；幂等键与活动 run 的唯一约束由数据库兜底。 */
  async createRun(input: { sessionId: string; userId: string; clientMessageId: string; question: string; accessLevel: string }) {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.create({
        data: { sessionId: input.sessionId, userId: input.userId, clientMessageId: input.clientMessageId, question: input.question, accessLevel: input.accessLevel, state: "planning" },
      });
      await tx.agentRunEvent.createMany({ data: [{ runId: run.id, seq: 1, type: "state", payload: { state: "planning" } }] });
      return run;
    });
  }

  /**
   * 条件迁移 + 追加事件。`to` 缺省表示不改状态（responding 里持续追加增量就是这种）。
   * `to` 与 `from` 不同时自动补一条 `state` 事件；返回最后一条事件的 seq（无事件时为 null）。
   */
  async transitionAndAppend(
    runId: string,
    opts: { from: string; to?: string; events?: AgentRunEventInput[]; errorCode?: string; answer?: string; usage?: unknown },
  ): Promise<{ seq: number | null }> {
    const to = opts.to ?? opts.from;
    // 同状态追加（from === to）是合法的：responding 里持续写增量就是这样，不经过迁移表。
    if (to !== opts.from && !TRANSITIONS[opts.from]?.includes(to)) throw new AgentStateTransitionError(runId, opts.from, to);
    const autoStateEvent: AgentRunEventInput | null = to !== opts.from ? { type: "state", payload: { state: to } } : null;
    const events = [...(autoStateEvent ? [autoStateEvent] : []), ...(opts.events ?? [])];

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.agentRun.updateMany({
        where: { id: runId, state: opts.from },
        data: { state: to, ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}), ...(opts.answer !== undefined ? { answer: opts.answer } : {}), ...(opts.usage !== undefined ? { usage: opts.usage as Prisma.InputJsonValue } : {}) },
      });
      if (updated.count !== 1) throw new AgentStateTransitionError(runId, opts.from, to);
      const [last] = await tx.agentRunEvent.findMany({ where: { runId }, orderBy: { seq: "desc" }, take: 1, select: { seq: true } });
      let seq = last?.seq ?? 0;
      if (!events.length) return { seq: seq || null };
      await tx.agentRunEvent.createMany({ data: events.map((event) => ({ runId, seq: ++seq, type: event.type, payload: event.payload as Prisma.InputJsonValue })) });
      return { seq };
    });
  }

  /** 断线重放与轮询的读取口；调用方必须先经 findRun 验归属。 */
  async eventsAfter(runId: string, afterSeq: number) {
    return this.prisma.agentRunEvent.findMany({ where: { runId, seq: { gt: afterSeq } }, orderBy: { seq: "asc" } });
  }

  /**
   * 取消本人的 run。查不到（他人/不存在）返回 null；已是终态返回原状态（无害空操作）；
   * 与「正常完成」竞争时条件更新失败抛 AgentStateTransitionError，由控制器转成当前状态。
   */
  async cancel(runId: string, userId: string): Promise<AgentRunRow | null> {
    const run = await this.findRun(runId, userId);
    if (!run) return null;
    if ((AGENT_TERMINAL_STATES as readonly string[]).includes(run.state)) return run;
    await this.transitionAndAppend(runId, { from: run.state, to: "cancelled", events: [{ type: "cancelled", payload: { state: "cancelled" } }] });
    return this.findRun(runId, userId);
  }

  /** 进程重启时调用：遗留活动 run 落 failed/INTERRUPTED 并写终态 error 事件，不自动重放模型调用。 */
  async failInterrupted(): Promise<number> {
    const stale = await this.prisma.agentRun.findMany({ where: { state: { in: [...AGENT_ACTIVE_STATES] } }, select: { id: true, state: true } });
    for (const run of stale) {
      await this.transitionAndAppend(run.id, {
        from: run.state,
        to: "failed",
        errorCode: "INTERRUPTED",
        events: [{ type: "error", payload: { code: "INTERRUPTED", message: "服务重启导致本次回答中断，请重新提问" } }],
      });
    }
    return stale.length;
  }
}
