"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { AgentTurn } from "../../lib/agent-chat";
import { AgentAssistantMessage, AgentUserMessage } from "./agent-message";
import { AgentWelcome } from "./agent-welcome";

/**
 * 对话滚动区。
 *
 * 滚动策略（用户要求「新消息到达时智能滚到底部，但用户主动看历史时不要强制拉回」）：
 *   * 距底部 80px 内 → 认为在「跟随最新」，内容变化时自动贴底；
 *   * 一旦用户往上翻出 80px → 立刻停止自动贴底，只在右下角给一个「回到底部」；
 *   * 用户自己发消息时（scrollSignal 变化）强制恢复跟随并贴底。
 * 滚动写在 rAF 里：同一次回答可能一帧内收到多个 answer_delta，
 * 合并成一次 scrollTop 赋值，避免滚动动画抖动。
 */
export function AgentThread({ turns, onPickSuggestion, onRetryTurn, scrollSignal }: {
  turns: AgentTurn[];
  onPickSuggestion: (question: string) => void;
  onRetryTurn: (question: string) => void;
  /** 每次用户发问自增：强制贴底（即使他刚才在看历史）。 */
  scrollSignal: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const empty = turns.length === 0;

  const stickToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(distance <= 80);
  }

  // 内容变化：跟随中才贴底。
  useEffect(() => {
    if (!following) return;
    const timer = setTimeout(stickToBottom, 0);
    return () => clearTimeout(timer);
  }, [turns, following, stickToBottom]);

  // 用户发问：无论如何恢复跟随。
  useEffect(() => {
    if (scrollSignal === 0) return;
    setFollowing(true);
    const timer = setTimeout(stickToBottom, 0);
    return () => clearTimeout(timer);
  }, [scrollSignal, stickToBottom]);

  return <div className="agent-thread-wrap">
    <div ref={scrollRef} className={`agent-scroll${empty ? " agent-scroll-empty" : ""}`} onScroll={handleScroll} data-testid="agent-scroll">
      {empty
        ? <AgentWelcome onPickSuggestion={onPickSuggestion} />
        : <div className="agent-thread" data-testid="agent-thread">
          {turns.map((turn) => <div className="agent-turn" key={turn.runId}>
            <AgentUserMessage text={turn.question} />
            <AgentAssistantMessage turn={turn} onRetry={onRetryTurn} />
          </div>)}
        </div>}
    </div>
    {!empty && !following && <button type="button" className="agent-scroll-bottom" onClick={() => { setFollowing(true); stickToBottom(); }} title="回到底部" aria-label="回到底部" data-testid="agent-scroll-bottom">
      <ArrowDown size={15} />
    </button>}
  </div>;
}
