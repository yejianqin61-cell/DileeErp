// 字典类型 / 字典项服务单元测试。
//
// 生产文件：apps/api/src/platform/dictionaries/dictionaries.service.ts（35 行，全部覆盖）
// 依赖 DTO：dictionaries.controller.ts:10-12（CreateTypeDto / CreateItemDto / UpdateItemDto，未导出，
//           因此长度/取值范围约束只在报告里说明，单测不断言）
// 依赖领域函数：audit.service.ts:10-12（AuditService.create/update/softDelete 是纯函数，不碰 prisma）
// 依赖 schema：prisma/schema.prisma:82-114（dictionary_types.key 全局唯一；dictionary_items 复合唯一
//           (type_id,key)；两个唯一索引都【不含 deleted_at 条件】——见 migrations/20260819123000 第 180/183 行）
//
// 本文件用手写假 Prisma（不连数据库），只断言外部行为：返回值、抛出异常、以及传给 Prisma 的查询形状。
// 记录型假对象用于钉查询形状；状态型假对象在内存里复刻唯一索引与软删过滤，用于验证生命周期行为。
//
// 机器码说明：本模块只抛 `new NotFoundException("…")`（纯字符串），没有业务码
// （实测 getResponse() = { message, error: "Not Found", statusCode: 404 }，无 code 字段），
// 因此 404 用例断言 statusCode + 异常类型，机器码缺口见文件末尾 KNOWN_DEFECT 用例。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { NotFoundException } = require("@nestjs/common");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { DictionariesService } = require("../../dist/platform/dictionaries/dictionaries.service.js");

const user = { id: "user-1", username: "admin", display_name: "管理员" };
const otherUser = { id: "user-2", username: "ops", display_name: "运维" };

