// 告警模块 AlertsService 单元测试（require 编译产物 apps/api/dist，不连真实数据库）。
// 关注点：多源告警汇总（生产日报 / 成品 QC / 库存净变动）、去重、状态覆盖、处理写入 alert_handling。
// 假 Prisma 复刻 where.status 过滤与 upsert 落库，因此 handle() 之后可以直接 list() 做往返断言。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { AlertsService } = require("../../dist/modules/alerts/alerts.service.js");
const { deduplicateAlerts } = require("../../dist/modules/alerts/alerts.domain.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");

const USER = { id: "user-1", username: "tester", display_name: "测试用户" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 手写假 Prisma：记录调用参数；alertHandling 用一个内存 store 模拟真实表。 */
function fakePrisma(config = {}) {
  const handlingStore = [...(config.handling ?? [])];
  const calls = {
    dailyFindMany: [], dailyFindFirst: [], qcFindMany: [], qcFindFirst: [], groupBy: [],
    handlingFindMany: [], handlingUpsert: [], handlingOther: [], auditCreate: [],
    sourceWrites: [], queryRaw: 0, executeRawUnsafe: 0, transaction: 0,
  };
  const client = {
    calls,
    handlingStore,
    productionDailyAlert: {
      findMany: async (args) => { calls.dailyFindMany.push(args); return config.daily ?? []; },
      findFirst: async (args) => { calls.dailyFindFirst.push(args); return config.dailySource ?? null; },
      update: async (args) => { calls.sourceWrites.push({ model: "productionDailyAlert", op: "update", args }); return {}; },
      updateMany: async (args) => { calls.sourceWrites.push({ model: "productionDailyAlert", op: "updateMany", args }); return { count: 0 }; },
    },
    finishedGoodsQcRecord: {
      findMany: async (args) => { calls.qcFindMany.push(args); return config.qc ?? []; },
      findFirst: async (args) => { calls.qcFindFirst.push(args); return config.qcSource ?? null; },
      update: async (args) => { calls.sourceWrites.push({ model: "finishedGoodsQcRecord", op: "update", args }); return {}; },
      updateMany: async (args) => { calls.sourceWrites.push({ model: "finishedGoodsQcRecord", op: "updateMany", args }); return { count: 0 }; },
    },
    inventoryFact: {
      groupBy: async (args) => { calls.groupBy.push(args); return config.negative ?? []; },
      update: async (args) => { calls.sourceWrites.push({ model: "inventoryFact", op: "update", args }); return {}; },
    },
    alertHandling: {
      findMany: async (args) => {
        calls.handlingFindMany.push(args);
        const status = args?.where?.status;
        return status ? handlingStore.filter((row) => row.status === status) : [...handlingStore];
      },
      upsert: async (args) => {
        calls.handlingUpsert.push(args);
        const key = args.where.sourceType_sourceId_alertType;
        const existing = handlingStore.find((row) => row.sourceType === key.sourceType && row.sourceId === key.sourceId && row.alertType === key.alertType);
        const row = existing ? { ...existing, ...args.update } : { id: "handling-1", ...args.create };
        if (existing) Object.assign(existing, row); else handlingStore.push(row);
        return config.upsertRow ?? row;
      },
      create: async (args) => { calls.handlingOther.push(args); return config.upsertRow ?? { id: "handling-1", ...args.data }; },
      update: async (args) => { calls.handlingOther.push(args); return config.upsertRow ?? { id: "handling-1", ...args.data }; },
    },
    auditEvent: { create: async (args) => { calls.auditCreate.push(args); return { id: "audit-1" }; } },
    $queryRaw: async () => { calls.queryRaw += 1; return []; },
    $executeRawUnsafe: async () => { calls.executeRawUnsafe += 1; return 1; },
  };
  client.$transaction = async (fn) => { calls.transaction += 1; return fn(client); };
  return client;
}

const serviceWith = (prisma) => new AlertsService(prisma, new AuditService(prisma));
const dailyRow = (id, alertType = "over_order", orderNo = "ORD-1", createdAt = new Date("2026-08-23T01:00:00Z")) => ({ id, alertType, orderNo, createdAt });
const qcRow = (id, orderNo = "ORD-2", createdAt = new Date("2026-08-23T02:00:00Z")) => ({ id, orderNo, createdAt });
const negativeRow = (orderNo, delta) => ({ orderNo, _sum: { quantityDelta: new Prisma.Decimal(delta) } });
const handlingRow = (overrides = {}) => ({ id: "handling-1", sourceType: "production_daily_alert", sourceId: "d-1", alertType: "over_order", status: "acknowledged", remark: "已核对", ...overrides });
const bySourceType = (data) => Object.fromEntries(data.map((row) => [row.source_type, row]));

/** 反向用例统一断言：失败路径不产生任何写入。 */
function assertNoWrites(prisma, caseName) {
  assert.equal(prisma.calls.handlingUpsert.length, 0, `${caseName}：不应 upsert alert_handling`);
  assert.equal(prisma.calls.handlingOther.length, 0, `${caseName}：不应 create/update alert_handling`);
  assert.equal(prisma.calls.sourceWrites.length, 0, `${caseName}：不应写源表`);
  assert.equal(prisma.calls.auditCreate.length, 0, `${caseName}：不应写审计事件`);
  assert.equal(prisma.handlingStore.length, 0, `${caseName}：alert_handling 不应有落库记录`);
}

// ---------------------------------------------------------------- list() 汇总

test("alerts.list_merges_three_alert_sources", async () => {
  const prisma = fakePrisma({ daily: [dailyRow("d-1")], qc: [qcRow("q-1")], negative: [negativeRow("ORD-3", "-1")] });
  const result = await serviceWith(prisma).list({});
  assert.equal(result.total, 3);
  assert.equal(result.data.length, 3);
  const byType = bySourceType(result.data);
  assert.equal(byType.production_daily_alert.source_id, "d-1");
  assert.equal(byType.production_daily_alert.severity, "high");
  assert.equal(byType.production_daily_alert.status, "pending");
  assert.equal(byType.production_daily_alert.handling_id, null);
  assert.equal(byType.production_daily_alert.remark, null);
  assert.equal(byType.finished_goods_qc.alert_type, "qc_rejected");
  assert.equal(byType.finished_goods_qc.order_no, "ORD-2");
  assert.equal(byType.inventory.alert_type, "inventory_delta");
  assert.equal(byType.inventory.severity, "medium");
  assert.equal(byType.inventory.order_no, "ORD-3");
  assert.equal(result.data.at(-1).severity, "medium", "medium 永远排在 high 之后");
});

test("alerts.list_maps_daily_alert_titles_by_alert_type", async () => {
  const prisma = fakePrisma({ daily: [dailyRow("d-1", "over_order"), dailyRow("d-2", "daily_discrepancy")] });
  const rows = (await serviceWith(prisma).list({})).data;
  const byId = Object.fromEntries(rows.map((row) => [row.source_id, row]));
  assert.equal(byId["d-1"].title, "生产超单");
  assert.equal(byId["d-1"].alert_type, "over_order");
  assert.equal(byId["d-2"].title, "生产日报差异");
  assert.equal(byId["d-2"].alert_type, "daily_discrepancy");
  assert.equal(rows.every((row) => row.severity === "high"), true);
  assert.equal(rows.every((row) => row.order_no === "ORD-1"), true);
});

test("alerts.list_pushes_query_filters_into_prisma_where", async () => {
  const prisma = fakePrisma();
  await serviceWith(prisma).list({ alert_type: "over_order", order_no: "ORD-9", status: "acknowledged", page: 1, page_size: 20 });
  assert.deepEqual(prisma.calls.dailyFindMany[0], {
    where: { deletedAt: null, status: { in: ["pending", "confirmed"] }, alertType: "over_order", orderNo: "ORD-9" },
    select: { id: true, alertType: true, orderNo: true, createdAt: true },
  });
  assert.deepEqual(prisma.calls.qcFindMany[0], {
    where: { deletedAt: null, conclusion: "rejected", orderNo: "ORD-9" },
    select: { id: true, orderNo: true, createdAt: true },
  });
  assert.deepEqual(prisma.calls.groupBy[0], { by: ["orderNo"], where: { orderNo: { not: null } }, _sum: { quantityDelta: true } });
  assert.deepEqual(prisma.calls.handlingFindMany[0], { where: { status: "acknowledged" } });
  assert.equal(prisma.calls.queryRaw, 0, "汇总路径不加行锁");
  assert.equal(prisma.calls.executeRawUnsafe, 0);
  assert.equal(prisma.calls.transaction, 0, "汇总路径不用事务");
});

test("alerts.list_omits_filters_for_blank_query_values", async () => {
  const prisma = fakePrisma();
  await serviceWith(prisma).list({ alert_type: "", order_no: "", severity: "", status: "" });
  assert.deepEqual(prisma.calls.dailyFindMany[0].where, { deletedAt: null, status: { in: ["pending", "confirmed"] } });
  assert.deepEqual(prisma.calls.qcFindMany[0].where, { deletedAt: null, conclusion: "rejected" });
  assert.deepEqual(prisma.calls.handlingFindMany[0], { where: {} }, "空串不是有效筛选条件");
});

test("alerts.list_ignores_non_negative_inventory_deltas", async () => {
  const prisma = fakePrisma({
    negative: [
      negativeRow("ORD-A", "-0.0001"),
      negativeRow("ORD-B", "0"),
      negativeRow("ORD-C", "0.0001"),
      { orderNo: "ORD-D", _sum: { quantityDelta: null } },
    ],
  });
  const result = await serviceWith(prisma).list({});
  assert.equal(result.total, 1, "只有净变动为负的分组产生告警（Decimal(18,4) 精度边界 -0.0001 也算负）");
  assert.equal(result.data[0].order_no, "ORD-A");
  assert.equal(result.data[0].severity, "medium");
  assert.equal(result.data[0].alert_type, "inventory_delta");
});

test("alerts.list_builds_inventory_source_id_from_order_no_tail", async () => {
  const prisma = fakePrisma({ negative: [negativeRow("SO-20260823-0001", "-2"), negativeRow(null, "-3")] });
  const ids = (await serviceWith(prisma).list({})).data.map((row) => row.source_id);
  assert.deepEqual(ids.slice().sort(), ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-0260823-0001"].sort());
  assert.equal(UUID_RE.test("00000000-0000-0000-0000-0260823-0001"), false, "order_no 非 UUID 时拼出的 source_id 不是合法 UUID");
  assert.equal(UUID_RE.test("00000000-0000-0000-0000-000000000000"), true);
});

test("alerts.list_deduplicates_rows_with_same_source_key", async () => {
  const prisma = fakePrisma({
    daily: [dailyRow("d-1", "over_order"), dailyRow("d-1", "over_order", "ORD-1", new Date("2026-08-23T05:00:00Z")), dailyRow("d-1", "daily_discrepancy")],
  });
  const result = await serviceWith(prisma).list({});
  assert.equal(result.total, 2, "同 source_type+source_id+alert_type 只保留一条；不同 alert_type 各自保留");
  assert.equal(result.data.filter((row) => row.alert_type === "over_order").length, 1);
});

test("alerts.list_overlays_handling_status_and_remark", async () => {
  const prisma = fakePrisma({ daily: [dailyRow("d-1")], handling: [handlingRow({ id: "h-9", status: "acknowledged", remark: "已核对日报" })] });
  const [row] = (await serviceWith(prisma).list({})).data;
  assert.equal(row.status, "acknowledged");
  assert.equal(row.handling_id, "h-9");
  assert.equal(row.remark, "已核对日报");
});

test("alerts.list_ignores_handling_from_other_source_or_alert_type", async () => {
  const prisma = fakePrisma({
    daily: [dailyRow("d-1")],
    handling: [handlingRow({ sourceId: "d-2" }), handlingRow({ alertType: "daily_discrepancy" }), handlingRow({ sourceType: "finished_goods_qc" })],
  });
  const [row] = (await serviceWith(prisma).list({})).data;
  assert.equal(row.status, "pending", "键不匹配的处理记录不得覆盖告警状态");
  assert.equal(row.handling_id, null);
  assert.equal(row.remark, null);
});

test("alerts.list_hides_alerts_without_matching_handling_when_status_filtered", async () => {
  const prisma = fakePrisma({
    daily: [dailyRow("d-1"), dailyRow("d-2")],
    handling: [handlingRow({ sourceId: "d-1", status: "resolved", remark: "已处理" })],
  });
  const resolved = await serviceWith(prisma).list({ status: "resolved" });
  assert.equal(resolved.total, 1);
  assert.equal(resolved.data[0].source_id, "d-1");
  assert.equal(resolved.data[0].status, "resolved");
  assert.equal(resolved.data[0].remark, "已处理");
});

test("alerts.list_status_pending_leaks_already_resolved_alerts", async () => {
  // KNOWN_DEFECT(apps/api/src/modules/alerts/alerts.service.ts:18-19)：
  // alert_handling 的预过滤用的是同一个 query.status，于是 status=pending 时
  // 已 acknowledged/resolved 的处理记录根本查不出来，源行硬编码的 "pending" 被原样返回，
  // 「待处理」列表把已处理告警重新暴露，handling_id / remark 一并丢失。
  // 期望：status=pending 应该返回 0 条（该告警已 resolved）。
  const prisma = fakePrisma({ daily: [dailyRow("d-1")], handling: [handlingRow({ status: "resolved", remark: "已处理" })] });
  const pending = await serviceWith(prisma).list({ status: "pending" });
  assert.equal(pending.total, 1, "已 resolved 的告警仍出现在 status=pending 列表中（缺陷）");
  assert.equal(pending.data[0].status, "pending");
  assert.equal(pending.data[0].handling_id, null, "处理记录被预过滤掉，备注同时丢失");
});

test("alerts.list_filters_by_severity_before_pagination", async () => {
  const prisma = fakePrisma({ daily: [dailyRow("d-1")], negative: [negativeRow("ORD-3", "-1")] });
  const service = serviceWith(prisma);
  const high = await service.list({ severity: "high" });
  assert.equal(high.total, 1);
  assert.equal(high.data[0].source_type, "production_daily_alert");
  const medium = await service.list({ severity: "medium" });
  assert.equal(medium.total, 1);
  assert.equal(medium.data[0].source_type, "inventory");
  assert.equal((await service.list({ severity: "low" })).total, 0, "无匹配严重度时返回空集而不是报错");
  assert.equal((await service.list({ severity: "critical" })).total, 0, "非枚举 severity 在服务层静默返回空集（DTO @IsIn 拦在 controller 层）");
});

test("alerts.list_paginates_and_reports_full_total", async () => {
  const prisma = fakePrisma({ daily: [dailyRow("d-1"), dailyRow("d-2"), dailyRow("d-3")] });
  const service = serviceWith(prisma);
  const page2 = await service.list({ page: 2, page_size: 2 });
  assert.equal(page2.total, 3, "total 是过滤后的全量，与分页无关");
  assert.equal(page2.data.length, 1);
  const page9 = await service.list({ page: 9, page_size: 2 });
  assert.equal(page9.data.length, 0, "越界页返回空数组");
  assert.equal(page9.total, 3);
  const defaults = await service.list({});
  assert.equal(defaults.data.length, 3, "默认 page=1 / page_size=20");
});

test("alerts.list_caps_page_size_at_200", async () => {
  const daily = Array.from({ length: 250 }, (_, index) => dailyRow(`d-${index}`));
  const prisma = fakePrisma({ daily });
  const result = await serviceWith(prisma).list({ page_size: 1000 });
  assert.equal(result.total, 250);
  assert.equal(result.data.length, 200, "单页最多 200 条");
});

test("alerts.list_page_size_boundaries_are_unvalidated", async () => {
  // 输入校验缺口：AlertsController 的 AlertQuery 对 page / page_size 只有 @IsOptional()，
  // 没有 @IsInt/@Min（apps/api/src/modules/alerts/alerts.controller.ts:9），查询串原样进入服务层。
  const daily = Array.from({ length: 10 }, (_, index) => dailyRow(`d-${index}`));
  const prisma = fakePrisma({ daily });
  const service = serviceWith(prisma);
  const zero = await service.list({ page_size: "0" });
  assert.equal(zero.total, 10);
  assert.deepEqual(zero.data, [], "page_size=0 得到 data 为空但 total=10 的自相矛盾响应");
  const negative = await service.list({ page_size: "-5" });
  assert.equal(negative.total, 10);
  assert.equal(negative.data.length, 5, "负 page_size 直接走 Array.slice 的负索引语义");
});

// ---------------------------------------------------------------- handle() 写入

test("alerts.handle_daily_alert_upserts_handling_and_audits", async () => {
  const prisma = fakePrisma({ dailySource: { id: "d-1", alertType: "over_order", orderNo: "ORD-1" } });
  const row = await serviceWith(prisma).handle("d-1", "acknowledged", "  已核对  ", USER);
  assert.equal(row.id, "handling-1");
  assert.deepEqual(prisma.calls.dailyFindFirst[0], { where: { id: "d-1", deletedAt: null }, select: { id: true, alertType: true, orderNo: true } });
  const upsert = prisma.calls.handlingUpsert[0];
  assert.deepEqual(upsert.where, { sourceType_sourceId_alertType: { sourceType: "production_daily_alert", sourceId: "d-1", alertType: "over_order" } });
  assert.deepEqual(upsert.create, {
    sourceType: "production_daily_alert", sourceId: "d-1", alertType: "over_order",
    status: "acknowledged", remark: "已核对", createdBy: "user-1", updatedBy: "user-1",
  });
  assert.deepEqual(upsert.update, { status: "acknowledged", remark: "已核对", updatedBy: "user-1" });
  assert.equal("createdBy" in upsert.update, false, "更新分支不得改写 createdBy");
  assert.deepEqual(prisma.calls.auditCreate[0].data, {
    action: "alert.acknowledged", entityType: "alert_handling", actorId: "user-1", entityId: "handling-1",
    details: { source_type: "production_daily_alert", source_id: "d-1", alert_type: "over_order", remark: "已核对" },
  });
});

test("alerts.handle_resolved_status_records_resolved_audit_action", async () => {
  const prisma = fakePrisma({ dailySource: { id: "d-1", alertType: "daily_discrepancy", orderNo: "ORD-1" } });
  await serviceWith(prisma).handle("d-1", "resolved", "已修复差异", USER);
  assert.equal(prisma.calls.handlingUpsert[0].create.status, "resolved");
  assert.equal(prisma.calls.handlingUpsert[0].update.status, "resolved");
  assert.equal(prisma.calls.auditCreate[0].data.action, "alert.resolved");
  assert.equal(prisma.calls.auditCreate[0].data.details.remark, "已修复差异");
});

test("alerts.handle_prefers_daily_source_before_qc", async () => {
  const prisma = fakePrisma({ dailySource: { id: "d-1", alertType: "over_order", orderNo: "ORD-1" }, qcSource: { id: "q-1", orderNo: "ORD-2" } });
  await serviceWith(prisma).handle("d-1", "acknowledged", "备注", USER);
  assert.equal(prisma.calls.dailyFindFirst.length, 1);
  assert.equal(prisma.calls.qcFindFirst.length, 0, "日报命中后短路，不再查 QC");
});

test("alerts.handle_falls_back_to_qc_record", async () => {
  const prisma = fakePrisma({ dailySource: null, qcSource: { id: "q-1", orderNo: "ORD-2" } });
  await serviceWith(prisma).handle("q-1", "acknowledged", "重新送检", USER);
  assert.deepEqual(prisma.calls.qcFindFirst[0], { where: { id: "q-1", deletedAt: null }, select: { id: true, orderNo: true } });
  assert.deepEqual(prisma.calls.handlingUpsert[0].where.sourceType_sourceId_alertType, { sourceType: "finished_goods_qc", sourceId: "q-1", alertType: "qc_rejected" });
  assert.equal(prisma.calls.handlingUpsert[0].create.status, "acknowledged");
});

test("alerts.handle_unknown_alert_is_rejected_without_writes", async () => {
  const prisma = fakePrisma({ dailySource: null, qcSource: null });
  await assert.rejects(
    () => serviceWith(prisma).handle("missing", "acknowledged", "备注", USER),
    (error) => error.getStatus() === 404 && error.getResponse().code === "ALERT_NOT_FOUND",
  );
  assertNoWrites(prisma, "未知告警");
});

test("alerts.handle_blank_remark_is_rejected_without_writes", async () => {
  for (const remark of ["", "   ", "\n\t", undefined, null]) {
    const prisma = fakePrisma({ dailySource: { id: "d-1", alertType: "over_order", orderNo: "ORD-1" } });
    await assert.rejects(
      () => serviceWith(prisma).handle("d-1", "acknowledged", remark, USER),
      (error) => error.getStatus() === 422 && error.getResponse().code === "ALERT_REMARK_REQUIRED",
    );
    assertNoWrites(prisma, `备注=${JSON.stringify(remark) ?? String(remark)}`);
  }
});

test("alerts.handle_not_found_wins_over_blank_remark", async () => {
  const prisma = fakePrisma({ dailySource: null, qcSource: null });
  await assert.rejects(
    () => serviceWith(prisma).handle("missing", "acknowledged", "   ", USER),
    (error) => error.getResponse().code === "ALERT_NOT_FOUND",
  );
  assertNoWrites(prisma, "未知告警 + 空备注");
});

test("alerts.handle_persists_remark_boundary_lengths", async () => {
  const boundary = fakePrisma({ dailySource: { id: "d-1", alertType: "over_order", orderNo: "ORD-1" } });
  await serviceWith(boundary).handle("d-1", "acknowledged", `  ${"备".repeat(1000)}  `, USER);
  assert.equal(boundary.calls.handlingUpsert[0].create.remark.length, 1000, "去掉首尾空白后正好 1000 字");
  const tooLong = fakePrisma({ dailySource: { id: "d-1", alertType: "over_order", orderNo: "ORD-1" } });
  await serviceWith(tooLong).handle("d-1", "acknowledged", "备".repeat(1001), USER);
  assert.equal(tooLong.calls.handlingUpsert[0].create.remark.length, 1001, "服务层不校验长度，超长只由 controller 的 @MaxLength(1000) 拦截");
});

test("alerts.handle_accepts_any_status_string_at_service_layer", async () => {
  // 非法输入边界：service 对 status 没有白名单，status="pending" 会被当成正常状态写库并写审计；
  // 拦截只发生在 controller DTO 的 @IsIn(["acknowledged","resolved"])（alerts.controller.ts:10）。
  const prisma = fakePrisma({ dailySource: { id: "d-1", alertType: "over_order", orderNo: "ORD-1" } });
  await serviceWith(prisma).handle("d-1", "pending", "备注", USER);
  assert.equal(prisma.calls.handlingUpsert[0].create.status, "pending");
  assert.equal(prisma.calls.auditCreate[0].data.action, "alert.pending");
});

test("alerts.handle_only_writes_alert_handling_not_source_status", async () => {
  // KNOWN_DEFECT(apps/api/src/modules/alerts/alerts.service.ts:21)：
  // handle() 只 upsert alert_handling + 写审计，完全没有回写源表状态。
  // 复现：处理一条生产日报超单告警后，production_daily_alerts.status 仍是 "pending"，
  //      生产进度仍用源表 status 判定 blocker（production-progress.service.ts:170
  //      「over_order_unconfirmed」），处理过的告警继续挂着待处理标记。
  const prisma = fakePrisma({ daily: [dailyRow("d-1")], dailySource: { id: "d-1", alertType: "over_order", orderNo: "ORD-1" } });
  const service = serviceWith(prisma);
  await service.handle("d-1", "resolved", "已核对并恢复", USER);
  assert.equal(prisma.handlingStore.length, 1, "只落一行 alert_handling");
  assert.equal(prisma.handlingStore[0].status, "resolved");
  assert.equal(prisma.calls.sourceWrites.length, 0, "源表 production_daily_alert / finished_goods_qc 未被写入（缺陷）");
  assert.equal(prisma.calls.transaction, 0, "处理流程没有事务包裹");
  const [row] = (await service.list({})).data;
  assert.equal(row.status, "resolved", "列表仅靠 alert_handling 覆盖状态");
  assert.deepEqual(prisma.calls.dailyFindMany[0].where.status, { in: ["pending", "confirmed"] }, "源行仍是 pending，依旧落在待办查询窗口内");
});

test("alerts.handle_inventory_alert_is_never_resolvable", async () => {
  // KNOWN_DEFECT(apps/api/src/modules/alerts/alerts.service.ts:17,22)：
  // 库存告警的 source_id 由 order_no 尾部拼成（非 UUID），而 findSource() 只查
  // production_daily_alert / finished_goods_qc；alert_handling.source_id 又是 @db.Uuid
  // （apps/api/prisma/schema.prisma:2217）。列表里出现的库存告警永远无法被处理。
  const prisma = fakePrisma({ negative: [negativeRow("SO-20260823-0001", "-1")] });
  const service = serviceWith(prisma);
  const listed = await service.list({});
  assert.equal(listed.total, 1);
  const sourceId = listed.data[0].source_id;
  assert.equal(sourceId, "00000000-0000-0000-0000-0260823-0001");
  assert.equal(UUID_RE.test(sourceId), false, "库存告警 id 不是合法 UUID");
  await assert.rejects(
    () => service.handle(sourceId, "acknowledged", "已核对", USER),
    (error) => error.getResponse().code === "ALERT_NOT_FOUND",
  );
  assertNoWrites(prisma, "库存告警处理");
});

// ---------------------------------------------------------------- 去重排序（领域函数）

test("alerts.deduplicate_sorts_medium_by_time_but_not_high", () => {
  const row = (id, severity, time) => ({ source_type: "production_daily_alert", source_id: id, alert_type: "over_order", order_no: "ORD-1", severity, title: "t", suggestion: "s", status: "pending", created_at: new Date(time) });
  assert.deepEqual(
    deduplicateAlerts([row("m-old", "medium", "2026-01-01T00:00:00Z"), row("m-new", "medium", "2026-12-31T00:00:00Z")]).map((item) => item.source_id),
    ["m-new", "m-old"],
    "medium 行按时间倒序",
  );
  // KNOWN_DEFECT(apps/api/src/modules/alerts/alerts.domain.ts:3)：比较器写成
  // `a.severity === "high" ? -1 : b.severity === "high" ? 1 : b.created_at - a.created_at`，
  // 两条 high 相比时恒返回 -1（既不自洽也不看时间）。断言与排序实现无关的性质：
  // 两种输入顺序里至少有一种得不到「时间倒序」，即 high 行的时间倒序意图未生效。
  const newer = row("h-new", "high", "2026-12-31T00:00:00Z");
  const older = row("h-old", "high", "2026-01-01T00:00:00Z");
  const allDescending = [[newer, older], [older, newer]].every((pair) => {
    const times = deduplicateAlerts(pair).map((item) => item.created_at.valueOf());
    return times[0] >= times[1];
  });
  assert.equal(allDescending, false, "high 行未按时间倒序（较早的告警可能排到较新的前面）");
  const mixed = deduplicateAlerts([older, newer, row("m-1", "medium", "2026-06-01T00:00:00Z")]).map((item) => item.severity);
  assert.deepEqual([...new Set(mixed)], ["high", "medium"], "high 仍整体优先于 medium");
});
