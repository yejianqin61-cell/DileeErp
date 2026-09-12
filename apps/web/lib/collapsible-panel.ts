"use client";

// 可收纳面板（如生产单详情的「工序与进度」）的展开/收起状态。
// 默认展开；用户的选择记在 localStorage，切到别的页面再回来仍然是收起的，不用每次重新点。
import { useCallback, useEffect, useState } from "react";

export type PanelStoredState = "expanded" | "collapsed";

export function panelStorageKey(name: string): string {
  return `dilee:panel:${name}`;
}

/** 只认自己写过的两个值：其它内容（旧版本、别处写的键）当作没设置过。 */
export function panelStateFromStorage(value: string | null | undefined): PanelStoredState | null {
  return value === "expanded" || value === "collapsed" ? value : null;
}

export function panelStateToStorage(open: boolean): PanelStoredState {
  return open ? "expanded" : "collapsed";
}

export function useCollapsiblePanel(name: string, defaultOpen = true) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = panelStateFromStorage(window.localStorage.getItem(panelStorageKey(name)));
    if (saved) setOpen(saved === "expanded");
  }, [name]);
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try { window.localStorage.setItem(panelStorageKey(name), panelStateToStorage(next)); } catch { /* 隐私模式下写不了，忽略即可 */ }
      }
      return next;
    });
  }, [name]);
  return { open, toggle };
}
