"use client";

import { useTranslate } from "../../features/agent-chat/i18n";
import { ClipboardList, Factory, PackageSearch, ShoppingCart, Sparkles } from "lucide-react";

/** 推荐问题卡片的图标：与四个问题一一对应（订单/生产/库存/采购）。 */
const SUGGESTION_ICONS = [ShoppingCart, Factory, PackageSearch, ClipboardList];

const SUGGESTION_KEYS = ["suggestionOrders", "suggestionDelays", "suggestionStock", "suggestionPurchasing"] as const;

/**
 * 空态（还没有任何消息）。点击推荐问题**只填入输入框**，不直接发送：
 * 用户可能想改订单号或时间范围，直接发出去反而要重来一次。
 */
export function AgentWelcome({ onPickSuggestion }: { onPickSuggestion: (question: string) => void }) {
  const t = useTranslate();
  return <div className="agent-empty" data-testid="agent-welcome">
    <div className="agent-empty-mark" aria-hidden="true"><Sparkles size={22} strokeWidth={1.8} /></div>
    <h1 className="agent-empty-title">{t("welcomeTitle")}</h1>
    <p className="agent-empty-sub">{t("welcomeSubtitle")}</p>
    {/* 用 ul/li 而不是给 button 挂 role="listitem"：后者会把按钮语义覆盖掉，读屏不再念「按钮」。 */}
    <ul className="agent-suggestions" aria-label={t("suggestionsLabel")}>
      {SUGGESTION_KEYS.map((key, index) => {
        const question = t(key);
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
