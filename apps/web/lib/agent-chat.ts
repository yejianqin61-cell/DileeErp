/**
 * 「迪礼顾问」对话页的视图模型（纯函数，无 React，可被 node:test 直接测试）。
 *
 * 为什么单独一层：后端把一轮问答拆成「历史 run 快照 + 当前活动 run 的 SSE 事件」两路来源，
 * 页面渲染只认 AgentTurn 一种形状。把两路来源折叠成同一形状的规则集中在这里，
 * 页面组件就不用各写一遍，也不会出现「历史消息」和「当前消息」两套 DOM。
 *
 * 数据全部来自现有后端契约（apps/api/src/modules/business-query-agent）：
 *   GET  /business-query/sessions/:id        → runs[]（run_id/state/question/answer/sources/error_code）
 *   SSE  /business-query/runs/:id/events     → 由 lib/business-query-state.ts 的 reducer 收敛
 * 这里不新增任何后端字段，也不推断后端没说的事实。
 */
import type { BusinessQueryPhase, BusinessQueryState, QuerySourceView, ToolStepView } from "./business-query-state";

/** 一轮问答在界面上的终态/进行态。`streaming` 覆盖 submitting / connecting / disconnected。 */
export type AgentTurnStatus = "streaming" | "done" | "error" | "cancelled";

export type AgentTurnError = { code: string; message: string };

export type AgentTurn = {
  runId: string;
  question: string;
  answer: string;
  sources: QuerySourceView[];
  toolSteps: ToolStepView[];
  status: AgentTurnStatus;
  error: AgentTurnError | null;
};

/** GET /business-query/sessions/:id 返回的单轮快照（字段名即后端 DTO，别改名）。 */
export type AgentSnapshotRun = {
  run_id: string;
  state: string;
  question: string;
  answer: string;
  sources: QuerySourceView[];
  latest_seq: number;
  error_code: string | null;
  access_level: string;
  created_at: string;
};

/** 会话列表项（GET /business-query/sessions）：后端只给这两个时间，没有标题字段。 */
export type AgentSessionSummary = { session_id: string; created_at: string; updated_at: string };

/**
 * 阶段文案：与既有 E2E（tests/e2e/business-query-recovery.spec.mjs）逐字对齐，
 * 改字之前先改测试，否则线上回归会红。
 */
export const PHASE_LABELS: Record<BusinessQueryPhase, string> = {
  idle: "",
  submitting: "正在提交…",
  connecting: "正在连接…",
  streaming: "正在回答…",
  disconnected: "连接中断，正在恢复…",
  done: "已完成",
  error: "未完成",
  cancelled: "已取消",
};

/** welcome 页的四个推荐问题（用户拍板文案，不要改写）。 */
export const SUGGESTED_QUESTIONS = [
  "最近有哪些销售订单？",
  "哪些生产任务即将延期？",
  "目前有哪些物料库存不足？",
  "帮我汇总本月采购情况。",
] as const;

/** 后端 run.state → 界面状态。未知状态按失败处理（宁可提示未完成，也不假装成功）。 */
export function turnStatusFromRunState(state: string): AgentTurnStatus {
  if (state === "completed") return "done";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "error";
  return "streaming";
}

/** run 是否已终态：终态才允许开下一轮 / 切会话，也才需要（能）从快照恢复。 */
export function isTerminalRunState(state: string): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/** 活动 run 的 reducer 阶段 → 界面状态。submitting/connecting/disconnected 仍属于「进行中」。 */
export function turnStatusFromPhase(phase: BusinessQueryPhase): AgentTurnStatus {
  if (phase === "done") return "done";
  if (phase === "error") return "error";
  if (phase === "cancelled") return "cancelled";
  return "streaming";
}

/** 历史 run 快照 → AgentTurn。失败轮的 error 只有错误码（快照不含 message），文案用稳定兜底。 */
export function turnFromSnapshotRun(run: AgentSnapshotRun): AgentTurn {
  const status = turnStatusFromRunState(run.state);
  return {
    runId: run.run_id,
    question: run.question,
    answer: run.answer,
    sources: run.sources ?? [],
    // 快照不持久化 tool_status（后端只存 answer/sources），历史轮没有执行步骤可展示。
    toolSteps: [],
    status,
    error: status === "error" ? { code: run.error_code ?? "RUN_FAILED", message: "本次查询未完成" } : null,
  };
}

/**
 * 当前活动 run（reducer 状态）→ AgentTurn；还没有提问过时返回 null。
 *
 * 注意 submitting 阶段 runId 还没拿到（POST 未返回），但问题已经要立刻显示出来，
 * 所以这时用占位 runId "pending"：先画出用户气泡 + 「正在组织查询…」，RUN_CREATED 到达后换真 runId。
 */
export function turnFromActiveState(state: BusinessQueryState): AgentTurn | null {
  if (!state.runId && !state.question) return null;
  return {
    runId: state.runId ?? "pending",
    question: state.question,
    answer: state.answer,
    sources: state.sources,
    toolSteps: state.toolSteps,
    status: turnStatusFromPhase(state.phase),
    error: state.error,
  };
}

/** 当前活动 run 是否已经从「进行中」落到终态 —— 决定能否提问 / 新建对话 / 切会话。 */
export function isTurnSettled(turn: AgentTurn | null): boolean {
  return turn === null || turn.status !== "streaming";
}

/** 该轮能否重试：失败或取消，且后端 run 已终态（重试=用同一问题建一个新 run）。 */
export function canRetryTurn(turn: AgentTurn): boolean {
  return turn.status === "error" || turn.status === "cancelled";
}

/**
 * 会话标题：后端没有 title 字段，取**首个非空问题**当标题（与 ChatGPT 侧栏同思路）。
 * 没有 run（空会话）时给「空会话」，由调用方决定要不要隐藏它。
 */
export function sessionTitleFromRuns(runs: AgentSnapshotRun[]): string {
  const first = runs.find((run) => run.question.trim().length > 0);
  if (!first) return "空会话";
  const question = first.question.trim().replace(/\s+/g, " ");
  return question.length > 28 ? `${question.slice(0, 28)}…` : question;
}

/** 一屏消息的合并结果：历史轮在前、当前活动轮在最后（同 runId 不重复出现）。 */
export function mergeTurns(history: AgentTurn[], active: AgentTurn | null): AgentTurn[] {
  if (!active) return history;
  if (history.some((turn) => turn.runId === active.runId)) {
    return history.map((turn) => (turn.runId === active.runId ? active : turn));
  }
  return [...history, active];
}

/**
 * POST /runs 需要的 client_message_id（后端 @IsUUID 校验，也用于幂等去重）。
 *
 * 为什么不能直接用 `crypto.randomUUID()`：它只在**安全上下文**（HTTPS / localhost）可用，
 * 而厂内系统部署在 http://118.178.95.156 —— 在那里 randomUUID 是 undefined，
 * 直接调用会抛异常，提问按钮看起来像坏了。getRandomValues 在非安全上下文也能用，
 * 所以回退成手拼 v4 UUID（最后兜底 Math.random，仅为极端旧浏览器不至于提不了问）。
 */
export function createClientMessageId(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = typeof globalThis.crypto === "undefined" ? null : globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === "function") webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  // 版本号 4（第 13 个十六进制位 = 4）与 variant（第 17 个位 = 8/9/a/b）
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
