"use client";

import { ClipboardList, Factory, PackageSearch, ShoppingCart, Sparkles } from "lucide-react";
import { SUGGESTED_QUESTIONS } from "../../lib/agent-chat";

/** 推荐问题卡片的图标：与四个问题一一对应（订单/生产/库存/采购）。 */
const SUGGESTION_ICONS = [ShoppingCart, Factory, PackageSearch, ClipboardList];

/**
 * 空态（还没有任何消息）。点击推荐问题**只填入输入框**，不直接发送：
 * 用户可能想改订单号或时间范围，直接发出去反而要重来一次。
 */
export function AgentWelcome({ onPickSuggestion }: { onPickSuggestion: (question: string) => void }) {
  return <div className="agent-empty" data-testid="agent-welcome">
    <div className="agent-empty-mark" aria-hidden="true"><Sparkles size={22} strokeWidth={1.8} /></div>
    <h1 className="agent-empty-title">今天有什么可以帮您？</h1>
    <p className="agent-empty-sub">查询订单、追踪生产进度、了解采购与库存情况</p>
    {/* 用 ul/li 而不是给 button 挂 role="listitem"：后者会把按钮语义覆盖掉，读屏不再念「按钮」。 */}
    <ul className="agent-suggestions" aria-label="推荐问题">
      {SUGGESTED_QUESTIONS.map((question, index) => {
        const Icon = SUGGESTION_ICONS[index] ?? Sparkles;
        return <li key={question}>
          <button type="button" className="agent-suggestion" onClick={() => onPickSuggestion(question)} data-testid="agent-suggestion" data-question={question}>
            <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
            <span>{question}</span>
          </button>
        </li>;
      })}
    </ul>
  </div>;
}
