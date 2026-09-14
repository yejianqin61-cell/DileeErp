// StateMachineService（apps/api/src/platform/state-machine/state-machine.service.ts）单元测试。
//
// 该服务是 platform 层的通用状态机，只有两个入口：
//   initialize()  激活态校验 → 事务内建 state_records + 首条 state_changes
//   transition()  激活态校验 → 事务内【行锁】→ 读记录 → 校验流转规则 → 改状态 + 追加变更
//
// 本文件钉住四件事：
//   1. 合法流转的写入形状（where / data / 事件顺序）；
//   2. 行锁的时机与形状（$queryRaw ... FOR UPDATE，且先于读取记录）；
//   3. 非法输入与非法流转【必须零写入】（update / create 未被调用）；
//   4. 服务层**不做任何参数校验**：空串、超长、非 UUID 一律原样下发查询，唯一防线是 DB 约束。
//
// 关于机器码：本服务抛的是【字符串】异常（NotFoundException("状态不存在或已停用") /
// BadRequestException("不允许的状态转换")），自身不带业务 code。真实机器码由
// ApiExceptionFilter 按 HTTP 状态派生（404 → NOT_FOUND、400 → VALIDATION_ERROR），
// 因此下面统一用 envelope() 跑一遍过滤器取机器码断言，而不是断言中文文案。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BadRequestException, NotFoundException } = require("@nestjs/common");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { ApiExceptionFilter } = require("../../dist/platform/http/api-exception.filter.js");
const { StateMachineService } = require("../../dist/platform/state-machine/state-machine.service.js");

const UUID = "2f1c6f5e-9d3a-4b7c-8e10-5a6b7c8d9e0f";
const USER = { display_name: "测试", id: "user-1", username: "tester" };
const RECORD = { currentStateId: "state-draft", entityId: UUID, entityType: "sales_order", id: "record-1", machineKey: "sales_order" };

/** 把异常过一遍真实异常过滤器，取生产环境会给到前端的机器码 / 状态码。 */
function envelope(exception) {
  const response = {
    body: null,
    statusCode: 0,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const request = { header: () => "req-state-machine", method: "POST", url: "/api/v1/state-machine" };
  new ApiExceptionFilter().catch(exception, { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) });
  return { code: response.body.error.code, message: response.body.error.message, status: response.statusCode };
}

/** 断言 promise 失败，且异常类型 / HTTP 状态 / 机器码都对得上；返回捕获到的异常。 */
async function expectFailure(run, expected) {
  let caught = null;
  await assert.rejects(run, (error) => { caught = error; return true; });
  assert.ok(caught instanceof expected.type, `期望 ${expected.type.name}，实际 ${caught && caught.constructor.name}`);
  const built = envelope(caught);
  assert.equal(built.status, expected.status, "HTTP 状态码");
  assert.equal(built.code, expected.code, "机器码");
  assert.equal(typeof built.message, "string");
  assert.ok(built.message.length > 0, "错误文案不得为空");
  return caught;
}

/**
 * 手写假 Prisma：记录每次调用的参数与全局事件顺序。
 *
 * options.state      : undefined=按 key 造一个激活态；null=查不到；函数=自定义查询表
 * options.record     : findUnique 的返回值（默认 null）
 * options.transition : findFirst 的返回值（默认 null），可为函数以模拟真实规则表
 * 外层 client 的写方法一律抛错，用来证明写入只走事务客户端。
 */
