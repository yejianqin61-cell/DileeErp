"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Loader2, RotateCcw, SendHorizonal, Square } from "lucide-react";
import { PageHeader } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { ErrorState, LoadingState } from "../../components/feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { initialBusinessQueryState, isBusyPhase, reduce, type QuerySourceView } from "../../lib/business-query-state";
import { followRunStream } from "../../lib/business-query-stream";

/**
 * 业务查询页（V0 阶段 1）：提问 → SSE 流式回答 → 来源与工具进度。
 * 刷新恢复：先读会话快照重建内容，再按最后已应用的 seq 续接（reducer 的 SNAPSHOT_RESTORED）。
 */

type SnapshotRun = { run_id: string; state: string; question: string; answer: string; sources: QuerySourceView[]; latest_seq: number; error_code: string | null; access_level: string; created_at: string };

const PHASE_LABELS: Record<string, string> = {
  idle: "", submitting: "正在提交…", connecting: "正在连接…", streaming: "正在回答…", disconnected: "连接中断，正在恢复…",
  done: "已完成", error: "未完成", cancelled: "已取消",
};

export default function BusinessQueryPage() {
  const [state, dispatch] = useReducer(reduce, initialBusinessQueryState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [pastRuns, setPastRuns] = useState<SnapshotRun[]>([]);
  const streamAbort = useRef<AbortController | null>(null);

  // 挂载即恢复：取（或建）本人的会话，读快照回填最近一轮。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sessions = (await apiGet<{ sessions: { session_id: string }[] }>("/business-query/sessions")).data.sessions;
        const existingId = sessions[0]?.session_id;
        const id = existingId ?? (await apiPost<{ session_id: string }>("/business-query/sessions")).data.session_id;
        const snapshot = (await apiGet<{ session_id: string; runs: SnapshotRun[] }>(`/business-query/sessions/${id}`)).data;
        if (cancelled) return;
        setSessionId(id);
        setPastRuns(snapshot.runs);
        const latest = snapshot.runs.at(-1);
        if (latest) {
          dispatch({ type: "SNAPSHOT_RESTORED", snapshot: { runId: latest.run_id, state: latest.state, question: latest.question, answer: latest.answer, sources: latest.sources, latestSeq: latest.latest_seq, errorCode: latest.error_code } });
        }
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof ApiClientError ? cause.message : "无法连接业务查询服务");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; streamAbort.current?.abort(); };
  }, []);

  const submit = useCallback(async () => {
    const question = input.trim();
    if (!question || !sessionId || isBusyPhase(state.phase)) return;
    setNotice("");
    dispatch({ type: "SUBMIT", question, sessionId });
    setInput("");
    const clientMessageId = crypto.randomUUID();
    try {
      const created = (await apiPost<{ run_id: string; state: string }>(`/business-query/sessions/${sessionId}/runs`, { question, client_message_id: clientMessageId })).data;
      dispatch({ type: "RUN_CREATED", runId: created.run_id });
      const abort = new AbortController();
      streamAbort.current = abort;
      await followRunStream({
        runId: created.run_id,
        lastSeq: 0,
        signal: abort.signal,
        onOpen: () => dispatch({ type: "CONNECTED" }),
        onEvent: (event) => dispatch({ type: "EVENT", event }),
        onRetry: () => dispatch({ type: "DISCONNECTED" }),
      });
    } catch (cause) {
      // 提问草稿不丢：429 忙碌、409 已有进行中的查询等情况，用户改完可直接重试（模块设计）。
      setInput(question);
      dispatch({ type: "RESET" });
      setNotice(cause instanceof ApiClientError ? cause.message : cause instanceof Error ? cause.message : "提交失败，请稍后重试");
    } finally {
      streamAbort.current = null;
    }
  }, [input, sessionId, state.phase]);

  const cancel = useCallback(async () => {
    if (!state.runId) return;
    try {
      const result = (await apiPost<{ state: string }>(`/business-query/runs/${state.runId}/cancel`)).data;
      // cancelled 终态事件会经 SSE 到达；若流已断，这里直接落一次本地状态兜底。
      if (result.state === "cancelled") dispatch({ type: "EVENT", event: { seq: state.lastSeq + 1, type: "cancelled", data: { state: "cancelled" } } });
    } catch (cause) {
      setNotice(cause instanceof ApiClientError ? cause.message : "取消失败");
    }
  }, [state.runId, state.lastSeq]);

  if (loading) return <div className="p-6"><LoadingState /></div>;
  if (loadError) return <div className="p-6"><ErrorState message={loadError} onRetry={() => window.location.reload()} /></div>;

  const busy = isBusyPhase(state.phase);
  return <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6" data-testid="page-business-query">
    <PageHeader title="业务查询" description="用一句话问订单、采购、生产与库存进展；财务类事实按角色档位开放，回答都带单据来源。" />
    {notice && <div className="ui-error text-sm" role="alert">{notice}</div>}

    <section className="rounded-lg border bg-card p-4">
      <Textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }}
        placeholder="例如：SO-2026 有哪些订单？现在到哪一步了？"
        rows={3}
        disabled={loading || busy}
        aria-label="业务问题"
      />
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={() => void submit()} disabled={busy || !input.trim()} data-testid="business-query-submit">
          <SendHorizonal size={15} className="mr-1" />提问
        </Button>
        {busy && <Button variant="secondary" onClick={() => void cancel()} data-testid="business-query-cancel"><Square size={14} className="mr-1" />取消</Button>}
        {state.phase !== "idle" && <span className="text-sm text-muted-foreground" data-testid="business-query-phase">{busy && <Loader2 size={13} className="mr-1 inline animate-spin" />}{PHASE_LABELS[state.phase]}</span>}
      </div>
    </section>

    {state.toolSteps.length > 0 && <section aria-label="查询进度" className="flex flex-col gap-1 text-sm text-muted-foreground">
      {state.toolSteps.map((step, index) => <div key={`${step.tool}-${step.operation}-${index}`} data-testid="business-query-tool-step">
        {step.status === "running" && `正在查询：${step.operation}…`}
        {step.status === "completed" && `已完成查询：${step.operation}`}
        {step.status === "failed" && `查询失败：${step.operation}${step.code ? `（${step.code}）` : ""}`}
      </div>)}
    </section>}

    {(state.answer || busy) && <section className="rounded-lg border bg-card p-4" aria-label="回答">
      {state.answer ? <p className="whitespace-pre-wrap text-sm leading-6" data-testid="business-query-answer">{state.answer}{busy && <span className="animate-pulse">▍</span>}</p> : <p className="text-sm text-muted-foreground">正在组织查询…</p>}
      {state.sources.length > 0 && <footer className="mt-3 border-t pt-2 text-xs text-muted-foreground" data-testid="business-query-sources">
        来源：{state.sources.map((source, index) => <span key={`${source.business_type}-${source.business_no}-${index}`} className="mr-2">{sourceLabel(source)}</span>)}
      </footer>}
      {state.phase === "error" && <p className="mt-2 text-sm text-destructive" data-testid="business-query-error">以上内容不完整：{state.error?.message ?? "本次查询未完成"}{state.error?.code ? `（${state.error.code}）` : ""}</p>}
    </section>}

    {pastRuns.length > 0 && <section aria-label="本次会话的历史问答" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">本次会话的历史问答</h2>
      {pastRuns.map((run) => <article key={run.run_id} className="rounded border bg-background p-3 text-sm">
        <div className="font-medium">{run.question}</div>
        <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{run.answer || `（${run.state === "failed" ? "未完成" : run.state === "cancelled" ? "已取消" : run.state}）`}</div>
        {run.sources.length > 0 && <div className="mt-1 text-xs text-muted-foreground">来源：{run.sources.map(sourceLabel).join("、")}</div>}
      </article>)}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => dispatch({ type: "RESET" })}><RotateCcw size={13} className="mr-1" />清空当前视图</Button>
    </section>}
  </div>;
}

function sourceLabel(source: QuerySourceView): string {
  return source.business_type === "sales_order" ? `销售单 ${source.business_no}` : `${source.business_type} ${source.business_no}`;
}
