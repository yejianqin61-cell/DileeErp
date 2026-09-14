const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException, NotFoundException, UnprocessableEntityException } = require("@nestjs/common");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { dailyCodePrefix } = require("../../dist/platform/database/daily-sequence-code.js");
const { ProcurementMasterDataService } = require("../../dist/modules/procurement/procurement-master-data.service.js");

// 采购主数据（单位 / 物料 / 供应商）的服务层行为契约。
// 断言口径：返回值 + Nest 异常的机器码（getResponse().code）+ 传给 Prisma 的查询形状（where / data）。
// 每个反向用例同时断言「失败时没有落库」：create/update 未被调用、或至少没有假审计记录。
// 用真 AuditService + 假 prisma：audit.record 最终打到的 prisma.auditEvent.create 是可观察的外部行为。

const USER = { id: "00000000-0000-0000-0000-0000000000aa", username: "tester", display_name: "测试" };
const UNIT_ID = "11111111-1111-1111-1111-111111111111";
const NEW_UNIT_ID = "11111111-1111-1111-1111-1111111111ff";
const MATERIAL_ID = "22222222-2222-2222-2222-222222222222";
const SUPPLIER_ID = "33333333-3333-3333-3333-333333333333";
const MAT_PREFIX = dailyCodePrefix("MAT");
const SUP_PREFIX = dailyCodePrefix("SUP");

function p2002(target) {
  const error = new Error("unique constraint failed");
  error.code = "P2002";
  if (target !== undefined) error.meta = { target };
  return error;
}

function makeHarness(options = {}) {
  const calls = {
    unit: { findFirst: [], findMany: [], create: [], update: [], count: [] },
    material: { findFirst: [], findMany: [], create: [], update: [], count: [] },
    supplier: { findFirst: [], findMany: [], create: [], update: [], count: [] },
    bomItem: { count: [] },
    operationCatalog: { count: [] },
    productionOrderOperation: { count: [] },
    purchaseOrder: { count: [] },
    purchaseOrderItem: { count: [] },
    auditEvent: { create: [] },
    locks: [],
    transactions: 0,
  };
  const rows = {
    unit: options.unitRow === undefined ? { id: UNIT_ID, name: "米", isActive: true, deletedAt: null, deletedBy: null } : options.unitRow,
    material: options.materialRow === undefined ? { id: MATERIAL_ID, name: "伞布", materialCode: "MAT-1", deletedAt: null } : options.materialRow,
    supplier: options.supplierRow === undefined ? { id: SUPPLIER_ID, name: "布料厂", supplierCode: "SUP-1", deletedAt: null } : options.supplierRow,
  };
  const queues = options.findFirstQueue ?? {};

  const findFirstFor = (kind) => async (args) => {
    calls[kind].findFirst.push(args);
    const queue = queues[kind];
    if (Array.isArray(queue)) return queue.length > 1 ? queue.shift() : queue[0] ?? null;
    const where = args?.where ?? {};
    // restoreUnit 用 deletedAt: { not: null } 找软删行；requireX 用 deletedAt: null 找存活行。
    if (where.deletedAt !== null && typeof where.deletedAt === "object" && where.deletedAt !== undefined) return options.deletedRow?.[kind] ?? null;
    const row = rows[kind];
    if (!row) return null;
    if (where.isActive === true && row.isActive !== true) return null;
    return row;
  };
  const findManyFor = (kind) => async (args) => {
    calls[kind].findMany.push(args);
    // 自动编码走 select: { materialCode: true } / { supplierCode: true }，所以这里返回行对象而不是裸字符串。
    if (kind === "material") return (options.codes?.material ?? []).map((code) => ({ materialCode: code }));
    if (kind === "supplier") return (options.codes?.supplier ?? []).map((code) => ({ supplierCode: code }));
    return options.codes?.unit ?? [];
  };
  const createFor = (kind) => async (args) => {
    calls[kind].create.push(args);
    if (options.createError?.[kind]) throw options.createError[kind];
    return { id: `${kind}-created`, ...args.data };
  };
  const updateFor = (kind) => async (args) => {
    calls[kind].update.push(args);
    if (options.updateError?.[kind]) throw options.updateError[kind];
    return { id: args.where.id, ...args.data };
  };
  const countFor = (kind) => async (args) => {
    calls[kind].count.push(args);
    return options.references?.[kind] ?? 0;
  };

  const tx = {
    $queryRawUnsafe: async (sql, ...params) => { calls.locks.push({ sql, params }); return []; },
    $executeRawUnsafe: async (sql, ...params) => { calls.locks.push({ sql, params }); return 1; },
    unit: { findFirst: findFirstFor("unit"), findMany: findManyFor("unit"), create: createFor("unit"), update: updateFor("unit"), count: countFor("unit") },
    material: { findFirst: findFirstFor("material"), findMany: findManyFor("material"), create: createFor("material"), update: updateFor("material"), count: countFor("material") },
    supplier: { findFirst: findFirstFor("supplier"), findMany: findManyFor("supplier"), create: createFor("supplier"), update: updateFor("supplier"), count: countFor("supplier") },
    bomItem: { count: countFor("bomItem") },
    operationCatalog: { count: countFor("operationCatalog") },
    productionOrderOperation: { count: countFor("productionOrderOperation") },
    purchaseOrder: { count: countFor("purchaseOrder") },
    purchaseOrderItem: { count: countFor("purchaseOrderItem") },
  };
  const prisma = {
    ...tx,
    $transaction: async (fn) => { calls.transactions += 1; return fn(tx); },
    auditEvent: { create: async (args) => { calls.auditEvent.create.push(args); return { id: `audit-${calls.auditEvent.create.length}` }; } },
  };
  const service = new ProcurementMasterDataService(prisma, new AuditService(prisma));
  return { service, calls, rows };
}

