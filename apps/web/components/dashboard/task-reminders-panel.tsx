"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ClipboardList } from "lucide-react";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { useSessionProfile } from "../../lib/session-context";
import { canVisitPath, SURFACE_SECTIONS } from "../../lib/surface-permission";
import {
  TASK_MODULES,
  taskCountsFromTasks,
  taskCountSummary,
  taskDueTone,
  taskModulePath,
  taskPriorityLabel,
  visibleTaskCounts,
  type TaskModule,
  type TaskReminder,
  type TaskReminderCounts,
  type TaskReminderSummary,
} from "../../lib/task-reminder";
import { Button } from "../ui/button";
import { EmptyState, LoadingState } from "../feedback/states";

/**
 * 计数字段必须全是有限数字才认；接口异常/代理返回别的形状时宁可显示「暂不可用」，
 * 也不要把数组或字符串当成条数渲染成 `undefined 条待办`。
 */
function normalizeCounts(value: unknown): TaskReminderCounts | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const keys = ["total", "urgent_count", "normal_count", "overdue_count", "due_soon_count"] as const;
  if (!keys.every((key) => typeof source[key] === "number" && Number.isFinite(source[key] as number))) return null;
  return {
    total: source.total as number,
    urgent_count: source.urgent_count as number,
    normal_count: source.normal_count as number,
    overdue_count: source.overdue_count as number,
    due_soon_count: source.due_soon_count as number,
  };
}

/** summary 的 `by_module` 也逐个校验；缺模块就少算该模块，不把坏数据拼进总数。 */
function normalizeSummary(value: unknown): TaskReminderSummary | null {
  const base = normalizeCounts(value);
  if (!base) return null;
  const rawByModule = (value as Record<string, unknown>).by_module;
  if (!rawByModule || typeof rawByModule !== "object") return base;
  const byModule: Partial<Record<TaskModule, TaskReminderCounts>> = {};
  for (const module of TASK_MODULES) {
    const counts = normalizeCounts((rawByModule as Record<string, unknown>)[module]);
    if (counts) byModule[module] = counts;
  }
  return { ...base, by_module: byModule };
}

/**
 * 首页「任务提醒」面板。
 *
 * 交互口径（用户 2026-11-18）：
 *   * **默认收起**，只显示有多少条待办，避免首页被长列表挤乱；
 *   * 点【展开】才请求完整任务列表（收起时只请求 summary 计数）；
 *   * 到期日由后端统一判定：逾期红、今天/明天到期黄；紧急/普通直接来自后端；
 *   * 任务标题和「打开单据」都跳源单据页面；「标记完成」只把这条提醒收起来，
 *     不替用户改源单据状态（源单据真正处理完时任务会自然消失）。
 *
 * 权限：面板横跨采购/仓库/质检，和工作台的财务卡片同一口径 —— 只显示
 * `surface_sections` 允许的模块；收起态的计数也按模块裁剪，不泄露无权模块。
 */
export function TaskRemindersPanel() {
  const profile = useSessionProfile();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<TaskReminderSummary | null>(null);
  const [tasks, setTasks] = useState<TaskReminder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summaryError, setSummaryError] = useState(false);
  const [busyId, setBusyId] = useState("");

  const allowedModules = useMemo(
    () => TASK_MODULES.filter((module) => canVisitPath(profile?.surface_sections ?? SURFACE_SECTIONS, taskModulePath(module))),
    [profile],
  );
  const visibleCounts = useMemo(() => visibleTaskCounts(counts, allowedModules), [counts, allowedModules]);

  useEffect(() => {
    let cancelled = false;
    apiGet<TaskReminderSummary>("/task-reminders/summary")
      .then((result) => {
        if (cancelled) return;
        setCounts(normalizeSummary(result.data));
        setSummaryError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCounts(null);
        setSummaryError(true);
      });
    return () => { cancelled = true; };
  }, []);

  async function loadTasks() {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<TaskReminder[]>("/task-reminders");
      const visible = (result.data ?? []).filter((task) => allowedModules.includes(task.module));
      setTasks(visible);
      setCounts(taskCountsFromTasks(visible));
      setSummaryError(false);
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "待办任务加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!tasks && !loading) await loadTasks();
  }

  async function complete(task: TaskReminder) {
    setBusyId(task.id);
    setError("");
    try {
      await apiPost("/task-reminders/complete", {
        source_type: task.source_type,
        source_id: task.source_id,
        task_type: task.task_type,
      });
      const nextTasks = tasks ? tasks.filter((row) => row.id !== task.id) : tasks;
      setTasks(nextTasks);
      if (nextTasks) setCounts(taskCountsFromTasks(nextTasks));
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : "标记完成失败，请重试");
    } finally {
      setBusyId("");
    }
  }

  return <section className="panel task-reminders" aria-labelledby="task-reminders-title" data-testid="task-reminders-panel">
    <div className="panel-heading">
      <h2 id="task-reminders-title"><ClipboardList size={16} />任务提醒 <span className="task-reminder-count" data-testid="task-reminder-count">{visibleCounts ? visibleCounts.total : "—"}</span></h2>
      <span className="panel-note" data-testid="task-reminder-summary">{summaryError && !visibleCounts ? "待办统计暂不可用" : taskCountSummary(visibleCounts)}</span>
      <Button variant="secondary" size="sm" onClick={() => { void toggle(); }} aria-expanded={open} aria-controls="task-reminders-body" data-testid="task-reminder-toggle">
        {open ? <><ChevronUp size={14} />收起</> : <><ChevronDown size={14} />展开</>}
      </Button>
    </div>
    {open && <div className="panel-body" id="task-reminders-body" data-testid="task-reminders-body">
      {loading ? <LoadingState label="正在加载待办任务" /> : tasks ? <>
        {error && <p className="task-reminder-error status-danger" role="alert">{error}</p>}
        {tasks.length === 0
          ? <EmptyState title="当前没有待处理任务" description="采购、仓库和质检的待办处理完后，这里会自动清空。" />
          : <ul className="task-reminder-list">
            {tasks.map((task) => <li className={`task-reminder-item is-${task.due_status}`} key={task.id} data-testid={`task-reminder-${task.id}`}>
              <span className={`task-reminder-priority is-${task.priority}`} data-testid={`task-reminder-priority-${task.id}`}>{taskPriorityLabel(task.priority)}</span>
              <div className="task-reminder-main">
                <Link className="task-reminder-title" href={task.href} data-testid={`task-reminder-link-${task.id}`}>{task.title} · {task.document_no}</Link>
                <span className="task-reminder-meta">{task.detail}</span>
              </div>
              <span className={`task-reminder-due is-${taskDueTone(task.due_status)}`} data-testid={`task-reminder-due-${task.id}`}>{task.due_label}</span>
              <div className="task-reminder-actions">
                <Button variant="secondary" size="sm" asChild><Link href={task.href}>打开单据</Link></Button>
                <Button variant="ghost" size="sm" onClick={() => { void complete(task); }} disabled={busyId === task.id} data-testid={`task-reminder-complete-${task.id}`}>{busyId === task.id ? "处理中" : "标记完成"}</Button>
              </div>
            </li>)}
          </ul>}
      </> : <div className="feedback-state">
        <strong>{error || "待办任务加载失败"}</strong>
        <Button variant="secondary" onClick={() => { void loadTasks(); }}>重新加载</Button>
      </div>}
    </div>}
  </section>;
}
