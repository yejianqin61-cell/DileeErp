export type WorkbenchBlocker = { code: string; label: string; suggestion: string };

export const WORKBENCH_STATUS_LABELS: Record<string, string> = {
  not_started: "未建立",
  in_progress: "进行中",
  blocked: "存在阻塞",
  ready_to_ship: "待发货",
  completed: "已完成",
};

export function overallStatus(statuses: string[], blockers: WorkbenchBlocker[]) {
  if (blockers.length) return "blocked";
  if (statuses.includes("in_progress")) return "in_progress";
  if (statuses.includes("ready_to_ship")) return "ready_to_ship";
  if (statuses.length > 0 && statuses.every((status) => ["completed", "paid", "closed"].includes(status))) return "completed";
  return statuses.length ? "in_progress" : "not_started";
}

export function decimalString(value: { toString(): string } | null | undefined) { return value?.toString() ?? "0"; }