const codeOf = (error) => error?.getResponse?.().code;
const auditActions = (calls) => calls.auditEvent.create.map((entry) => entry.data.action);

async function rejectsWithCode(factory, code) {
  await assert.rejects(factory, (error) => {
    assert.equal(codeOf(error), code, `期望机器码 ${code}，实际 ${JSON.stringify(error?.getResponse?.() ?? error?.message)}`);
    return true;
  });
}

/* ------------------------------------------------------------------ 单位 */

test("unit.list_filters-deleted-and-orders-by-name", async () => {
  const h = makeHarness();
  await h.service.listUnits();
  assert.deepEqual(h.calls.unit.findMany, [{ where: { deletedAt: null }, orderBy: { name: "asc" } }]);
});

test("unit.create_persists-name-remark-and-audit-fields", async () => {
  const h = makeHarness();
  const created = await h.service.createUnit({ name: "千克", remark: "重量单位" }, USER);
  assert.deepEqual(h.calls.unit.create, [{ data: { name: "千克", remark: "重量单位", createdBy: USER.id, updatedBy: USER.id } }]);
  assert.equal(created.id, "unit-created");
  assert.deepEqual(auditActions(h.calls), ["unit.create"]);
  assert.equal(h.calls.auditEvent.create[0].data.entityType, "unit");
  assert.equal(h.calls.auditEvent.create[0].data.entityId, "unit-created", "新建的审计 entityId 必须是被创建行的 id");
});

test("unit.create_does-not-trim-name-unlike-material", async () => {
  // 已确认行为：createUnit 原样透传 name（物料才会 trim）。这里固化现状，便于日后统一口径时被发现。
  const h = makeHarness();
  await h.service.createUnit({ name: " 米 " }, USER);
  assert.equal(h.calls.unit.create[0].data.name, " 米 ");
});

test("unit.create_duplicate-name_409-MASTER_DATA_CONFLICT-and-no-audit", async () => {
  const h = makeHarness({ createError: { unit: p2002(["name"]) } });
  await rejectsWithCode(() => h.service.createUnit({ name: "米" }, USER), "MASTER_DATA_CONFLICT");
  await assert.rejects(() => h.service.createUnit({ name: "米" }, USER), (error) => {
    assert.ok(error instanceof ConflictException);
    assert.equal(error.getResponse().message, "单位名称已存在");
    return true;
  });
  assert.deepEqual(auditActions(h.calls), [], "写入失败不能留下 create 审计");
});

test("unit.create_non-P2002-error_propagates-unchanged-and-no-audit", async () => {
  const failure = new Error("foreign key violation");
  failure.code = "P2003";
  const h = makeHarness({ createError: { unit: failure } });
  await assert.rejects(() => h.service.createUnit({ name: "米" }, USER), (error) => error === failure, "P2003 之类错误不能被包装成 409");
  assert.deepEqual(auditActions(h.calls), []);
});

test("unit.update_only-writes-provided-fields-and-ignores-null-name", async () => {
  const h = makeHarness();
  await h.service.updateUnit(UNIT_ID, { name: null, remark: "新备注" }, USER);
  assert.deepEqual(h.calls.unit.update[0], { where: { id: UNIT_ID }, data: { remark: "新备注", updatedBy: USER.id } });
  assert.equal("name" in h.calls.unit.update[0].data, false, "name=null 表示「不改名称」，不能写 null");
  assert.deepEqual(h.calls.unit.findFirst[0], { where: { id: UNIT_ID, deletedAt: null } });
  assert.deepEqual(auditActions(h.calls), ["unit.update"]);
  assert.equal(h.calls.auditEvent.create[0].data.entityId, UNIT_ID);
});

test("unit.update_null-remark-clears-it-but-undefined-leaves-it-alone", async () => {
  const clearing = makeHarness();
  await clearing.service.updateUnit(UNIT_ID, { remark: null }, USER);
  assert.deepEqual(clearing.calls.unit.update[0].data, { remark: null, updatedBy: USER.id });

  const untouched = makeHarness();
  await untouched.service.updateUnit(UNIT_ID, {}, USER);
  assert.deepEqual(untouched.calls.unit.update[0].data, { updatedBy: USER.id }, "空 patch 只能改 updatedBy");
});

test("unit.update_missing-unit_404-and-no-write", async () => {
  const h = makeHarness({ unitRow: null });
  await rejectsWithCode(() => h.service.updateUnit(UNIT_ID, { name: "个" }, USER), "UNIT_NOT_FOUND");
  assert.deepEqual(h.calls.unit.update, [], "前置校验失败不能产生 update");
  assert.deepEqual(auditActions(h.calls), []);
});

test("unit.update_duplicate-name_409-MASTER_DATA_CONFLICT", async () => {
  const h = makeHarness({ updateError: { unit: p2002(["name"]) } });
  await rejectsWithCode(() => h.service.updateUnit(UNIT_ID, { name: "个" }, USER), "MASTER_DATA_CONFLICT");
  assert.deepEqual(auditActions(h.calls), [], "update 失败不能留审计");
});

