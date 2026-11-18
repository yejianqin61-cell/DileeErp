// 首页任务提醒的到期/排序/计数口径（纯函数，不连数据库）。
//
// 为什么单独测这一层：逾期红点、今天/明天到期黄标、紧急排序都由它决定。
// 如果这些规则散在服务层，任何一次「按 UTC 比日期」的改动都会让晚上 8 点后的任务
// 提前变成逾期，而界面看起来只是颜色不对，没人会联想到时区。
const assert = require("node:assert/strict");
const test = require("node:test");
// 正式 CI 先 `nest build`，测试跑 dist；增量构建留下的旧 dist 缺新导出时回退到源码。
// 回退必须自己注册 tsx：Node 24 虽然能剥类型，但解析不了领域文件里无扩展名的相对 import，
// 直接 require 会 ERR_MODULE_NOT_FOUND；tsx/cjs 同时解决 .ts 与无扩展名解析。
const domain = (() => {
  try {
    const compiled = require("../../dist/modules/task-reminders/task-reminders.domain.js");
    if (typeof compiled.countTaskRemindersByModule !== "function" || typeof compiled.isTaskSourcePair !== "function") throw new Error("dist is stale");
    return compiled;
  } catch {
    require("tsx/cjs");
    return require("../../src/modules/task-reminders/task-reminders.domain.ts");
  }
})();
const {
  buildTaskReminder,
  compareTaskReminders,
  countTaskReminders,
  countTaskRemindersByModule,
  isTaskSourcePair,
  taskDueLabel,
  taskDueStatus,
  taskKey,
  taskPriority,
} = domain;

// 北京时间 2026-09-17 12:00
const NOW = new Date("2026-09-17T04:00:00.000Z");

test("到期状态按北京时间自然日判定：昨天逾期、今天/明天临近、后天正常、空值不设截止", () => {
  assert.equal(taskDueStatus("2026-09-16T00:00:00.000Z", NOW), "overdue");
  assert.equal(taskDueStatus("2026-09-17T00:00:00.000Z", NOW), "due_soon");
  assert.equal(taskDueStatus("2026-09-18T00:00:00.000Z", NOW), "due_soon");
  assert.equal(taskDueStatus("2026-09-19T00:00:00.000Z", NOW), "normal");
  assert.equal(taskDueStatus(null, NOW), "none");
});

test("北京时间刚过午夜时，当天到期的任务不能算逾期", () => {
  // UTC 2026-09-17 16:30 = 北京时间 2026-09-18 00:30；到期日 2026-09-18 仍是「今天」。
  const justAfterMidnight = new Date("2026-09-17T16:30:00.000Z");
  assert.equal(taskDueStatus("2026-09-18T00:00:00.000Z", justAfterMidnight), "due_soon");
  assert.equal(taskDueLabel("2026-09-18T00:00:00.000Z", justAfterMidnight), "今天到期（09-18）");
});

test("到期文案直接给出逾期天数和日期，用户不用自己算", () => {
  assert.equal(taskDueLabel("2026-09-15T00:00:00.000Z", NOW), "已逾期 2 天（09-15 到期）");
  assert.equal(taskDueLabel("2026-09-17T00:00:00.000Z", NOW), "今天到期（09-17）");
  assert.equal(taskDueLabel("2026-09-18T00:00:00.000Z", NOW), "明天到期（09-18）");
  assert.equal(taskDueLabel("2026-09-19T00:00:00.000Z", NOW), "截止 09-19");
  assert.equal(taskDueLabel(null, NOW), "未设截止日期");
});

test("紧急 = 已逾期或今明到期，其余普通", () => {
  for (const status of ["overdue", "due_soon"]) assert.equal(taskPriority(status), "urgent");
  for (const status of ["normal", "none"]) assert.equal(taskPriority(status), "normal");
});

test("任务键由来源类型 + 源单据 UUID + 任务类型组成，标记完成时三段都可独立校验", () => {
  const key = taskKey({ source_type: "raw_material_movement", source_id: "11111111-1111-4111-8111-111111111111", task_type: "outbound" });
  assert.equal(key, "raw_material_movement:11111111-1111-4111-8111-111111111111:outbound");
});

