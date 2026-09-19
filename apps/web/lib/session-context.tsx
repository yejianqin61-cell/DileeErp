"use client";

import { createContext, useContext } from "react";
import type { SessionProfile } from "./session";

/**
 * 当前会话的权限档案，由 AppShell 注入。
 *
 * 为什么用 context 而不是让每个组件各自再请求一次 `/auth/me`：
 *   页面里凡是要按权限决定"显示/隐藏某块内容"的地方（工作台的财务卡片就是第一处），
 *   都各自请求一遍会变成 N 次往返，而且同一时刻可能读到不一致的权限快照。
 *   AppShell 已经请求过了，往下传是最省的。
 */
export const SessionContext = createContext<SessionProfile | null>(null);

export function useSessionProfile(): SessionProfile | null {
  return useContext(SessionContext);
}
