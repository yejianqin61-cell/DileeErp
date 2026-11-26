"use client";

import { useTranslate } from "../../features/agent-chat/i18n";
import { useContext, useEffect, useState } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { AgentSettingsContext } from "../../features/agent-chat/settings/settings";
import themeStyles from "../../features/agent-chat/settings/theme.module.css";
import type { AgentSessionSummary } from "../../lib/agent-chat";
import { formatBeijingShort } from "../../lib/audit-time";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import styles from "./agent-history-dialog.module.css";

export type AgentHistoryEntry = Omit<AgentSessionSummary, "title"> & { title: string; runCount: number };

export function AgentHistoryDialog({
  open, onOpenChange, entries, loading, error, actionError, currentSessionId, truncated, onSelect, onReload, onRename, onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: AgentHistoryEntry[];
  loading: boolean;
  error: string;
  actionError: string;
  currentSessionId: string | null;
  truncated: boolean;
  onSelect: (sessionId: string) => void;
  onReload: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  const t = useTranslate();
  const [editing, setEditing] = useState<{ sessionId: string; title: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const { theme } = useContext(AgentSettingsContext);

  useEffect(() => {
    if (open) return;
    setEditing(null);
    setRemoving(null);
  }, [open]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || !editing) return;
    event.preventDefault();
    const title = editing.title.trim();
    if (!title) return;
    onRename(editing.sessionId, title);
    setEditing(null);
  }

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={themeStyles.root} data-agent-theme={theme} data-testid="agent-history-dialog" onEscapeKeyDown={(event) => { if (!editing) return; event.preventDefault(); setEditing(null); }}>
        <DialogHeader>
          <DialogTitle>{t("history")}</DialogTitle>
          <DialogDescription>{t("historyDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="agent-history">
            {loading && <p className="agent-history-hint" data-testid="agent-history-loading"><Loader2 size={13} className="spin" aria-hidden="true" /> {t("historyLoading")}</p>}
            {!loading && error && <div className="agent-history-hint" role="alert" data-testid="agent-history-error">
              {error}
              <Button variant="secondary" size="sm" onClick={onReload}>{t("historyReload")}</Button>
            </div>}
            {!loading && actionError && <p className="agent-history-hint" role="alert" data-testid="agent-history-action-error">{actionError}</p>}
            {!loading && !error && entries.length === 0 && <p className="agent-history-hint" data-testid="agent-history-empty">{t("historyEmpty")}</p>}
            {!loading && !error && entries.length > 0 && <ul className="agent-history-list" data-testid="agent-history-list">
              {entries.map((entry) => <li key={entry.session_id} className={styles.row} data-testid="agent-history-row">
                {editing?.sessionId === entry.session_id
                  ? <input className={`ui-input ${styles.main}`} aria-label={t("sessionName")} autoFocus maxLength={100} value={editing.title} onChange={(event) => setEditing({ sessionId: entry.session_id, title: event.target.value })} onKeyDown={handleKeyDown} />
                  : <button type="button" className={`agent-history-item ${styles.main}`} aria-current={entry.session_id === currentSessionId ? "true" : undefined} onClick={() => onSelect(entry.session_id)} data-testid="agent-history-item" data-session-id={entry.session_id}>
                    <span className="agent-history-item-title">{entry.title}</span>
                    <span className="agent-history-item-meta">{t("historyMeta", { time: formatBeijingShort(entry.updated_at), count: entry.runCount })}</span>
                  </button>}
                <Button variant="ghost" size="icon" title={t("rename")} aria-label={t("rename")} onClick={() => setEditing({ sessionId: entry.session_id, title: entry.title })}><Pencil size={14} /></Button>
                <Button variant="ghost" size="icon" title={t("remove")} aria-label={t("remove")} onClick={() => setRemoving(entry.session_id)}><Trash2 size={14} /></Button>
              </li>)}
            </ul>}
          </div>
        </DialogBody>
        <div className="agent-history-footnote">
          <span>{truncated ? t("historyTruncated") : t("historyOnlyMine")}</span>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={removing !== null} onOpenChange={(next) => { if (!next) setRemoving(null); }}>
      <DialogContent role="alertdialog" className={themeStyles.root} data-agent-theme={theme}>
        <DialogHeader>
          <DialogTitle>{t("removeTitle")}</DialogTitle>
          <DialogDescription>{t("removeDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setRemoving(null)}>{t("cancel")}</Button>
          <Button onClick={() => { if (removing) onDelete(removing); setRemoving(null); }}>{t("removeConfirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
