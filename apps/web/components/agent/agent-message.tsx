"use client";

import { memo, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, RotateCcw, Sparkles } from "lucide-react";
import type { AgentTurn } from "../../lib/agent-chat";
import { canRetryTurn } from "../../lib/agent-chat";
import { copyText } from "../../lib/clipboard";
import { Button } from "../ui/button";
import { AgentMarkdown } from "./agent-markdown";
import { AgentSources } from "./agent-sources";
import { AgentToolSteps } from "./agent-tool-steps";

/** 用户消息：右侧浅色圆角气泡。 */
export function AgentUserMessage({ text }: { text: string }) {
  return <div className="agent-msg agent-msg-user" data-testid="agent-message-user">
    <div className="agent-bubble-user">{text}</div>
  </div>;
}

/**
 * AI 消息：左侧无背景正文（Markdown）+ 执行步骤 + 来源 + 复制/重试。
 *
 * memo 的意义：长对话里历史消息对象在流式期间引用不变，
 * 只有正在生成的那一条会重渲染 —— 否则每来一个 delta，整段历史都要重新解析 Markdown。
 *
 * 扩展位（为将来的结构化结果预留，当前渲染顺序 = 步骤 → 正文 → 来源 → 动作）：
 *   后端目前 completed 事件只给 `answer` 文本（订单/库存明细是模型写进 Markdown 表格的），
 *   所以这里没有「结构化结果卡」组件可挂。等后端在消息里下发结构化 payload 时，
 *   在正文与来源之间插入一个 `AgentStructuredResult` 即可，页面与线程都不用改。
 */
export const AgentAssistantMessage = memo(function AgentAssistantMessage({ turn, onRetry }: { turn: AgentTurn; onRetry?: (question: string) => void }) {
  const streaming = turn.status === "streaming";
  const retryable = Boolean(onRetry) && canRetryTurn(turn);
  return <div className="agent-msg agent-msg-assistant" data-testid="agent-message-assistant">
    <span className="agent-avatar" aria-hidden="true"><Sparkles size={14} strokeWidth={1.9} /></span>
    <div className="agent-answer">
      <AgentToolSteps steps={turn.toolSteps} />

      {/* 流式期间还没有任何正文：给一句轻量状态，而不是空白等在那儿。 */}
      {streaming && !turn.answer && <p className="agent-answer-note" data-testid="agent-answer-pending">正在组织查询…</p>}

      {turn.answer && <div data-testid="business-query-answer">
        {/* 流式光标由 Markdown 渲染器挂在最后一个段落末尾（贴着最后一个字），不是单独一行方块 */}
        <AgentMarkdown text={turn.answer} caret={streaming} />
      </div>}

      {turn.status === "error" && <p className="agent-answer-error" data-testid="business-query-error" role="alert">
        <AlertTriangle size={13} aria-hidden="true" />{`以上内容不完整：${turn.error?.message ?? "本次查询未完成"}${turn.error?.code ? `（${turn.error.code}）` : ""}`}
      </p>}

      {turn.status === "cancelled" && <p className="agent-answer-note" data-testid="agent-answer-cancelled">
        已停止生成{turn.answer ? "，以上是停止前收到的内容。" : "。"}
      </p>}

      <AgentSources sources={turn.sources} />

      <div className="agent-answer-actions">
        {turn.answer && <CopyButton text={turn.answer} />}
        {retryable && <Button variant="ghost" size="sm" onClick={() => onRetry?.(turn.question)} title="用同一个问题重新查询" data-testid="agent-retry"><RotateCcw size={12} />重试</Button>}
      </div>
    </div>
  </div>;
});

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  // 2 秒后回到「复制」：状态提示只在点完的一瞬间有意义。
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return <Button variant="ghost" size="sm" title="复制这条回复" onClick={() => { void copyText(text).then((copied) => setState(copied ? "copied" : "failed")); }} data-testid="agent-copy">
    {state === "copied" ? <Check size={12} /> : <Copy size={12} />}
    {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制"}
  </Button>;
}
