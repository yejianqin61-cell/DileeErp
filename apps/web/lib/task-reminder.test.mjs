// 首页任务提醒的纯展示规则（不渲染组件）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  countsAfterComplete,
  taskCountsFromTasks,
  taskCountSummary,
  taskDueTone,
  taskModulePath,
  taskPriorityLabel,
  visibleTaskCounts,
} from "./task-reminder.ts";

const baseCounts = { total: 5, urgent_count: 2, normal_count: 3, overdue_count: 1, due_soon_count: 1 };

test("到期配色：逾期红、今明到期黄、其余灰", () => {
  assert.equal(taskDueTone("overdue"), "danger");
  assert.equal(taskDueTone("due_soon"), "warning");
  assert.equal(taskDueTone("normal"), "neutral");
  assert.equal(taskDueTone("none"), "neutral");
});

test("紧急/普通有中文标签，不把内部枚举直接摆到界面上", () => {
  assert.equal(taskPriorityLabel("urgent"), "紧急");
  assert.equal(taskPriorityLabel("normal"), "普通");
});

test("收起摘要：统计中 / 无任务 / 有紧急任务三种说法", () => {
  assert.equal(taskCountSummary(null), "正在统计待办");
  assert.equal(taskCountSummary({ ...baseCounts, total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 }), "当前没有待处理任务");
  assert.equal(taskCountSummary(baseCounts), "5 条待办，其中 2 条紧急");
  assert.equal(taskCountSummary({ ...baseCounts, urgent_count: 0 }), "5 条待办");
});

test("标记完成后只递减这条任务对应的计数，不会把其它紧急任务一起算掉", () => {
  const urgentOverdue = { id: "a", source_type: "x", source_id: "a", task_type: "arrival", title: "", module: "procurement", document_no: "", order_no: null, detail: "", href: "/", due_at: null, due_status: "overdue", due_label: "", priority: "urgent", created_at: "2026-09-01T00:00:00.000Z" };
  assert.deepEqual(countsAfterComplete(baseCounts, urgentOverdue), { total: 4, urgent_count: 1, normal_count: 3, overdue_count: 0, due_soon_count: 1 });
  const normal = { ...urgentOverdue, id: "b", source_id: "b", due_status: "normal", priority: "normal" };
  assert.deepEqual(countsAfterComplete(baseCounts, normal), { total: 4, urgent_count: 2, normal_count: 2, overdue_count: 1, due_soon_count: 1 });
});

test("计数不会减成负数（重复点击/计数过期时的兜底）", () => {
  const task = { id: "a", source_type: "x", source_id: "a", task_type: "arrival", title: "", module: "procurement", document_no: "", order_no: null, detail: "", href: "/", due_at: null, due_status: "overdue", due_label: "", priority: "urgent", created_at: "2026-09-01T00:00:00.000Z" };
  assert.deepEqual(countsAfterComplete({ total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 }, task), { total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 });
});

test("按表面权限汇总 summary：只加用户能进的模块；旧响应没有 by_module 时退回整体计数", () => {
  const summary = {
    ...baseCounts,
    by_module: {
      procurement: { total: 2, urgent_count: 1, normal_count: 1, overdue_count: 1, due_soon_count: 0 },
      warehouse: { total: 3, urgent_count: 1, normal_count: 2, overdue_count: 0, due_soon_count: 1 },
      qc: { total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 },
      production: { total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 },
    },
  };
  assert.deepEqual(visibleTaskCounts(summary, ["procurement"]), { total: 2, urgent_count: 1, normal_count: 1, overdue_count: 1, due_soon_count: 0 });
  assert.deepEqual(visibleTaskCounts(summary, ["procurement", "warehouse"]), { total: 5, urgent_count: 2, normal_count: 3, overdue_count: 1, due_soon_count: 1 });
  assert.deepEqual(visibleTaskCounts({ ...baseCounts }, ["qc"]), baseCounts);
});

test("模块 → 表面权限路径与 sectionOfPath 的映射一致", () => {
  assert.equal(taskModulePath("procurement"), "/procurement");
  assert.equal(taskModulePath("warehouse"), "/warehouse");
  assert.equal(taskModulePath("qc"), "/qc");
  assert.equal(taskModulePath("production"), "/production");
});

test("展开后按权限过滤的列表可以直接重新计数", () => {
  const task = (priority, due_status) => ({ id: String(Math.random()), source_type: "x", source_id: "x", task_type: "arrival", title: "", module: "procurement", document_no: "", order_no: null, detail: "", href: "/", due_at: null, due_status, due_label: "", priority, created_at: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(taskCountsFromTasks([task("urgent", "overdue"), task("normal", "none")]), { total: 2, urgent_count: 1, normal_count: 1, overdue_count: 1, due_soon_count: 0 });
  assert.deepEqual(taskCountsFromTasks([]), { total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 });
});
