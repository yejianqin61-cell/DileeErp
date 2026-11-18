/**
 * 首页任务提醒的展示类型与纯展示规则。
 *
 * 后端已经把「逾期 / 今天或明天到期 / 普通」判定完并给出中文 `due_label`，
 * 前端只负责配色和文案，不再自己算日期 —— 否则服务器与浏览器时区不同时会各标各的。
 */

export const TASK_MODULES = ["procurement", "warehouse", "production", "qc"] as const;
export type TaskModule = (typeof TASK_MODULES)[number];

export type TaskReminder = {
  id: string;
  source_type: string;
  source_id: string;
  task_type: string;
  title: string;
  module: TaskModule;
  document_no: string;
  order_no: string | null;
  detail: string;
  href: string;
  due_at: string | null;
  due_status: "overdue" | "due_soon" | "normal" | "none";
  due_label: string;
  priority: "urgent" | "normal";
  created_at: string;
};

export type TaskReminderCounts = {
  total: number;
  urgent_count: number;
  normal_count: number;
  overdue_count: number;
  due_soon_count: number;
};

/** summary / list 的 meta 形状：顶层是全部任务，`by_module` 用于按表面权限裁剪。 */
export type TaskReminderSummary = TaskReminderCounts & {
  by_module?: Partial<Record<TaskModule, TaskReminderCounts>>;
};

export type TaskTone = "danger" | "warning" | "neutral";

/** 模块 → 表面权限栏目路径（与 `sectionOfPath` 的映射一致）。 */
export function taskModulePath(module: TaskModule): string {
  return `/${module}`;
}

/** 到期颜色：逾期红、今明两天黄、其余灰。 */
export function taskDueTone(status: TaskReminder["due_status"]): TaskTone {
  if (status === "overdue") return "danger";
  if (status === "due_soon") return "warning";
  return "neutral";
}

export function taskPriorityLabel(priority: TaskReminder["priority"]): "紧急" | "普通" {
  return priority === "urgent" ? "紧急" : "普通";
}

/** 收起状态的一句话摘要（含紧急条数，用户不用展开也知道要不要点）。 */
export function taskCountSummary(counts: TaskReminderCounts | null): string {
  if (!counts) return "正在统计待办";
  if (counts.total === 0) return "当前没有待处理任务";
  return counts.urgent_count > 0 ? `${counts.total} 条待办，其中 ${counts.urgent_count} 条紧急` : `${counts.total} 条待办`;
}

function emptyCounts(): TaskReminderCounts {
  return { total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 };
}

function addCounts(target: TaskReminderCounts, source: TaskReminderCounts) {
  target.total += source.total;
  target.urgent_count += source.urgent_count;
  target.normal_count += source.normal_count;
  target.overdue_count += source.overdue_count;
  target.due_soon_count += source.due_soon_count;
}

/**
 * 按用户能进的栏目汇总 summary。
 * 没有 `by_module`（旧接口/测试桩）时退回整体计数，避免老响应直接消失。
 */
export function visibleTaskCounts(counts: TaskReminderSummary | null, allowedModules: readonly TaskModule[]): TaskReminderCounts | null {
  if (!counts) return null;
  if (!counts.by_module) return counts;
  const visible = emptyCounts();
  for (const module of allowedModules) {
    const moduleCounts = counts.by_module[module];
    if (moduleCounts) addCounts(visible, moduleCounts);
  }
  return visible;
}

/** 展开后已按权限过滤的列表：直接重新计数，标记完成时不用再猜 summary 的分模块数。 */
export function taskCountsFromTasks(tasks: readonly TaskReminder[]): TaskReminderCounts {
  const counts = emptyCounts();
  for (const task of tasks) {
    counts.total += 1;
    if (task.priority === "urgent") counts.urgent_count += 1;
    else counts.normal_count += 1;
    if (task.due_status === "overdue") counts.overdue_count += 1;
    if (task.due_status === "due_soon") counts.due_soon_count += 1;
  }
  return counts;
}

/** 兼容只拿到顶层计数的场景：标记完成后同步本地数字，不为一个勾选重拉整页。 */
export function countsAfterComplete(counts: TaskReminderCounts, task: TaskReminder): TaskReminderCounts {
  return {
    total: Math.max(0, counts.total - 1),
    urgent_count: Math.max(0, counts.urgent_count - (task.priority === "urgent" ? 1 : 0)),
    normal_count: Math.max(0, counts.normal_count - (task.priority === "normal" ? 1 : 0)),
    overdue_count: Math.max(0, counts.overdue_count - (task.due_status === "overdue" ? 1 : 0)),
    due_soon_count: Math.max(0, counts.due_soon_count - (task.due_status === "due_soon" ? 1 : 0)),
  };
}
