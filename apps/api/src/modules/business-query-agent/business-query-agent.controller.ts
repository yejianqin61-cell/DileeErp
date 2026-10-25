import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { AgentStateManager, AgentStateTransitionError } from "./state-manager";
import { CreateRunDto } from "./business-query-agent.dto";
import { AgentOrchestrator } from "./agent-orchestrator";
import { StreamTransport } from "./stream-transport";
import { QueryPermissionGuard, type AgentAuthenticatedRequest, type AgentPrincipal } from "./query-permission.guard";

/**
 * 业务查询 Agent 的 6 条路由（工程布局「JSON 与 SSE 协议」）。
 * 全部先过 AuthenticationGuard（登录）再过 QueryPermissionGuard（两档数据档位）；
 * 归属校验以 userId + 资源 ID 双条件查询，他人资源一律 404（不泄露存在性）。
 */
@Controller("business-query")
@UseGuards(AuthenticationGuard, QueryPermissionGuard)
export class BusinessQueryAgentController {
  /** runId → AbortController：cancel 时中断本进程编排（多副本部署前不共享）。 */
  private readonly aborts = new Map<string, AbortController>();

  constructor(
    private readonly state: AgentStateManager,
    private readonly orchestrator: AgentOrchestrator,
    private readonly transport: StreamTransport,
  ) {}

  @Post("sessions")
  @HttpCode(201)
  async createSession(@Req() request: AgentAuthenticatedRequest) {
    const principal = requirePrincipal(request);
    const session = await this.state.createSession(principal.user.id);
    return { data: { session_id: session.id }, meta: {} };
  }

  @Get("sessions")
  async listSessions(@Req() request: AgentAuthenticatedRequest) {
    const principal = requirePrincipal(request);
    const sessions = await this.state.listSessions(principal.user.id);
    return { data: { sessions: sessions.map((session) => ({ session_id: session.id, created_at: session.createdAt, updated_at: session.updatedAt })) }, meta: {} };
  }

  /** 会话快照：刷新页恢复用。旧 full run 在降权后的档位下不可见，也不可读。 */
  @Get("sessions/:id")
  async sessionSnapshot(@Param("id", ParseUUIDPipe) sessionId: string, @Req() request: AgentAuthenticatedRequest) {
    const principal = requirePrincipal(request);
    const session = await this.state.findSession(sessionId, principal.user.id);
    if (!session) throw new NotFoundException({ code: "AGENT_SESSION_NOT_FOUND", message: "会话不存在", details: [] });
    const runs = await this.state.listRuns(sessionId, principal.user.id);
    const visible = runs.filter((run) => isReadableAt(principal, run));
    const data = [];
    for (const run of visible) {
      const events = await this.state.eventsAfter(run.id, 0);
      const deltas = events.filter((event) => event.type === "answer_delta").map((event) => String((event.payload as { text?: unknown }).text ?? ""));
      const sources = events.filter((event) => event.type === "source").flatMap((event) => (event.payload as { sources?: unknown[] }).sources ?? []);
      data.push({
        run_id: run.id,
        state: run.state,
        question: run.question,
        answer: run.answer ?? deltas.join(""),
        sources,
        latest_seq: events.length ? events[events.length - 1].seq : 1,
        error_code: run.errorCode,
        access_level: run.accessLevel,
        created_at: run.createdAt,
      });
    }
    return { data: { session_id: sessionId, runs: data }, meta: {} };
  }

