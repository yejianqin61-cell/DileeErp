/**
 * 独立验证探针：2026-11-09 财务挂账口径变更（D1 / D2 / A1 / A3a / A5）。
 *
 * 设计原则（按 task-9 要求）：
 *   - **不复用** `apps/api/test/` 里被 test-sync 改过的用例；本文件自带断言与手写 Prisma 替身；
 *   - 只加载 `apps/api/dist`（今日 12:22 build，晚于全部 src mtime）的真实 service / 内核函数，
 *     不 import src、不 import test；
 *   - 只读：不连数据库、不写业务数据；唯一副作用是写本目录下的 results.json；
 *   - 可重复运行：`node .agent/verify/finance-accrual-policy-2026-11-09-probe.mjs`
 *
 * 覆盖：
 *   R1  D1  候选链首位「原材料」（资产类）
 *   R2  D2  createAccrual post:true → posted；client → 不另开事务；幂等三态（posted 同额/异额、reversed）
 *   R3  D2  确认与挂账同事务（回滚语义 + 正例）
 *   R4  A1  accruedSourceIds 只认 posted
 *   R5  A3a 红字凭证不可再红冲；应付/应收在 posted 挂账凭证存在时禁止回退/冲销/删除；仅 draft 时软删
 *   R6  A5  三大报表取数排除 sourceType='voucher'（where 断言 + 端到端行为 + 灵敏度反证）
 *
 * 回归（typecheck / 3 个核心测试文件）不在此脚本内，命令与结果见同名 report.md §7。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist");
const FIN = path.join(DIST, "modules", "finance");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "finance-accrual-policy-2026-11-09-results.json");

require("reflect-metadata");
const { Prisma } = require("@prisma/client");
const catalog = require(path.join(FIN, "accounting-subject-catalog.js"));
const { VoucherService, SOURCE_VOUCHER, SOURCE_RECEIVABLE, SOURCE_PAYABLE } = require(path.join(FIN, "voucher.service.js"));
const { SupplierPayableService } = require(path.join(FIN, "supplier-payable.service.js"));
const { ReceivableService } = require(path.join(FIN, "receivable.service.js"));
const { FinanceThreeStatementsService } = require(path.join(FIN, "finance-three-statements.service.js"));

const USER = { id: "probe-user-1", username: "probe", displayName: "独立验证探针" };
const D = (value) => new Prisma.Decimal(String(value));
const yuan = (units) => Number(units) / 10000;

/* ------------------------------------------------------------------ 断言与结果收集 */

class AssertionError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertionError(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new AssertionError(`${message}（expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}）`);
}

function assertDeep(actual, expected, message) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new AssertionError(`${message}\n  expected=${right}\n  actual  =${left}`);
}

async function expect422(promise, expectedCode, message) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error !== null, `${message}：期望抛 422 ${expectedCode}，实际正常返回`);
  const status = typeof error.getStatus === "function" ? error.getStatus() : error.status;
  const body = typeof error.getResponse === "function" ? error.getResponse() : (error.response ?? {});
  assertEqual(status, 422, `${message}：HTTP 状态应为 422（实际 ${status}，message=${error.message}）`);
  assertEqual(body.code, expectedCode, `${message}：错误码应为 ${expectedCode}`);
  return { status, code: body.code, message: body.message };
}

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
}

async function check(id, title, fn) {
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, title, status: "PASS", detail: detail ?? null });
    console.log(`[PASS] ${id} ${title}`);
  } catch (error) {
    results.push({ id, group: currentGroup, title, status: "FAIL", detail: { message: error.message } });
    console.log(`[FAIL] ${id} ${title}`);
    console.log(`       ${String(error.message).split("\n").join("\n       ")}`);
  }
}

/* ------------------------------------------------------------------ 手写 Prisma 替身 */

const MODEL_KEYS = [
  "voucher", "voucherLine", "accountingSubject", "bank", "cashFlowEntry",
  "supplierPayableEntry", "receivableSource", "supplierPayableReconciliation",
  "receivableReconciliation", "salaryPayment", "supplierPayment", "customerPayment",
  "salesOrder", "dictionaryItem", "auditEvent",
];

let sequence = 0;
const nextId = (model) => `${model}-${++sequence}`;
const cloneRow = (row) => ({ ...row });