function fakePrisma(options = {}) {
  const events = [];
  const locks = [];
  const definitionQueries = [];
  const recordQueries = [];
  const recordCreated = [];
  const recordUpdated = [];
  const transitionQueries = [];
  const changeCreated = [];

  const stateFor = (args) => {
    if (typeof options.state === "function") return options.state(args);
    if ("state" in options) return options.state;
    return { deletedAt: null, id: `state-${args.where.key}`, isActive: true, key: args.where.key, machineKey: args.where.machineKey };
  };
  const transitionFor = (args) => (typeof options.transition === "function" ? options.transition(args) : options.transition ?? null);

  const tx = {
    async $queryRaw(strings, ...values) {
      events.push("lock");
      locks.push({ sql: Array.from(strings).join("?"), values });
      return [];
    },
    stateRecord: {
      async create(args) { events.push("record.create"); recordCreated.push(args); return options.onCreateRecord ? options.onCreateRecord(args) : { id: "record-1", ...args.data }; },
      async findUnique(args) { events.push("record.findUnique"); recordQueries.push(args); return options.record ?? null; },
      async update(args) { events.push("record.update"); recordUpdated.push(args); return options.onUpdateRecord ? options.onUpdateRecord(args) : { id: args.where.id, ...args.data }; },
    },
    stateTransition: {
      async findFirst(args) { events.push("transition.findFirst"); transitionQueries.push(args); return transitionFor(args); },
    },
    stateChange: {
      async create(args) { events.push("change.create"); changeCreated.push(args); return options.onChangeCreate ? options.onChangeCreate(args) : { id: "change-1", ...args.data }; },
    },
  };

  const outside = (name) => () => { throw new Error(`${name} 必须走事务客户端，不得直接用外层 client`); };
  const prisma = {
    stateDefinition: {
      async findFirst(args) { events.push("definition.findFirst"); definitionQueries.push(args); return stateFor(args); },
    },
    async $transaction(fn) { events.push("transaction.start"); return fn(tx); },
    stateChange: { create: outside("stateChange.create") },
    stateRecord: { create: outside("stateRecord.create"), update: outside("stateRecord.update") },
  };

  return { changeCreated, definitionQueries, events, locks, prisma, recordCreated, recordQueries, recordUpdated, transitionQueries };
}

/** 真实 AuditService（create/update 不碰 prisma，只做字段拼装）。 */
const audit = () => new AuditService({});
const service = (db) => new StateMachineService(db.prisma, audit());

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

test("state-machine.initialize_writes_the_record_and_its_first_change_in_one_transaction", async () => {
  const db = fakePrisma();
  const record = await service(db).initialize("sales_order", "sales_order", UUID, "draft", USER, "建单");

  assert.deepEqual(db.definitionQueries, [{ where: { deletedAt: null, isActive: true, key: "draft", machineKey: "sales_order" } }]);
  assert.equal(db.recordCreated.length, 1);
  assert.deepEqual(db.recordCreated[0].data, {
    createdBy: "user-1", currentStateId: "state-draft", entityId: UUID, entityType: "sales_order", machineKey: "sales_order", updatedBy: "user-1",
  });
  assert.equal(db.changeCreated.length, 1);
  assert.deepEqual(db.changeCreated[0].data, {
    createdBy: "user-1", recordId: "record-1", remark: "建单", toStateId: "state-draft", updatedBy: "user-1",
  });
  assert.equal(db.changeCreated[0].data.fromStateId, undefined, "首条变更没有来源态");
  assert.equal(record.currentStateId, "state-draft");
  assert.equal(record.id, "record-1", "initialize 返回建好的记录本体");
  assert.deepEqual(db.events, ["definition.findFirst", "transaction.start", "record.create", "change.create"]);
});

test("state-machine.initialize_keeps_a_missing_remark_as_undefined_instead_of_writing_a_placeholder", async () => {
  const db = fakePrisma();
  await service(db).initialize("sales_order", "sales_order", UUID, "draft", USER);

  const data = db.changeCreated[0].data;
  assert.ok("remark" in data, "remark 键始终存在");
  assert.equal(data.remark, undefined, "未传备注时写 undefined（DB 落 NULL），不得篡改成空串或默认文案");
});

test("state-machine.initialize_rejects_an_unknown_state_with_404_and_writes_nothing", async () => {
  const db = fakePrisma({ state: null });
  await expectFailure(() => service(db).initialize("sales_order", "sales_order", UUID, "ghost", USER), {
    code: "NOT_FOUND", status: 404, type: NotFoundException,
  });

  assert.deepEqual(db.events, ["definition.findFirst"], "状态不存在时不得进入事务");
  assert.equal(db.recordCreated.length, 0, "状态不存在时不得写记录");
  assert.equal(db.changeCreated.length, 0, "状态不存在时不得写变更历史");
  assert.equal(db.recordUpdated.length, 0);
});

