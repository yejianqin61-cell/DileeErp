"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AgentComposer } from "../../components/agent/agent-composer";
import { AgentHistoryDialog, type AgentHistoryEntry } from "../../components/agent/agent-history-dialog";
import { AgentThread } from "../../components/agent/agent-thread";
import { AgentToolbar } from "../../components/agent/agent-toolbar";
import { ErrorState, LoadingState } from "../../components/feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { initialBusinessQueryState, isBusyPhase, reduce, type QuerySourceView } from "../../lib/business-query-state";
import { followRunStream } from "../../lib/business-query-stream";
import {
  PHASE_LABELS,
  createClientMessageId,
  isTerminalRunState,
  mergeTurns,
  sessionTitleFromRuns,
  turnFromActiveState,
  turnFromSnapshotRun,
  type AgentSessionSummary,
  type AgentSnapshotRun,
  type AgentTurn,
} from "../../lib/agent-chat";

/**
 * 「迪礼顾问」—— ChatGPT 风格的 AI 工作区。
 *
 * 后端能力（apps/api/.../business-query-agent，V0 已上线）：
 *   * POST /business-query/sessions                      建会话
 *   * GET  /business-query/sessions                      列本人会话（updatedAt 倒序，无标题字段）
 *   * GET  /business-query/sessions/:id                  会话快照（刷新/切会话恢复）
 *   * POST /business-query/sessions/:id/runs             提问（202，返回 run_id；幂等键 client_message_id）
 *   * GET  /business-query/runs/:id/events               SSE：state/tool_status/answer_delta/source/completed/cancelled/error
 *   * POST /business-query/runs/:id/cancel               取消（真实可用）
 * 所以这里**不假装**任何能力：流式、取消、断线续接、刷新恢复、历史会话切换都接的是真接口；
 * 后端没有的（会话重命名/删除、导出、单据深链接）界面上就不出现。
 */

/** 历史弹窗最多回读多少个会话的快照：会话列表接口不带标题，标题要靠逐会话快照的首个问题生成。 */
const HISTORY_LIMIT = 20;

type Notice = { message: string; action: "submit" | "reload" | null };

