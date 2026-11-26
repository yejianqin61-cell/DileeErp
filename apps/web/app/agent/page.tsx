"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AgentComposer } from "../../components/agent/agent-composer";
import { AgentHistoryDialog, type AgentHistoryEntry } from "../../components/agent/agent-history-dialog";
import { AgentThread } from "../../components/agent/agent-thread";
import { AgentToolbar } from "../../components/agent/agent-toolbar";
import { ErrorState, LoadingState } from "../../components/feedback/states";
import { cacheAccessLevel, clearCachedSession, readCachedSession, writeCachedSession } from "../../lib/agent-cache";
import { openAgentCacheStore } from "../../lib/agent-cache-idb";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { initialBusinessQueryState, isBusyPhase, reduce, type QuerySourceView } from "../../lib/business-query-state";
import { followRunStream } from "../../lib/business-query-stream";
import { useSessionProfile } from "../../lib/session-context";
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

const HISTORY_LIMIT = 20;
const OFFLINE_NOTICE = "无法连接业务查询服务，当前显示本地缓存";

const isUnreachable = (cause: unknown) => !(cause instanceof ApiClientError) || cause.code === "REQUEST_ERROR";

type Notice = { message: string; action: "submit" | "reload" | null };

export default function AgentPage() {
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
  const submitLock = useRef(false);
  const busy = isBusyPhase(state.phase);
  const [syncing, setSyncing] = useState(false);
  const epoch = useRef(0);
  const profile = useSessionProfile();
  const userId = profile?.id ?? null;
  const level = cacheAccessLevel(profile?.role_keys ?? []);
  const cache = useMemo(() => {
    const store = userId ? openAgentCacheStore() : null;
    return store && userId ? { store, userId, level } : null;
  }, [userId, level]);

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
      if (abort.signal.aborted) return;
      if (cache && (cause as { refused?: boolean }).refused) void clearCachedSession(cache.store, cache.userId);
      setNotice({ message: cause instanceof Error ? cause.message : "与服务的连接中断，请刷新页面重试", action: "reload" });
    }).finally(() => {
      if (streamAbort.current === abort) streamAbort.current = null;
    });
  }, [cache]);

  const hydrateSession = useCallback(async (targetSessionId: string, accept: () => boolean) => {
    const snapshot = (await apiGet<{ session_id: string; runs: AgentSnapshotRun[] }>(`/business-query/sessions/${encodeURIComponent(targetSessionId)}`)).data;
    if (!accept()) return;
    if (cache) void writeCachedSession(cache.store, cache.userId, targetSessionId, snapshot.runs);
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
  }, [cache, followStream]);

  useEffect(() => {
    let cancelled = false;
    let answered = false;
    let shown = false;
    let offline = false;
    const ticket = ++epoch.current;
    const current = () => !cancelled && ticket === epoch.current;
    const accept = () => {
      if (!current()) return false;
      answered = true;
      return true;
    };
    if (cache) {
      setSyncing(true);
      void readCachedSession(cache.store, cache.userId, cache.level).then((cached) => {
        if (!cached || answered || !current()) return;
        shown = true;
        setSessionId(cached.session_id);
        setHistory(cached.runs.map(turnFromSnapshotRun));
        setLoading(false);
        if (offline) {
          setLoadError("");
          setNotice({ message: OFFLINE_NOTICE, action: "reload" });
        }
      });
    }
    void (async () => {
      try {
        const sessions = (await apiGet<{ sessions: AgentSessionSummary[] }>("/business-query/sessions")).data.sessions;
        if (!current()) return;
        const latest = sessions[0];
        if (!latest) {
          accept();
          if (cache) void clearCachedSession(cache.store, cache.userId);
          setSessionId(null);
          setHistory([]);
        } else {
          setSessionId(latest.session_id);
          await hydrateSession(latest.session_id, accept);
        }
        if (current()) setSyncing(false);
      } catch (cause) {
        if (!current()) return;
        if (cache && isUnreachable(cause)) {
          offline = true;
          if (shown) {
            setNotice({ message: OFFLINE_NOTICE, action: "reload" });
            return;
          }
        } else {
          answered = true;
          if (cache) void clearCachedSession(cache.store, cache.userId);
          setHistory([]);
        }
        setLoadError(cause instanceof ApiClientError ? cause.message : "无法连接业务查询服务");
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      streamAbort.current?.abort();
    };
  }, [cache, hydrateSession]);

  const revoked = state.error?.code === "ACCESS_REVOKED";
  const previousPhase = useRef(state.phase);
  useEffect(() => {
    const finished = isBusyPhase(previousPhase.current) && !isBusyPhase(state.phase) && state.phase !== "idle";
    previousPhase.current = state.phase;
    if (!cache) return;
    if (revoked) {
      void clearCachedSession(cache.store, cache.userId);
      return;
    }
    if (!finished || !sessionId) return;
    const ticket = epoch.current;
    void apiGet<{ runs: AgentSnapshotRun[] }>(`/business-query/sessions/${encodeURIComponent(sessionId)}`)
      .then(async ({ data }) => {
        if (ticket === epoch.current) await writeCachedSession(cache.store, cache.userId, sessionId, data.runs);
      })
      .catch(() => undefined);
  }, [cache, revoked, sessionId, state.phase]);

  useEffect(() => {
    if (!loading && !loadError) inputRef.current?.focus();
  }, [loading, loadError]);

  const submit = useCallback(async (questionOverride?: string) => {
    const question = (questionOverride ?? input).trim();
    if (!question || syncing || isBusyPhase(state.phase) || submitLock.current) return;
    submitLock.current = true;
    setNotice(null);
    const settled = turnFromActiveState(state);
    if (settled) setHistory((previous) => mergeTurns(previous, settled));
    dispatch({ type: "SUBMIT", question, sessionId: sessionId ?? "pending" });
    setInput("");
    setScrollSignal((value) => value + 1);
    try {
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
      setInput(question);
      dispatch({ type: "RESET" });
      const message = cause instanceof ApiClientError ? cause.message : cause instanceof Error ? cause.message : "提交失败，请稍后重试";
      setNotice({ message, action: "submit" });
    } finally {
      submitLock.current = false;
    }
  }, [followStream, input, sessionId, state, syncing]);

  const submitRef = useRef(submit);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  const cancel = useCallback(async () => {
    if (!state.runId) return;
    try {
      const result = (await apiPost<{ state: string }>(`/business-query/runs/${encodeURIComponent(state.runId)}/cancel`)).data;
      if (result.state === "cancelled") dispatch({ type: "EVENT", event: { seq: state.lastSeq + 1, type: "cancelled", data: { state: "cancelled" } } });
    } catch (cause) {
      setNotice({ message: cause instanceof ApiClientError ? cause.message : "取消失败，请稍后再试", action: null });
    }
  }, [state.lastSeq, state.runId]);

  const retryTurn = useCallback((question: string) => { void submitRef.current(question); }, []);

  const pickSuggestion = useCallback((question: string) => {
    setInput(question);
    setNotice(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const startNewConversation = useCallback(() => {
    if (isBusyPhase(state.phase)) return;
    epoch.current += 1;
    setSyncing(false);
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
    const ticket = ++epoch.current;
    const current = () => ticket === epoch.current;
    setSyncing(false);
    streamAbort.current?.abort();
    setNotice(null);
    setSessionId(targetSessionId);
    setHistory([]);
    dispatch({ type: "RESET" });
    setLoadError("");
    setLoading(true);
    try {
      await hydrateSession(targetSessionId, current);
    } catch (cause) {
      if (current()) setLoadError(cause instanceof ApiClientError ? cause.message : "无法读取该会话");
    } finally {
      if (current()) setLoading(false);
    }
  }, [hydrateSession, sessionId]);

  if (loading) return <div className="agent-loading"><LoadingState label="正在准备迪礼顾问" /></div>;
  if (loadError) return <div className="agent-loading"><ErrorState message={loadError} onRetry={() => window.location.reload()} /></div>;

  const turns = mergeTurns(history, turnFromActiveState(state));
  const retryNotice = notice?.action === "submit" ? () => { void submit(); } : notice?.action === "reload" ? () => window.location.reload() : undefined;

  return <>
    <div className="agent-workspace" data-testid="page-agent">
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
        sendDisabled={syncing}
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