test("state-machine.initialize_rejects_states_that_are_inactive_or_soft_deleted", async () => {
  // 用一张小状态表模拟真实 DB：isActive=false 与 deletedAt 非空的行都必须被 where 过滤掉。
  const table = [
    { deletedAt: null, id: "state-inactive", isActive: false, key: "inactive", machineKey: "sales_order" },
    { deletedAt: new Date("2026-01-01T00:00:00.000Z"), id: "state-deleted", isActive: true, key: "deleted", machineKey: "sales_order" },
  ];
  const lookup = (args) => table.find((row) => row.machineKey === args.where.machineKey && row.key === args.where.key && row.isActive === args.where.isActive && row.deletedAt === args.where.deletedAt) ?? null;

  for (const key of ["inactive", "deleted"]) {
    const db = fakePrisma({ state: lookup });
    await expectFailure(() => service(db).initialize("sales_order", "sales_order", UUID, key, USER), {
      code: "NOT_FOUND", status: 404, type: NotFoundException,
    });
    assert.deepEqual(db.definitionQueries[0].where, { deletedAt: null, isActive: true, key, machineKey: "sales_order" });
    assert.equal(db.recordCreated.length, 0, `${key}: 停用/软删状态不得被用来建记录`);
    assert.equal(db.changeCreated.length, 0, `${key}: 停用/软删状态不得落变更历史`);
  }
});

test("state-machine.initialize_does_not_trim_or_normalise_a_blank_state_key", async () => {
  const db = fakePrisma({ state: null });
  await expectFailure(() => service(db).initialize("sales_order", "sales_order", UUID, "   ", USER), {
    code: "NOT_FOUND", status: 404, type: NotFoundException,
  });

  assert.equal(db.definitionQueries[0].where.key, "   ", "空白 key 原样下发查询，服务层不 trim、不归一化");
  assert.equal(db.recordCreated.length, 0);
  assert.equal(db.changeCreated.length, 0);
});

test("state-machine.initialize_has_no_length_or_uuid_guard_so_the_database_is_the_only_limit", async () => {
  // 服务层没有 class-validator / 长度 / UUID 校验，machineKey 直传（schema 为 VarChar(80)，
  // state_records.entity_id 为 Uuid）。这里钉住"直传"这一事实。
  // 未验证：Postgres 对 >80 字符与非 UUID 的实际拒绝行为（本文件不连库）。
  const longKey = "k".repeat(200);
  const db = fakePrisma();
  await service(db).initialize(longKey, "sales_order", "not-a-uuid", "draft", USER);

  assert.equal(db.definitionQueries[0].where.machineKey, longKey, "超长 machineKey 未被截断或拒绝");
  assert.equal(db.definitionQueries[0].where.machineKey.length, 200);
  assert.equal(db.recordCreated[0].data.entityId, "not-a-uuid", "非 UUID 的 entityId 直达写入参数");
  assert.equal(db.recordCreated[0].data.machineKey, longKey);
});

test("state-machine.initialize_takes_no_row_lock_and_relies_on_the_unique_key", async () => {
  // 隐藏分支：行锁只在 transition 里加。initialize 既不加锁也不做"已存在"预检，
  // 并发重复初始化只能靠 state_records 的 (machine_key, entity_type, entity_id) 唯一键兜底。
  const db = fakePrisma();
  await service(db).initialize("sales_order", "sales_order", UUID, "draft", USER);

  assert.equal(db.locks.length, 0, "initialize 不加行锁");
  assert.equal(db.recordQueries.length, 0, "initialize 不预检记录是否已存在");

  const conflict = Object.assign(new Error("Unique constraint failed on the fields: (`machine_key`,`entity_type`,`entity_id`)"), { code: "P2002" });
  const dup = fakePrisma({ onCreateRecord: () => { throw conflict; } });
  await assert.rejects(() => service(dup).initialize("sales_order", "sales_order", UUID, "draft", USER), (error) => error.code === "P2002");
  assert.equal(dup.changeCreated.length, 0, "记录写入失败后不得继续写变更历史");
  const built = envelope(conflict);
  assert.equal(built.status, 409, "重复初始化由过滤器映射为 409");
  assert.equal(built.code, "UNIQUE_VALUE_CONFLICT");
});