function matchField(value, cond) {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date ? value.getTime() === cond.getTime() : new Date(value).getTime() === cond.getTime();
  if (typeof cond === "object" && cond !== null) {
    if ("in" in cond) return (cond.in ?? []).some((item) => matchField(value, item));
    if ("notIn" in cond) return !(cond.notIn ?? []).some((item) => matchField(value, item));
    if ("not" in cond) return !matchField(value, cond.not);
    if ("startsWith" in cond) return typeof value === "string" && value.startsWith(cond.startsWith);
    if ("lt" in cond) return new Date(value).getTime() < new Date(cond.lt).getTime();
    if ("lte" in cond) return new Date(value).getTime() <= new Date(cond.lte).getTime();
    if ("gt" in cond) return new Date(value).getTime() > new Date(cond.gt).getTime();
    if ("gte" in cond) return new Date(value).getTime() >= new Date(cond.gte).getTime();
    if (Object.keys(cond).length === 0) return true;
    // 关系过滤（本探针不依赖）：一律视为不命中，避免「假通过」。
    return false;
  }
  return value === cond;
}

function matches(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => matchField(row[key], cond));
}

function snapshotState(state) {
  const snapshot = {};
  for (const key of Object.keys(state)) snapshot[key] = Array.isArray(state[key]) ? state[key].map(cloneRow) : state[key];
  return snapshot;
}

function restoreState(state, snapshot) {
  for (const key of Object.keys(snapshot)) state[key] = Array.isArray(snapshot[key]) ? snapshot[key].map(cloneRow) : snapshot[key];
}

/**
 * 内存版 Prisma 替身。
 * - 支持本探针用到的查询子集：等值 / in / not / startsWith / lte / gte / Date / null；
 * - `include` / `select` / `orderBy` 忽略（种子行自带嵌套字段，够 service 读取）；
 * - `$transaction` 有**快照回滚语义**：回调抛错则恢复调用前状态（用于验证 D2 同事务）。
 */
function makeDb(seed = {}) {
  const state = {};
  for (const key of MODEL_KEYS) state[key] = (seed[key] ?? []).map(cloneRow);
  const calls = [];
  const counters = { transaction: 0 };
  const record = (model, method, args) => calls.push({ model, method, args });

  const findRows = (model, where) => state[model].filter((row) => matches(row, where));

  const db = { state, calls, counters };

  for (const model of MODEL_KEYS) {
    db[model] = {
      findFirst: async (args = {}) => {
        record(model, "findFirst", args);
        const rows = findRows(model, args.where);
        return rows.length ? cloneRow(rows[0]) : null;
      },
      findUnique: async (args = {}) => {
        record(model, "findUnique", args);
        const rows = findRows(model, args.where);
        return rows.length ? cloneRow(rows[0]) : null;
      },
      findMany: async (args = {}) => {
        record(model, "findMany", args);
        return findRows(model, args.where).map(cloneRow);
      },
      create: async (args = {}) => {
        record(model, "create", args);
        const row = { id: args.data?.id ?? nextId(model), ...args.data };
        state[model].push(row);
        return cloneRow(row);
      },
      update: async (args = {}) => {
        record(model, "update", args);
        const row = state[model].find((item) => matches(item, args.where));
        if (!row) throw new Error(`[fake-prisma] ${model}.update 未命中：${JSON.stringify(args.where)}`);
        Object.assign(row, args.data);
        return cloneRow(row);
      },
      updateMany: async (args = {}) => {
        record(model, "updateMany", args);
        const rows = state[model].filter((item) => matches(item, args.where));
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      },
      deleteMany: async (args = {}) => {
        record(model, "deleteMany", args);
        const keep = state[model].filter((item) => !matches(item, args.where));
        const removed = state[model].length - keep.length;
        state[model] = keep;
        return { count: removed };
      },
      createMany: async (args = {}) => {
        record(model, "createMany", args);
        const rows = (Array.isArray(args.data) ? args.data : [args.data]).map((data) => ({ id: data.id ?? nextId(model), ...data }));
        state[model].push(...rows);
        return { count: rows.length };
      },
      count: async (args = {}) => {
        record(model, "count", args);
        return findRows(model, args.where).length;
      },
      groupBy: async (args = {}) => {
        record(model, "groupBy", args);
        return [];
      },
      aggregate: async (args = {}) => {
        record(model, "aggregate", args);
        return { _count: { _all: 0 } };
      },
    };
  }

  db.$queryRaw = async () => [];
  db.$executeRaw = async () => 0;
  db.$transaction = async (arg) => {
    counters.transaction += 1;
    if (typeof arg !== "function") return arg;
    const snapshot = snapshotState(state);
    try {
      return await arg(db);
    } catch (error) {
      restoreState(state, snapshot);
      throw error;
    }
  };
  return db;
}

function makeAudit() {
  const events = [];
  return {
    events,
    create: (user) => ({ createdBy: user.id, updatedBy: user.id }),
    update: (user) => ({ updatedBy: user.id }),
    softDelete: (user) => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }),
    record: async (action, entityType, actorId, entityId, details = {}, client) => {
      events.push({ action, entityType, actorId, entityId, details, inTransaction: Boolean(client) });
    },
    recordWithOrderNo: async (action, entityType, orderNo, actorId, entityId, details = {}) => {
      events.push({ action, entityType, orderNo, actorId, entityId, details });
    },
  };
}

