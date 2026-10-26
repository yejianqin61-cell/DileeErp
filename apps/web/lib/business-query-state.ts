/**
 * 业务查询页的前端状态机（纯 reducer，供查询页复用与单测）。
 *
 * 迁移图与模块设计「SSE 与前后端状态机」一致：
 *   idle → submitting → connecting → streaming → done，另有 disconnected / error / cancelled；
 *   disconnected 可回 connecting/streaming（续接）；终态不可离开。
 * 事件按 `seq` 去重；**刷新恢复走快照**：答案以后端快照为准重建，续接从快照的 latest_seq 开始，
 * 所以重放的 answer_delta 不会与快照内容重复拼接。
 */

export type BusinessQueryPhase = "idle" | "submitting" | "connecting" | "streaming" | "disconnected" | "done" | "error" | "cancelled";

export type QuerySourceView = { business_type: string; business_no: string; queried_at?: string };
export type ToolStepView = { tool: string; operation: string; status: string; code?: string };

export type BusinessQueryState = {
  phase: BusinessQueryPhase;
  sessionId: string | null;
  runId: string | null;
  question: string;
  answer: string;
  sources: QuerySourceView[];
  toolSteps: ToolStepView[];
  error: { code: string; message: string } | null;
  /** 最后**已应用**的事件序号：去重基准，也是断线续接（Last-Event-ID）的起点。 */
  lastSeq: number;
};

export const initialBusinessQueryState: BusinessQueryState = {
  phase: "idle",
  sessionId: null,
  runId: null,
  question: "",
  answer: "",
  sources: [],
  toolSteps: [],
  error: null,
  lastSeq: 0,
};

export type BusinessQueryEvent = { seq: number; type: string; data: Record<string, unknown> };

export type BusinessQueryAction =
  | { type: "SUBMIT"; question: string; sessionId: string }
  | { type: "RUN_CREATED"; runId: string }
  | { type: "CONNECTED" }
  | { type: "EVENT"; event: BusinessQueryEvent }
  | { type: "DISCONNECTED" }
  | { type: "SNAPSHOT_RESTORED"; snapshot: { runId: string; state: string; question: string; answer: string; sources: QuerySourceView[]; latestSeq: number; errorCode?: string | null } }
  | { type: "RESET" };

const ACTIVE_PHASES: ReadonlySet<BusinessQueryPhase> = new Set(["idle", "submitting", "connecting", "streaming", "disconnected"]);
const TERMINAL_PHASES: ReadonlySet<BusinessQueryPhase> = new Set(["done", "error", "cancelled"]);

export function reduce(state: BusinessQueryState, action: BusinessQueryAction): BusinessQueryState {
  switch (action.type) {
    case "SUBMIT": {
      // 只有"没有活动运行"时才允许新开一轮（含终态后重问）；活动中的提交由页面层先挡一道。
      if (!TERMINAL_PHASES.has(state.phase) && state.phase !== "idle") return state;
      return { ...initialBusinessQueryState, sessionId: action.sessionId, question: action.question, phase: "submitting" };
    }
    case "RUN_CREATED":
      if (state.phase !== "submitting") return state;
      return { ...state, phase: "connecting", runId: action.runId };
    case "CONNECTED":
      if (state.phase !== "connecting" && state.phase !== "submitting" && state.phase !== "disconnected") return state;
      return { ...state, phase: "connecting" };
    case "EVENT":
      return reduceEvent(state, action.event);
    case "DISCONNECTED":
      // 终态后的断线无所谓（内容已完整）；活动中的断线进入 disconnected 等待续接。
      return TERMINAL_PHASES.has(state.phase) || state.phase === "idle" ? state : { ...state, phase: "disconnected" };
    case "SNAPSHOT_RESTORED":
      return reduceSnapshot(state, action.snapshot);
    case "RESET":
      return { ...initialBusinessQueryState, sessionId: state.sessionId };
    default:
      return state;
  }
}