test("state-machine.initialize_fails_closed_when_the_first_change_cannot_be_written", async () => {
  const failure = new Error("state_changes insert failed");
  const db = fakePrisma({ onChangeCreate: () => { throw failure; } });
  await assert.rejects(() => service(db).initialize("sales_order", "sales_order", UUID, "draft", USER), (error) => error === failure);

  assert.equal(db.recordCreated.length, 1, "记录写入先发生；假 client 不回滚，真实 DB 会整事务回滚");
  assert.equal(db.recordUpdated.length, 0);
});

// ---------------------------------------------------------------------------
// transition —— 正常路径
// ---------------------------------------------------------------------------

test("state-machine.transition_locks_the_row_then_updates_the_state_and_appends_the_change", async () => {
  const db = fakePrisma({ record: RECORD, transition: { id: "transition-1" } });
  const updated = await service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER, "审核通过");

  assert.equal(db.locks.length, 1, "进入事务后第一步就是行锁");
  assert.match(db.locks[0].sql, /state_records/);
  assert.match(db.locks[0].sql, /FOR UPDATE/);
  assert.deepEqual(db.locks[0].values, ["sales_order", "sales_order", UUID], "锁参数与入参一一对应");
  assert.deepEqual(db.recordQueries[0].where, {
    machineKey_entityType_entityId: { entityId: UUID, entityType: "sales_order", machineKey: "sales_order" },
  }, "按唯一的复合键读记录");
  assert.deepEqual(db.transitionQueries[0].where, {
    fromStateId: "state-draft", machineKey: "sales_order", toStateId: "state-confirmed",
  }, "规则必须精确匹配 机器/来源态/目标态");
  assert.deepEqual(db.recordUpdated[0], { data: { currentStateId: "state-confirmed", updatedBy: "user-1" }, where: { id: "record-1" } });
  assert.equal("createdBy" in db.recordUpdated[0].data, false, "更新记录不重复盖 createdBy");
  assert.deepEqual(db.changeCreated[0].data, {
    createdBy: "user-1", fromStateId: "state-draft", recordId: "record-1", remark: "审核通过", toStateId: "state-confirmed", updatedBy: "user-1",
  }, "变更历史必须记下来源态与目标态");
  assert.equal(updated.currentStateId, "state-confirmed");
  assert.deepEqual(db.events, [
    "definition.findFirst", "transaction.start", "lock", "record.findUnique", "transition.findFirst", "record.update", "change.create",
  ], "顺序：查目标态 → 开事务 → 加锁 → 读记录 → 查规则 → 改状态 → 追加变更");
});

test("state-machine.transition_passes_the_previous_state_as_from_state_id_after_the_update", async () => {
  // 变更历史里的 fromStateId 必须是【更新前】的 currentStateId，而不是更新后的值。
  const db = fakePrisma({ record: RECORD, transition: { id: "transition-1" } });
  await service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER);

  assert.equal(db.changeCreated[0].data.fromStateId, "state-draft");
  assert.notEqual(db.changeCreated[0].data.fromStateId, db.recordUpdated[0].data.currentStateId);
  assert.equal(db.changeCreated[0].data.toStateId, db.recordUpdated[0].data.currentStateId);
  assert.equal(db.changeCreated[0].data.remark, undefined, "未传备注时为 undefined");
});

