"use client";

import { useTranslate } from "../../features/agent-chat/i18n";
import Link from "next/link";
import { History, LayoutDashboard, Plus, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { AgentSettingsMenu } from "./agent-settings-menu";

/**
 * Agent 工作区顶部工具栏：固定不滚动，只放身份与两个**真的能用**的动作。
 * 没有面包屑、没有说明段落 —— 那是 ERP 表单页的语言，不是对话页的。
 */
export function AgentToolbar({ busy, onNewConversation, onOpenHistory }: { busy: boolean; onNewConversation: () => void; onOpenHistory: () => void }) {
  const t = useTranslate();
  // 运行中禁止切会话：后端同一时刻只允许一个活动 run，切走只会留下一条无人接管的流。
  const blockedHint = busy ? t("busyHint") : undefined;
  return <header className="agent-toolbar">
    <div className="agent-toolbar-title">
      {/* 窄屏会把 ERP 侧栏让给对话（见 globals.css 的手机端规则），这里留一个回工作台的入口，
          避免手机上隐藏侧栏后走不出去。桌面端这个图标是隐藏的。 */}
      <Link href="/" className="agent-toolbar-home" aria-label={t("backToDashboard")} title={t("backToDashboard")} data-testid="agent-toolbar-home"><LayoutDashboard size={16} /></Link>
      <span className="agent-toolbar-mark" aria-hidden="true"><Sparkles size={15} strokeWidth={1.9} /></span>
      <h1 className="agent-toolbar-name">{t("appName")}</h1>
      <span className="agent-toolbar-sub">{t("appSubtitle")}</span>
    </div>
    <div className="agent-toolbar-actions">
      <Button variant="ghost" size="sm" onClick={onOpenHistory} disabled={busy} title={blockedHint ?? t("historyHint")} data-testid="agent-history-open"><History size={14} />{t("history")}</Button>
      <Button variant="secondary" size="sm" onClick={onNewConversation} disabled={busy} title={blockedHint ?? t("newConversationHint")} data-testid="agent-new-conversation"><Plus size={14} />{t("newConversation")}</Button>
      <AgentSettingsMenu />
    </div>
  </header>;
}