/** P2002 唯一约束冲突（Prisma 会在 create 时抛出，服务不捕获、不预检）。 */
function uniqueViolation(target) {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${target.join(",")})`), { code: "P2002", meta: { target } });
}

function emptyCalls() {
  return {
    typeFindMany: [], typeFindFirst: [], typeCreate: [],
    itemFindMany: [], itemFindFirst: [], itemCreate: [], itemUpdate: [], itemDelete: [],
    auditEventCreate: [], transaction: [], queryRaw: [], executeRaw: [],
  };
}

/** 记录型假 Prisma：返回固定行，只关心"服务发出了什么查询"。 */
function fakePrisma(overrides = {}) {
  const calls = emptyCalls();
  const prisma = {
    calls,
    dictionaryType: {
      async findMany(args) { calls.typeFindMany.push(args); return overrides.types ?? []; },
      async findFirst(args) { calls.typeFindFirst.push(args); return overrides.type ?? null; },
      async create(args) {
        calls.typeCreate.push(args);
        if (overrides.typeCreateError) throw overrides.typeCreateError;
        return overrides.createdType ?? { id: "type-new", ...args.data };
      },
    },
    dictionaryItem: {
      async findMany(args) { calls.itemFindMany.push(args); return overrides.items ?? []; },
      async findFirst(args) { calls.itemFindFirst.push(args); return overrides.item ?? null; },
      async create(args) {
        calls.itemCreate.push(args);
        if (overrides.itemCreateError) throw overrides.itemCreateError;
        return overrides.createdItem ?? { id: "item-new", ...args.data };
      },
      async update(args) {
        calls.itemUpdate.push(args);
        if (overrides.itemUpdateError) throw overrides.itemUpdateError;
        return overrides.updatedItem ?? { id: args.where.id, ...args.data };
      },
      async delete(args) {
        calls.itemDelete.push(args);
        throw new Error("字典项只允许软删除，生产代码不应调用 dictionaryItem.delete");
      },
    },
    auditEvent: { async create(args) { calls.auditEventCreate.push(args); return args.data; } },
    async $transaction(fn) { calls.transaction.push("start"); return fn(prisma); },
    async $queryRaw(...args) { calls.queryRaw.push(args); return []; },
    async $executeRawUnsafe(...args) { calls.executeRaw.push(args); return 0; },
  };
  return prisma;
}

function make(overrides = {}) {
  const prisma = fakePrisma(overrides);
  return { prisma, calls: prisma.calls, service: new DictionariesService(prisma, new AuditService(prisma)) };
}

/** where 匹配：null 同时匹配 null 与 undefined（模拟 Prisma 对可空列的过滤）。 */
function matches(row, where = {}) {
  return Object.entries(where).every(([field, value]) => (value === null ? row[field] === null || row[field] === undefined : row[field] === value));
}

function sortRows(rows, orderBy) {
  const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, direction] of Object.entries(spec)) {
        const left = a[field];
        const right = b[field];
        if (left === right) continue;
        const cmp = left < right ? -1 : 1;
        return direction === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

/** 状态型假 Prisma：复刻 schema.prisma:112 的复合唯一索引（含软删行）与 deleted_at/is_active 过滤。 */
function statefulPrisma(seed = {}) {
  const calls = emptyCalls();
  const types = (seed.types ?? []).map((row) => ({ deletedAt: null, ...row }));
  const items = (seed.items ?? []).map((row) => ({ deletedAt: null, isActive: true, sortOrder: 0, ...row }));
  let seq = 0;
  const prisma = {
    calls,
    dictionaryType: {
      async findMany(args = {}) { calls.typeFindMany.push(args); return sortRows(types.filter((row) => matches(row, args.where)), args.orderBy); },
      async findFirst(args = {}) { calls.typeFindFirst.push(args); return types.find((row) => matches(row, args.where)) ?? null; },
      async create({ data }) {
        calls.typeCreate.push({ data });
        if (types.some((row) => row.key === data.key)) throw uniqueViolation(["key"]);
        const row = { id: `type-${++seq}`, ...data };
        types.push(row);
        return row;
      },
    },
    dictionaryItem: {
      async findMany(args = {}) { calls.itemFindMany.push(args); return sortRows(items.filter((row) => matches(row, args.where)), args.orderBy); },
      async findFirst(args = {}) { calls.itemFindFirst.push(args); return items.find((row) => matches(row, args.where)) ?? null; },
      async create({ data }) {
        calls.itemCreate.push({ data });
        if (items.some((row) => row.typeId === data.typeId && row.key === data.key)) throw uniqueViolation(["type_id", "key"]);
        const row = { id: `item-${++seq}`, isActive: true, ...data };
        items.push(row);
        return row;
      },
      async update({ where, data }) {
        calls.itemUpdate.push({ where, data });
        const row = items.find((entry) => entry.id === where.id);
        if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        Object.assign(row, data);
        return row;
      },
      async delete(args) {
        calls.itemDelete.push(args);
        throw new Error("字典项只允许软删除，生产代码不应调用 dictionaryItem.delete");
      },
    },
    auditEvent: { async create(args) { calls.auditEventCreate.push(args); return args.data; } },
    async $transaction(fn) { calls.transaction.push("start"); return fn(prisma); },
    async $queryRaw(...args) { calls.queryRaw.push(args); return []; },
    async $executeRawUnsafe(...args) { calls.executeRaw.push(args); return 0; },
  };
  return prisma;
}

function makeStateful(seed = {}) {
  const prisma = statefulPrisma(seed);
  return { prisma, calls: prisma.calls, service: new DictionariesService(prisma, new AuditService(prisma)) };
}

const is404 = (error) => error instanceof NotFoundException && error.getResponse().statusCode === 404;

// ---------------------------------------------------------------- listTypes

test("dictionaries.listTypes_filters_soft_deleted_and_orders_by_key", async () => {
  const rows = [{ id: "type-1", key: "color", name: "颜色" }];
  const { service, calls } = make({ types: rows });
  const result = await service.listTypes();
  assert.equal(result, rows, "应原样返回 Prisma 结果，不做二次加工");
  assert.deepEqual(calls.typeFindMany[0], { where: { deletedAt: null }, orderBy: { key: "asc" } });
  assert.equal(calls.typeFindMany.length, 1);
});

test("dictionaries.listTypes_empty_table_returns_empty_array", async () => {
  const { service, calls } = make({ types: [] });
  assert.deepEqual(await service.listTypes(), []);
  assert.equal(calls.typeFindMany.length, 1, "空表也只允许一次查询");
  assert.deepEqual(calls.typeFindFirst, []);
});

// ---------------------------------------------------------------- createType

test("dictionaries.createType_stamps_audit_columns_and_does_not_mutate_input", async () => {
  const input = { key: "color", name: "颜色" };
  const { service, calls } = make();
  await service.createType(input, user);
  assert.deepEqual(calls.typeCreate[0].data, { key: "color", name: "颜色", createdBy: "user-1", updatedBy: "user-1" });
  assert.deepEqual(input, { key: "color", name: "颜色" }, "调用方传入的 input 不得被就地修改");
});

test("dictionaries.createType_uses_the_acting_user_for_both_audit_columns", async () => {
  const { service, calls } = make();
  await service.createType({ key: "size", name: "尺寸" }, otherUser);
  assert.equal(calls.typeCreate[0].data.createdBy, "user-2");
  assert.equal(calls.typeCreate[0].data.updatedBy, "user-2");
});

test("dictionaries.createType_does_not_precheck_duplicate_key_and_propagates_conflict", async () => {
  const { service, calls } = make({ typeCreateError: uniqueViolation(["key"]) });
  await assert.rejects(
    () => service.createType({ key: "color", name: "重复颜色" }, user),
    (error) => error.code === "P2002" && error.meta.target[0] === "key",
  );
  assert.equal(calls.typeCreate.length, 1, "冲突由数据库唯一索引产生，服务仍会尝试写入一次");
  assert.deepEqual(calls.typeFindFirst, [], "服务不做 key 预检（预检本身也有竞态，这里明确记录现状）");
});

test("dictionaries.createType_soft_deleted_key_cannot_be_reused", async () => {
  // KNOWN_DEFECT（类型侧，与 createItem_soft_deleted_item_key_cannot_be_reused 同源）：
  // dictionary_types_key_key 唯一索引同样不含 deleted_at 条件
  // （prisma/schema.prisma:84，migrations/20260819123000_platform_foundation/migration.sql:180），
  // 软删的类型在 listTypes 里消失（deletedAt 过滤），但它的 key 仍占位：重建同 key 得到 P2002。
  // 本模块目前没有 deleteType 入口，所以这条路径只能由历史/迁移数据触发（潜在缺陷，非现行可达）。
  const { service, calls } = makeStateful({ types: [{ id: "type-old", key: "color", name: "旧颜色", deletedAt: new Date() }] });
  assert.deepEqual(await service.listTypes(), [], "软删类型不出现在列表里");
  await assert.rejects(
    () => service.createType({ key: "color", name: "新颜色" }, user),
    (error) => error.code === "P2002" && error.meta.target[0] === "key",
  );
  assert.deepEqual(calls.typeFindFirst, [], "createType 不做 key 预检，冲突只能靠数据库抛出");
});

test("dictionaries.createType_falsy_boundary_input_is_passed_through_unchecked", async () => {
  // KNOWN_DEFECT（输入校验缺口）：controller 的 CreateTypeDto 只有 @IsString() @MaxLength(80)/(100)，
  // 而 class-validator 的 isString("") === true（本仓库内实测），服务层也没有任何 key/name 非空校验，
  // 因此空串 key/name 会被原样写库。复现：POST /api/v1/dictionaries/types {"key":"","name":""} → 201。
  // 责任位置：apps/api/src/platform/dictionaries/dictionaries.controller.ts:10（缺 @IsNotEmpty）
  //           apps/api/src/platform/dictionaries/dictionaries.service.ts:10（服务层无兜底校验）
  const { service, calls } = make();
  await service.createType({ key: "", name: "" }, user);
  assert.equal(calls.typeCreate[0].data.key, "");
  assert.equal(calls.typeCreate[0].data.name, "");
  assert.equal(calls.typeCreate.length, 1, "当前实现不会拒绝空串 key");
});

test("dictionaries.createType_overlong_key_is_passed_through_untruncated", async () => {
  const longKey = "k".repeat(200);
  const longName = "n".repeat(300);
  const { service, calls } = make();
  await service.createType({ key: longKey, name: longName }, user);
  assert.equal(calls.typeCreate[0].data.key.length, 200, "服务不截断、不补齐");
  assert.equal(calls.typeCreate[0].data.name.length, 300);
  // 未验证：schema.prisma:84-85 的 VarChar(80)/(100) 由数据库侧拦截（Postgres 会报 22001），
  // 单测不连库，故无法断言其错误码。
});

// ---------------------------------------------------------------- listItems 前置校验

test("dictionaries.listItems_include_inactive_flag_controls_is_active_filter", async () => {
  const { service, calls } = make({ type: { id: "type-1", key: "color" } });
  await service.listItems("color");
  await service.listItems("color", true);
  await service.listItems("color", false);
  assert.deepEqual(calls.itemFindMany[0].where, { typeId: "type-1", deletedAt: null, isActive: true }, "默认只看启用项");
  assert.deepEqual(calls.itemFindMany[1].where, { typeId: "type-1", deletedAt: null }, "includeInactive=true 时不加 isActive 条件");
  assert.equal("isActive" in calls.itemFindMany[1].where, false);
  assert.deepEqual(calls.itemFindMany[2].where, { typeId: "type-1", deletedAt: null, isActive: true }, "显式 false 与默认一致");
  for (const call of calls.itemFindMany) {
    assert.deepEqual(call.orderBy, [{ sortOrder: "asc" }, { key: "asc" }]);
  }
});

test("dictionaries.listItems_missing_or_soft_deleted_type_is_404_and_reads_no_items", async () => {
  const { service, calls } = make({ type: null });
  await assert.rejects(() => service.listItems("ghost"), is404);
  assert.deepEqual(calls.typeFindFirst[0], { where: { key: "ghost", deletedAt: null } }, "软删类型按 deletedAt:null 视为不存在");
  assert.deepEqual(calls.itemFindMany, [], "类型不存在时不得读字典项");
});

test("dictionaries.listItems_does_not_normalise_the_type_key", async () => {
  const { service, calls } = make({ type: null });
  await assert.rejects(() => service.listItems(" Color "), is404);
  assert.equal(calls.typeFindFirst[0].where.key, " Color ", "不做 trim / 大小写归一（非法 key 因此落 404 而不是命中 color）");

  const stateful = makeStateful({ types: [{ id: "type-1", key: "color", name: "颜色" }] });
  await assert.rejects(() => stateful.service.listItems("Color"), is404);
});

// ---------------------------------------------------------------- listItems 行为（状态型）

test("dictionaries.listItems_filters_deleted_and_orders_by_sort_order_then_key", async () => {
  const { service } = makeStateful({
    types: [{ id: "type-1", key: "color", name: "颜色" }, { id: "type-2", key: "other", name: "其它" }],
    items: [
      { id: "item-blue", typeId: "type-1", key: "blue", label: "蓝", sortOrder: 2 },
      { id: "item-red", typeId: "type-1", key: "red", label: "红", sortOrder: 0 },
      { id: "item-black", typeId: "type-1", key: "black", label: "黑", sortOrder: 2 },
      { id: "item-gray", typeId: "type-1", key: "gray", label: "灰", sortOrder: 1, isActive: false },
      { id: "item-white", typeId: "type-1", key: "white", label: "白", sortOrder: 0, deletedAt: new Date() },
      { id: "item-other-red", typeId: "type-2", key: "red", label: "别的类型的红", sortOrder: 0 },
    ],
  });
  const rows = await service.listItems("color");
  assert.deepEqual(rows.map((row) => row.id), ["item-red", "item-black", "item-blue"], "先按 sortOrder，再按 key；停用项与软删项都被过滤");
  assert.equal(rows.some((row) => row.id === "item-other-red"), false, "同 key 但属于别的类型不得混入");
  assert.equal(rows.some((row) => row.id === "item-white"), false);
});

test("dictionaries.listItems_include_inactive_keeps_inactive_and_still_hides_deleted", async () => {
  const { service } = makeStateful({
    types: [{ id: "type-1", key: "color", name: "颜色" }],
    items: [
      { id: "item-red", typeId: "type-1", key: "red", label: "红", sortOrder: 0 },
      { id: "item-gray", typeId: "type-1", key: "gray", label: "灰", sortOrder: 1, isActive: false },
      { id: "item-white", typeId: "type-1", key: "white", label: "白", sortOrder: 0, deletedAt: new Date() },
    ],
  });
  const rows = await service.listItems("color", true);
  assert.deepEqual(rows.map((row) => row.id), ["item-red", "item-gray"], "includeInactive 只放开停用项，软删项依旧不可见");
});

test("dictionaries.listItems_type_without_items_returns_empty_array", async () => {
  const { service, calls } = makeStateful({ types: [{ id: "type-1", key: "color", name: "颜色" }] });
  assert.deepEqual(await service.listItems("color"), []);
  assert.equal(calls.itemFindMany.length, 1);
  assert.equal(calls.itemCreate.length, 0);
});

// ---------------------------------------------------------------- createItem

test("dictionaries.createItem_defaults_sort_order_to_zero_and_stamps_type_and_audit", async () => {
  const { service, calls } = make({ type: { id: "type-1", key: "color" } });
  await service.createItem("color", { key: "red", label: "红" }, user);
  const data = calls.itemCreate[0].data;
  assert.deepEqual(data, { typeId: "type-1", key: "red", label: "红", sortOrder: 0, createdBy: "user-1", updatedBy: "user-1" });
  assert.equal("sort_order" in data, false, "snake_case 入参不得泄漏到 Prisma");
});

test("dictionaries.createItem_persists_explicit_zero_and_negative_sort_order", async () => {
  const { service, calls } = make({ type: { id: "type-1", key: "color" } });
  await service.createItem("color", { key: "red", label: "红", sort_order: 0 }, user);
  await service.createItem("color", { key: "gray", label: "灰", sort_order: -5 }, user);
  assert.equal(calls.itemCreate[0].data.sortOrder, 0, "显式 0 不能被 ?? 误判为缺省");
  assert.equal(calls.itemCreate[1].data.sortOrder, -5, "服务层不做 @Min(0) 校验，负数会直接下发；闸门只在 controller DTO（UpdateItemDto/CreateItemDto 的 @Min(0)）");
});

test("dictionaries.createItem_ignores_unexpected_input_fields", async () => {
  const { service, calls } = make({ type: { id: "type-1", key: "color" } });
  await service.createItem("color", { key: "red", label: "红", sort_order: 1, is_active: false, typeId: "type-hacked", id: "forced-id" }, user);
  assert.deepEqual(Object.keys(calls.itemCreate[0].data).sort(), ["createdBy", "key", "label", "sortOrder", "typeId", "updatedBy"].sort());
  assert.equal(calls.itemCreate[0].data.typeId, "type-1", "typeId 只能来自路径解析出的类型");
  assert.equal(calls.itemCreate[0].data.isActive, undefined, "新建项不接受 is_active 覆盖（默认 true 由数据库给）");
});

test("dictionaries.createItem_rejects_unknown_type_without_writing", async () => {
  const { service, calls } = make({ type: null });
  await assert.rejects(() => service.createItem("ghost", { key: "red", label: "红" }, user), is404);
  assert.deepEqual(calls.typeFindFirst[0], { where: { key: "ghost", deletedAt: null } });
  assert.deepEqual(calls.itemCreate, [], "前置校验失败时绝不产生写入");
});

test("dictionaries.createItem_rejects_soft_deleted_type_without_writing", async () => {
  const { service, calls } = makeStateful({ types: [{ id: "type-1", key: "color", name: "颜色", deletedAt: new Date() }] });
  await assert.rejects(() => service.createItem("color", { key: "red", label: "红" }, user), is404);
  assert.deepEqual(calls.itemCreate, [], "类型已软删 → 404，且不写字典项");
});

test("dictionaries.createItem_propagates_duplicate_key_within_type_and_allows_other_types", async () => {
  const { service, calls } = makeStateful({
    types: [{ id: "type-1", key: "color", name: "颜色" }, { id: "type-2", key: "size", name: "尺寸" }],
  });
  await service.createItem("color", { key: "red", label: "红" }, user);
  await assert.rejects(
    () => service.createItem("color", { key: "red", label: "又一个红" }, user),
    (error) => error.code === "P2002" && error.meta.target.join(",") === "type_id,key",
  );
  const sameKeyOtherType = await service.createItem("size", { key: "red", label: "尺寸里的红" }, user);
  assert.equal(sameKeyOtherType.typeId, "type-2", "唯一约束是 (typeId,key) 复合的，跨类型同 key 合法");
  assert.equal(calls.itemCreate.length, 3, "冲突不预检：同 key 第二次仍然真正尝试写入");
  assert.deepEqual(calls.itemFindFirst, [], "createItem 全程不读字典项做预检");
});

test("dictionaries.createItem_soft_deleted_item_key_cannot_be_reused", async () => {
  // KNOWN_DEFECT：唯一索引 dictionary_items_type_id_key_key 不含 deleted_at 条件
  // （prisma/schema.prisma:112，migrations/20260819123000_platform_foundation/migration.sql:183），
  // 而本模块只提供软删、没有任何恢复/硬删入口，因此软删一个字典项后它的 key 永久不可复用：
  // 列表里看不到它（deletedAt 过滤），再建同 key 却拿到 409 UNIQUE_VALUE_CONFLICT。
  // 复现：POST items {key:"red"} → DELETE items/{id} → 再次 POST items {key:"red"} → 409。
  const { service } = makeStateful({ types: [{ id: "type-1", key: "color", name: "颜色" }] });
  const created = await service.createItem("color", { key: "red", label: "红" }, user);
  await service.deleteItem(created.id, user);
  assert.deepEqual(await service.listItems("color", true), [], "软删后列表（含停用）也看不到");
  await assert.rejects(
    () => service.createItem("color", { key: "red", label: "重建红" }, user),
    (error) => error.code === "P2002",
  );
});

test("dictionaries.createItem_overlong_key_and_empty_label_are_passed_through", async () => {
  const { service, calls } = make({ type: { id: "type-1", key: "color" } });
  await service.createItem("color", { key: "k".repeat(200), label: "" }, user);
  assert.equal(calls.itemCreate[0].data.key.length, 200, "服务不截断超长 key");
  assert.equal(calls.itemCreate[0].data.label, "", "空 label 当前被接受（同 createType 的校验缺口，未验证数据库侧反应）");
});

// ---------------------------------------------------------------- updateItem

test("dictionaries.updateItem_patches_only_provided_fields", async () => {
  const { service, calls } = make({ item: { id: "item-1", typeId: "type-1" } });
  await service.updateItem("item-1", { label: "深红" }, user);
  assert.deepEqual(calls.itemFindFirst[0], { where: { id: "item-1", deletedAt: null } });
  assert.deepEqual(calls.itemUpdate[0].where, { id: "item-1" });
  assert.deepEqual(calls.itemUpdate[0].data, { label: "深红", updatedBy: "user-1" });
  assert.equal("sortOrder" in calls.itemUpdate[0].data, false, "未提供的字段不得被写成 undefined");
  assert.equal("isActive" in calls.itemUpdate[0].data, false);
});

test("dictionaries.updateItem_writes_falsy_boundary_values", async () => {
  const { service, calls } = make({ item: { id: "item-1" } });
  await service.updateItem("item-1", { label: "", sort_order: 0, is_active: false }, user);
  const data = calls.itemUpdate[0].data;
  assert.deepEqual(data, { label: "", sortOrder: 0, isActive: false, updatedBy: "user-1" });
  assert.equal(data.sortOrder, 0, "0 必须落库（用 === undefined 判定，而非真值判定）");
  assert.equal(data.isActive, false, "false 必须落库（停用项靠它表达）");
  assert.equal(data.label, "");
});

test("dictionaries.updateItem_empty_patch_writes_only_the_audit_column", async () => {
  const { service, calls } = make({ item: { id: "item-1" } });
  await service.updateItem("item-1", {}, user);
  assert.deepEqual(calls.itemUpdate[0].data, { updatedBy: "user-1" }, "空 patch 只留审计列，不产生副作用写入");
});

test("dictionaries.updateItem_ignores_unknown_input_fields", async () => {
  const { service, calls } = make({ item: { id: "item-1", typeId: "type-1" } });
  // 传入 camelCase 的 isActive 与试图改归属的 typeId/key：都不在字段白名单里，必须被丢弃。
  await service.updateItem("item-1", { isActive: false, typeId: "type-2", key: "hacked", label: "合法" }, user);
  const data = calls.itemUpdate[0].data;
  assert.deepEqual(data, { label: "合法", updatedBy: "user-1" });
  assert.equal(data.isActive, undefined);
  assert.equal(data.typeId, undefined, "字典项不得被改挂到别的类型");
  assert.equal(data.key, undefined);
});

test("dictionaries.updateItem_rejects_missing_or_soft_deleted_item_without_update", async () => {
  const { service, calls } = make({ item: null });
  await assert.rejects(() => service.updateItem("item-ghost", { label: "x" }, user), is404);
  assert.deepEqual(calls.itemFindFirst[0], { where: { id: "item-ghost", deletedAt: null } }, "软删项按 deletedAt:null 视为不存在");
  assert.deepEqual(calls.itemUpdate, [], "前置校验失败时绝不 update");
  assert.deepEqual(calls.itemDelete, []);
});

// ---------------------------------------------------------------- deleteItem

test("dictionaries.deleteItem_soft_deletes_and_never_hard_deletes", async () => {
  const { service, calls } = make({ item: { id: "item-1" } });
  await service.deleteItem("item-1", user);
  const { where, data } = calls.itemUpdate[0];
  assert.deepEqual(where, { id: "item-1" });
  assert.equal(data.deletedAt instanceof Date, true, "软删写 deletedAt 时间戳");
  assert.equal(data.deletedBy, "user-1");
  assert.equal(data.updatedBy, "user-1");
  assert.deepEqual(Object.keys(data).sort(), ["deletedAt", "deletedBy", "updatedBy"].sort(), "软删不夹带其它字段");
  assert.deepEqual(calls.itemDelete, [], "不得走硬删");
});

test("dictionaries.deleteItem_rejects_unknown_item_without_write", async () => {
  const { service, calls } = make({ item: null });
  await assert.rejects(() => service.deleteItem("item-ghost", user), is404);
  assert.deepEqual(calls.itemFindFirst[0], { where: { id: "item-ghost", deletedAt: null } });
  assert.deepEqual(calls.itemUpdate, [], "找不到就不写");
});

test("dictionaries.deleteItem_second_call_is_rejected", async () => {
  const { service, calls } = makeStateful({ types: [{ id: "type-1", key: "color", name: "颜色" }] });
  const created = await service.createItem("color", { key: "red", label: "红" }, user);
  await service.deleteItem(created.id, user);
  await assert.rejects(() => service.deleteItem(created.id, user), is404);
  assert.equal(calls.itemUpdate.length, 1, "重复删除被 404 挡住，不产生第二次写入");
});

// ---------------------------------------------------------------- 员工类型

test("dictionaries.listEmployeeTypes_returns_fixed_types_without_prisma", async () => {
  const { service, calls } = make({ types: [{ id: "whatever", key: "employee_type", name: "员工类型" }] });
  const rows = await service.listEmployeeTypes();
  assert.deepEqual(rows, [
    { id: "employee_type_workshop", key: "workshop", label: "车间", isActive: true },
    { id: "employee_type_non_workshop", key: "non_workshop", label: "非车间", isActive: true },
  ]);
  assert.deepEqual(calls.typeFindMany, [], "固定枚举不读库（数据库里的 employee_type 变更不会影响该接口）");
  assert.deepEqual(calls.itemFindMany, []);
});

test("dictionaries.createEmployeeType_is_retired_and_writes_nothing", async () => {
  const { service, calls } = make();
  await assert.rejects(() => service.createEmployeeType({ key: "workshop", label: "车间" }, user), is404);
  assert.deepEqual(calls.typeCreate, [], "固定枚举不可新增：不产生任何写入");
  assert.deepEqual(calls.itemCreate, []);
  assert.deepEqual(calls.typeFindFirst, [], "直接抛异常，连前置查询都不发");
});

// ---------------------------------------------------------------- 横向：查询形状 / 错误契约

test("dictionaries.mutations_open_no_transaction_raw_sql_or_audit_event", async () => {
  const { service, calls } = make({ type: { id: "type-1", key: "color" }, item: { id: "item-1" } });
  await service.createType({ key: "color", name: "颜色" }, user);
  await service.createItem("color", { key: "red", label: "红" }, user);
  await service.updateItem("item-1", { label: "深红" }, user);
  await service.deleteItem("item-1", user);
  assert.deepEqual(calls.transaction, [], "每次写都是单条语句：无事务、无行锁");
  assert.deepEqual(calls.queryRaw, [], "本模块不使用 SELECT ... FOR UPDATE");
  assert.deepEqual(calls.executeRaw, []);
  // 观察：字典变更只写 created_by/updated_by 列，不落 audit_events（对比其它模块会调 audit.record）；
  // 是否有意为之未在代码中说明 —— 标注为未验证。
  assert.deepEqual(calls.auditEventCreate, [], "字典 CRUD 当前不产生审计事件行");
});

test("dictionaries.not_found_errors_carry_no_business_code", async () => {
  // KNOWN_DEFECT（错误契约缺口）：本模块抛出的是纯字符串 NotFoundException，
  // getResponse() = { message, error: "Not Found", statusCode: 404 }，没有 code 字段；
  // 经 ApiExceptionFilter 后统一映射为通用码 NOT_FOUND（见 test/unit/error-envelope-mapping.test.cjs:41），
  // 因此前端无法用机器码区分「字典类型不存在」与「字典项不存在」，只能匹配中文文案。
  // 仓库其它模块的写法是 NotFoundException({ code: "XXX_NOT_FOUND", ... })。
  // 责任位置：apps/api/src/platform/dictionaries/dictionaries.service.ts:19,33,34
  const missingType = make({ type: null });
  const typeError = await missingType.service.listItems("ghost").then(() => null, (error) => error);

  const missingItem = make({ item: null });
  const itemError = await missingItem.service.updateItem("item-ghost", { label: "x" }, user).then(() => null, (error) => error);

  for (const error of [typeError, itemError]) {
    assert.ok(error instanceof NotFoundException);
    assert.equal(error.getResponse().statusCode, 404);
    assert.equal(error.getResponse().code, undefined, "无业务机器码：与仓库其它模块的 code 约定不一致");
  }
  assert.equal(typeError.getResponse().message, "字典类型不存在");
  assert.equal(itemError.getResponse().message, "字典项不存在");
  assert.equal(typeError.getResponse().code, itemError.getResponse().code, "两种失败在信封层不可区分");
});