test("buildTaskReminder 统一补出 id / 到期状态 / 文案 / 优先级，并把日期序列化成 ISO", () => {
  const task = buildTaskReminder({
    source_type: "purchase_order",
    source_id: "22222222-2222-4222-8222-222222222222",
    task_type: "arrival",
    title: "采购到货待登记",
    module: "procurement",
    document_no: "PO-20260901-001",
    order_no: "SO-20260901-001",
    detail: "SO-20260901-001 · 甲供应商",
    href: "/procurement/orders?order_no=SO-20260901-001",
    due_at: "2026-09-16T00:00:00.000Z",
    created_at: "2026-09-10T00:00:00.000Z",
  }, NOW);
  assert.equal(task.id, "purchase_order:22222222-2222-4222-8222-222222222222:arrival");
  assert.equal(task.due_status, "overdue");
  assert.equal(task.priority, "urgent");
  assert.equal(task.due_label, "已逾期 1 天（09-16 到期）");
  assert.equal(task.due_at, "2026-09-16T00:00:00.000Z");
  assert.equal(task.created_at, "2026-09-10T00:00:00.000Z");
});

test("排序：逾期 → 今明到期 → 有截止日 → 无截止日；同档先到期日、再创建时间", () => {
  const make = (id, due_at, created_at, due_status) => ({
    id, source_type: "x", source_id: id, task_type: "arrival", title: id, module: "procurement",
    document_no: id, order_no: null, detail: "", href: "/", due_at, due_status,
    due_label: "", priority: due_status === "overdue" || due_status === "due_soon" ? "urgent" : "normal", created_at,
  });
  const rows = [
    make("none", null, "2026-09-01T00:00:00.000Z", "none"),
    make("normal-late", "2026-09-25T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "normal"),
    make("normal-early", "2026-09-20T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "normal"),
    make("tomorrow", "2026-09-18T00:00:00.000Z", "2026-09-03T00:00:00.000Z", "due_soon"),
    make("today", "2026-09-17T00:00:00.000Z", "2026-09-04T00:00:00.000Z", "due_soon"),
    make("overdue", "2026-09-16T00:00:00.000Z", "2026-09-05T00:00:00.000Z", "overdue"),
  ];
  assert.deepEqual(rows.slice().sort(compareTaskReminders).map((row) => row.id), ["overdue", "today", "tomorrow", "normal-early", "normal-late", "none"]);
});

test("计数：总数、紧急/普通、逾期/今明到期分别统计", () => {
  const make = (due_status, priority) => ({
    id: Math.random().toString(), source_type: "x", source_id: Math.random().toString(), task_type: "arrival",
    title: "", module: "procurement", document_no: "", order_no: null, detail: "", href: "/", due_at: null,
    due_status, due_label: "", priority, created_at: "2026-09-01T00:00:00.000Z",
  });
  const counts = countTaskReminders([
    make("overdue", "urgent"),
    make("due_soon", "urgent"),
    make("due_soon", "urgent"),
    make("normal", "normal"),
    make("none", "normal"),
  ]);
  assert.deepEqual(counts, { total: 5, urgent_count: 3, normal_count: 2, overdue_count: 1, due_soon_count: 2 });
});

test("分模块计数：首页按表面权限裁剪时，只汇总用户能进的模块", () => {
  const make = (module, due_status, priority) => ({
    id: Math.random().toString(), source_type: "x", source_id: Math.random().toString(), task_type: "arrival",
    title: "", module, document_no: "", order_no: null, detail: "", href: "/", due_at: null,
    due_status, due_label: "", priority, created_at: "2026-09-01T00:00:00.000Z",
  });
  const byModule = countTaskRemindersByModule([
    make("procurement", "overdue", "urgent"),
    make("procurement", "normal", "normal"),
    make("warehouse", "due_soon", "urgent"),
    make("qc", "none", "normal"),
  ]);
  assert.deepEqual(byModule.procurement, { total: 2, urgent_count: 1, normal_count: 1, overdue_count: 1, due_soon_count: 0 });
  assert.deepEqual(byModule.warehouse, { total: 1, urgent_count: 1, normal_count: 0, overdue_count: 0, due_soon_count: 1 });
  assert.deepEqual(byModule.qc, { total: 1, urgent_count: 0, normal_count: 1, overdue_count: 0, due_soon_count: 0 });
  assert.deepEqual(byModule.production, { total: 0, urgent_count: 0, normal_count: 0, overdue_count: 0, due_soon_count: 0 });
});

test("标记完成的来源类型与任务类型必须成对，拒绝两个枚举各自合法但配错的组合", () => {
  assert.equal(isTaskSourcePair("raw_material_movement", "outbound"), true);
  assert.equal(isTaskSourcePair("purchase_order", "arrival"), true);
  assert.equal(isTaskSourcePair("purchase_order", "outbound"), false);
  assert.equal(isTaskSourcePair("unknown_source", "arrival"), false);
});
