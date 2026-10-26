"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { AgentSessionSummary } from "../../lib/agent-chat";
import { formatBeijingShort } from "../../lib/audit-time";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

/** 历史会话列表项：标题由首个问题生成（后端没有 title 字段），另带最近更新时间与轮数。 */
export type AgentHistoryEntry = AgentSessionSummary & { title: string; runCount: number };

/**
 * 历史记录弹窗。
 *
 * 只做后端已支持的三件事：列出本人会话、读取某个会话的快照、切过去继续问。
 * **没有**删除 / 重命名 / 归档：后端没有这些接口，所以界面上也不出现这些按钮
 * （用户明确要求不要把未实现的能力伪装成可用）。
 */
export function AgentHistoryDialog({
  open, onOpenChange, entries, loading, error, currentSessionId, truncated, onSelect, onReload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: AgentHistoryEntry[];
  loading: boolean;
  error: string;
  currentSessionId: string | null;
  /** 会话数超过取回上限时为 true：界面要如实说明只显示最近 N 个。 */
  truncated: boolean;
  onSelect: (sessionId: string) => void;
  onReload: () => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-testid="agent-history-dialog">
      <DialogHeader>
        <DialogTitle>历史记录</DialogTitle>
        <DialogDescription>只显示你自己的会话；切换会话会按当前数据档位重新读取内容。</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="agent-history">
          {loading && <p className="agent-history-hint" data-testid="agent-history-loading"><Loader2 size={13} className="spin" aria-hidden="true" /> 正在读取会话…</p>}
          {!loading && error && <div className="agent-history-hint" role="alert" data-testid="agent-history-error">
            {error}
            <Button variant="secondary" size="sm" onClick={onReload}>重新读取</Button>
          </div>}
          {!loading && !error && entries.length === 0 && <p className="agent-history-hint" data-testid="agent-history-empty">还没有历史会话。在下方提第一个问题后，这里就能找回它。</p>}
          {!loading && !error && entries.length > 0 && <ul className="agent-history-list" data-testid="agent-history-list">
            {entries.map((entry) => <li key={entry.session_id}>
              <button type="button" className="agent-history-item" aria-current={entry.session_id === currentSessionId ? "true" : undefined} onClick={() => onSelect(entry.session_id)} data-testid="agent-history-item" data-session-id={entry.session_id}>
                <span className="agent-history-item-title">{entry.title}</span>
                <span className="agent-history-item-meta">{formatBeijingShort(entry.updated_at)} · {entry.runCount} 轮</span>
              </button>
            </li>)}
          </ul>}
        </div>
      </DialogBody>
      <div className="agent-history-footnote">
        <span>{truncated ? "只显示最近 20 个会话。" : "仅本人可见。"}</span>
        <span>删除、重命名与导出：后端暂无接口。</span>
      </div>
    </DialogContent>
  </Dialog>;
}