test("state-machine.transition_accepts_only_the_direction_stored_in_the_rule_table", async () => {
  // 规则表里只登记 confirmed -> draft（反向），请求 draft -> confirmed 必须被拒。
  const rules = [{ fromStateId: "state-confirmed", machineKey: "sales_order", toStateId: "state-draft" }];
  const lookup = (args) => rules.find((rule) => rule.machineKey === args.where.machineKey && rule.fromStateId === args.where.fromStateId && rule.toStateId === args.where.toStateId) ?? null;

  const forward = fakePrisma({ record: RECORD, transition: lookup });
  await expectFailure(() => service(forward).transition("sales_order", "sales_order", UUID, "confirmed", USER), {
    code: "VALIDATION_ERROR", status: 400, type: BadRequestException,
  });
  assert.equal(forward.recordUpdated.length, 0, "反向流转不得落库");
  assert.equal(forward.changeCreated.length, 0, "反向流转不得写变更历史");

  const backward = fakePrisma({ record: { ...RECORD, currentStateId: "state-confirmed" }, transition: lookup });
  const updated = await service(backward).transition("sales_order", "sales_order", UUID, "draft", USER);
  assert.equal(updated.currentStateId, "state-draft", "同样数据下正向请求被接受");
  assert.equal(backward.changeCreated.length, 1);
});

test("state-machine.transition_requires_an_explicit_self_transition_rule", async () => {
  const rules = [{ fromStateId: "state-draft", machineKey: "sales_order", toStateId: "state-draft" }];
  const lookup = (args) => rules.find((rule) => rule.machineKey === args.where.machineKey && rule.fromStateId === args.where.fromStateId && rule.toStateId === args.where.toStateId) ?? null;

  const without = fakePrisma({ record: RECORD, transition: null });
  await expectFailure(() => service(without).transition("sales_order", "sales_order", UUID, "draft", USER), {
    code: "VALIDATION_ERROR", status: 400, type: BadRequestException,
  });
  assert.deepEqual(without.transitionQueries[0].where, { fromStateId: "state-draft", machineKey: "sales_order", toStateId: "state-draft" });
  assert.equal(without.recordUpdated.length, 0, "无自流转规则时状态不变");
  assert.equal(without.changeCreated.length, 0);

  const with_ = fakePrisma({ record: RECORD, transition: lookup });
  const updated = await service(with_).transition("sales_order", "sales_order", UUID, "draft", USER);
  assert.equal(updated.currentStateId, "state-draft", "显式登记的自流转被接受");
  assert.equal(with_.changeCreated.length, 1, "自流转也留痕");
});

test("state-machine.transition_does_not_re_check_the_activity_of_the_current_state", async () => {
  // 隐藏分支：只校验【目标态】是否激活，从不按 currentStateId 回查来源态。
  // 因此一个停在已停用/软删状态的记录，只要有规则，仍能被流转出去。
  const db = fakePrisma({ record: { ...RECORD, currentStateId: "state-retired" }, transition: { id: "transition-1" } });
  const updated = await service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER);

  assert.equal(db.definitionQueries.length, 1, "只查了一次状态定义");
  assert.equal(db.definitionQueries[0].where.key, "confirmed", "查的是目标态；来源态从未回查");
  assert.deepEqual(db.transitionQueries[0].where, { fromStateId: "state-retired", machineKey: "sales_order", toStateId: "state-confirmed" });
  assert.equal(updated.currentStateId, "state-confirmed");
});

test("state-machine.transition_resolves_the_target_state_outside_the_row_lock", async () => {
  // 目标态的激活校验发生在事务之前，不在行锁保护范围内：并发停用目标态时本方法无法察觉。
  const db = fakePrisma({ record: RECORD, transition: { id: "transition-1" } });
  await service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER);

  assert.ok(db.events.indexOf("definition.findFirst") < db.events.indexOf("transaction.start"));
  assert.ok(db.events.indexOf("transaction.start") < db.events.indexOf("lock"));
  assert.ok(db.events.indexOf("lock") < db.events.indexOf("record.findUnique"), "读记录必须在行锁之后，否则读到的是脏快照");
});

// ---------------------------------------------------------------------------
// transition —— 反向用例
// ---------------------------------------------------------------------------