test("unit.set-active_persists-isActive-for-both-directions_KNOWN_DEFECT-no-audit", async () => {
  // KNOWN_DEFECT（审计缺口）：停用/启用是主数据状态变更，却完全不写 auditEvent。
  // 对照 apps/api/src/modules/sales/customers.service.ts:60-63 的 setActive 会记录 customer.activate/customer.deactivate。
  // 责任位置：apps/api/src/modules/procurement/procurement-master-data.service.ts:21,44,55（setXxxActive 直接 update，无 audit.record）。
  const off = makeHarness();
  await off.service.setUnitActive(UNIT_ID, false, USER);
  assert.deepEqual(off.calls.unit.update[0], { where: { id: UNIT_ID }, data: { isActive: false, updatedBy: USER.id } });
  assert.deepEqual(auditActions(off.calls), [], "KNOWN_DEFECT：停用单位没有审计记录");

  const on = makeHarness();
  await on.service.setUnitActive(UNIT_ID, true, USER);
  assert.equal(on.calls.unit.update[0].data.isActive, true);
  assert.deepEqual(auditActions(on.calls), [], "KNOWN_DEFECT：启用单位没有审计记录");
});

test("unit.set-active_missing-unit_404-and-no-write", async () => {
  const h = makeHarness({ unitRow: null });
  await rejectsWithCode(() => h.service.setUnitActive(UNIT_ID, false, USER), "UNIT_NOT_FOUND");
  assert.deepEqual(h.calls.unit.update, []);
});

test("unit.delete_unreferenced_locks-row-then-soft-deletes-with-snapshot", async () => {
  const h = makeHarness();
  const deleted = await h.service.deleteUnit(UNIT_ID, USER);
  assert.equal(h.calls.transactions, 1, "引用检查与软删必须在同一事务内");
  assert.match(h.calls.locks[0].sql, /SELECT id FROM units/);
  assert.match(h.calls.locks[0].sql, /FOR UPDATE$/);
  assert.deepEqual(h.calls.locks[0].params, [UNIT_ID]);
  // 四张引用表都要查，且只看未删除的引用
  assert.deepEqual(
    [h.calls.material.count.length, h.calls.bomItem.count.length, h.calls.operationCatalog.count.length, h.calls.productionOrderOperation.count.length],
    [1, 1, 1, 1],
  );
  // 每张引用表用的外键列不同：物料与工序目录是 default_unit_id，BOM 行与订单工序是 unit_id
  const referenceWhere = {
    material: { defaultUnitId: UNIT_ID, deletedAt: null },
    bomItem: { unitId: UNIT_ID, deletedAt: null },
    operationCatalog: { defaultUnitId: UNIT_ID, deletedAt: null },
    productionOrderOperation: { unitId: UNIT_ID, deletedAt: null },
  };
  for (const kind of Object.keys(referenceWhere)) {
    assert.deepEqual(h.calls[kind].count[0].where, referenceWhere[kind]);
  }
  const data = h.calls.unit.update[0].data;
  assert.equal(data.isActive, false, "软删同时要停用");
  assert.ok(data.deletedAt instanceof Date);
  assert.equal(data.deletedBy, USER.id);
  assert.equal(data.updatedBy, USER.id);
  assert.deepEqual(auditActions(h.calls), ["unit.delete"]);
  assert.deepEqual(h.calls.auditEvent.create[0].data.details, { name: "米" });
  assert.equal(h.calls.auditEvent.create[0].data.entityId, UNIT_ID);
  assert.equal(deleted.id, UNIT_ID);
});

test("unit.delete_referenced-by-any-of-four-tables_409-and-no-soft-delete", async () => {
  for (const referencing of ["material", "bomItem", "operationCatalog", "productionOrderOperation"]) {
    const h = makeHarness({ references: { [referencing]: 1 } });
    await rejectsWithCode(() => h.service.deleteUnit(UNIT_ID, USER), "MASTER_DATA_IN_USE");
    await assert.rejects(() => h.service.deleteUnit(UNIT_ID, USER), (error) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getResponse().message, "基础资料已被业务引用，只能停用");
      return true;
    });
    assert.deepEqual(h.calls.unit.update, [], `${referencing} 引用存在时不能软删`);
    assert.deepEqual(auditActions(h.calls), []);
  }
});

test("unit.delete_already-deleted-before-transaction_404-and-skipped", async () => {
  const h = makeHarness({ unitRow: null });
  await rejectsWithCode(() => h.service.deleteUnit(UNIT_ID, USER), "UNIT_NOT_FOUND");
  assert.equal(h.calls.transactions, 0, "前置校验失败不应开启事务（不取行锁）");
  assert.deepEqual(h.calls.locks, []);
  assert.deepEqual(h.calls.unit.update, []);
});

test("unit.delete_row-vanished-inside-transaction_404-and-no-write", async () => {
  // 隐藏分支：ensureUnusedAndDelete 在事务内会再查一次存活行，行已被并发删除时按 404 处理，而不是继续软删。
  const h = makeHarness({ findFirstQueue: { unit: [{ id: UNIT_ID, name: "米", isActive: true, deletedAt: null }, null] } });
  await rejectsWithCode(() => h.service.deleteUnit(UNIT_ID, USER), "UNIT_NOT_FOUND");
  assert.equal(h.calls.transactions, 1);
  assert.deepEqual(h.calls.unit.update, []);
  assert.deepEqual(auditActions(h.calls), []);
});

