// 生产日报告警：确认 / 恢复后确认门禁 / 合并异常处理 / 审计事件写入。
//
// 被测实现：apps/api/src/modules/production/production-daily-alerts.service.ts（require 编译产物 dist）
// 依赖：PrismaService（手写假 client）、AuditService（记录 auditEvent.create 的行为）、
//       ProductionDailyAlertsController 的 ConfirmAlertDto(@IsString @MaxLength(1000))。
// 约定：断言机器码、断言传给 Prisma 的 where/data 形状、断言失败路径不产生任何写入。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ProductionDailyAlertsService } = require("../../dist/modules/production/production-daily-alerts.service.js");

const USER = { id: "user-1" };

function alertRow(overrides = {}) {
  return {
    id: "alert-1",
    alertType: "daily_discrepancy",
    productionOrderId: "order-1",
    productionOrderOperationId: "op-1",
    orderNo: "ORD-1",
    reportDate: new Date("2026-09-03T00:00:00.000Z"),
    status: "pending",
    confirmRemark: null,
    confirmedBy: null,
    confirmedAt: null,
    recoveredAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function anomalyRow(overrides = {}) {
  return {
    id: "anomaly-1",
    reportKind: "employee",
    productionOrderOperationId: "op-1",
    employeeId: "emp-1",
    reportDate: new Date("2026-09-03T00:00:00.000Z"),
    status: "pending",
    resolvedAt: null,
    ...overrides,
  };
}

/**
 * 手写假 Prisma：默认所有读返回可配置的行，所有写记录调用参数到 calls，绝不连真库。
 * $queryRaw / $queryRawUnsafe 也提供桩（本服务未使用行锁，桩用于断言「确实没有加锁」）。
 */
function harness({ row = alertRow(), anomaly = anomalyRow(), listRows = [], auditEventPage = [], onAlertRead } = {}) {
  const calls = {
    alertFindFirst: [],
    alertFindMany: [],
    alertUpdate: [],
    anomalyFindMany: [],
    anomalyFindUnique: [],
    anomalyUpdate: [],
    auditCreate: [],
    auditFindMany: [],
    transactions: 0,
    txRawQueries: 0,
    txAlertReads: 0,
  };

  const tx = {
    productionDailyAlert: {
      findFirst: async () => {
        calls.txAlertReads += 1;
        return row;
      },
      findUnique: async () => {
        calls.txAlertReads += 1;
        return row;
      },
      update: async (args) => {
        calls.alertUpdate.push(args);
        return { ...row, ...args.data };
      },
    },
    dailyReportMergeAnomaly: {
      findUnique: async (args) => {
        calls.anomalyFindUnique.push(args);
        return anomaly;
      },
      update: async (args) => {
        calls.anomalyUpdate.push(args);
        return { ...anomaly, ...args.data };
      },
    },
    auditEvent: {
      create: async (args) => {
        calls.auditCreate.push(args);
        return args.data;
      },
    },
    $queryRaw: async () => {
      calls.txRawQueries += 1;
      return [];
    },
    $queryRawUnsafe: async () => {
      calls.txRawQueries += 1;
      return [];
    },
  };

  const prisma = {
    productionDailyAlert: {
      findFirst: async (args) => {
        calls.alertFindFirst.push(args);
        return onAlertRead ? onAlertRead() : row;
      },
      findMany: async (args) => {
        calls.alertFindMany.push(args);
        return listRows;
      },
    },
    dailyReportMergeAnomaly: {
      findMany: async (args) => {
        calls.anomalyFindMany.push(args);
        return listRows;
      },
    },
    auditEvent: {
      findMany: async (args) => {
        calls.auditFindMany.push(args);
        return auditEventPage;
      },
    },
    $transaction: async (fn) => {
      calls.transactions += 1;
      return fn(tx);
    },
    $queryRaw: async () => [],
    $queryRawUnsafe: async () => [],
  };

  const auditCalls = [];
  const audit = {
    calls: auditCalls,
    record: async (...args) => {
      auditCalls.push(args);
    },
  };

  return { service: new ProductionDailyAlertsService(prisma, audit), prisma, tx, audit, calls };
}

/** 断言 Nest 异常的机器码（必要时同时断言 HTTP 状态码）。 */
function hasCode(code, status) {
  return (error) => {
    const body = error && typeof error.getResponse === "function" ? error.getResponse() : {};
    assert.equal(body.code, code);
    if (status !== undefined) {
      assert.equal(typeof error.getStatus === "function" ? error.getStatus() : undefined, status);
    }
    return true;
  };
}

function assertNoWrites(calls, audit) {
  assert.equal(calls.transactions, 0, "非法输入不得开启事务");
  assert.equal(calls.alertUpdate.length, 0, "非法输入不得更新告警");
  assert.equal(calls.anomalyUpdate.length, 0, "非法输入不得更新异常");
  assert.equal(calls.auditCreate.length, 0, "非法输入不得写事务内审计事件");
  assert.equal(audit.calls.length, 0, "非法输入不得写外部审计记录");
}

// ---------------------------------------------------------------- list

test("production-daily-alerts.list_defaults_to_active_rows_with_relations_and_fixed_sort", async () => {
  const { service, calls } = harness({ listRows: [alertRow()] });
  const rows = await service.list({});
  const args = calls.alertFindMany[0];
  assert.equal(calls.alertFindMany.length, 1);
  assert.deepEqual(args.where, { deletedAt: null });
  assert.deepEqual(args.include, { productionOrder: true, productionOrderOperation: true });
  assert.deepEqual(args.orderBy, [{ status: "asc" }, { reportDate: "desc" }, { updatedAt: "desc" }]);
  assert.equal(rows.length, 1);
});

test("production-daily-alerts.list_maps_every_snake_case_filter_to_its_prisma_field", async () => {
  const { service, calls } = harness();
  await service.list({
    alert_type: "daily_discrepancy",
    status: "pending",
    order_no: "ORD-1",
    production_order_id: "order-1",
    production_order_operation_id: "op-1",
    report_date: "2026-09-03",
  });
  assert.deepEqual(calls.alertFindMany[0].where, {
    deletedAt: null,
    alertType: "daily_discrepancy",
    status: "pending",
    orderNo: "ORD-1",
    productionOrderId: "order-1",
    productionOrderOperationId: "op-1",
    reportDate: new Date("2026-09-03T00:00:00.000Z"),
  });
});

test("production-daily-alerts.list_ignores_empty_string_filters", async () => {
  const { service, calls } = harness();
  await service.list({ alert_type: "", status: "", order_no: "", production_order_id: "", production_order_operation_id: "", report_date: "" });
  assert.deepEqual(calls.alertFindMany[0].where, { deletedAt: null });
});

test("production-daily-alerts.list_report_date_filter_is_utc_midnight_of_that_day", async () => {
  const { service, calls } = harness();
  await service.list({ report_date: "2026-01-01" });
  const value = calls.alertFindMany[0].where.reportDate;
  assert.ok(value instanceof Date);
  assert.equal(value.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(value.getUTCHours(), 0);
});

test("production-daily-alerts.list_report_date_is_unvalidated_so_invalid_days_roll_over_or_arrive_as_invalid_date", async () => {
  // 非法输入未被拒绝：list 的 query 没有 DTO（controller 第 18 行用裸对象），
  // 服务直接拼接 `${report_date}T00:00:00.000Z`（实现第 13 行）。
  // 疑似缺陷（低危，未验证是否为预期）：report_date=2026-02-30 被 Date 静默滚到 3 月 2 日，
  // 于是查询落到「另一天」的告警上，既不报错也不返回空。
  const { service, calls } = harness();
  await service.list({ report_date: "2026-02-30" });
  assert.equal(calls.alertFindMany[0].where.reportDate.toISOString(), "2026-03-02T00:00:00.000Z");
  // 月份越界 → Invalid Date，非法值直接交给 Prisma（而非 422 拒绝）。
  await service.list({ report_date: "2026-13-45" });
  assert.ok(Number.isNaN(calls.alertFindMany[1].where.reportDate.getTime()));
  // 带时间部分的 ISO 串被拼接后成为 Invalid Date。
  await service.list({ report_date: "2026-09-03T10:00:00.000Z" });
  assert.ok(Number.isNaN(calls.alertFindMany[2].where.reportDate.getTime()));
});

test("production-daily-alerts.list_returns_repository_rows_unchanged", async () => {
  const rows = [alertRow({ id: "alert-a" }), alertRow({ id: "alert-b", status: "confirmed" })];
  const { service } = harness({ listRows: rows });
  assert.equal(await service.list({}), rows);
});

// ----------------------------------------------------------------- get

test("production-daily-alerts.get_missing_alert_throws_not_found_code", async () => {
  const { service } = harness({ row: null });
  await assert.rejects(() => service.get("alert-404"), hasCode("PRODUCTION_DAILY_ALERT_NOT_FOUND", 404));
});

test("production-daily-alerts.get_scopes_query_to_id_and_soft_delete_null_with_relations", async () => {
  const { service, calls } = harness();
  const row = await service.get("alert-1");
  assert.deepEqual(calls.alertFindFirst[0], {
    where: { id: "alert-1", deletedAt: null },
    include: { productionOrder: true, productionOrderOperation: true },
  });
  assert.equal(row.id, "alert-1");
});

// ------------------------------------------------------------- confirm

test("production-daily-alerts.confirm_blank_remark_rejected_with_422_code_and_no_write", async () => {
  for (const remark of [undefined, null, "", "   ", "\n\t "]) {
    const { service, calls, audit } = harness();
    await assert.rejects(() => service.confirm("alert-1", remark, USER), hasCode("ALERT_CONFIRM_REMARK_REQUIRED", 422));
    assert.equal(calls.alertFindFirst.length, 0, "备注校验必须早于读取告警");
    assertNoWrites(calls, audit);
  }
});

test("production-daily-alerts.confirm_recovered_alert_is_rejected_without_any_write", async () => {
  const { service, calls, audit } = harness({ row: alertRow({ status: "recovered", recoveredAt: new Date("2026-09-04T00:00:00.000Z") }) });
  await assert.rejects(() => service.confirm("alert-1", "已核对", USER), hasCode("RECOVERED_ALERT_CANNOT_CONFIRM", 422));
  assert.equal(calls.alertFindFirst.length, 1);
  assertNoWrites(calls, audit);
});

test("production-daily-alerts.confirm_missing_alert_throws_not_found_and_writes_nothing", async () => {
  const { service, calls, audit } = harness({ row: null });
  await assert.rejects(() => service.confirm("alert-404", "已核对", USER), hasCode("PRODUCTION_DAILY_ALERT_NOT_FOUND", 404));
  assertNoWrites(calls, audit);
});

test("production-daily-alerts.confirm_persists_status_remark_actor_and_timestamps", async () => {
  const { service, calls } = harness({ row: alertRow({ status: "pending" }) });
  const result = await service.confirm("alert-1", "已核对并放行", USER);
  assert.equal(calls.alertUpdate.length, 1);
  assert.deepEqual(calls.alertUpdate[0].where, { id: "alert-1" });
  const data = calls.alertUpdate[0].data;
  assert.equal(data.status, "confirmed");
  assert.equal(data.confirmRemark, "已核对并放行");
  assert.equal(data.confirmedBy, USER.id);
  assert.equal(data.updatedBy, USER.id);
  assert.ok(data.confirmedAt instanceof Date && !Number.isNaN(data.confirmedAt.getTime()));
  // 不写 recoveredAt / deletedAt 等无关字段
  assert.deepEqual(Object.keys(data).sort(), ["confirmRemark", "confirmedAt", "confirmedBy", "status", "updatedBy"]);
  assert.equal(result.status, "confirmed");
});

test("production-daily-alerts.confirm_transaction_audit_event_carries_before_and_after_status", async () => {
  const { service, calls } = harness({ row: alertRow({ status: "pending", orderNo: "ORD-9", alertType: "over_order" }) });
  await service.confirm("alert-1", "已核对", USER);
  assert.equal(calls.auditCreate.length, 1);
  assert.deepEqual(calls.auditCreate[0].data, {
    action: "production_daily_alert.confirm",
    entityType: "production_daily_alert",
    actorId: USER.id,
    entityId: "alert-1",
    details: { order_no: "ORD-9", alert_type: "over_order", remark: "已核对", before_status: "pending", after_status: "confirmed" },
  });
});

test("production-daily-alerts.confirm_writes_the_same_action_twice_into_audit_events", async () => {
  // KNOWN_DEFECT：一次 confirm 会产出两条同一 action 的审计行 ——
  // 事务内 tx.auditEvent.create（实现第 28 行）与事务外 this.audit.record（第 31 行），
  // 二者都写 audit_events 表（schema.prisma:219-232，AuditService 第 14-16 行）。
  // 期望：单次确认只留一条 production_daily_alert.confirm 审计行（或二者语义明确区分）。
  // 实际：/production/daily-alerts/:id/audit-events 会返回两行内容近似但 details 不同的记录。
  // 责任位置：apps/api/src/modules/production/production-daily-alerts.service.ts:28,31
  const { service, calls, audit } = harness();
  await service.confirm("alert-1", "已核对", USER);
  assert.equal(calls.auditCreate.length, 1, "事务内审计事件");
  assert.equal(audit.calls.length, 1, "事务外审计记录");
  assert.equal(calls.auditCreate[0].data.action, "production_daily_alert.confirm");
  assert.deepEqual(audit.calls[0], [
    "production_daily_alert.confirm",
    "production_daily_alert",
    USER.id,
    "alert-1",
    { order_no: "ORD-1", alert_type: "daily_discrepancy", remark: "已核对" },
  ]);
});

test("production-daily-alerts.confirm_already_confirmed_alert_is_not_blocked", async () => {
  // 隐藏分支：唯一状态门禁是 recovered；confirmed 可以被重复确认并再次写审计。
  const { service, calls, audit } = harness({ row: alertRow({ status: "confirmed", confirmRemark: "上一次备注" }) });
  const result = await service.confirm("alert-1", "再次确认", USER);
  assert.equal(result.status, "confirmed");
  assert.equal(calls.alertUpdate.length, 1);
  assert.equal(calls.auditCreate.length, 1);
  assert.equal(calls.auditCreate[0].data.details.before_status, "confirmed");
  assert.equal(audit.calls.length, 1);
});

test("production-daily-alerts.confirm_does_not_recheck_status_inside_the_transaction", async () => {
  // KNOWN_DEFECT：状态门禁只用事务外的 get()（第 24-25 行），事务内既不加行锁
  // （无 $queryRaw `... FOR UPDATE`，对比 payroll-ledger.service.ts:84 的写法）也不重读行，
  // 因此 get 与 update 之间若告警被 recover，confirm 仍会把 status 覆盖回 confirmed。
  // 复现：并发 recover 后 confirm → 期望 422 RECOVERED_ALERT_CANNOT_CONFIRM，实际写入 confirmed。
  // 责任位置：apps/api/src/modules/production/production-daily-alerts.service.ts:24-27
  const { service, calls } = harness({ row: alertRow({ status: "pending" }) });
  await service.confirm("alert-1", "已核对", USER);
  assert.equal(calls.txRawQueries, 0, "事务内没有行锁");
  assert.equal(calls.txAlertReads, 0, "事务内没有重读状态");
  assert.equal(calls.alertUpdate[0].data.status, "confirmed", "陈旧读取的 pending 被无条件写成 confirmed");
});

test("production-daily-alerts.confirm_accepts_1000_char_remark_and_passes_longer_input_through", async () => {
  // 边界：备注长度限制在 DTO 层（ConfirmAlertDto @MaxLength(1000)，controller 第 10 行），
  // 服务层没有长度校验 —— 锁定该分工，避免以后误以为服务会拒绝超长备注。
  const atLimit = "备".repeat(1000);
  const { service, calls } = harness();
  await service.confirm("alert-1", atLimit, USER);
  assert.equal(calls.alertUpdate[0].data.confirmRemark.length, 1000);

  const overLimit = harness();
  await overLimit.service.confirm("alert-1", "备".repeat(1001), USER);
  assert.equal(overLimit.calls.alertUpdate[0].data.confirmRemark.length, 1001);
});

test("production-daily-alerts.confirm_persists_remark_verbatim_while_merge_anomaly_trims", async () => {
  // 观察（未验证是否为预期）：同文件的 resolveMergeAnomaly 写库用 remark.trim()，
  // 而 confirm 只在校验时 trim，落库保留原始空白。前端与 /alerts/:id/handle（会 trim）联动时，
  // 同一句备注在两张表里可能一个带空白、一个不带。
  const { service, calls } = harness();
  await service.confirm("alert-1", "  已核对  ", USER);
  assert.equal(calls.alertUpdate[0].data.confirmRemark, "  已核对  ");
  assert.equal(calls.auditCreate[0].data.details.remark, "  已核对  ");
});

// -------------------------------------------------------- auditEvents

test("production-daily-alerts.auditEvents_requires_an_existing_alert", async () => {
  const { service, calls } = harness({ row: null });
  await assert.rejects(() => service.auditEvents("alert-404"), hasCode("PRODUCTION_DAILY_ALERT_NOT_FOUND", 404));
  assert.equal(calls.auditFindMany.length, 0, "告警不存在时不得查询审计历史");
});

test("production-daily-alerts.auditEvents_queries_entity_history_newest_first", async () => {
  const events = [{ id: "audit-1", action: "production_daily_alert.confirm" }];
  const { service, calls } = harness({ auditEventPage: events });
  assert.equal(await service.auditEvents("alert-1"), events);
  assert.deepEqual(calls.auditFindMany[0], {
    where: { entityType: "production_daily_alert", entityId: "alert-1" },
    orderBy: { createdAt: "desc" },
  });
});

// --------------------------------------------------- listMergeAnomalies

test("production-daily-alerts.listMergeAnomalies_without_status_omits_the_where_filter", async () => {
  const { service, calls } = harness();
  await service.listMergeAnomalies();
  assert.equal(calls.anomalyFindMany.length, 1);
  assert.equal(calls.anomalyFindMany[0].where, undefined);
  assert.deepEqual(calls.anomalyFindMany[0].orderBy, [{ status: "asc" }, { reportDate: "desc" }]);
});

test("production-daily-alerts.listMergeAnomalies_scopes_to_requested_status", async () => {
  const { service, calls } = harness();
  await service.listMergeAnomalies("pending");
  assert.deepEqual(calls.anomalyFindMany[0].where, { status: "pending" });
  await service.listMergeAnomalies("");
  assert.equal(calls.anomalyFindMany[1].where, undefined, "空串与未传等价");
});

// ------------------------------------------------ resolveMergeAnomaly

test("production-daily-alerts.resolveMergeAnomaly_blank_remark_rejected_with_422_and_no_write", async () => {
  for (const remark of [undefined, "", "  "]) {
    const { service, calls, audit } = harness();
    await assert.rejects(() => service.resolveMergeAnomaly("anomaly-1", remark, USER), hasCode("ANOMALY_RESOLUTION_REMARK_REQUIRED", 422));
    assert.equal(calls.anomalyFindUnique.length, 0, "备注校验必须早于读取异常");
    assertNoWrites(calls, audit);
  }
});

test("production-daily-alerts.resolveMergeAnomaly_missing_anomaly_throws_not_found_and_skips_outer_audit", async () => {
  const { service, calls, audit } = harness({ anomaly: null });
  await assert.rejects(() => service.resolveMergeAnomaly("anomaly-404", "已核对", USER), hasCode("DAILY_REPORT_MERGE_ANOMALY_NOT_FOUND", 404));
  assert.equal(calls.anomalyUpdate.length, 0);
  assert.equal(calls.auditCreate.length, 0);
  assert.equal(audit.calls.length, 0, "事务内抛错后不得再写事务外审计");
});

test("production-daily-alerts.resolveMergeAnomaly_marks_resolved_and_audits_the_trimmed_remark", async () => {
  const { service, calls, audit } = harness({ anomaly: anomalyRow({ reportKind: "employee" }) });
  const result = await service.resolveMergeAnomaly("anomaly-1", "  已核对并保留人工计薪差异  ", USER);
  assert.equal(calls.anomalyFindUnique[0].where.id, "anomaly-1");
  assert.equal(calls.anomalyUpdate[0].where.id, "anomaly-1");
  assert.equal(calls.anomalyUpdate[0].data.status, "resolved");
  assert.ok(calls.anomalyUpdate[0].data.resolvedAt instanceof Date);
  // 2026-09-16 全站治理：行上要自带「谁解决的」，界面才能显示「最后修改人」而不是去翻审计表。
  assert.equal(calls.anomalyUpdate[0].data.updatedBy, USER.id);
  assert.equal(calls.auditCreate[0].data.action, "daily_report_merge_anomaly.resolve");
  assert.equal(calls.auditCreate[0].data.entityType, "daily_report_merge_anomaly");
  assert.equal(calls.auditCreate[0].data.actorId, USER.id);
  assert.equal(calls.auditCreate[0].data.entityId, "anomaly-1");
  assert.deepEqual(calls.auditCreate[0].data.details, { report_kind: "employee", remark: "已核对并保留人工计薪差异" });
  assert.deepEqual(audit.calls[0], ["daily_report_merge_anomaly.resolve", "daily_report_merge_anomaly", USER.id, "anomaly-1", { remark: "已核对并保留人工计薪差异" }]);
  assert.equal(result.status, "resolved");
});

test("production-daily-alerts.resolveMergeAnomaly_already_resolved_is_a_noop_but_still_writes_outer_audit", async () => {
  // 观察（未验证是否为预期）：已在 resolved 时事务内直接返回 current（第 46 行），
  // 不 update、不写事务内审计，但事务外的 audit.record（第 51 行）照旧执行，
  // 于是「无状态变更」也会留下一条 resolve 审计行（且 details 里没有 report_kind，与正常路径不一致）。
  const anomaly = anomalyRow({ status: "resolved", resolvedAt: new Date("2026-09-04T00:00:00.000Z") });
  const { service, calls, audit } = harness({ anomaly });
  const result = await service.resolveMergeAnomaly("anomaly-1", "重复提交", USER);
  assert.equal(result, anomaly, "已处理时原样返回当前行");
  assert.equal(calls.anomalyUpdate.length, 0, "不得重复更新");
  assert.equal(calls.auditCreate.length, 0, "不得重复写事务内审计");
  assert.equal(audit.calls.length, 1, "事务外审计仍会写入");
});
