"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AgentComposer } from "../../components/agent/agent-composer";
import { AgentHistoryDialog, type AgentHistoryEntry } from "../../components/agent/agent-history-dialog";
import { AgentThread } from "../../components/agent/agent-thread";
import { AgentToolbar } from "../../components/agent/agent-toolbar";
import { ErrorState, LoadingState } from "../../components/feedback/states";
import { EMPTY_BRANCHES, addBranch, ancestryOf, isBranchState, parentOf, revealing, selectVersion, versionsOf, visiblePath, type BranchState } from "../../features/agent-chat/chat/branches";
import { browserSessionStore, loadDraft, saveDraft } from "../../features/agent-chat/chat/drafts";
import { translatorFor } from "../../features/agent-chat/i18n";
import { AgentSettingsContext, useAgentSettingsState } from "../../features/agent-chat/settings/settings";
import themeStyles from "../../features/agent-chat/settings/theme.module.css";
import { cacheAccessLevel, clearCachedSession, readCachedSession, writeCachedSession } from "../../lib/agent-cache";
import { openAgentCacheStore } from "../../lib/agent-cache-idb";
import { ApiClientError, apiDelete, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { initialBusinessQueryState, isBusyPhase, reduce, type QuerySourceView } from "../../lib/business-query-state";
import { followRunStream } from "../../lib/business-query-stream";
import { useSessionProfile } from "../../lib/session-context";
import {
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
const PHASE_KEYS = { submitting: "phaseSubmitting", connecting: "phaseConnecting", streaming: "phaseStreaming", disconnected: "phaseDisconnected", done: "phaseDone", error: "phaseError", cancelled: "phaseCancelled" } as const;

const isUnreachable = (cause: unknown) => !(cause instanceof ApiClientError) || cause.code === "REQUEST_ERROR";

type Notice = { message: string; action: "submit" | "reload" | null; resend?: Resend };

type Resend = { question: string; parent: string | null };

export default function AgentPage() {
  const [state, dispatch] = useReducer(reduce, initialBusinessQueryState);
  const appearance = useAgentSettingsState();
  const t = useMemo(() => translatorFor(appearance.settings.locale), [appearance.settings.locale]);
  const translate = useRef(t);
  translate.current = t;
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
  const [historyActionError, setHistoryActionError] = useState("");
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
  const drafts = useMemo(() => (cache ? { ...cache, session: browserSessionStore() } : null), [cache]);
  const typed = useRef(0);

  const keepDraft = useCallback((target: string | null, text: string) => {
    if (drafts) void saveDraft(drafts, target, text);
  }, [drafts]);

  const showDraft = useCallback((target: string | null, since = typed.current) => {
    if (typed.current !== since) return;
    setInput("");
    if (drafts) void loadDraft(drafts, target).then((text) => { if (typed.current === since) setInput(text); });
  }, [drafts]);

  const edit = useCallback((text: string) => {
    typed.current += 1;
    setInput(text);
    keepDraft(sessionId, text);
  }, [keepDraft, sessionId]);

  const [branchMap, setBranchMap] = useState<Record<string, BranchState>>({});
  const [pendingParent, setPendingParent] = useState<string | null>(null);
  const branches = (sessionId ? branchMap[sessionId] : undefined) ?? EMPTY_BRANCHES;

  const keepBranches = useCallback((target: string, next: BranchState) => {
    setBranchMap((map) => ({ ...map, [target]: next }));
    if (cache) void cache.store.set(`branches:${cache.userId}:${target}`, next).catch(() => undefined);
  }, [cache]);

  useEffect(() => {
    if (!cache || !sessionId) return;
    void cache.store.get(`branches:${cache.userId}:${sessionId}`)
      .then((stored) => {
        if (isBranchState(stored)) setBranchMap((map) => (map[sessionId] ? map : { ...map, [sessionId]: stored }));
      })
      .catch(() => undefined);
  }, [cache, sessionId]);

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
      setNotice({ message: cause instanceof Error ? cause.message : translate.current("streamLost"), action: "reload" });
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
    const since = typed.current;
    let drafted: string | null | undefined;
    const draftFor = (target: string | null) => {
      if (drafted === target) return;
      drafted = target;
      showDraft(target, since);
    };
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
        draftFor(cached.session_id);
        setLoading(false);
        if (offline) {
          setLoadError("");
          setNotice({ message: translate.current("offlineNotice"), action: "reload" });
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
          draftFor(null);
        } else {
          setSessionId(latest.session_id);
          draftFor(latest.session_id);
          await hydrateSession(latest.session_id, accept);
        }
        if (current()) setSyncing(false);
      } catch (cause) {
        if (!current()) return;
        if (cache && isUnreachable(cause)) {
          offline = true;
          if (shown) {
            setNotice({ message: translate.current("offlineNotice"), action: "reload" });
            return;
          }
        } else {
          answered = true;
          if (cache) void clearCachedSession(cache.store, cache.userId);
          setHistory([]);
        }
        setLoadError(cause instanceof ApiClientError ? cause.message : translate.current("unreachable"));
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      streamAbort.current?.abort();
    };
  }, [cache, hydrateSession, showDraft]);

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

  const submit = useCallback(async (questionOverride?: string, resend?: Resend) => {
    const question = (resend?.question ?? questionOverride ?? input).trim();
    const fromInput = resend === undefined && questionOverride === undefined;
    if (!question || syncing || isBusyPhase(state.phase) || submitLock.current) return;
    submitLock.current = true;
    setNotice(null);
    const settled = turnFromActiveState(state);
    if (settled) setHistory((previous) => mergeTurns(previous, settled));
    const ids = mergeTurns(history, settled).map((turn) => turn.runId);
    const parent = resend ? resend.parent : visiblePath(ids, branches).at(-1) ?? null;
    const context = ancestryOf(ids, branches, parent);
    setPendingParent(parent);
    dispatch({ type: "SUBMIT", question, sessionId: sessionId ?? "pending" });
    if (fromInput) setInput("");
    setScrollSignal((value) => value + 1);
    let activeSessionId = sessionId;
    try {
      if (!activeSessionId) {
        activeSessionId = (await apiPost<{ session_id: string }>("/business-query/sessions")).data.session_id;
        setSessionId(activeSessionId);
      }
      const created = (await apiPost<{ run_id: string; state: string }>(`/business-query/sessions/${encodeURIComponent(activeSessionId)}/runs`, {
        question,
        client_message_id: createClientMessageId(),
        context_run_ids: context,
      })).data;
      keepBranches(activeSessionId, addBranch(branches, created.run_id, parent));
      dispatch({ type: "RUN_CREATED", runId: created.run_id });
      if (fromInput) keepDraft(sessionId, "");
      followStream(created.run_id, 0);
    } catch (cause) {
      if (!resend) {
        setInput(question);
        if (activeSessionId !== sessionId) keepDraft(sessionId, "");
        keepDraft(activeSessionId, question);
      }
      dispatch({ type: "RESET" });
      const message = cause instanceof ApiClientError ? cause.message : cause instanceof Error ? cause.message : translate.current("submitFailed");
      setNotice({ message, action: "submit", resend });
    } finally {
      submitLock.current = false;
    }
  }, [branches, followStream, history, input, keepBranches, keepDraft, sessionId, state, syncing]);

  const submitRef = useRef(submit);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  const cancel = useCallback(async () => {
    if (!state.runId) return;
    try {
      const result = (await apiPost<{ state: string }>(`/business-query/runs/${encodeURIComponent(state.runId)}/cancel`)).data;
      if (result.state === "cancelled") dispatch({ type: "EVENT", event: { seq: state.lastSeq + 1, type: "cancelled", data: { state: "cancelled" } } });
    } catch (cause) {
      setNotice({ message: cause instanceof ApiClientError ? cause.message : translate.current("cancelFailed"), action: null });
    }
  }, [state.lastSeq, state.runId]);

  const retryTurn = useCallback((question: string) => { void submitRef.current(question); }, []);

  const pickSuggestion = useCallback((question: string) => {
    edit(question);
    setNotice(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [edit]);

  const startNewConversation = useCallback(() => {
    if (isBusyPhase(state.phase)) return;
    epoch.current += 1;
    setSyncing(false);
    streamAbort.current?.abort();
    setNotice(null);
    setHistory([]);
    setSessionId(null);
    showDraft(null);
    dispatch({ type: "RESET" });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [showDraft, state.phase]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    setHistoryActionError("");
    try {
      const sessions = (await apiGet<{ sessions: AgentSessionSummary[] }>("/business-query/sessions")).data.sessions;
      const limited = sessions.slice(0, HISTORY_LIMIT);
      setHistoryTruncated(sessions.length > limited.length);
      const entries = await Promise.all(limited.map(async (session): Promise<AgentHistoryEntry> => {
        try {
          const snapshot = (await apiGet<{ runs: AgentSnapshotRun[] }>(`/business-query/sessions/${encodeURIComponent(session.session_id)}`)).data;
          const derived = snapshot.runs.some((run) => run.question.trim()) ? sessionTitleFromRuns(snapshot.runs) : translate.current("emptySession");
          return { ...session, title: session.title ?? derived, runCount: snapshot.runs.length };
        } catch {
          return { ...session, title: session.title ?? translate.current("unreadableSession"), runCount: 0 };
        }
      }));
      setHistoryEntries(entries);
    } catch (cause) {
      setHistoryError(cause instanceof ApiClientError ? cause.message : translate.current("historyFailed"));
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
    showDraft(targetSessionId);
    dispatch({ type: "RESET" });
    setLoadError("");
    setLoading(true);
    try {
      await hydrateSession(targetSessionId, current);
    } catch (cause) {
      if (current()) setLoadError(cause instanceof ApiClientError ? cause.message : translate.current("sessionFailed"));
    } finally {
      if (current()) setLoading(false);
    }
  }, [hydrateSession, sessionId, showDraft]);

  const renameSession = useCallback(async (targetSessionId: string, title: string) => {
    setHistoryActionError("");
    try {
      const result = (await apiPatch<{ title: string }>(`/business-query/sessions/${encodeURIComponent(targetSessionId)}`, { title })).data;
      setHistoryEntries((entries) => entries.map((entry) => (entry.session_id === targetSessionId ? { ...entry, title: result.title } : entry)));
    } catch (cause) {
      setHistoryActionError(cause instanceof ApiClientError ? cause.message : translate.current("renameFailed"));
    }
  }, []);

  const deleteSession = useCallback(async (targetSessionId: string) => {
    setHistoryActionError("");
    try {
      await apiDelete(`/business-query/sessions/${encodeURIComponent(targetSessionId)}`);
      setHistoryEntries((entries) => entries.filter((entry) => entry.session_id !== targetSessionId));
      keepDraft(targetSessionId, "");
      if (targetSessionId !== sessionId) return;
      startNewConversation();
      if (cache) void clearCachedSession(cache.store, cache.userId);
    } catch (cause) {
      setHistoryActionError(cause instanceof ApiClientError ? cause.message : translate.current("removeFailed"));
    }
  }, [cache, keepDraft, sessionId, startNewConversation]);

  const themed = { "data-agent-theme": appearance.theme };

  if (loading) return <div className={`agent-loading ${themeStyles.root}`} {...themed}><LoadingState label={t("preparing")} /></div>;
  if (loadError) return <div className={`agent-loading ${themeStyles.root}`} {...themed}><ErrorState message={loadError} onRetry={() => window.location.reload()} /></div>;

  const allTurns = mergeTurns(history, turnFromActiveState(state));
  const ids = allTurns.map((turn) => turn.runId);
  const tracked = ids.includes("pending") ? addBranch(branches, "pending", pendingParent) : branches;
  const shownBranches = busy && state.runId ? revealing(ids, tracked, state.runId) : tracked;
  const byId = new Map(allTurns.map((turn) => [turn.runId, turn]));
  const turns = visiblePath(ids, shownBranches).flatMap((id) => byId.get(id) ?? []);
  const versions = new Map(turns.map((turn) => [turn.runId, versionsOf(ids, shownBranches, turn.runId)]));
  const editTurn = (runId: string, question: string) => { void submit(undefined, { question, parent: parentOf(ids, branches, runId) }); };
  const chooseVersion = (runId: string) => { if (sessionId) keepBranches(sessionId, selectVersion(ids, branches, runId)); };
  const retryNotice = notice?.action === "submit" ? () => { void submit(undefined, notice.resend); } : notice?.action === "reload" ? () => window.location.reload() : undefined;

  return <AgentSettingsContext.Provider value={appearance}>
    <div className={`agent-workspace ${themeStyles.root}`} data-testid="page-agent" {...themed}>
      <AgentToolbar
        busy={busy}
        onNewConversation={startNewConversation}
        onOpenHistory={() => { setHistoryOpen(true); void loadHistory(); }}
      />
      <AgentThread turns={turns} versions={versions} locked={busy || syncing} onEditTurn={editTurn} onSelectVersion={chooseVersion} onPickSuggestion={pickSuggestion} onRetryTurn={retryTurn} scrollSignal={scrollSignal} />
      <AgentComposer
        value={input}
        onChange={edit}
        onSubmit={() => { void submit(); }}
        onStop={() => { void cancel(); }}
        busy={busy}
        canStop={Boolean(state.runId)}
        sendDisabled={syncing}
        phaseLabel={state.phase === "idle" ? "" : t(PHASE_KEYS[state.phase])}
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
      actionError={historyActionError}
      currentSessionId={sessionId}
      truncated={historyTruncated}
      onSelect={(targetSessionId) => { void switchSession(targetSessionId); }}
      onReload={() => { void loadHistory(); }}
      onRename={(targetSessionId, title) => { void renameSession(targetSessionId, title); }}
      onDelete={(targetSessionId) => { void deleteSession(targetSessionId); }}
    />
  </AgentSettingsContext.Provider>;
}