test("unit.restore_live-or-missing-unit_404-UNIT_NOT_DELETED-and-no-write", async () => {
  const h = makeHarness();
  await rejectsWithCode(() => h.service.restoreUnit(UNIT_ID, USER), "UNIT_NOT_DELETED");
  await assert.rejects(() => h.service.restoreUnit(UNIT_ID, USER), (error) => {
    assert.ok(error instanceof NotFoundException);
    return true;
  });
  assert.deepEqual(h.calls.unit.update, []);
  assert.deepEqual(h.calls.unit.findFirst[0].where, { id: UNIT_ID, deletedAt: { not: null } });
});

test("unit.restore_clears-deletedAt-and-reactivates-keeping-deletedBy-trace", async () => {
  const deletedAt = new Date("2026-01-01T00:00:00.000Z");
  const h = makeHarness({ deletedRow: { unit: { id: UNIT_ID, name: "米", isActive: false, deletedAt, deletedBy: "old-actor" } } });
  const restored = await h.service.restoreUnit(UNIT_ID, USER);
  assert.deepEqual(h.calls.unit.update[0], { where: { id: UNIT_ID }, data: { deletedAt: null, isActive: true, updatedBy: USER.id } });
  assert.equal("deletedBy" in h.calls.unit.update[0].data, false, "恢复不清空 deletedBy：保留原始删除痕迹");
  assert.deepEqual(auditActions(h.calls), ["unit.restore"]);
  assert.deepEqual(h.calls.auditEvent.create[0].data.details, { name: "米", deleted_by: "old-actor", deleted_at: deletedAt, restored_by: USER.id });
  assert.equal(restored.isActive, true);
});

test("unit.restore_name-tombstone_409-UNIT_NAME_CONFLICT-and-no-audit", async () => {
  const h = makeHarness({
    deletedRow: { unit: { id: UNIT_ID, name: "米", deletedAt: new Date(), deletedBy: null } },
    updateError: { unit: p2002("units_name_key") },
  });
  await rejectsWithCode(() => h.service.restoreUnit(UNIT_ID, USER), "UNIT_NAME_CONFLICT");
  assert.deepEqual(auditActions(h.calls), [], "恢复失败不能留审计");
});

test("unit.restore_non-P2002-error_propagates-unchanged", async () => {
  const failure = new Error("connection reset");
  const h = makeHarness({ deletedRow: { unit: { id: UNIT_ID, name: "米", deletedAt: new Date() } }, updateError: { unit: failure } });
  await assert.rejects(() => h.service.restoreUnit(UNIT_ID, USER), (error) => error === failure);
});

/* ------------------------------------------------------------------ 物料 */

test("material.list_only-raw-materials-not-deleted-with-default-unit", async () => {
  const h = makeHarness();
  await h.service.listMaterials();
  assert.deepEqual(h.calls.material.findMany, [{
    where: { deletedAt: null, materialType: "raw_material" },
    include: { defaultUnit: true },
    orderBy: { materialCode: "asc" },
  }]);
});

test("material.create_requires-active-unit_and-does-not-write-when-inactive", async () => {
  const h = makeHarness({ unitRow: { id: UNIT_ID, name: "米", isActive: false, deletedAt: null } });
  await rejectsWithCode(() => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID }, USER), "UNIT_NOT_FOUND");
  assert.deepEqual(h.calls.unit.findFirst[0].where, { id: UNIT_ID, deletedAt: null, isActive: true }, "必须只接受未删除且启用的单位");
  assert.deepEqual(h.calls.material.create, []);
  assert.deepEqual(auditActions(h.calls), []);
});

test("material.create_missing-unit_404-and-no-write", async () => {
  const h = makeHarness({ unitRow: null });
  await rejectsWithCode(() => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID }, USER), "UNIT_NOT_FOUND");
  assert.deepEqual(h.calls.material.create, []);
});

test("material.create_defaults-type-conditionally-and-normalizes-composite-key", async () => {
  const h = makeHarness();
  const created = await h.service.createMaterial({
    code_mode: "manual",
    material_code: " MAT-9 ",
    name: " 伞布 ",
    specification_model: " 190T ",
    color: null,
    default_unit_id: UNIT_ID,
    material_type: undefined,
    remark: "备注",
  }, USER);
  assert.deepEqual(h.calls.material.create[0].data, {
    materialCode: "MAT-9",
    name: "伞布",
    specificationModel: "190T",
    color: "",
    defaultUnitId: UNIT_ID,
    materialType: "raw_material",
    remark: "备注",
    createdBy: USER.id,
    updatedBy: USER.id,
  });
  assert.equal(created.id, "material-created");
  assert.deepEqual(auditActions(h.calls), ["material.create"]);

  // material_type: null 同样落到默认值（?? 而不是 === undefined 判断）
  const nullType = makeHarness();
  await nullType.service.createMaterial({ code_mode: "manual", material_code: "MAT-N", name: "伞骨", default_unit_id: UNIT_ID, material_type: null }, USER);
  assert.equal(nullType.calls.material.create[0].data.materialType, "raw_material");
});

