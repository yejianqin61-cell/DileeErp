import { beijingDate } from "../../platform/time/beijing-time";

/**
 * 首页「任务提醒」的领域口径。
 *
 * 为什么把到期判定放成纯函数：
 *   * 同一张单据在「今天 23:59」和「明天 00:01」看到的状态必须稳定，不能跟着服务器时区漂；
 *   * 前端只负责展示，逾期/临近到期/普通这一层判断只允许后端一份实现，
 *     否则列表里的红点和详情页的日期会各说各话。
 *
 * 所有日期比较都按**北京时间自然日**：`expectedDate` / `receivedDate` 这类 `@db.Date`
 * 读出来是 UTC 零点，直接和 `new Date()` 比会把它误判成「昨天已逾期」。
 */

export type TaskModule = "procurement" | "warehouse" | "production" | "qc";
export type TaskType = "unordered" | "arrival" | "inspection" | "inbound_notice" | "outbound" | "finished_goods_qc";
export type TaskPriority = "urgent" | "normal";
export type TaskDueStatus = "overdue" | "due_soon" | "normal" | "none";

/**
 * 每种源单据只产出一种待办。标记完成时不能只校验两个枚举各自合法：
 * `source_type` 与 `task_type` 必须成对，否则能写进一条永远匹配不到任务的完成记录。
 */
export const TASK_TYPE_BY_SOURCE: Readonly<Record<string, TaskType>> = {
  purchase_plan: "unordered",
  purchase_order: "arrival",
  incoming_inspection: "inspection",
  raw_material_inbound_notice: "inbound_notice",
  raw_material_movement: "outbound",
  finished_goods_inspection_submission: "finished_goods_qc",
};

export function isTaskSourcePair(sourceType: string, taskType: string): boolean {
  return TASK_TYPE_BY_SOURCE[sourceType] === taskType;
}

export type TaskReminder = {
  /** `source_type:source_id:task_type` —— 标记完成时原样回传，三段都能被服务端独立校验。 */
  id: string;
  source_type: string;
  source_id: string;
  task_type: TaskType;
  title: string;
  module: TaskModule;
  document_no: string;
  order_no: string | null;
  detail: string;
  href: string;
  due_at: string | null;
  due_status: TaskDueStatus;
  due_label: string;
  priority: TaskPriority;
  created_at: string;
};

/** 服务层拼装任务时给的口径；`id` / `priority` / `due_*` 由本模块统一派生。 */
export type TaskDraft = Omit<TaskReminder, "id" | "due_status" | "due_label" | "priority" | "due_at" | "created_at"> & {
  due_at: Date | string | null;
  created_at: Date | string;
};

export type TaskCounts = {
  total: number;
  urgent_count: number;
  normal_count: number;
  overdue_count: number;
  due_soon_count: number;
};

const DAY_MS = 86_400_000;

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 北京时间的自然日序号（只用于日期差，不参与展示）。 */
function dayNumber(date: Date): number {
  const [year, month, day] = beijingDate(date).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** 到期状态：逾期 / 今天或明天到期 / 正常 / 未设截止。 */
export function taskDueStatus(dueAt: Date | string | null | undefined, now: Date = new Date()): TaskDueStatus {
  const due = toDate(dueAt);
  if (!due) return "none";
  const diff = dayNumber(due) - dayNumber(now);
  if (diff < 0) return "overdue";
  if (diff <= 1) return "due_soon";
  return "normal";
}

/** 给列表看的到期文案；「临近到期」统一成今天/明天，避免把「还有 1 天」写成模糊的「即将到期」。 */
export function taskDueLabel(dueAt: Date | string | null | undefined, now: Date = new Date()): string {
  const due = toDate(dueAt);
  if (!due) return "未设截止日期";
  const diff = dayNumber(due) - dayNumber(now);
  const compact = beijingDate(due).slice(5);
  if (diff < 0) return `已逾期 ${-diff} 天（${compact} 到期）`;
  if (diff === 0) return `今天到期（${compact}）`;
  if (diff === 1) return `明天到期（${compact}）`;
  return `截止 ${compact}`;
}

/** 紧急 = 已逾期或今天/明天到期；其余为普通。 */
export function taskPriority(status: TaskDueStatus): TaskPriority {
  return status === "overdue" || status === "due_soon" ? "urgent" : "normal";
}

export function taskKey(input: Pick<TaskReminder, "source_type" | "source_id" | "task_type">): string {
  return `${input.source_type}:${input.source_id}:${input.task_type}`;
}

export function buildTaskReminder(draft: TaskDraft, now: Date = new Date()): TaskReminder {
  const due = toDate(draft.due_at);
  const created = toDate(draft.created_at) ?? now;
  const dueStatus = taskDueStatus(due, now);
  return {
    ...draft,
    id: taskKey(draft),
    due_at: due ? due.toISOString() : null,
    due_status: dueStatus,
    due_label: taskDueLabel(due, now),
    priority: taskPriority(dueStatus),
    created_at: created.toISOString(),
  };
}

/** 排序：逾期 → 今天/明天到期 → 有截止日 → 无截止日；同一档先按到期日、再按创建时间。 */
export function compareTaskReminders(left: TaskReminder, right: TaskReminder): number {
  const rank: Record<TaskDueStatus, number> = { overdue: 0, due_soon: 1, normal: 2, none: 3 };
  const byStatus = rank[left.due_status] - rank[right.due_status];
  if (byStatus !== 0) return byStatus;
  if (left.due_at && right.due_at && left.due_at !== right.due_at) return left.due_at.localeCompare(right.due_at);
  if (left.due_at && !right.due_at) return -1;
  if (!left.due_at && right.due_at) return 1;
  return left.created_at.localeCompare(right.created_at);
}

export function countTaskReminders(tasks: readonly TaskReminder[]): TaskCounts {
  const counts = emptyTaskCounts();
  for (const task of tasks) incrementTaskCounts(counts, task);
  return counts;
}

/** 分模块计数：首页按 `surface_sections` 只汇总用户能进的模块，收起态的数字不泄露无权模块。 */
export function countTaskRemindersByModule(tasks: readonly TaskReminder[]): Record<TaskModule, TaskCounts> {
  const byModule: Record<TaskModule, TaskCounts> = {
    procurement: emptyTaskCounts(),
    warehouse: emptyTaskCounts(),
    production: emptyTaskCounts(),
    qc: emptyTaskCounts(),
  };
  for (const task of tasks) incrementTaskCounts(byModule[task.module], task);
  return byModule;
}

function emptyTaskCounts(): TaskCounts {
  return { total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 };
}

function incrementTaskCounts(counts: TaskCounts, task: TaskReminder) {
  counts.total += 1;
  if (task.priority === "urgent") counts.urgent_count += 1;
  else counts.normal_count += 1;
  if (task.due_status === "overdue") counts.overdue_count += 1;
  if (task.due_status === "due_soon") counts.due_soon_count += 1;
}