function reduceEvent(state: BusinessQueryState, event: BusinessQueryEvent): BusinessQueryState {
  // ACCESS_REVOKED 是服务端专用的 seq=0 控制帧，必须绕过重放去重与终态锁；
  // 已在授权时渲染的字节无法收回，但本地缓存不能再被新档位续接或复用。
  if (event.type === "error" && event.data.code === "ACCESS_REVOKED") {
    return { ...state, phase: "error", answer: "", sources: [], toolSteps: [], error: { code: "ACCESS_REVOKED", message: String(event.data.message ?? "当前档位已无法读取该回答") } };
  }
  // 终态锁死 + seq 去重：迟到的重复事件整个忽略（不产生新对象，渲染也不抖动）。
  if (TERMINAL_PHASES.has(state.phase)) return state;
  if (!Number.isInteger(event.seq) || event.seq <= state.lastSeq) return state;
  const next: BusinessQueryState = { ...state, lastSeq: event.seq };
  if (state.phase === "connecting" || state.phase === "submitting" || state.phase === "disconnected") next.phase = "streaming";

  switch (event.type) {
    case "state": {
      const runState = String(event.data.state ?? "");
      if (runState === "cancelled") return { ...next, phase: "cancelled" };
      if (runState === "failed") return { ...next, phase: "error", error: { code: "RUN_FAILED", message: "本次查询未完成" } };
      return next;
    }
    case "tool_status": {
      const step: ToolStepView = {
        tool: String(event.data.tool ?? ""),
        operation: String(event.data.operation ?? ""),
        status: String(event.data.status ?? ""),
        ...(event.data.code ? { code: String(event.data.code) } : {}),
      };
      const index = next.toolSteps.findIndex((existing) => existing.tool === step.tool && existing.operation === step.operation);
      const toolSteps = index >= 0 ? next.toolSteps.map((existing, position) => (position === index ? step : existing)) : [...next.toolSteps, step];
      return { ...next, toolSteps };
    }
    case "answer_delta":
      return { ...next, answer: next.answer + String(event.data.text ?? "") };
    case "source": {
      const incoming = Array.isArray(event.data.sources) ? event.data.sources as QuerySourceView[] : [];
      const sources = [...next.sources];
      for (const source of incoming) {
        if (!sources.some((existing) => existing.business_type === source.business_type && existing.business_no === source.business_no)) sources.push(source);
      }
      return { ...next, sources };
    }
    case "completed": {
      const answer = typeof event.data.answer === "string" ? event.data.answer : next.answer;
      const sources = Array.isArray(event.data.sources) ? event.data.sources as QuerySourceView[] : next.sources;
      return { ...next, phase: "done", answer, sources };
    }
    case "cancelled":
      return { ...next, phase: "cancelled" };
    case "error":
      return { ...next, phase: "error", error: { code: String(event.data.code ?? "RUN_FAILED"), message: String(event.data.message ?? "本次查询未完成") } };
    default:
      return next;
  }
}

function reduceSnapshot(state: BusinessQueryState, snapshot: { runId: string; state: string; question: string; answer: string; sources: QuerySourceView[]; latestSeq: number; errorCode?: string | null }): BusinessQueryState {
  // 活动中的运行才可能被快照"接管"（刷新恢复）；本地已经在终态时不动，避免把 done 冲回 streaming。
  if (TERMINAL_PHASES.has(state.phase)) return state;
  const phase: BusinessQueryPhase = snapshot.state === "completed" ? "done"
    : snapshot.state === "cancelled" ? "cancelled"
    : snapshot.state === "failed" ? "error"
    : "streaming";
  return {
    ...state,
    phase,
    runId: snapshot.runId,
    question: snapshot.question,
    answer: snapshot.answer,
    sources: snapshot.sources,
    error: phase === "error" ? { code: snapshot.errorCode ?? "RUN_FAILED", message: "本次查询未完成" } : null,
    // lastSeq 取较大者：快照里已有的内容不会再被重放的增量拼一次。
    lastSeq: Math.max(state.lastSeq, snapshot.latestSeq),
  };
}

/** 页面用：活动阶段判断（能否提问/能否取消）。 */
export function isBusyPhase(phase: BusinessQueryPhase): boolean {
  return ACTIVE_PHASES.has(phase) && phase !== "idle";
}