test("material.create_rejects-unknown-or-empty-material-type_422-and-no-write", async () => {
  for (const materialType of ["semi_finished", "", "Raw_Material"]) {
    const h = makeHarness();
    await rejectsWithCode(() => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID, material_type: materialType }, USER), "INVALID_MATERIAL_TYPE");
    await assert.rejects(
      () => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID, material_type: materialType }, USER),
      (error) => error instanceof UnprocessableEntityException,
    );
    assert.deepEqual(h.calls.material.create, [], `material_type=${JSON.stringify(materialType)} 不能落库`);
    assert.deepEqual(auditActions(h.calls), []);
  }
  // 合法值必须被接受（正向对照，避免只测拒绝）
  for (const materialType of ["raw_material", "finished_product"]) {
    const h = makeHarness();
    await h.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID, material_type: materialType }, USER);
    assert.equal(h.calls.material.create[0].data.materialType, materialType);
  }
});

test("material.create_manual-mode-requires-non-blank-code_422-and-no-write", async () => {
  for (const materialCode of [undefined, "", "   "]) {
    const h = makeHarness();
    await rejectsWithCode(() => h.service.createMaterial({ code_mode: "manual", material_code: materialCode, name: "伞布", default_unit_id: UNIT_ID }, USER), "MATERIAL_CODE_REQUIRED");
    assert.deepEqual(h.calls.material.create, [], `material_code=${JSON.stringify(materialCode)} 不能落库`);
    assert.deepEqual(auditActions(h.calls), []);
  }
});

test("material.create_auto-mode_builds-daily-code-and-ignores-supplied-code", async () => {
  const h = makeHarness({ codes: { material: [`${MAT_PREFIX}0002`] } });
  await h.service.createMaterial({ code_mode: "auto", material_code: "MAT-IGNORED", name: "伞布", default_unit_id: UNIT_ID }, USER);
  assert.deepEqual(h.calls.material.findMany[0], { where: { materialCode: { startsWith: MAT_PREFIX } }, select: { materialCode: true } });
  assert.equal(h.calls.material.create[0].data.materialCode, `${MAT_PREFIX}0003`, "自动编码 = 当天最大数字后缀 + 1");

  // 空库从 0001 开始；手工编码的非数字后缀（ABC）不参与序号计算
  const empty = makeHarness({ codes: { material: [] } });
  await empty.service.createMaterial({ code_mode: "auto", name: "伞布", default_unit_id: UNIT_ID }, USER);
  assert.equal(empty.calls.material.create[0].data.materialCode, `${MAT_PREFIX}0001`);

  const manualSuffix = makeHarness({ codes: { material: [`${MAT_PREFIX}ABC`, null, "MAT-20200101-0009"] } });
  await manualSuffix.service.createMaterial({ code_mode: "auto", name: "伞布", default_unit_id: UNIT_ID }, USER);
  assert.equal(manualSuffix.calls.material.create[0].data.materialCode, `${MAT_PREFIX}0001`, "非数字后缀与其它日期的编码都不参与");
});

test("material.create_unknown-code-mode_falls-back-to-manual-code", async () => {
  // 服务层不校验 code_mode（只有 DTO 的 @IsIn 拦），非 auto 一律按手写编码走。
  const h = makeHarness();
  await h.service.createMaterial({ code_mode: "guess", material_code: "MAT-X", name: "伞布", default_unit_id: UNIT_ID }, USER);
  assert.equal(h.calls.material.create[0].data.materialCode, "MAT-X");
  assert.deepEqual(h.calls.material.findMany, [], "非 auto 模式不应触发自动编码查询");
});

test("material.create_composite-conflict_409-with-composite-message-and-no-audit", async () => {
  for (const target of [["name", "specificationModel", "color"], "materials_name_specification_model_color_key"]) {
    const h = makeHarness({ createError: { material: p2002(target) } });
    await rejectsWithCode(() => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID }, USER), "MASTER_DATA_CONFLICT");
    await assert.rejects(() => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID }, USER), (error) => {
      assert.match(error.getResponse().message, /名称 \+ 规格型号 \+ 颜色/);
      return true;
    });
    assert.deepEqual(auditActions(h.calls), [], "冲突不能留下假审计");
  }
});