test("state-machine.transition_rejects_an_unknown_target_state_before_locking_or_writing", async () => {
  const db = fakePrisma({ state: null, record: RECORD, transition: { id: "transition-1" } });
  await expectFailure(() => service(db).transition("sales_order", "sales_order", UUID, "ghost", USER), {
    code: "NOT_FOUND", status: 404, type: NotFoundException,
  });

  assert.deepEqual(db.definitionQueries[0].where, { deletedAt: null, isActive: true, key: "ghost", machineKey: "sales_order" });
  assert.deepEqual(db.events, ["definition.findFirst"], "目标态不存在时不得开事务");
  assert.equal(db.locks.length, 0, "不存在的目标态不得加行锁");
  assert.equal(db.recordUpdated.length, 0);
  assert.equal(db.changeCreated.length, 0);
});

test("state-machine.transition_refuses_to_move_into_an_inactive_or_soft_deleted_target_state", async () => {
  // SRS §5 要求「停用状态」不可作为流转目标；用真实过滤条件（isActive + deletedAt）验证。
  const table = [
    { deletedAt: null, id: "state-t-inactive", isActive: false, key: "confirmed", machineKey: "sales_order" },
    { deletedAt: new Date("2026-02-01T00:00:00.000Z"), id: "state-t-deleted", isActive: true, key: "confirmed", machineKey: "sales_order" },
  ];
  const lookup = (args) => table.find((row) => row.machineKey === args.where.machineKey && row.key === args.where.key && row.isActive === args.where.isActive && row.deletedAt === args.where.deletedAt) ?? null;

  for (const row of table) {
    const db = fakePrisma({ record: RECORD, state: lookup, transition: { id: "transition-1" } });
    await expectFailure(() => service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER), {
      code: "NOT_FOUND", status: 404, type: NotFoundException,
    });
    assert.deepEqual(db.definitionQueries[0].where, { deletedAt: null, isActive: true, key: "confirmed", machineKey: "sales_order" }, `${row.id} 必须被 where 过滤`);
    assert.equal(db.locks.length, 0, `${row.id}: 停用/软删目标态不得加锁`);
    assert.equal(db.recordUpdated.length, 0, `${row.id}: 停用/软删目标态不得改状态`);
    assert.equal(db.changeCreated.length, 0, `${row.id}: 停用/软删目标态不得写变更历史`);
  }
});

test("state-machine.transition_rejects_a_missing_record_with_404_after_locking_and_writes_nothing", async () => {
  const db = fakePrisma({ record: null, transition: { id: "transition-1" } });
  await expectFailure(() => service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER), {
    code: "NOT_FOUND", status: 404, type: NotFoundException,
  });

  assert.equal(db.locks.length, 1, "行锁先于读取：读不到记录时锁已加，随后随事务失败释放");
  assert.equal(db.recordUpdated.length, 0, "记录不存在时不得更新");
  assert.equal(db.changeCreated.length, 0, "记录不存在时不得写变更历史");
  assert.equal(db.transitionQueries.length, 0, "记录都没读到，不应去查规则");
});

test("state-machine.transition_rejects_an_illegal_transition_with_400_and_no_write", async () => {
  const db = fakePrisma({ record: RECORD, transition: null });
  await expectFailure(() => service(db).transition("sales_order", "sales_order", UUID, "cancelled", USER), {
    code: "VALIDATION_ERROR", status: 400, type: BadRequestException,
  });

  assert.deepEqual(db.transitionQueries[0].where, { fromStateId: "state-draft", machineKey: "sales_order", toStateId: "state-cancelled" });
  assert.equal(db.recordUpdated.length, 0, "非法流转绝不改状态");
  assert.equal(db.changeCreated.length, 0, "非法流转绝不追加变更历史");
});

test("state-machine.transition_rejects_a_machine_key_that_does_not_match_the_rule", async () => {
  // 规则按 machineKey 隔离：同一对状态在别的状态机下登记，不得被本状态机复用。
  const db = fakePrisma({
    record: { ...RECORD, machineKey: "purchase_order" },
    transition: (args) => (args.where.machineKey === "sales_order" ? { id: "transition-1" } : null),
  });
  await expectFailure(() => service(db).transition("purchase_order", "purchase_order", UUID, "confirmed", USER), {
    code: "VALIDATION_ERROR", status: 400, type: BadRequestException,
  });

  assert.deepEqual(db.transitionQueries[0].where, { fromStateId: "state-draft", machineKey: "purchase_order", toStateId: "state-confirmed" });
  assert.equal(db.recordUpdated.length, 0);
  assert.equal(db.changeCreated.length, 0);
});

