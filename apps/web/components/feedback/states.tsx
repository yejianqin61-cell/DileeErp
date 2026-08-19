import { AlertTriangle, Inbox, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";

export function EmptyState({ title = "暂无数据", description = "当前没有可展示的记录", action }: { title?: string; description?: string; action?: ReactNode }) {
  return <div className="feedback-state"><Inbox size={24} /><strong>{title}</strong><p>{description}</p>{action}</div>;
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return <div className="feedback-state"><LoaderCircle className="spin" size={22} /><span>{label}...</span></div>;
}

export function ErrorState({ message = "数据加载失败", onRetry }: { message?: string; onRetry?: () => void }) {
  return <div className="feedback-state feedback-error"><AlertTriangle size={24} /><strong>{message}</strong>{onRetry && <Button variant="secondary" onClick={onRetry}>重新加载</Button>}</div>;
}

export function DemoNotice() { return <div className="demo-notice">演示页面：以下内容用于访谈讨论，不代表已确认的生产数据或业务规则。</div>; }