test("material.create_code-conflict_409-points-to-code-not-spec", async () => {
  const h = makeHarness({ createError: { material: p2002(["material_code"]) } });
  await rejectsWithCode(() => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-DUP", name: "伞布", default_unit_id: UNIT_ID }, USER), "MASTER_DATA_CONFLICT");
  await assert.rejects(() => h.service.createMaterial({ code_mode: "manual", material_code: "MAT-DUP", name: "伞布", default_unit_id: UNIT_ID }, USER), (error) => {
    assert.match(error.getResponse().message, /物料编码已存在/);
    return true;
  });
});

test("material.update_writes-only-provided-fields_and-normalizes-blanks", async () => {
  const h = makeHarness();
  await h.service.updateMaterial(MATERIAL_ID, {
    material_code: null,
    name: " 新名 ",
    specification_model: null,
    color: " 蓝 ",
    default_unit_id: null,
    material_type: undefined,
    remark: null,
  }, USER);
  const data = h.calls.material.update[0].data;
  assert.equal(h.calls.material.update[0].where.id, MATERIAL_ID);
  assert.deepEqual(data, { name: "新名", specificationModel: "", color: "蓝", remark: null, updatedBy: USER.id });
  assert.equal("materialCode" in data, false, "material_code=null 表示不改编码");
  assert.equal("defaultUnitId" in data, false);
  assert.equal("materialType" in data, false);
  assert.deepEqual(h.calls.unit.findFirst, [], "default_unit_id 为空时不应查询单位");
  assert.deepEqual(h.calls.material.findFirst[0].where, { id: MATERIAL_ID, deletedAt: null });
  assert.deepEqual(auditActions(h.calls), ["material.update"]);
  assert.equal(h.calls.auditEvent.create[0].data.entityId, MATERIAL_ID);
});

test("material.update_missing-material_404-and-no-write", async () => {
  const h = makeHarness({ materialRow: null });
  await rejectsWithCode(() => h.service.updateMaterial(MATERIAL_ID, { name: "伞布2" }, USER), "MATERIAL_NOT_FOUND");
  assert.deepEqual(h.calls.material.update, []);
  assert.deepEqual(auditActions(h.calls), []);
});

test("material.update_unit-change_requires-active-unit", async () => {
  const h = makeHarness({ unitRow: { id: NEW_UNIT_ID, name: "个", isActive: true, deletedAt: null } });
  await h.service.updateMaterial(MATERIAL_ID, { default_unit_id: NEW_UNIT_ID }, USER);
  assert.deepEqual(h.calls.unit.findFirst[0].where, { id: NEW_UNIT_ID, deletedAt: null, isActive: true });
  assert.equal(h.calls.material.update[0].data.defaultUnitId, NEW_UNIT_ID);

  const inactive = makeHarness({ unitRow: { id: NEW_UNIT_ID, isActive: false, deletedAt: null } });
  await rejectsWithCode(() => inactive.service.updateMaterial(MATERIAL_ID, { default_unit_id: NEW_UNIT_ID }, USER), "UNIT_NOT_FOUND");
  assert.deepEqual(inactive.calls.material.update, [], "换到停用单位必须被拒且不落库");
});

test("material.update_invalid-type_422-and-no-write", async () => {
  const h = makeHarness();
  await rejectsWithCode(() => h.service.updateMaterial(MATERIAL_ID, { material_type: "semi_finished" }, USER), "INVALID_MATERIAL_TYPE");
  assert.deepEqual(h.calls.material.update, []);
  assert.deepEqual(auditActions(h.calls), []);
});

test("material.update_empty-material-type_KNOWN_DEFECT-writes-empty-string", async () => {
  // KNOWN_DEFECT：校验用 `if (input.material_type && ...)`，空串是 falsy → 跳过枚举校验；
  // 而 data 拼装只排除 undefined/null，于是空串被写进 material_type。
  // 后果：该行 materialType='' 之后不再满足 listMaterials 的 materialType: "raw_material" 过滤，物料从列表里消失。
  // 复现：PATCH /materials/:id { "material_type": "" }（UpdateMaterialDto 的 @IsOptional() 放行空串）。
  // 责任位置：apps/api/src/modules/procurement/procurement-master-data.service.ts:43。
  const h = makeHarness();
  await h.service.updateMaterial(MATERIAL_ID, { material_type: "" }, USER);
  assert.equal(h.calls.material.update[0].data.materialType, "", "KNOWN_DEFECT：空串物料类型被写入");
  assert.equal(h.calls.material.update.length, 1, "KNOWN_DEFECT：非法类型仍然落库了");

  // 对照：同一个非法值在创建路径会被 422 拒绝 —— 两条路径口径不一致。
  const create = makeHarness();
  await rejectsWithCode(() => create.service.createMaterial({ code_mode: "manual", material_code: "MAT-1", name: "伞布", default_unit_id: UNIT_ID, material_type: "" }, USER), "INVALID_MATERIAL_TYPE");
});

test("material.update_whitespace-name_KNOWN_DEFECT-writes-empty-name", async () => {
  // KNOWN_DEFECT：UpdateMaterialDto 的 name 只有 @IsString()/@MaxLength，没有 @IsNotEmpty()+@EmptyStringToUndefined()
  // （创建用 MaterialDto 有），因此 `name: "   "` 会走到服务层被 trim 成空串并落库。
  // 后果：空名物料占用 (name, specification_model, color) 组合唯一键，第二行空名物料直接 409，语义上无法用名称区分。
  // 复现：PATCH /materials/:id { "name": "   " }（POST /materials 同样受影响）。
  // 责任位置：apps/api/src/modules/procurement/procurement-master-data.controller.ts:20 + service:43。
  const h = makeHarness();
  await h.service.updateMaterial(MATERIAL_ID, { name: "   " }, USER);
  assert.equal(h.calls.material.update[0].data.name, "", "KNOWN_DEFECT：全空格名称被 trim 成空串后落库");
});

test("material.set-active_persists-isActive-and-404-when-missing_KNOWN_DEFECT-no-audit", async () => {
  // KNOWN_DEFECT（审计缺口，同 unit.set-active）：物料停用/启用同样不写 auditEvent。
  // 责任位置：apps/api/src/modules/procurement/procurement-master-data.service.ts:44。
  const h = makeHarness();
  await h.service.setMaterialActive(MATERIAL_ID, false, USER);
  assert.deepEqual(h.calls.material.update[0], { where: { id: MATERIAL_ID }, data: { isActive: false, updatedBy: USER.id } });
  assert.deepEqual(auditActions(h.calls), [], "KNOWN_DEFECT：停用物料没有审计记录");

  const missing = makeHarness({ materialRow: null });
  await rejectsWithCode(() => missing.service.setMaterialActive(MATERIAL_ID, true, USER), "MATERIAL_NOT_FOUND");
  assert.deepEqual(missing.calls.material.update, []);
});

test("material.delete_referenced-by-bom_409-locked-and-no-soft-delete", async () => {
  const h = makeHarness({ references: { bomItem: 2 } });
  await rejectsWithCode(() => h.service.deleteMaterial(MATERIAL_ID, USER), "MASTER_DATA_IN_USE");
  assert.match(h.calls.locks[0].sql, /SELECT id FROM materials/);
  assert.deepEqual(h.calls.bomItem.count[0].where, { materialId: MATERIAL_ID, deletedAt: null });
  assert.deepEqual(h.calls.material.update, []);
  assert.deepEqual(auditActions(h.calls), []);
});

test("material.delete_unreferenced_soft-deletes-with-code-snapshot", async () => {
  const h = makeHarness();
  await h.service.deleteMaterial(MATERIAL_ID, USER);
  assert.equal(h.calls.material.update[0].data.isActive, false);
  assert.ok(h.calls.material.update[0].data.deletedAt instanceof Date);
  assert.deepEqual(auditActions(h.calls), ["material.delete"]);
  assert.deepEqual(h.calls.auditEvent.create[0].data.details, { name: "伞布", material_code: "MAT-1" });
});

/* ------------------------------------------------------------------ 供应商 */

test("supplier.list_filters-deleted-and-orders-by-code", async () => {
  const h = makeHarness();
  await h.service.listSuppliers();
  assert.deepEqual(h.calls.supplier.findMany, [{ where: { deletedAt: null }, orderBy: { supplierCode: "asc" } }]);
});

test("supplier.create_manual-mode-requires-non-blank-code_422-and-no-write", async () => {
  for (const supplierCode of [undefined, "", "   "]) {
    const h = makeHarness();
    await rejectsWithCode(() => h.service.createSupplier({ code_mode: "manual", supplier_code: supplierCode, name: "布料厂" }, USER), "SUPPLIER_CODE_REQUIRED");
    assert.deepEqual(h.calls.supplier.create, [], `supplier_code=${JSON.stringify(supplierCode)} 不能落库`);
    assert.deepEqual(auditActions(h.calls), []);
  }
});

test("supplier.create_trims-code-keeps-name_defaults-settlement-info", async () => {
  const h = makeHarness();
  await h.service.createSupplier({ code_mode: "manual", supplier_code: " SUP-9 ", name: " 布料厂 ", contact_name: "李", phone: "138", remark: "r" }, USER);
  assert.deepEqual(h.calls.supplier.create[0].data, {
    supplierCode: "SUP-9",
    name: " 布料厂 ",
    contactName: "李",
    phone: "138",
    settlementInfo: {},
    remark: "r",
    createdBy: USER.id,
    updatedBy: USER.id,
  });
  assert.deepEqual(auditActions(h.calls), ["supplier.create"]);

  const withInfo = makeHarness();
  await withInfo.service.createSupplier({ code_mode: "manual", supplier_code: "SUP-9", name: "布料厂", settlement_info: { bank: "工行", account: "6222" } }, USER);
  assert.deepEqual(withInfo.calls.supplier.create[0].data.settlementInfo, { bank: "工行", account: "6222" });

  const nullInfo = makeHarness();
  await nullInfo.service.createSupplier({ code_mode: "manual", supplier_code: "SUP-9", name: "布料厂", settlement_info: null }, USER);
  assert.deepEqual(nullInfo.calls.supplier.create[0].data.settlementInfo, {}, "创建时 null 结算信息归一成 {}（DB 列非空）");
});

test("supplier.create_auto-mode_builds-daily-code", async () => {
  const h = makeHarness({ codes: { supplier: [`${SUP_PREFIX}0007`, `${SUP_PREFIX}XYZ`] } });
  await h.service.createSupplier({ code_mode: "auto", supplier_code: "SUP-IGNORED", name: "布料厂" }, USER);
  assert.deepEqual(h.calls.supplier.findMany[0], { where: { supplierCode: { startsWith: SUP_PREFIX } }, select: { supplierCode: true } });
  assert.equal(h.calls.supplier.create[0].data.supplierCode, `${SUP_PREFIX}0008`);
});

test("supplier.create_conflict_409-generic-message-and-no-audit", async () => {
  const h = makeHarness({ createError: { supplier: p2002(["name"]) } });
  await rejectsWithCode(() => h.service.createSupplier({ code_mode: "manual", supplier_code: "SUP-1", name: "布料厂" }, USER), "MASTER_DATA_CONFLICT");
  await assert.rejects(() => h.service.createSupplier({ code_mode: "manual", supplier_code: "SUP-1", name: "布料厂" }, USER), (error) => {
    assert.equal(error.getResponse().message, "名称或编码已存在");
    return true;
  });
  assert.deepEqual(auditActions(h.calls), []);
});

test("supplier.update_writes-only-provided-fields-and-clears-nullable-ones", async () => {
  const h = makeHarness();
  await h.service.updateSupplier(SUPPLIER_ID, {
    supplier_code: null,
    name: null,
    contact_name: null,
    phone: undefined,
    settlement_info: undefined,
    remark: "新",
  }, USER);
  assert.deepEqual(h.calls.supplier.update[0], {
    where: { id: SUPPLIER_ID },
    data: { contactName: null, remark: "新", updatedBy: USER.id },
  });
  assert.deepEqual(h.calls.supplier.findFirst[0].where, { id: SUPPLIER_ID, deletedAt: null });
  assert.deepEqual(auditActions(h.calls), ["supplier.update"]);
});

test("supplier.update_null-settlement-info_KNOWN_DEFECT-writes-null", async () => {
  // KNOWN_DEFECT：同一函数里其它字段都用 `undefined` 判断、null 可以清空，
  // 但 settlement_info 写成 `input.settlement_info === undefined ? {} : { settlementInfo: input.settlement_info }`，
  // null 会原样传给 Prisma；而 Supplier.settlementInfo 是 `Json @default("{}")` 非空列，
  // POST 路径有 `?? {}` 兜底、PATCH 路径没有 → PATCH { "settlement_info": null } 会以 5xx（Prisma 非空约束）收场，而不是 422。
  // 责任位置：apps/api/src/modules/procurement/procurement-master-data.service.ts:54（创建路径在 :52 有兜底）。
  const h = makeHarness();
  await h.service.updateSupplier(SUPPLIER_ID, { settlement_info: null }, USER);
  assert.equal(h.calls.supplier.update[0].data.settlementInfo, null, "KNOWN_DEFECT：null 结算信息被直接写入");
  assert.equal("settlementInfo" in h.calls.supplier.update[0].data, true);
});

test("supplier.update_empty-code_KNOWN_DEFECT-writes-empty-string", async () => {
  // KNOWN_DEFECT：supplier_code 只在 undefined/null 时跳过，空串会写成空供应商编码（Supplier.supplierCode 唯一且必填）。
  // 复现：PATCH /suppliers/:id { "supplier_code": "" }。
  // 责任位置：apps/api/src/modules/procurement/procurement-master-data.service.ts:54。
  const h = makeHarness();
  await h.service.updateSupplier(SUPPLIER_ID, { supplier_code: "" }, USER);
  assert.equal(h.calls.supplier.update[0].data.supplierCode, "", "KNOWN_DEFECT：空编码被写入");
});

test("supplier.update_missing_404-and-no-write", async () => {
  const h = makeHarness({ supplierRow: null });
  await rejectsWithCode(() => h.service.updateSupplier(SUPPLIER_ID, { name: "布料厂2" }, USER), "SUPPLIER_NOT_FOUND");
  assert.deepEqual(h.calls.supplier.update, []);
  assert.deepEqual(auditActions(h.calls), []);
});

test("supplier.set-active_persists-isActive-and-404-when-missing_KNOWN_DEFECT-no-audit", async () => {
  // KNOWN_DEFECT（审计缺口，同 unit/material）。
  // 责任位置：apps/api/src/modules/procurement/procurement-master-data.service.ts:55。
  const h = makeHarness();
  await h.service.setSupplierActive(SUPPLIER_ID, false, USER);
  assert.deepEqual(h.calls.supplier.update[0], { where: { id: SUPPLIER_ID }, data: { isActive: false, updatedBy: USER.id } });
  assert.deepEqual(auditActions(h.calls), [], "KNOWN_DEFECT：停用供应商没有审计记录");

  const missing = makeHarness({ supplierRow: null });
  await rejectsWithCode(() => missing.service.setSupplierActive(SUPPLIER_ID, false, USER), "SUPPLIER_NOT_FOUND");
  assert.deepEqual(missing.calls.supplier.update, []);
});

test("supplier.delete_referenced-by-order-head-or-line_409-and-no-soft-delete", async () => {
  for (const referencing of ["purchaseOrder", "purchaseOrderItem"]) {
    const h = makeHarness({ references: { [referencing]: 1 } });
    await rejectsWithCode(() => h.service.deleteSupplier(SUPPLIER_ID, USER), "MASTER_DATA_IN_USE");
    assert.deepEqual(h.calls.purchaseOrder.count[0].where, { supplierId: SUPPLIER_ID, deletedAt: null });
    assert.deepEqual(h.calls.purchaseOrderItem.count[0].where, { supplierId: SUPPLIER_ID, deletedAt: null });
    assert.deepEqual(h.calls.supplier.update, [], `${referencing} 引用存在时不能软删`);
    assert.deepEqual(auditActions(h.calls), []);
  }
});

test("supplier.delete_unreferenced_soft-deletes-with-code-snapshot", async () => {
  const h = makeHarness();
  await h.service.deleteSupplier(SUPPLIER_ID, USER);
  assert.match(h.calls.locks[0].sql, /SELECT id FROM suppliers/);
  assert.match(h.calls.locks[0].sql, /FOR UPDATE$/);
  assert.equal(h.calls.supplier.update[0].data.isActive, false);
  assert.equal(h.calls.supplier.update[0].data.deletedBy, USER.id);
  assert.deepEqual(auditActions(h.calls), ["supplier.delete"]);
  assert.deepEqual(h.calls.auditEvent.create[0].data.details, { name: "布料厂", supplier_code: "SUP-1" });
  assert.equal(h.calls.auditEvent.create[0].data.entityId, SUPPLIER_ID);
});