function makeCashFlowStub() {
  return {
    requireSubject: async (subjectId) => ({ id: subjectId, category: "损益类", name: "管理费用" }),
    reverseSourceFlowInTransaction: async () => [],
  };
}

const SUBJECTS = [
  { id: "sub-raw", category: "资产类", name: "原材料", deletedAt: null, isActive: true, sortOrder: 180, balanceDirection: "借" },
  { id: "sub-cost", category: "损益类", name: "主营业务成本", deletedAt: null, isActive: true, sortOrder: 810, balanceDirection: "借" },
  { id: "sub-ap", category: "负债类", name: "应付账款", deletedAt: null, isActive: true, sortOrder: 420, balanceDirection: "贷" },
  { id: "sub-ar", category: "资产类", name: "应收账款", deletedAt: null, isActive: true, sortOrder: 110, balanceDirection: "借" },
  { id: "sub-rev", category: "损益类", name: "主营业务收入", deletedAt: null, isActive: true, sortOrder: 770, balanceDirection: "借" },
];

function accrualInput(overrides = {}) {
  return {
    source_type: SOURCE_PAYABLE,
    source_id: "ap-1",
    document_no: "AP-1",
    voucher_date: "2026-11-10",
    currency: "CNY",
    amount: "100.00",
    counterparty_name: "供应商A",
    contra_subject_names: ["原材料", "主营业务成本"],
    ...overrides,
  };
}

function voucherRow(overrides = {}) {
  return {
    id: "v-1",
    voucherNo: "记-2026-11-0001",
    voucherDate: new Date("2026-11-10T00:00:00.000Z"),
    period: "2026-11",
    sourceType: SOURCE_PAYABLE,
    sourceId: "ap-1",
    summary: "挂账",
    currency: "CNY",
    debitTotal: D("100.00"),
    creditTotal: D("100.00"),
    status: "posted",
    deletedAt: null,
    lines: [],
    ...overrides,
  };
}

const linesOf = (db) => db.state.voucherLine;

/* ------------------------------------------------------------------ R1 D1 候选链 */

async function verifyD1() {
  group("R1-D1");

  await check("D1-01", "raw_material_inbound 候选链首位 = 原材料（资产类），第二 = 主营业务成本", async () => {
    const names = catalog.paymentSubjectNames("raw_material_inbound");
    assertEqual(names[0], "原材料", "raw_material_inbound 首位");
    assertEqual(names[1], "主营业务成本", "raw_material_inbound 兜底");
    const seed = catalog.ACCOUNTING_SUBJECT_SEEDS.find((item) => item.name === "原材料");
    assert(seed, "科目表中必须存在「原材料」");
    assertEqual(seed.category, "资产类", "「原材料」必须属于资产类（存货口径）");
    return { names: [...names], category: seed.category };
  });

  await check("D1-02", "DEFAULT / PAYABLE_CONFIRM / purchase_receipt 首位均为原材料，其它来源不受影响", async () => {
    assertEqual(catalog.DEFAULT_PAYMENT_SUBJECT_NAMES[0], "原材料", "DEFAULT 首位");
    assertEqual(catalog.PAYABLE_CONFIRM_SUBJECT_NAMES[0], "原材料", "PAYABLE_CONFIRM 首位");
    assertEqual(catalog.paymentSubjectNames("purchase_receipt")[0], "原材料", "purchase_receipt 首位");
    assertEqual(catalog.paymentSubjectNames("outsource_receipt")[0], "加工费", "外加工候选链不应被 D1 影响");
    assertEqual(catalog.paymentSubjectNames("other")[0], "管理费用", "其他应付候选链不应被 D1 影响");
    return {
      DEFAULT: [...catalog.DEFAULT_PAYMENT_SUBJECT_NAMES],
      PAYABLE_CONFIRM: [...catalog.PAYABLE_CONFIRM_SUBJECT_NAMES],
      purchase_receipt: [...catalog.paymentSubjectNames("purchase_receipt")],
      outsource_receipt: [...catalog.paymentSubjectNames("outsource_receipt")],
      other: [...catalog.paymentSubjectNames("other")],
    };
  });
}

/* ------------------------------------------------------------------ R2 D2 createAccrual 行为 */