test("state-machine.transition_does_not_validate_blank_or_overlong_target_keys", async () => {
  // 边界：空串与超长 key 都不在服务层被拒，而是原样下发；查不到才 404。
  const blank = fakePrisma({ state: null, record: RECORD, transition: { id: "transition-1" } });
  await expectFailure(() => service(blank).transition("sales_order", "sales_order", UUID, "", USER), {
    code: "NOT_FOUND", status: 404, type: NotFoundException,
  });
  assert.equal(blank.definitionQueries[0].where.key, "", "空串原样查询，未被 trim/拒绝");
  assert.equal(blank.recordUpdated.length, 0);
  assert.equal(blank.changeCreated.length, 0);

  const longKey = "s".repeat(120);
  const overlong = fakePrisma({ state: null, record: RECORD, transition: { id: "transition-1" } });
  await expectFailure(() => service(overlong).transition("sales_order", "sales_order", UUID, longKey, USER), {
    code: "NOT_FOUND", status: 404, type: NotFoundException,
  });
  assert.equal(overlong.definitionQueries[0].where.key, longKey, "超长 key 原样查询（schema 为 VarChar(80)，仅 DB 会截断/报错）");
  assert.equal(overlong.recordUpdated.length, 0);
  assert.equal(overlong.changeCreated.length, 0);
});

test("state-machine.transition_fails_closed_when_the_change_history_cannot_be_written", async () => {
  const failure = new Error("state_changes insert failed");
  const db = fakePrisma({ onChangeCreate: () => { throw failure; }, record: RECORD, transition: { id: "transition-1" } });
  await assert.rejects(() => service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER), (error) => error === failure);

  assert.equal(db.recordUpdated.length, 1, "更新先发生；假 client 不回滚，真实 DB 会整事务回滚");
});

// ---------------------------------------------------------------------------
// 事务与审计
// ---------------------------------------------------------------------------

test("state-machine.writes_always_go_through_the_transaction_client", async () => {
  // 假 client 的外层 stateRecord/stateChange 写方法会抛错：只要服务绕过事务直接写就会炸。
  const db = fakePrisma({ record: RECORD, transition: { id: "transition-1" } });
  await service(db).initialize("sales_order", "sales_order", UUID, "draft", USER);
  await service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER);

  assert.equal(db.events.filter((event) => event === "transaction.start").length, 2, "两个入口各自开一个事务");
});

test("state-machine.audit_fields_come_from_the_authenticated_user_id", async () => {
  const db = fakePrisma({ record: RECORD, transition: { id: "transition-1" } });
  await service(db).initialize("sales_order", "sales_order", UUID, "draft", USER);

  for (const args of [db.recordCreated[0], db.changeCreated[0]]) {
    assert.deepEqual(Object.keys(args.data).filter((key) => key.endsWith("By")).sort(), ["createdBy", "updatedBy"]);
    assert.equal(args.data.createdBy, USER.id);
    assert.equal(args.data.updatedBy, USER.id);
    assert.equal(JSON.stringify(args.data).includes(USER.username), false, "不得把 username 当成审计字段");
    assert.equal(JSON.stringify(args.data).includes(USER.display_name), false, "不得把 display_name 当成审计字段");
  }
});

test("state-machine.transition_only_stamps_updated_by_on_the_record_but_both_on_the_change", async () => {
  const db = fakePrisma({ record: RECORD, transition: { id: "transition-1" } });
  await service(db).transition("sales_order", "sales_order", UUID, "confirmed", USER);

  assert.deepEqual(Object.keys(db.recordUpdated[0].data).sort(), ["currentStateId", "updatedBy"]);
  assert.deepEqual(Object.keys(db.changeCreated[0].data).sort(), ["createdBy", "fromStateId", "recordId", "remark", "toStateId", "updatedBy"]);
});
