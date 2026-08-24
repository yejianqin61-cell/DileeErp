"use client";

import { useEffect, useState } from "react";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "./toast";

type Notice = { id: number; title?: string; description: string; tone?: "default" | "error" };
let nextId = 1;
const listeners = new Set<(notice: Notice) => void>();
export function notify(description: string, title?: string, tone: Notice["tone"] = "default") { const notice = { id: nextId++, title, description, tone }; listeners.forEach((listener) => listener(notice)); }
export function Toaster() { const [notices, setNotices] = useState<Notice[]>([]); useEffect(() => { const listener = (notice: Notice) => setNotices((current) => [...current, notice]); listeners.add(listener); return () => { listeners.delete(listener); }; }, []); return <ToastProvider swipeDirection="right"><>{notices.map((notice) => <Toast key={notice.id} onOpenChange={(open) => { if (!open) setNotices((current) => current.filter((item) => item.id !== notice.id)); }} className={notice.tone === "error" ? "border-[var(--danger)]" : undefined}><div><ToastTitle>{notice.title ?? (notice.tone === "error" ? "操作失败" : "操作成功")}</ToastTitle><ToastDescription>{notice.description}</ToastDescription></div><ToastClose aria-label="关闭">×</ToastClose></Toast>)}<ToastViewport /></></ToastProvider>; }