async function verifyD2Behaviour() {
  group("R2-D2");

  await check("D2-01", "post:true（事务外）→ 凭证 status=posted，且只开 1 个事务", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const audit = makeAudit();
    const service = new VoucherService(db, audit);
    const result = await service.createAccrual(accrualInput(), USER, { post: true });

    assertEqual(result.status, "posted", "返回值 status");
    assertEqual(result.replayed, false, "首次创建 replayed");
    assertEqual(db.state.voucher.length, 1, "应恰好落 1 张凭证");
    assertEqual(db.state.voucher[0].status, "posted", "落库后的凭证状态");
    assertEqual(db.state.voucher[0].sourceType, SOURCE_PAYABLE, "sourceType");
    assertEqual(db.counters.transaction, 1, "事务外生成应恰好开 1 个事务");
    assert(linesOf(db).length >= 2, "至少 2 条分录");
    assert(audit.events.some((event) => event.action === "voucher.post" && event.details?.auto === true && event.details?.reason === "confirm_post"), "必须记 voucher.post（auto/confirm_post）");
    return { status: db.state.voucher[0].status, transactions: db.counters.transaction, lineCount: linesOf(db).length };
  });

  await check("D2-02", "传入 client 时不再调用 root.$transaction，且读写全走 client", async () => {
    const tx = makeDb({ accountingSubject: SUBJECTS });
    const audit = makeAudit();
    let rootTransactionCalls = 0;
    const root = {
      $transaction: async () => {
        rootTransactionCalls += 1;
        throw new Error("传了 client 时不允许另开事务");
      },
    };
    const service = new VoucherService(root, audit);
    const result = await service.createAccrual(accrualInput({ source_id: "ap-client" }), USER, { client: tx, post: true });

    assertEqual(rootTransactionCalls, 0, "root.$transaction 调用次数");
    assertEqual(result.status, "posted", "返回值 status");
    const called = (model, method) => tx.calls.some((call) => call.model === model && call.method === method);
    assert(called("accountingSubject", "findMany"), "科目解析必须走 client");
    assert(called("voucher", "findFirst"), "幂等查询必须走 client");
    assert(called("voucher", "create"), "凭证写入必须走 client");
    assert(called("voucherLine", "createMany"), "分录写入必须走 client");
    assertEqual(tx.state.voucher[0].status, "posted", "client 内落库状态");
    return { rootTransactionCalls, clientCalls: tx.calls.length, voucherCount: tx.state.voucher.length };
  });

  await check("D2-03", "幂等：已 posted 且金额/币种一致 → replayed=true，不重建", async () => {
    const db = makeDb({ voucher: [voucherRow({ id: "v-posted", status: "posted" })], accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const result = await service.createAccrual(accrualInput(), USER, { post: true });

    assertEqual(result.replayed, true, "replayed");
    assertEqual(result.status, "posted", "status");
    assertEqual(result.id, "v-posted", "复用原凭证 id");
    assert(!db.calls.some((call) => call.model === "voucher" && call.method === "create"), "不得新建凭证");
    assert(!db.calls.some((call) => call.model === "voucher" && call.method === "update"), "不得更新凭证");
    return { result };
  });

  await check("D2-04", "幂等：已 posted 但金额不一致 → 422 VOUCHER_ACCRUAL_AMOUNT_MISMATCH", async () => {
    const db = makeDb({ voucher: [voucherRow({ id: "v-posted", status: "posted" })], accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const error = await expect422(service.createAccrual(accrualInput({ amount: "200.00" }), USER, { post: true }), "VOUCHER_ACCRUAL_AMOUNT_MISMATCH", "金额不一致");
    assertEqual(db.state.voucher.length, 1, "不得新建凭证");
    return error;
  });

  await check("D2-05", "幂等：已 reversed → 422 VOUCHER_ACCRUAL_REVERSED", async () => {
    const db = makeDb({ voucher: [voucherRow({ id: "v-rev", status: "reversed" })], accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const error = await expect422(service.createAccrual(accrualInput(), USER, { post: true }), "VOUCHER_ACCRUAL_REVERSED", "已红冲");
    assertEqual(db.state.voucher.length, 1, "不得新建凭证");
    return error;
  });

  await check("D2-06", "附加（契约 §3）：已存在 draft 挂账凭证 + post:true → 按入参重建后过账", async () => {
    const existing = voucherRow({
      id: "v-draft",
      voucherNo: "记-2026-11-0007",
      status: "draft",
      debitTotal: D("50.00"),
      lines: [{ direction: "debit", subjectLabel: "主营业务成本", amount: D("50.00") }],
    });
    const db = makeDb({ voucher: [existing], accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const result = await service.createAccrual(accrualInput({ amount: "100.00" }), USER, { post: true });

    assertEqual(result.status, "posted", "status");
    assertEqual(result.replayed, true, "replayed");
    const updated = db.state.voucher.find((row) => row.id === "v-draft");
    assertEqual(updated.status, "posted", "原凭证被过账");
    assertEqual(String(updated.debitTotal), "100", "金额按本次入参重建");
    assert(db.calls.some((call) => call.model === "voucherLine" && call.method === "deleteMany"), "必须清旧分录");
    const rebuilt = linesOf(db);
    assertEqual(rebuilt.length, 2, "重建后两条分录");
    assert(rebuilt.some((line) => line.direction === "debit" && line.subjectLabel === "原材料"), "借方应为首选科目「原材料」");
    return { result, lines: rebuilt.map((line) => `${line.direction}:${line.subjectLabel}:${String(line.amount)}`) };
  });
}

/* ------------------------------------------------------------------ R3 D2 同事务 */

function payableEntryRow(overrides = {}) {
  return {
    id: "ap-1",
    payableNo: "AP-202611-0001",
    orderNo: "PO-1",
    supplierId: "sup-1",
    sourceType: "raw_material_inbound",
    status: "draft",
    amount: D("100.00"),
    currency: "CNY",
    subjectId: null,
    remark: "",
    deletedAt: null,
    allocations: [],
    payableSource: { status: "pending_finance" },
    outsourcePayableSource: null,
    supplier: { name: "供应商A" },
    ...overrides,
  };
}

async function verifyD2Transaction() {
  group("R3-D2-TX");

  await check("D2-07", "正例：confirm 成功时 entry=confirmed 且挂账凭证=posted（同事务提交）", async () => {
    const db = makeDb({ supplierPayableEntry: [payableEntryRow()], accountingSubject: SUBJECTS });
    const audit = makeAudit();
    const service = new SupplierPayableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const result = await service.confirm("ap-1", USER, {});

    assertEqual(result.status, "confirmed", "entry 状态");
    assertEqual(result.accrual_replayed, false, "首次挂账 replayed");
    assert(result.accrual_voucher_id, "必须返回挂账凭证 id");
    const voucher = db.state.voucher.find((row) => row.id === result.accrual_voucher_id);
    assert(voucher, "凭证必须落在同一批状态里");
    assertEqual(voucher.status, "posted", "挂账凭证状态");
    assertEqual(voucher.sourceType, SOURCE_PAYABLE, "凭证来源类型");
    assertEqual(voucher.sourceId, "ap-1", "凭证来源 id");
    assertEqual(db.state.supplierPayableEntry[0].status, "confirmed", "提交后 entry 持久状态");
    assertEqual(db.counters.transaction, 1, "confirm 只开 1 个事务（挂账不再另开）");
    const debit = linesOf(db).find((line) => line.direction === "debit");
    assertEqual(debit.subjectLabel, "原材料", "挂账借方 = D1 首选的原材料");
    return { entryStatus: db.state.supplierPayableEntry[0].status, voucherStatus: voucher.status, debit: debit.subjectLabel, transactions: db.counters.transaction };
  });

  await check("D2-08", "回滚：挂账步骤抛错 → entry 仍为 draft、无凭证、无 confirm 审计", async () => {
    // accountingSubject 为空 → createAccrual 在 subjectByName 抛 ACCOUNTING_SUBJECT_NOT_FOUND
    const db = makeDb({ supplierPayableEntry: [payableEntryRow()], accountingSubject: [] });
    const audit = makeAudit();
    const service = new SupplierPayableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));

    const error = await expect422(service.confirm("ap-1", USER, {}), "ACCOUNTING_SUBJECT_NOT_FOUND", "挂账失败");

    assertEqual(db.state.supplierPayableEntry[0].status, "draft", "回滚后 entry 必须仍是 draft");
    assertEqual(db.state.voucher.length, 0, "回滚后不得留下凭证");
    assert(!audit.events.some((event) => event.action === "supplier_payable.confirm"), "回滚后不得留下 confirm 审计");
    assertEqual(db.state.auditEvent.length, 0, "fake prisma 的 auditEvent 表也应为空");
    return { error, entryStatus: db.state.supplierPayableEntry[0].status, vouchers: db.state.voucher.length };
  });
}

/* ------------------------------------------------------------------ R4 A1 只认 posted */

async function verifyA1() {
  group("R4-A1");

  await check("A1-01", "accruedSourceIds 查询条件 status='posted'（不再把 draft 当已挂账）", async () => {
    const db = makeDb({
      voucher: [
        voucherRow({ id: "v-draft", sourceType: SOURCE_PAYABLE, sourceId: "p-draft", status: "draft" }),
        voucherRow({ id: "v-posted", sourceType: SOURCE_PAYABLE, sourceId: "p-posted", status: "posted" }),
      ],
    });
    const service = new VoucherService(db, makeAudit());
    const draftOnly = await service.accruedSourceIds(SOURCE_PAYABLE, ["p-draft"]);
    const posted = await service.accruedSourceIds(SOURCE_PAYABLE, ["p-posted"]);
    const captured = db.calls.filter((call) => call.model === "voucher" && call.method === "findMany");

    assertEqual(captured.length, 2, "应查询两次");
    for (const call of captured) {
      assertEqual(call.args.where.status, "posted", "where.status 必须是单值 'posted'");
      assertEqual(call.args.where.deletedAt, null, "where.deletedAt 必须是 null");
    }
    assertEqual(draftOnly.size, 0, "只有 draft 凭证时不得判定为已挂账");
    assertDeep([...posted], ["p-posted"], "posted 凭证必须命中");
    return { whereStatus: captured[0].args.where.status, draftOnly: [...draftOnly], posted: [...posted] };
  });
}

/* ------------------------------------------------------------------ R5 A3a 护栏 */

async function verifyA3a() {
  group("R5-A3a");

  await check("A3a-01", "红字凭证（source_type='voucher'）不能再红冲 → 422 VOUCHER_RED_NOT_REVERSIBLE", async () => {
    const red = voucherRow({ id: "v-red", voucherNo: "记-2026-11-0010", sourceType: SOURCE_VOUCHER, sourceId: "v-origin", status: "posted" });
    const db = makeDb({ voucher: [red] });
    const service = new VoucherService(db, makeAudit());
    const error = await expect422(service.reverse("v-red", "再冲一次", USER), "VOUCHER_RED_NOT_REVERSIBLE", "红字不可再红冲");
    assert(!db.calls.some((call) => call.model === "voucher" && call.method === "create"), "不得生成新的红字凭证");
    assertEqual(db.counters.transaction, 0, "守卫必须在开事务前生效");
    return error;
  });

  await check("A3a-02", "应付 reopen：存在 posted 挂账凭证 → 422 SUPPLIER_PAYABLE_HAS_POSTED_ACCRUAL", async () => {
    const db = makeDb({
      supplierPayableEntry: [payableEntryRow({ status: "confirmed" })],
      voucher: [voucherRow({ status: "posted", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
    });
    const audit = makeAudit();
    const service = new SupplierPayableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const error = await expect422(service.reopen("ap-1", "回退", USER), "SUPPLIER_PAYABLE_HAS_POSTED_ACCRUAL", "应付回退");
    assertEqual(db.state.supplierPayableEntry[0].status, "confirmed", "被拒绝后 entry 状态不变");
    return error;
  });

  await check("A3a-03", "应付 reverse：存在 posted 挂账凭证 → 422 SUPPLIER_PAYABLE_HAS_POSTED_ACCRUAL", async () => {
    const db = makeDb({
      supplierPayableEntry: [payableEntryRow({ status: "confirmed" })],
      voucher: [voucherRow({ status: "posted", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
    });
    const audit = makeAudit();
    const service = new SupplierPayableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const error = await expect422(service.reverse("ap-1", "冲销", USER), "SUPPLIER_PAYABLE_HAS_POSTED_ACCRUAL", "应付冲销");
    assertEqual(db.state.supplierPayableEntry[0].status, "confirmed", "被拒绝后 entry 状态不变");
    return error;
  });

  await check("A3a-04", "应付 removeOther：存在 posted 挂账凭证 → 422 SUPPLIER_PAYABLE_HAS_POSTED_ACCRUAL", async () => {
    const db = makeDb({
      supplierPayableEntry: [payableEntryRow({ status: "confirmed", sourceType: "other" })],
      voucher: [voucherRow({ status: "posted", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
      supplierPayableReconciliation: [],
    });
    const audit = makeAudit();
    const service = new SupplierPayableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const error = await expect422(service.removeOther("ap-1", "录错", USER), "SUPPLIER_PAYABLE_HAS_POSTED_ACCRUAL", "应付删除");
    assertEqual(db.state.supplierPayableEntry[0].deletedAt ?? null, null, "被拒绝后不得软删");
    return error;
  });

  await check("A3a-05", "应收 reopen：存在 posted 挂账凭证 → 422 RECEIVABLE_SOURCE_HAS_POSTED_ACCRUAL", async () => {
    const db = makeDb({
      receivableSource: [{ id: "ar-1", sourceNo: "AR-1", orderNo: "SO-1", status: "confirmed", currency: "CNY", amount: D("100.00"), remark: "", deletedAt: null, allocations: [] }],
      voucher: [voucherRow({ status: "posted", sourceType: SOURCE_RECEIVABLE, sourceId: "ar-1" })],
    });
    const audit = makeAudit();
    const service = new ReceivableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const error = await expect422(service.reopen("ar-1", "回退", USER), "RECEIVABLE_SOURCE_HAS_POSTED_ACCRUAL", "应收回退");
    assertEqual(db.state.receivableSource[0].status, "confirmed", "被拒绝后状态不变");
    return error;
  });

  await check("A3a-06", "应收 cancel：存在 posted 挂账凭证 → 422 RECEIVABLE_SOURCE_HAS_POSTED_ACCRUAL", async () => {
    const db = makeDb({
      receivableSource: [{ id: "ar-1", sourceNo: "AR-1", orderNo: "SO-1", status: "confirmed", currency: "CNY", amount: D("100.00"), remark: "", deletedAt: null, allocations: [] }],
      voucher: [voucherRow({ status: "posted", sourceType: SOURCE_RECEIVABLE, sourceId: "ar-1" })],
    });
    const audit = makeAudit();
    const service = new ReceivableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const error = await expect422(service.cancel("ar-1", "取消", USER), "RECEIVABLE_SOURCE_HAS_POSTED_ACCRUAL", "应收取消");
    assertEqual(db.state.receivableSource[0].status, "confirmed", "被拒绝后状态不变");
    return error;
  });

  await check("A3a-07", "只有 draft 挂账凭证时：应付 reopen 会软删草稿凭证（voucher.update 收到 deletedAt）", async () => {
    const db = makeDb({
      supplierPayableEntry: [payableEntryRow({ status: "confirmed" })],
      voucher: [voucherRow({ id: "v-draft-ap", status: "draft", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
    });
    const audit = makeAudit();
    const service = new SupplierPayableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const row = await service.reopen("ap-1", "回退", USER);

    assertEqual(row.status, "draft", "entry 回退成功");
    const softDeleteCall = db.calls.find((call) => call.model === "voucher" && call.method === "update" && call.args?.data?.deletedAt instanceof Date);
    assert(softDeleteCall, "必须对草稿挂账凭证做软删（update.data.deletedAt）");
    const draft = db.state.voucher.find((item) => item.id === "v-draft-ap");
    assert(draft.deletedAt instanceof Date, "草稿凭证 deletedAt 已落库");
    assertEqual(draft.deletedBy, USER.id, "软删记录操作人");
    return { entryStatus: row.status, draftDeleted: draft.deletedAt instanceof Date, deletedBy: draft.deletedBy };
  });

  await check("A3a-08", "只有 draft 挂账凭证时：应收 cancel 会软删草稿凭证", async () => {
    const db = makeDb({
      receivableSource: [{ id: "ar-1", sourceNo: "AR-1", orderNo: "SO-1", status: "confirmed", currency: "CNY", amount: D("100.00"), remark: "", deletedAt: null, allocations: [] }],
      voucher: [voucherRow({ id: "v-draft-ar", status: "draft", sourceType: SOURCE_RECEIVABLE, sourceId: "ar-1" })],
    });
    const audit = makeAudit();
    const service = new ReceivableService(db, audit, makeCashFlowStub(), undefined, new VoucherService(db, audit));
    const row = await service.cancel("ar-1", "取消", USER);

    assertEqual(row.status, "cancelled", "应收取消成功");
    const draft = db.state.voucher.find((item) => item.id === "v-draft-ar");
    assert(draft.deletedAt instanceof Date, "草稿凭证应被软删");
    return { sourceStatus: row.status, draftDeleted: draft.deletedAt instanceof Date };
  });
}

/* ------------------------------------------------------------------ R6 A5 报表排除红字 */

function statementsSeed() {
  return {
    voucher: [
      {
        id: "v-normal",
        voucherNo: "记-2026-11-0001",
        voucherDate: new Date("2026-11-10T00:00:00.000Z"),
        period: "2026-11",
        sourceType: "cash_flow_entry",
        sourceId: "entry-normal",
        summary: "收款",
        currency: "CNY",
        debitTotal: D("100.00"),
        creditTotal: D("100.00"),
        status: "posted",
        deletedAt: null,
        lines: [
          { subjectKey: "银行存款", direction: "debit", amount: "100.00" },
          { subjectKey: "损益类/主营业务收入", direction: "credit", amount: "100.00" },
        ],
      },
      {
        id: "v-red",
        voucherNo: "记-2026-11-0002",
        voucherDate: new Date("2026-11-11T00:00:00.000Z"),
        period: "2026-11",
        sourceType: "voucher",
        sourceId: "v-normal",
        summary: "红冲 记-2026-11-0001",
        currency: "CNY",
        debitTotal: D("100.00"),
        creditTotal: D("100.00"),
        status: "posted",
        deletedAt: null,
        lines: [
          { subjectKey: "损益类/主营业务收入", direction: "debit", amount: "100.00" },
          { subjectKey: "银行存款", direction: "credit", amount: "100.00" },
        ],
      },
    ],
    accountingSubject: SUBJECTS,
    cashFlowEntry: [],
    bank: [],
  };
}

async function verifyA5() {
  group("R6-A5");

  await check("A5-01", "报表取数 where 含 sourceType:{not:'voucher'}（红字凭证不参与）", async () => {
    const db = makeDb(statementsSeed());
    const service = new FinanceThreeStatementsService(db);
    await service.balanceSheet({ to: "2026-11-30" });
    const query = db.calls.find((call) => call.model === "voucher" && call.method === "findMany");
    assert(query, "必须查询凭证");
    assertEqual(query.args.where.status, "posted", "只取 posted");
    assertEqual(query.args.where.deletedAt, null, "排除软删");
    assert(query.args.where.sourceType && query.args.where.sourceType.not === "voucher", "where.sourceType.not 必须为 'voucher'");
    return { where: { status: query.args.where.status, deletedAt: query.args.where.deletedAt, sourceType: query.args.where.sourceType } };
  });

  await check("A5-02", "端到端：posted 红字凭证不进三大报表（BS/IS/CF 全额等于正常凭证）", async () => {
    const db = makeDb(statementsSeed());
    const service = new FinanceThreeStatementsService(db);
    const [bs, is, cf] = await Promise.all([
      service.balanceSheet({ to: "2026-11-30" }),
      service.incomeStatement({ from: "2026-11-01", to: "2026-11-30" }),
      service.cashFlowStatement({ from: "2026-11-01", to: "2026-11-30" }),
    ]);
    const bsMoney = bs.current.assets.find((line) => line.row === 1);
    const isRevenue = is.current.lines.find((line) => line.row === 1);
    const cfRow1 = cf.current.lines.find((line) => line.row === 1);

    assertEqual(yuan(bs.current.totalAssets), 100, "资产总计 = 正常凭证 100（红字若进表会变 0）");
    assertEqual(yuan(bsMoney.value), 100, "货币资金 = 100");
    assertEqual(is.current.unmapped.length, 0, "利润表不应有未归位科目");
    assertEqual(yuan(isRevenue.value), 100, "营业收入 = 100（红字若进表会变 0）");
    assertEqual(cf.current.unmapped.length, 0, "现金流量表不应有未归位对方科目");
    assertEqual(yuan(cfRow1.value), 100, "销售商品收到的现金 = 100");
    assertEqual(yuan(cf.current.netIncrease), 100, "现金净增加 = 100");
    assertEqual(yuan(cf.current.closing), 100, "期末现金 = 100");
    assertEqual(is.gap.draftVouchers, 0, "草稿凭证张数");
    assertEqual(is.gap.entriesWithoutVoucher, 0, "无凭证流水条数");
    return {
      balanceSheet: { money: yuan(bsMoney.value), totalAssets: yuan(bs.current.totalAssets), difference: yuan(bs.current.difference) },
      incomeStatement: { revenue: yuan(isRevenue.value), unmapped: is.current.unmapped.length },
      cashFlow: { row1: yuan(cfRow1.value), netIncrease: yuan(cf.current.netIncrease), closing: yuan(cf.current.closing), unmapped: cf.current.unmapped.length },
    };
  });

  await check("A5-03", "灵敏度反证：若去掉 sourceType 过滤，同一数据会把红字算进表（证明 A5-02 不是假通过）", async () => {
    const db = makeDb(statementsSeed());
    const original = db.voucher.findMany;
    // 故意剥掉 where.sourceType（模拟未实现 A5 的旧代码），其余完全一致。
    db.voucher.findMany = async (args = {}) => {
      const where = { ...args.where };
      delete where.sourceType;
      return original({ ...args, where });
    };
    const service = new FinanceThreeStatementsService(db);
    const [bs, is, cf] = await Promise.all([
      service.balanceSheet({ to: "2026-11-30" }),
      service.incomeStatement({ from: "2026-11-01", to: "2026-11-30" }),
      service.cashFlowStatement({ from: "2026-11-01", to: "2026-11-30" }),
    ]);
    const revenue = is.current.lines.find((line) => line.row === 1);

    assertEqual(yuan(bs.current.totalAssets), 0, "去掉过滤后资产应被红字抵消为 0");
    assertEqual(yuan(revenue.value), 0, "去掉过滤后收入应被红字抵消为 0");
    assertEqual(cf.current.unmapped.length, 1, "去掉过滤后红字的对方科目会掉进未归位");
    return { totalAssets: yuan(bs.current.totalAssets), revenue: yuan(revenue.value), cfUnmapped: cf.current.unmapped.length };
  });
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log("== 2026-11-09 accrual policy independent probe ==");
  console.log(`dist: ${FIN}`);
  await verifyD1();
  await verifyD2Behaviour();
  await verifyD2Transaction();
  await verifyA1();
  await verifyA3a();
  await verifyA5();

  const passed = results.filter((item) => item.status === "PASS").length;
  const failed = results.filter((item) => item.status === "FAIL").length;
  const summary = { total: results.length, passed, failed };
  console.log("== summary ==");
  console.log(`PASS ${passed} / FAIL ${failed} / TOTAL ${results.length}`);

  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2), "utf8");
  console.log(`results.json: ${RESULTS_JSON}`);

  if (failed > 0) process.exitCode = 1;
}

await main();
