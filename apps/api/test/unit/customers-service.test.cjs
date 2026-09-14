const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CustomersService } = require("../../dist/modules/sales/customers.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { dailyCodePrefix } = require("../../dist/platform/database/daily-sequence-code.js");

// 客户主数据：CRUD + 联系人 + 自动编码（CUS-YYYYMMDD-NNNN）+ 软删。
// 本文件只连手写假 Prisma（不连库），断言外部行为：返回值、异常机器码（getResponse().code）、
// 以及真正传给 Prisma 的查询形状（where / data）；失败路径一律额外断言「没有发生写入」。

const USER = { id: "user-1" };
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";

/** Prisma P2002：target 可为列名数组 / 约束名 / 缺失（拿不到 target 时服务应保守不重试）。 */
function uniqueViolation(target) {
  const error = new Error("Unique constraint failed");
  error.code = "P2002";
  if (target !== undefined) error.meta = { target };
  return error;
}

/** 手写假 Prisma：记录每个模型的调用参数；$transaction 同时支持数组式与回调式（含 tx 桩）。 */
function fakePrisma(overrides = {}) {
  const calls = {
    findMany: [], count: [], findFirst: [], create: [], update: [], hardDelete: [],
    contactFindFirst: [], contactCreate: [], contactUpdate: [], contactUpdateMany: [], contactHardDelete: [],
    auditEvents: [], sequence: [], transactionWithFn: 0, transactionWithArray: 0,
  };
  const customerContact = {
    async findFirst(args) { calls.contactFindFirst.push(args); return null; },
    async create(args) { calls.contactCreate.push(args); calls.sequence.push("contact.create"); return { id: "contact-created", ...args.data }; },
    async update(args) { calls.contactUpdate.push(args); calls.sequence.push("contact.update"); return { id: args.where.id, ...args.data }; },
    async updateMany(args) { calls.contactUpdateMany.push(args); calls.sequence.push("contact.updateMany"); return { count: 1 }; },
    async delete(args) { calls.contactHardDelete.push(args); return { id: args.where.id }; },
  };
  const customer = {
    async findMany(args) { calls.findMany.push(args); return []; },
    async count(args) { calls.count.push(args); return 0; },
    async findFirst(args) { calls.findFirst.push(args); return { id: args.where.id, deletedAt: null }; },
    async create(args) { calls.create.push(args); return { id: "customer-created", ...args.data }; },
    async update(args) { calls.update.push(args); return { id: args.where.id, ...args.data }; },
    async delete(args) { calls.hardDelete.push(args); return { id: args.where.id }; },
  };
  const prisma = {
    calls,
    customer,
    customerContact,
    auditEvent: { async create({ data }) { calls.auditEvents.push(data); return data; } },
    // 行锁（$queryRaw / $executeRawUnsafe）桩：客户模块当前不用，但保持与其它假 client 一致的形状。
    async $queryRaw(...args) { calls.sequence.push("queryRaw"); return args[0] ?? []; },
    async $executeRawUnsafe(...args) { calls.sequence.push("executeRawUnsafe"); return args.length; },
    async $transaction(arg) {
      if (Array.isArray(arg)) { calls.transactionWithArray += 1; return Promise.all(arg); }
      calls.transactionWithFn += 1;
      return arg({ customer, customerContact });
    },
  };
  if (overrides.customer) Object.assign(customer, overrides.customer);
  if (overrides.customerContact) Object.assign(customerContact, overrides.customerContact);
  if (overrides.prisma) Object.assign(prisma, overrides.prisma);
  return prisma;
}

/** 装配真实 AuditService（写入走 auditEvent 桩）+ 被测 CustomersService。 */
function build(overrides = {}) {
  const prisma = fakePrisma(overrides);
  return { prisma, service: new CustomersService(prisma, new AuditService(prisma)) };
}

function rejectsWithCode(promiseFactory, code, status) {
  return assert.rejects(promiseFactory, (error) => {
    assert.equal(typeof error.getResponse, "function", "必须是 Nest 异常（可读机器码）");
    assert.equal(error.getResponse().code, code);
    if (status !== undefined) assert.equal(error.getStatus(), status);
    return true;
  });
}

// ---------------------------------------------------------------- list

test("customers.list_withoutSearch_filtersSoftDeletedAndPaginatesFromTheRequestedPage", async () => {
  const rows = [{ id: "c-1", name: "客户1" }];
  const { prisma, service } = build({
    customer: {
      findMany: async (args) => { prisma.calls.findMany.push(args); return rows; },
      count: async (args) => { prisma.calls.count.push(args); return 7; },
    },
  });

  const result = await service.list(2, 20);

  assert.deepEqual(result, { data: rows, total: 7 });
  assert.equal(prisma.calls.transactionWithArray, 1, "list 必须走一次数组式 $transaction");
  const args = prisma.calls.findMany[0];
  assert.deepEqual(args.where, { deletedAt: null });
  assert.equal("OR" in args.where, false, "无搜索词时不应带 OR");
  assert.deepEqual(args.orderBy, { updatedAt: "desc" });
  assert.equal(args.skip, 20, "第 2 页 skip=(2-1)*20");
  assert.equal(args.take, 20);
  assert.deepEqual(args.include.contacts.where, { deletedAt: null });
  assert.deepEqual(args.include.contacts.orderBy, [{ isDefault: "desc" }, { name: "asc" }]);
  assert.deepEqual(prisma.calls.count[0].where, { deletedAt: null }, "count 必须与 findMany 用同一 where（否则 total 与数据不一致）");
});

test("customers.list_withSearch_matchesNameOrCodeCaseInsensitively", async () => {
  const { prisma, service } = build();
  await service.list(1, 20, "acme");
  const where = prisma.calls.findMany[0].where;
  assert.deepEqual(where, {
    deletedAt: null,
    OR: [
      { name: { contains: "acme", mode: "insensitive" } },
      { customerCode: { contains: "acme", mode: "insensitive" } },
    ],
  });
  assert.deepEqual(prisma.calls.count[0].where, where);
});

test("customers.list_emptySearch_isTreatedAsNoSearch_butWhitespaceSearchIsNotTrimmed", async () => {
  const { prisma, service } = build();
  await service.list(1, 20, "");
  assert.equal("OR" in prisma.calls.findMany[0].where, false, "空串搜索词按「不搜索」处理");

  await service.list(1, 20, " ");
  const where = prisma.calls.findMany[1].where;
  assert.deepEqual(where.OR[0].name, { contains: " ", mode: "insensitive" }, "搜索词不做 trim（空格仍是有效搜索词）");
});

test("customers.list_pageBoundaryValues_mapToSkipAndTake", async () => {
  const { prisma, service } = build();
  await service.list(1, 1);
  assert.equal(prisma.calls.findMany[0].skip, 0);
  assert.equal(prisma.calls.findMany[0].take, 1);
  // PaginationQueryDto 已把 page 限制为 >=1、page_size 限制为 1..200（apps/api/src/platform/http/pagination-query.dto.ts），
  // 服务层不做二次校验：这里固定上边界映射，0 / 负数由 DTO 在进服务前拦掉。
  await service.list(3, 200);
  assert.equal(prisma.calls.findMany[1].skip, 400);
  assert.equal(prisma.calls.findMany[1].take, 200);
});

// ---------------------------------------------------------------- get

test("customers.get_found_returnsCustomerWithOnlyActiveContacts", async () => {
  const row = { id: CUSTOMER_ID, name: "客户1", deletedAt: null };
  const { prisma, service } = build({ customer: { findFirst: async (args) => { prisma.calls.findFirst.push(args); return row; } } });

  const result = await service.get(CUSTOMER_ID);

  assert.equal(result, row);
  const args = prisma.calls.findFirst[0];
  assert.deepEqual(args.where, { id: CUSTOMER_ID, deletedAt: null });
  assert.deepEqual(args.include.contacts.where, { deletedAt: null });
  assert.deepEqual(args.include.contacts.orderBy, [{ isDefault: "desc" }, { name: "asc" }]);
});

test("customers.get_missingOrSoftDeleted_throwsCUSTOMER_NOT_FOUND_withoutWriting", async () => {
  // 软删客户被 where.deletedAt=null 过滤掉后同样走 404 分支，故合并验证。
  const { prisma, service } = build({ customer: { findFirst: async () => null } });

  await rejectsWithCode(() => service.get(CUSTOMER_ID), "CUSTOMER_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.create, []);
  assert.deepEqual(prisma.calls.update, []);
  assert.deepEqual(prisma.calls.auditEvents, []);
});

// ---------------------------------------------------------------- create

test("customers.create_manualCode_writesTrimmedCodeAuditFieldsAndAuditEvent", async () => {
  const { prisma, service } = build();

  const customer = await service.create({ customer_code: "  CUS-20260912-0007  ", name: "客户A", country_region: "CN" }, USER);

  const data = prisma.calls.create[0].data;
  assert.equal(data.customerCode, "CUS-20260912-0007", "手工编码必须 trim 后入库");
  assert.equal(data.name, "客户A");
  assert.equal(data.countryRegion, "CN");
  assert.equal(data.createdBy, "user-1");
  assert.equal(data.updatedBy, "user-1");
  assert.equal(customer.id, "customer-created");
  assert.equal(prisma.calls.findMany.length, 0, "手工编码模式不应去查当天最大序号");

  const event = prisma.calls.auditEvents[0];
  assert.equal(event.action, "customer.create");
  assert.equal(event.entityType, "customer");
  assert.equal(event.entityId, "customer-created");
  assert.equal(event.actorId, "user-1");
  assert.deepEqual(event.details, { customer_code: "CUS-20260912-0007", name: "客户A" });
});

test("customers.create_missingCodeInManualMode_throwsCUSTOMER_CODE_REQUIRED_withoutAnyWrite", async () => {
  const { prisma, service } = build();

  await rejectsWithCode(() => service.create({ name: "客户A" }, USER), "CUSTOMER_CODE_REQUIRED", 422);
  await rejectsWithCode(() => service.create({ code_mode: "manual", name: "客户A" }, USER), "CUSTOMER_CODE_REQUIRED", 422);

  assert.deepEqual(prisma.calls.create, [], "校验失败绝不能落库");
  assert.deepEqual(prisma.calls.findMany, [], "也不应触发自动编码查询");
  assert.deepEqual(prisma.calls.auditEvents, []);
});

test("customers.create_blankCode_isRejectedAsMissingCode", async () => {
  const { prisma, service } = build();
  for (const customer_code of ["", "   ", "\t\n"]) {
    await rejectsWithCode(() => service.create({ customer_code, name: "客户A" }, USER), "CUSTOMER_CODE_REQUIRED", 422);
  }
  assert.deepEqual(prisma.calls.create, []);
  assert.deepEqual(prisma.calls.auditEvents, []);
});

test("customers.create_codeModeIsMatchedStrictly_onlyTheLiteralAutoEnablesAutoCoding", async () => {
  const { prisma, service } = build();
  // 大小写 / 前后空格都不算 auto，会退回「手工编码模式」并要求编码。
  for (const code_mode of ["AUTO", "auto ", " auto", "Auto", "automatic", ""]) {
    await rejectsWithCode(() => service.create({ code_mode, name: "客户A" }, USER), "CUSTOMER_CODE_REQUIRED", 422);
  }
  assert.deepEqual(prisma.calls.create, []);
  assert.deepEqual(prisma.calls.findMany, []);
});

test("customers.create_autoMode_usesMaxNumericSuffixOfTodayAndIgnoresManualSuffixes", async () => {
  const prefix = dailyCodePrefix("CUS");
  const { prisma, service } = build({
    customer: {
      findMany: async (args) => {
        prisma.calls.findMany.push(args);
        return [{ customerCode: `${prefix}0001` }, { customerCode: `${prefix}ABC` }, { customerCode: `${prefix}0002` }, { customerCode: "SUP-20260912-0099" }];
      },
    },
  });

  await service.create({ code_mode: "auto", name: "客户B" }, USER);

  const args = prisma.calls.findMany[0];
  const usedPrefix = args.where.customerCode.startsWith;
  assert.match(usedPrefix, /^CUS-\d{8}-$/, "自动编码前缀 = CUS-YYYYMMDD-");
  assert.deepEqual(args.select, { customerCode: true }, "自动编码只取编码列");
  assert.equal(prisma.calls.create[0].data.customerCode, `${usedPrefix}0003`, "非数字后缀（ABC）不参与序号比较");
});

test("customers.create_autoMode_startsAt0001WhenNoCustomerCodeExistsToday", async () => {
  const { prisma, service } = build();
  await service.create({ code_mode: "auto", name: "客户首个" }, USER);
  const usedPrefix = prisma.calls.findMany[0].where.customerCode.startsWith;
  assert.equal(prisma.calls.create[0].data.customerCode, `${usedPrefix}0001`);
});

test("customers.create_autoMode_winsOverSuppliedManualCode", async () => {
  const { prisma, service } = build();
  await service.create({ code_mode: "auto", customer_code: "CUS-MANUAL-1", name: "客户C" }, USER);
  const usedPrefix = prisma.calls.findMany[0].where.customerCode.startsWith;
  assert.equal(prisma.calls.create[0].data.customerCode, `${usedPrefix}0001`, "code_mode=auto 时忽略传入的 encoding 编码");
  assert.equal(prisma.calls.findMany.length, 1);
});

test("customers.create_emptyOrOverlongName_isNotGuardedByTheServiceLayer", async () => {
  const { prisma, service } = build();
  const overlong = "客".repeat(201);
  await service.create({ customer_code: "CUS-1", name: "" }, USER);
  await service.create({ customer_code: "CUS-2", name: overlong }, USER);
  // KNOWN_DEFECT 空客户名可以一路写进库（未修，仅记录）：
  //   复现：POST /api/customers { code_mode:"manual", customer_code:"CUS-1", name:"" }
  //   期望：400/422（name 在 CustomerDto 里是必填，缺省即拒）；实际：ValidationPipe 放行
  //   （@IsString() 对 "" 返回 true，且没有 @IsNotEmpty），服务层也不校验 → 写入 name:""
  //   （customers.name 是 NOT NULL UNIQUE，于是第二个空名客户会撞唯一索引得到 409）。
  //   责任位置：apps/api/src/modules/sales/customers.controller.ts:17（缺 @IsNotEmpty）、
  //            apps/api/src/modules/sales/customers.service.ts:40（直接透传 input.name）。
  // 服务层同样不做长度校验：上限只由 DTO 的 @MaxLength(200) 承担（见 master-data-create-dto.test.cjs）。
  assert.equal(prisma.calls.create[0].data.name, "");
  assert.equal(prisma.calls.create[1].data.name.length, 201);
});

test("customers.create_autoMode_retriesOnCustomerCodeViolationAndRecomputesTheCode", async () => {
  const prefix = dailyCodePrefix("CUS");
  let lookups = 0;
  const { prisma, service } = build({
    customer: {
      findMany: async (args) => {
        prisma.calls.findMany.push(args);
        lookups += 1;
        return lookups === 1 ? [{ customerCode: `${prefix}0001` }] : [{ customerCode: `${prefix}0001` }, { customerCode: `${prefix}0002` }];
      },
      create: async (args) => {
        prisma.calls.create.push(args);
        if (prisma.calls.create.length === 1) throw uniqueViolation(["customer_code"]);
        return { id: "customer-created", ...args.data };
      },
    },
  });

  const customer = await service.create({ code_mode: "auto", name: "并发客户" }, USER);

  assert.equal(prisma.calls.create.length, 2, "撞客户编码唯一索引后必须重算重试一次");
  assert.equal(prisma.calls.create[0].data.customerCode, `${prefix}0002`);
  assert.equal(prisma.calls.create[1].data.customerCode, `${prefix}0003`, "重试必须重新查当天最大值");
  assert.equal(prisma.calls.findMany.length, 2);
  assert.equal(customer.id, "customer-created");
  assert.equal(prisma.calls.auditEvents.length, 1, "只有成功的写入才记审计");
});

test("customers.create_autoMode_givesUpAfterThreeAttemptsAndThrowsCUSTOMER_CONFLICT", async () => {
  const { prisma, service } = build({
    customer: { create: async (args) => { prisma.calls.create.push(args); throw uniqueViolation(["customer_code"]); } },
  });

  await rejectsWithCode(() => service.create({ code_mode: "auto", name: "撞号客户" }, USER), "CUSTOMER_CONFLICT", 409);

  assert.equal(prisma.calls.create.length, 3, "最多尝试 3 次（attempt < 3 才重试）");
  assert.deepEqual(prisma.calls.auditEvents, [], "全部失败时不得留下审计/写入痕迹");
});

test("customers.create_nameConflict_isNotRetried_evenInAutoMode", async () => {
  const { prisma, service } = build({
    customer: { create: async (args) => { prisma.calls.create.push(args); throw uniqueViolation(["customers_name_key"]); } },
  });

  await rejectsWithCode(() => service.create({ code_mode: "auto", name: "重名客户" }, USER), "CUSTOMER_CONFLICT", 409);

  assert.equal(prisma.calls.create.length, 1, "撞名称重试没有意义，必须立刻 409");
  assert.deepEqual(prisma.calls.auditEvents, []);
});

test("customers.create_p2002WithoutTargetInfo_isNotRetried_andBecomesConflict", async () => {
  const { prisma, service } = build({
    customer: { create: async (args) => { prisma.calls.create.push(args); throw uniqueViolation(undefined); } },
  });

  await rejectsWithCode(() => service.create({ code_mode: "auto", name: "客户D" }, USER), "CUSTOMER_CONFLICT", 409);

  assert.equal(prisma.calls.create.length, 1, "拿不到 target 时保守不重试（不会写坏数据）");
});

test("customers.create_manualModeConflict_isNotRetried_notEvenOnCustomerCode", async () => {
  const { prisma, service } = build({
    customer: { create: async (args) => { prisma.calls.create.push(args); throw uniqueViolation(["customers_customer_code_key"]); } },
  });

  await rejectsWithCode(() => service.create({ customer_code: "CUS-9", name: "客户E" }, USER), "CUSTOMER_CONFLICT", 409);

  assert.equal(prisma.calls.create.length, 1, "重试只服务于自动编码撞号");
  assert.equal(prisma.calls.findMany.length, 0);
  assert.deepEqual(prisma.calls.auditEvents, []);
});

test("customers.create_nonUniqueDatabaseError_isRethrownUnchanged", async () => {
  const boom = Object.assign(new Error("FK violation"), { code: "P2003" });
  const { prisma, service } = build({ customer: { create: async (args) => { prisma.calls.create.push(args); throw boom; } } });

  await assert.rejects(() => service.create({ customer_code: "CUS-9", name: "客户F" }, USER), (error) => {
    assert.equal(error, boom, "非 P2002 必须原样抛出，不能被包装成 409");
    assert.equal(error.code, "P2003");
    return true;
  });
  assert.deepEqual(prisma.calls.auditEvents, []);
});

// ---------------------------------------------------------------- update

test("customers.update_missingCustomer_throwsCUSTOMER_NOT_FOUND_withoutWrite", async () => {
  const { prisma, service } = build({ customer: { findFirst: async () => null } });

  await rejectsWithCode(() => service.update(CUSTOMER_ID, { name: "新名" }, USER), "CUSTOMER_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.update, [], "前置校验失败时不能调用 update");
  assert.deepEqual(prisma.calls.auditEvents, []);
});

test("customers.update_partialInput_onlyWritesProvidedFields", async () => {
  const { prisma, service } = build();

  await service.update(CUSTOMER_ID, { name: "改名后的客户", currency: "USD" }, USER);

  const args = prisma.calls.update[0];
  assert.equal(args.where.id, CUSTOMER_ID);
  assert.deepEqual(Object.keys(args.data).sort(), ["currency", "name", "updatedBy"]);
  assert.equal("countryRegion" in args.data, false, "未提供的字段必须完全不出现在 data 里（避免被清空）");
  assert.equal("remark" in args.data, false);
  assert.equal("customerCode" in args.data, false);

  const event = prisma.calls.auditEvents[0];
  assert.equal(event.action, "customer.update");
  assert.equal(event.entityId, CUSTOMER_ID);
  assert.deepEqual(event.details, { fields: ["name", "currency"] });
});

test("customers.update_emptyStringValues_areWrittenThroughAsEmptyNotSkipped", async () => {
  const { prisma, service } = build();
  await service.update(CUSTOMER_ID, { remark: "", address: "", payment_terms: "" }, USER);
  const data = prisma.calls.update[0].data;
  assert.equal(data.remark, "");
  assert.equal(data.address, "");
  assert.equal(data.paymentTerms, "");
  assert.deepEqual(Object.keys(data).sort(), ["address", "paymentTerms", "remark", "updatedBy"]);
});

test("customers.update_customerCode_isNotTrimmedUnlikeCreate", async () => {
  const { prisma, service } = build();
  // 观察（与 create 不一致，但与采购主数据 updateMaterial/updateSupplier 的既有行为一致）：
  // create 会 trim 编码，update 原样透传。此处固定现状，是否属缺陷见报告。
  await service.update(CUSTOMER_ID, { customer_code: "  CUS-20260912-0009  " }, USER);
  assert.equal(prisma.calls.update[0].data.customerCode, "  CUS-20260912-0009  ");
});

test("customers.update_p2002_throwsCUSTOMER_CONFLICT_afterASingleAttempt", async () => {
  const { prisma, service } = build({
    customer: {
      findFirst: async (args) => { prisma.calls.findFirst.push(args); return { id: CUSTOMER_ID }; },
      update: async (args) => { prisma.calls.update.push(args); throw uniqueViolation(["customer_code"]); },
    },
  });

  await rejectsWithCode(() => service.update(CUSTOMER_ID, { customer_code: "CUS-DUP" }, USER), "CUSTOMER_CONFLICT", 409);

  assert.equal(prisma.calls.update.length, 1, "update 不做自动编码重试");
  assert.deepEqual(prisma.calls.auditEvents, []);
});

test("customers.update_nonUniqueDatabaseError_isRethrownUnchanged", async () => {
  const boom = Object.assign(new Error("check violation"), { code: "P2004" });
  const { prisma, service } = build({ customer: { update: async (args) => { prisma.calls.update.push(args); throw boom; } } });

  await assert.rejects(() => service.update(CUSTOMER_ID, { name: "客户G" }, USER), (error) => {
    assert.equal(error, boom);
    return true;
  });
});

// ---------------------------------------------------------------- setActive

test("customers.setActive_true_setsFlagAndRecordsActivateEvent", async () => {
  const { prisma, service } = build();

  await service.setActive(CUSTOMER_ID, true, USER);

  const args = prisma.calls.update[0];
  assert.equal(args.where.id, CUSTOMER_ID);
  assert.equal(args.data.isActive, true);
  assert.equal(args.data.updatedBy, "user-1");
  assert.equal(prisma.calls.auditEvents[0].action, "customer.activate");
  assert.equal(prisma.calls.auditEvents[0].entityId, CUSTOMER_ID);
});

test("customers.setActive_false_writesBooleanFalseAndRecordsDeactivateEvent", async () => {
  const { prisma, service } = build();

  await service.setActive(CUSTOMER_ID, false, USER);

  assert.equal(prisma.calls.update[0].data.isActive, false, "false 不能被当成「未提供」而跳过");
  assert.equal(prisma.calls.auditEvents[0].action, "customer.deactivate");
});

test("customers.setActive_missingCustomer_throwsCUSTOMER_NOT_FOUND_withoutWrite", async () => {
  const { prisma, service } = build({ customer: { findFirst: async () => null } });

  await rejectsWithCode(() => service.setActive(CUSTOMER_ID, false, USER), "CUSTOMER_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.update, []);
  assert.deepEqual(prisma.calls.auditEvents, []);
});

// ---------------------------------------------------------------- delete（软删）

test("customers.delete_softDeletesInsteadOfHardDeleting", async () => {
  const { prisma, service } = build();

  await service.delete(CUSTOMER_ID, USER);

  const args = prisma.calls.update[0];
  assert.equal(args.where.id, CUSTOMER_ID);
  assert.ok(args.data.deletedAt instanceof Date, "软删写 deletedAt");
  assert.equal(args.data.deletedBy, "user-1");
  assert.equal(args.data.updatedBy, "user-1");
  assert.deepEqual(prisma.calls.hardDelete, [], "绝不能物理删除客户");
  assert.equal(prisma.calls.auditEvents[0].action, "customer.delete");
  assert.equal(prisma.calls.auditEvents[0].entityId, CUSTOMER_ID);
});

test("customers.delete_missingCustomer_throwsCUSTOMER_NOT_FOUND_withoutWrite", async () => {
  const { prisma, service } = build({ customer: { findFirst: async () => null } });

  await rejectsWithCode(() => service.delete(CUSTOMER_ID, USER), "CUSTOMER_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.update, []);
  assert.deepEqual(prisma.calls.hardDelete, []);
  assert.deepEqual(prisma.calls.auditEvents, []);
});

// ---------------------------------------------------------------- 联系人：新增

test("customers.createContact_defaultContact_clearsOtherDefaultsBeforeInsert", async () => {
  const { prisma, service } = build();

  const contact = await service.createContact(CUSTOMER_ID, { name: "张经理", phone: "13800000000", is_default: true }, USER);

  assert.equal(prisma.calls.transactionWithFn, 1, "联系人写入必须在一个事务里");
  assert.deepEqual(prisma.calls.sequence, ["contact.updateMany", "contact.create"], "先把旧默认联系人降级，再插入新默认联系人");
  assert.deepEqual(prisma.calls.contactUpdateMany[0], {
    where: { customerId: CUSTOMER_ID, deletedAt: null },
    data: { isDefault: false, updatedBy: "user-1" },
  });
  const data = prisma.calls.contactCreate[0].data;
  assert.equal(data.customerId, CUSTOMER_ID);
  assert.equal(data.isDefault, true);
  assert.equal(data.isActive, true);
  assert.equal(data.createdBy, "user-1");
  assert.equal(data.updatedBy, "user-1");
  assert.equal(contact.id, "contact-created");

  const event = prisma.calls.auditEvents[0];
  assert.equal(event.action, "customer_contact.create");
  assert.equal(event.entityType, "customer_contact");
  assert.equal(event.entityId, "contact-created");
  assert.deepEqual(event.details, { customer_id: CUSTOMER_ID });
});

test("customers.createContact_withoutDefaultFlag_doesNotTouchOtherContacts_andAppliesDefaults", async () => {
  const { prisma, service } = build();

  await service.createContact(CUSTOMER_ID, { name: "李工" }, USER);

  assert.deepEqual(prisma.calls.contactUpdateMany, [], "非默认联系人不得重置别人的 is_default");
  assert.deepEqual(prisma.calls.sequence, ["contact.create"]);
  assert.equal(prisma.calls.contactCreate[0].data.isDefault, false);
  assert.equal(prisma.calls.contactCreate[0].data.isActive, true);
});

test("customers.createContact_explicitFalseFlags_areNotOverriddenByDefaults", async () => {
  const { prisma, service } = build();

  await service.createContact(CUSTOMER_ID, { name: "王工", is_default: false, is_active: false }, USER);

  assert.deepEqual(prisma.calls.contactUpdateMany, []);
  assert.equal(prisma.calls.contactCreate[0].data.isDefault, false);
  assert.equal(prisma.calls.contactCreate[0].data.isActive, false, "is_active:false 不能被 ?? true 覆盖");
});

test("customers.createContact_missingCustomer_throwsCUSTOMER_NOT_FOUND_withoutContactWrite", async () => {
  const { prisma, service } = build({ customer: { findFirst: async () => null } });

  await rejectsWithCode(() => service.createContact(CUSTOMER_ID, { name: "张经理", is_default: true }, USER), "CUSTOMER_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.contactCreate, []);
  assert.deepEqual(prisma.calls.contactUpdateMany, []);
  assert.equal(prisma.calls.transactionWithFn, 0, "客户不存在时连事务都不该开");
  assert.deepEqual(prisma.calls.auditEvents, []);
});

// ---------------------------------------------------------------- 联系人：修改

test("customers.updateContact_missingContact_throwsCUSTOMER_CONTACT_NOT_FOUND_withoutWrite", async () => {
  const { prisma, service } = build(); // customerContact.findFirst 默认返回 null

  await rejectsWithCode(() => service.updateContact(CUSTOMER_ID, CONTACT_ID, { phone: "13900000000" }, USER), "CUSTOMER_CONTACT_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.contactFindFirst[0].where, { id: CONTACT_ID, customerId: CUSTOMER_ID, deletedAt: null }, "联系人必须属于该客户且未软删");
  assert.deepEqual(prisma.calls.contactUpdate, []);
  assert.deepEqual(prisma.calls.contactUpdateMany, []);
  assert.equal(prisma.calls.transactionWithFn, 0);
  assert.deepEqual(prisma.calls.auditEvents, []);
});

test("customers.updateContact_missingCustomer_throwsCUSTOMER_NOT_FOUND_withoutContactLookup", async () => {
  const { prisma, service } = build({ customer: { findFirst: async () => null } });

  await rejectsWithCode(() => service.updateContact(CUSTOMER_ID, CONTACT_ID, { phone: "1" }, USER), "CUSTOMER_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.contactFindFirst, [], "客户不存在时不应继续查联系人");
  assert.deepEqual(prisma.calls.contactUpdate, []);
  assert.equal(prisma.calls.transactionWithFn, 0);
});

test("customers.updateContact_promotingToDefault_clearsOtherDefaultsThenUpdatesTheTarget", async () => {
  const { prisma, service } = build({
    customerContact: { findFirst: async (args) => { prisma.calls.contactFindFirst.push(args); return { id: CONTACT_ID, customerId: CUSTOMER_ID }; } },
  });

  await service.updateContact(CUSTOMER_ID, CONTACT_ID, { is_default: true, phone: "13900000000" }, USER);

  assert.deepEqual(prisma.calls.sequence, ["contact.updateMany", "contact.update"]);
  assert.deepEqual(prisma.calls.contactUpdateMany[0], {
    where: { customerId: CUSTOMER_ID, deletedAt: null },
    data: { isDefault: false, updatedBy: "user-1" },
  });
  const args = prisma.calls.contactUpdate[0];
  assert.deepEqual(args.where, { id: CONTACT_ID }, "更新目标用 requireContact 查出的联系人 id");
  assert.deepEqual(Object.keys(args.data).sort(), ["isDefault", "phone", "updatedBy"]);
  assert.equal(args.data.isDefault, true);
  assert.equal(args.data.phone, "13900000000");

  const event = prisma.calls.auditEvents[0];
  assert.equal(event.action, "customer_contact.update");
  assert.equal(event.entityId, CONTACT_ID);
  assert.deepEqual(event.details, { fields: ["is_default", "phone"] });
});

test("customers.updateContact_explicitFalseDefault_doesNotClearOtherContacts", async () => {
  const { prisma, service } = build({
    customerContact: { findFirst: async (args) => { prisma.calls.contactFindFirst.push(args); return { id: CONTACT_ID, customerId: CUSTOMER_ID }; } },
  });

  await service.updateContact(CUSTOMER_ID, CONTACT_ID, { is_default: false }, USER);

  assert.deepEqual(prisma.calls.contactUpdateMany, [], "is_default:false 走 falsy 分支，不会重置他人");
  assert.equal(prisma.calls.contactUpdate[0].data.isDefault, false);
  // 观察：若该联系人是唯一默认联系人，把它设为 false 后该客户可能没有任何默认联系人（服务不做补偿）。
  assert.deepEqual(prisma.calls.sequence, ["contact.update"]);
});

test("customers.updateContact_partialInput_dropsUnsetFields", async () => {
  const { prisma, service } = build({
    customerContact: { findFirst: async (args) => { prisma.calls.contactFindFirst.push(args); return { id: CONTACT_ID, customerId: CUSTOMER_ID }; } },
  });

  await service.updateContact(CUSTOMER_ID, CONTACT_ID, { email: "a@b.com" }, USER);

  assert.deepEqual(Object.keys(prisma.calls.contactUpdate[0].data).sort(), ["email", "updatedBy"]);
  assert.equal("name" in prisma.calls.contactUpdate[0].data, false);
  assert.equal("isActive" in prisma.calls.contactUpdate[0].data, false);
});

// ---------------------------------------------------------------- 联系人：软删

test("customers.deleteContact_softDeletesContactAndRecordsAudit", async () => {
  const { prisma, service } = build({
    customerContact: { findFirst: async (args) => { prisma.calls.contactFindFirst.push(args); return { id: CONTACT_ID, customerId: CUSTOMER_ID }; } },
  });

  await service.deleteContact(CUSTOMER_ID, CONTACT_ID, USER);

  assert.deepEqual(prisma.calls.contactFindFirst[0].where, { id: CONTACT_ID, customerId: CUSTOMER_ID, deletedAt: null });
  const args = prisma.calls.contactUpdate[0];
  assert.deepEqual(args.where, { id: CONTACT_ID });
  assert.ok(args.data.deletedAt instanceof Date, "联系人软删写 deletedAt");
  assert.equal(args.data.deletedBy, "user-1");
  assert.equal(args.data.updatedBy, "user-1");
  assert.deepEqual(prisma.calls.contactHardDelete, [], "联系人不得物理删除");
  assert.equal(prisma.calls.auditEvents[0].action, "customer_contact.delete");
  assert.equal(prisma.calls.auditEvents[0].entityId, CONTACT_ID);
});

test("customers.deleteContact_missingContact_throwsCUSTOMER_CONTACT_NOT_FOUND_withoutWrite", async () => {
  const { prisma, service } = build();

  await rejectsWithCode(() => service.deleteContact(CUSTOMER_ID, CONTACT_ID, USER), "CUSTOMER_CONTACT_NOT_FOUND", 404);

  assert.deepEqual(prisma.calls.contactUpdate, []);
  assert.deepEqual(prisma.calls.contactHardDelete, []);
  assert.deepEqual(prisma.calls.auditEvents, []);
});