export default function BusinessQueryPage() {
  // 活动 run 仍复用既有 reducer（seq 去重、断线续接、快照不重复拼接都有单测覆盖），
  // 已结束的历史轮由 history 持有。
  const [state, dispatch] = useReducer(reduce, initialBusinessQueryState);
  const [history, setHistory] = useState<AgentTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<AgentHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const streamAbort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 防连点：Enter 连按两次时，第一次的 dispatch 还没渲染出来，两次都会进 submit。
  // 不加锁会 POST 两个 run（后端 409），用户看到一条莫名其妙的报错。
  const submitLock = useRef(false);
  const busy = isBusyPhase(state.phase);

  /** 订阅某个 run 的 SSE：断线由 followRunStream 内部续接，终态事件到达即结束。 */
  const followStream = useCallback((runId: string, lastSeq: number) => {
    streamAbort.current?.abort();
    const abort = new AbortController();
    streamAbort.current = abort;
    void followRunStream({
      runId,
      lastSeq,
      signal: abort.signal,
      onOpen: () => dispatch({ type: "CONNECTED" }),
      onEvent: (event) => dispatch({ type: "EVENT", event }),
      onRetry: () => dispatch({ type: "DISCONNECTED" }),
    }).catch((cause) => {
      // 主动 abort（切会话/新建对话）不算失败，不弹错误。
      if (abort.signal.aborted) return;
      setNotice({ message: cause instanceof Error ? cause.message : "与服务的连接中断，请刷新页面重试", action: "reload" });
    }).finally(() => {
      if (streamAbort.current === abort) streamAbort.current = null;
    });
  }, []);

  /** 读一个会话的快照：历史轮进 history，最后一轮作为活动 run（活动中的继续续接 SSE）。 */
  const hydrateSession = useCallback(async (targetSessionId: string) => {
    const snapshot = (await apiGet<{ session_id: string; runs: AgentSnapshotRun[] }>(`/business-query/sessions/${encodeURIComponent(targetSessionId)}`)).data;
    const lastRun = snapshot.runs.at(-1);
    setHistory(snapshot.runs.slice(0, -1).map(turnFromSnapshotRun));
    if (!lastRun) {
      dispatch({ type: "RESET" });
      return;
    }
    dispatch({
      type: "SNAPSHOT_RESTORED",
      snapshot: {
        runId: lastRun.run_id,
        state: lastRun.state,
        question: lastRun.question,
        answer: lastRun.answer,
        sources: lastRun.sources as QuerySourceView[],
        latestSeq: lastRun.latest_seq,
        errorCode: lastRun.error_code,
      },
    });
    if (!isTerminalRunState(lastRun.state)) followStream(lastRun.run_id, lastRun.latest_seq);
  }, [followStream]);

  // 挂载：取本人最近一个会话并恢复；没有会话就等第一条提问再创建（不预先造空会话）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sessions = (await apiGet<{ sessions: AgentSessionSummary[] }>("/business-query/sessions")).data.sessions;
        if (cancelled) return;
        const latest = sessions[0];
        if (!latest) return;
        setSessionId(latest.session_id);
        await hydrateSession(latest.session_id);
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof ApiClientError ? cause.message : "无法连接业务查询服务");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      streamAbort.current?.abort();
    };
  }, [hydrateSession]);

  // 载入完成把焦点放进输入框：对话页打开就能直接打字，不用先点一下。
  useEffect(() => {
    if (!loading && !loadError) inputRef.current?.focus();
  }, [loading, loadError]);

  const submit = useCallback(async (questionOverride?: string) => {
    const question = (questionOverride ?? input).trim();
    if (!question || isBusyPhase(state.phase) || submitLock.current) return;
    submitLock.current = true;
    setNotice(null);
    // 上一轮已结束（完成/失败/取消）：先固化进历史，新 run 的渲染不会把它顶掉。
    const settled = turnFromActiveState(state);
    if (settled) setHistory((previous) => mergeTurns(previous, settled));
    dispatch({ type: "SUBMIT", question, sessionId: sessionId ?? "pending" });
    setInput("");
    setScrollSignal((value) => value + 1);
    try {
      // 会话按需创建：只有真的提问才 POST /sessions。
      let activeSessionId = sessionId;
      if (!activeSessionId) {
        activeSessionId = (await apiPost<{ session_id: string }>("/business-query/sessions")).data.session_id;
        setSessionId(activeSessionId);
      }
      const created = (await apiPost<{ run_id: string; state: string }>(`/business-query/sessions/${encodeURIComponent(activeSessionId)}/runs`, {
        question,
        client_message_id: createClientMessageId(),
      })).data;
      dispatch({ type: "RUN_CREATED", runId: created.run_id });
      followStream(created.run_id, 0);
    } catch (cause) {
      // 草稿不丢：429 忙碌、409 已有进行中的查询、网络失败，用户改完可直接回车重试。
      setInput(question);
      dispatch({ type: "RESET" });
      const message = cause instanceof ApiClientError ? cause.message : cause instanceof Error ? cause.message : "提交失败，请稍后重试";
      setNotice({ message, action: "submit" });
    } finally {
      submitLock.current = false;
    }
  }, [followStream, input, sessionId, state]);

  // 让「重试」按钮的回调引用保持稳定：否则每条历史消息的 memo 都会因为 onRetry 变了而重渲染，
  // 流式期间等于每个增量都重解析一遍全部历史 Markdown。
  const submitRef = useRef(submit);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  const cancel = useCallback(async () => {
    if (!state.runId) return;
    try {
      const result = (await apiPost<{ state: string }>(`/business-query/runs/${encodeURIComponent(state.runId)}/cancel`)).data;
      // cancelled 终态事件会经 SSE 到达；流已断时这里落一次本地状态兜底，避免一直显示「停止中」。
      if (result.state === "cancelled") dispatch({ type: "EVENT", event: { seq: state.lastSeq + 1, type: "cancelled", data: { state: "cancelled" } } });
    } catch (cause) {
      setNotice({ message: cause instanceof ApiClientError ? cause.message : "取消失败，请稍后再试", action: null });
    }
  }, [state.lastSeq, state.runId]);

  const retryTurn = useCallback((question: string) => { void submitRef.current(question); }, []);

  const pickSuggestion = useCallback((question: string) => {
    setInput(question);
    setNotice(null);
    // 只填入不发送：用户可以先把单号/月份改成自己想问的。
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const startNewConversation = useCallback(() => {
    if (isBusyPhase(state.phase)) return;
    streamAbort.current?.abort();
    setNotice(null);
    setInput("");
    setHistory([]);
    setSessionId(null);
    dispatch({ type: "RESET" });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [state.phase]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const sessions = (await apiGet<{ sessions: AgentSessionSummary[] }>("/business-query/sessions")).data.sessions;
      const limited = sessions.slice(0, HISTORY_LIMIT);
      setHistoryTruncated(sessions.length > limited.length);
      const entries = await Promise.all(limited.map(async (session): Promise<AgentHistoryEntry> => {
        try {
          const snapshot = (await apiGet<{ runs: AgentSnapshotRun[] }>(`/business-query/sessions/${encodeURIComponent(session.session_id)}`)).data;
          return { ...session, title: sessionTitleFromRuns(snapshot.runs), runCount: snapshot.runs.length };
        } catch {
          // 单个会话读不到（例如降权后的旧 full 会话）不拖垮整个列表。
          return { ...session, title: "（会话内容无法读取）", runCount: 0 };
        }
      }));
      setHistoryEntries(entries);
    } catch (cause) {
      setHistoryError(cause instanceof ApiClientError ? cause.message : "无法读取历史会话");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const switchSession = useCallback(async (targetSessionId: string) => {
    setHistoryOpen(false);
    if (targetSessionId === sessionId) return;
    streamAbort.current?.abort();
    setNotice(null);
    setSessionId(targetSessionId);
    setHistory([]);
    dispatch({ type: "RESET" });
    setLoadError("");
    setLoading(true);
    try {
      await hydrateSession(targetSessionId);
    } catch (cause) {
      setLoadError(cause instanceof ApiClientError ? cause.message : "无法读取该会话");
    } finally {
      setLoading(false);
    }
  }, [hydrateSession, sessionId]);

  if (loading) return <div className="agent-loading"><LoadingState label="正在准备迪礼顾问" /></div>;
  if (loadError) return <div className="agent-loading"><ErrorState message={loadError} onRetry={() => window.location.reload()} /></div>;

  const turns = mergeTurns(history, turnFromActiveState(state));
  const retryNotice = notice?.action === "submit" ? () => { void submit(); } : notice?.action === "reload" ? () => window.location.reload() : undefined;

  return <>
    <div className="agent-workspace" data-testid="page-business-query">
      <AgentToolbar
        busy={busy}
        onNewConversation={startNewConversation}
        onOpenHistory={() => { setHistoryOpen(true); void loadHistory(); }}
      />
      <AgentThread turns={turns} onPickSuggestion={pickSuggestion} onRetryTurn={retryTurn} scrollSignal={scrollSignal} />
      <AgentComposer
        value={input}
        onChange={setInput}
        onSubmit={() => { void submit(); }}
        onStop={() => { void cancel(); }}
        busy={busy}
        canStop={Boolean(state.runId)}
        phaseLabel={PHASE_LABELS[state.phase]}
        notice={notice?.message ?? null}
        onRetryNotice={retryNotice}
        onDismissNotice={() => setNotice(null)}
        inputRef={inputRef}
      />
    </div>
    <AgentHistoryDialog
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      entries={historyEntries}
      loading={historyLoading}
      error={historyError}
      currentSessionId={sessionId}
      truncated={historyTruncated}
      onSelect={(targetSessionId) => { void switchSession(targetSessionId); }}
      onReload={() => { void loadHistory(); }}
    />
  </>;
}