  @Post("sessions/:id/runs")
  @HttpCode(202)
  async createRun(@Param("id", ParseUUIDPipe) sessionId: string, @Body() dto: CreateRunDto, @Req() request: AgentAuthenticatedRequest) {
    const principal = requirePrincipal(request);
    const session = await this.state.findSession(sessionId, principal.user.id);
    if (!session) throw new NotFoundException({ code: "AGENT_SESSION_NOT_FOUND", message: "会话不存在", details: [] });

    // 幂等：同键同问题返回原 run；同键不同问题 409；已降权的旧 full run 返回权限错误（模块设计）。
    const existing = await this.state.findRunByIdempotencyKey(sessionId, dto.client_message_id);
    if (existing) {
      if (existing.question !== dto.question) {
        throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT", message: "相同幂等键对应了不同的问题，请换一个新的 client_message_id", details: [] });
      }
      if (!isReadableAt(principal, existing)) {
        throw new ForbiddenException({ code: "AGENT_ACCESS_REVOKED", message: "当前档位已无法读取该回答", details: [] });
      }
      return { data: { run_id: existing.id, state: existing.state }, meta: {} };
    }
    if (await this.state.hasActiveRun(principal.user.id)) {
      throw new ConflictException({ code: "RUN_IN_PROGRESS", message: "你已有一个正在进行的查询，请等待完成或取消后再提问", details: [] });
    }

    let run;
    try {
      run = await this.state.createRun({ sessionId, userId: principal.user.id, clientMessageId: dto.client_message_id, question: dto.question, accessLevel: principal.accessLevel });
    } catch (error) {
      // 部分唯一索引（单用户单活动 run）是并发竞态的最后闸门，撞上即按忙碌处理。
      if (isUniqueViolation(error)) throw new ConflictException({ code: "RUN_IN_PROGRESS", message: "你已有一个正在进行的查询，请等待完成或取消后再提问", details: [] });
      throw error;
    }

    const abort = new AbortController();
    this.aborts.set(run.id, abort);
    void this.orchestrator.run(run, principal, abort.signal).finally(() => this.aborts.delete(run.id));
    return { data: { run_id: run.id, state: run.state }, meta: {} };
  }

  /** SSE：归属与档位在此校验（401/403/404 仍走 JSON 错误信封），流由 transport 接管响应。 */
  @Get("runs/:id/events")
  async subscribe(@Param("id", ParseUUIDPipe) runId: string, @Req() request: AgentAuthenticatedRequest, @Res() response: Response) {
    const principal = requirePrincipal(request);
    const run = await this.state.findRun(runId, principal.user.id);
    if (!run) throw new NotFoundException({ code: "AGENT_RUN_NOT_FOUND", message: "查询不存在", details: [] });
    if (!isReadableAt(principal, run)) {
      throw new ForbiddenException({ code: "AGENT_ACCESS_REVOKED", message: "当前档位已无法读取该回答", details: [] });
    }
    const afterSeq = parseLastEventId(request.headers["last-event-id"], runId);
    await this.transport.follow(response, run, afterSeq);
  }

  @Post("runs/:id/cancel")
  async cancel(@Param("id", ParseUUIDPipe) runId: string, @Req() request: AgentAuthenticatedRequest) {
    const principal = requirePrincipal(request);
    let run;
    try {
      run = await this.state.cancel(runId, principal.user.id);
    } catch (error) {
      // 与「正常完成」竞争时条件更新失败：回读当前状态返回，取消一个已完成的 run 是无害的。
      if (!(error instanceof AgentStateTransitionError)) throw error;
      run = await this.state.findRun(runId, principal.user.id);
    }
    if (!run) throw new NotFoundException({ code: "AGENT_RUN_NOT_FOUND", message: "查询不存在", details: [] });
    this.aborts.get(runId)?.abort();
    return { data: { state: run.state }, meta: {} };
  }
}

function requirePrincipal(request: AgentAuthenticatedRequest): AgentPrincipal {
  if (!request.agentPrincipal) throw new UnauthorizedException();
  return request.agentPrincipal;
}

/** 运行内容对当前档位是否可读：创建时 full 的 run，在降权后的 operational 档位下一律不可读。 */
function isReadableAt(principal: AgentPrincipal, run: { accessLevel: string }): boolean {
  return principal.accessLevel === "full" || run.accessLevel !== "full";
}

/** `Last-Event-ID` 形如 `<runId>:<seq>`：只决定重放起点，且必须匹配当前 run（模块设计）。 */
function parseLastEventId(raw: unknown, runId: string): number {
  if (raw === undefined) return 0;
  const [idPart, seqPart] = String(raw).split(":");
  if (idPart !== runId) throw new BadRequestException({ code: "AGENT_LAST_EVENT_ID_INVALID", message: "Last-Event-ID 与当前查询不匹配", details: [] });
  const seq = Number(seqPart);
  if (!Number.isInteger(seq) || seq < 0) throw new BadRequestException({ code: "AGENT_LAST_EVENT_ID_INVALID", message: "Last-Event-ID 的序号必须是非负整数", details: [] });
  return seq;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002");
}
