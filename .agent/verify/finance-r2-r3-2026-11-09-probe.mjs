/**
 * 独立验证探针：2026-11-09 财务治理 R2/R3（D4 / D5 / R3-1 / R3-4 / R3-5 / R3-6 / R3-7）。
 *
 * 设计原则（按 task-26 / brief R3-11 要求）：
 *   - **不复用** `apps/api/test/` 下的任何用例；本文件自带断言与手写 Prisma 替身（内存 + 事务回滚语义）；
 *   - 只加载 `apps/api/dist`（最新 build）的真实 service 与内核，不 import src / test；
 *   - 只读：不连数据库、不写业务数据；唯一副作用是写本目录下的 results.json；
 *   - 可重复运行：`node .agent/verify/finance-r2-r3-2026-11-09-probe.mjs`
 *
 * 覆盖（≥12 例，含 2 个反证）：
 *   D4   强制核销额=单据额：应付/应收 3 个错误码 + 历史 partially_paid 只结余款
 *   D5   专票 11300/13% → 净 10000 + 税 1300、借贷严格相等、普票不拆、缺税率 422、r≥1 守卫、缺进项税科目 422
 *   SID  凭证行科目 id 落库（含业务科目辅助维度、同名跨类目留空、红冲沿用原行 id）
 *   IDX  部分唯一索引：红冲后可再建、双 active 被拦（+ 迁移 DDL 条件）
 *   LINK 冲销联动：付款冲销 → 红冲流水凭证；流水冲销 → 红冲/作废其凭证（幂等）
 *   AUTO 自动过账：流水凭证 posted；改已过账凭证的流水 422 CASH_FLOW_HAS_POSTED_VOUCHER
 *   RE   reaccrue：红冲后重算 → posted；已 posted → 422；accrual_status 四态
 *   CX   反证 1：去掉部分唯一索引条件（恢复全局唯一）→ 红冲后重算失败
 *        反证 2：去掉进项税行 → 借贷不相等
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist");
const FIN = path.join(DIST, "modules", "finance");
const VERIFY_DIR = path.join(REPO_ROOT, ".agent", "verify");
const RESULTS_JSON = path.join(VERIFY_DIR, "finance-r2-r3-2026-11-09-results.json");
const MIGRATION = path.join(REPO_ROOT, "apps", "api", "prisma", "migrations", "20261109130000_finance_governance_r3", "migration.sql");
const SCHEMA = path.join(REPO_ROOT, "apps", "api", "prisma", "schema.prisma");

require("reflect-metadata");
const { Prisma } = require("@prisma/client");
const { VoucherService, SOURCE_VOUCHER, SOURCE_RECEIVABLE, SOURCE_PAYABLE, SOURCE_CASH_FLOW } = require(path.join(FIN, "voucher.service.js"));
const { SupplierPayableService } = require(path.join(FIN, "supplier-payable.service.js"));
const { ReceivableService } = require(path.join(FIN, "receivable.service.js"));
const { SupplierPaymentService } = require(path.join(FIN, "supplier-payment.service.js"));
const { CustomerPaymentService } = require(path.join(FIN, "customer-payment.service.js"));
const { CashFlowService } = require(path.join(FIN, "cash-flow.service.js"));

const USER = { id: "probe-r2r3-user", username: "probe", displayName: "R2/R3 独立验证探针" };
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
  return { status, code: body.code, message: body.message, details: body.details ?? [] };
}

async function expectThrow(promise, predicate, message) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error !== null, `${message}：期望抛错，实际正常返回`);
  assert(predicate(error), `${message}：错误不符合预期（message=${error.message}）`);
  return error;
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
  "receivableReconciliation", "supplierPayment", "customerPayment",
  "supplierPaymentAllocation", "receivableAllocation", "auditEvent",
  "supplier", "customer", "dictionaryItem", "salesOrder",
];

let sequence = 0;
const nextId = (model) => `${model}-${++sequence}`;
const cloneRow = (row) => ({ ...row });
const isDecimal = (value) => value instanceof Prisma.Decimal;

function matchField(value, cond) {
  if (cond === null) return value === null || value === undefined;
  if (cond === undefined) return true;
  if (cond instanceof Date) return value instanceof Date ? value.getTime() === cond.getTime() : new Date(value).getTime() === cond.getTime();
  if (cond instanceof Prisma.Decimal) return isDecimal(value) ? value.eq(cond) : String(value) === String(cond);
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
    // 关系过滤（如 `payment: { status: "posted" }`）：行上带了对应的嵌套对象才判命中。
    if (value && typeof value === "object" && !isDecimal(value) && !(value instanceof Date)) {
      return Object.entries(cond).every(([key, sub]) => matchField(value[key], sub));
    }
    return false;
  }
  return value === cond;
}

function matches(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond ?? []).some((sub) => matches(row, sub));
    if (key === "AND") return (cond ?? []).every((sub) => matches(row, sub));
    if (key === "NOT") return !matches(row, cond);
    return matchField(row[key], cond);
  });
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
 * - 查询子集：等值 / in / notIn / not / startsWith / lt|lte|gt|gte / Date / null / OR / AND / 关系嵌套过滤；
 * - `include` / `select` 忽略（种子行自带嵌套字段；voucher.lines 与 allocations 由 find* 自动补）；
 * - `$transaction` 有**回滚语义**（回调抛错恢复调用前状态）；
 * - `options.unique` 模拟迁移里的唯一约束：
 *     "partial"（默认，迁移 DDL 语义）：同一来源「未删 + 未红冲 + 有来源」只能有一张凭证；
 *     "global"：旧全局唯一键语义（红冲行也占键）→ 用来做「去掉部分索引就会失败」的反证；
 *     "none"：不约束。
 */
function makeDb(seed = {}, options = {}) {
  const state = {};
  for (const key of MODEL_KEYS) state[key] = (seed[key] ?? []).map(cloneRow);
  const calls = [];
  const counters = { transaction: 0 };
  const unique = options.unique ?? "partial";
  const record = (model, method, args) => calls.push({ model, method, args });

  const findRows = (model, where) => state[model].map((row) => attach(model, cloneRow(row))).filter((row) => matches(row, where));
  const byId = (model, id) => state[model].find((row) => row.id === id) ?? null;

  const attach = (model, row) => {
    if (!row) return null;
    if (model === "voucher") {
      row.lines = state.voucherLine
        .filter((line) => line.voucherId === row.id)
        .sort((left, right) => (left.lineNo ?? 0) - (right.lineNo ?? 0))
        .map(cloneRow);
    }
    // 核销行的 `payment` 关系按**当前**付款状态解析（真实库的关系过滤是 join 现值，
    // 不是创建那一刻的快照）：refreshStatus 依赖它判断「有效核销」。
    if (model === "supplierPaymentAllocation") {
      row.payment = byId("supplierPayment", row.paymentId) ?? row.payment ?? { status: "posted" };
    }
    if (model === "receivableAllocation") {
      row.payment = byId("customerPayment", row.paymentId) ?? row.payment ?? { status: "posted" };
    }
    if (model === "supplierPayment") {
      row.allocations = state.supplierPaymentAllocation.filter((item) => item.paymentId === row.id).map(cloneRow);
    }
    if (model === "customerPayment") {
      row.allocations = state.receivableAllocation.filter((item) => item.paymentId === row.id).map(cloneRow);
    }
    if (model === "supplierPayableEntry") {
      row.allocations = state.supplierPaymentAllocation.filter((item) => item.payableEntryId === row.id).map(cloneRow);
    }
    if (model === "receivableSource") {
      row.allocations = state.receivableAllocation.filter((item) => item.receivableSourceId === row.id).map(cloneRow);
    }
    return row;
  };

  const enforceUnique = (data) => {
    if (unique === "none" || !data.sourceId) return;
    const active = (row) => row.deletedAt === null || row.deletedAt === undefined;
    const occupy = state.voucher.filter((row) => row.sourceType === data.sourceType && row.sourceId === data.sourceId
      && (unique === "global" ? true : active(row) && row.status !== "reversed"));
    if (!occupy.length) return;
    const code = unique === "global" ? "vouchers_source_type_source_id_key" : "vouchers_source_active_key";
    const error = new Error(`[fake-prisma] unique 约束冲突：${code} (source_type=${data.sourceType}, source_id=${data.sourceId})`);
    error.code = "P2002";
    error.meta = { target: code };
    throw error;
  };

  const db = { state, calls, counters, unique };
  for (const model of MODEL_KEYS) {
    db[model] = {
      findFirst: async (args = {}) => {
        record(model, "findFirst", args);
        const rows = findRows(model, args.where);
        return rows.length ? attach(model, cloneRow(rows[0])) : null;
      },
      findUnique: async (args = {}) => {
        record(model, "findUnique", args);
        const row = findRows(model, args.where)[0];
        return row ? attach(model, cloneRow(row)) : null;
      },
      findMany: async (args = {}) => {
        record(model, "findMany", args);
        return findRows(model, args.where).map((row) => attach(model, cloneRow(row)));
      },
      create: async (args = {}) => {
        record(model, "create", args);
        const data = args.data ?? {};
        if (model === "voucher") enforceUnique(data);
        const row = { id: data.id ?? nextId(model), createdAt: data.createdAt ?? new Date(), ...data };
        // 可空软删列在真实库里默认 NULL；替身也补上，否则 `deletedAt: null` 的过滤会漏掉新建行。
        if (row.deletedAt === undefined) row.deletedAt = null;
        // 核销行的 `status` 在真实库里默认 'active'（schema @default）。
        if ((model === "supplierPaymentAllocation" || model === "receivableAllocation") && row.status === undefined) row.status = "active";
        // 关系便捷字段：新建的核销行自动带上所属付款的嵌套状态，模拟关系过滤可命中。
        if (model === "supplierPaymentAllocation") row.payment = byId("supplierPayment", data.paymentId) ?? { status: "posted" };
        if (model === "receivableAllocation") row.payment = byId("customerPayment", data.paymentId) ?? { status: "posted" };
        state[model].push(row);
        return cloneRow(row);
      },
      update: async (args = {}) => {
        record(model, "update", args);
        const row = state[model].find((item) => matches(item, args.where));
        if (!row) throw new Error(`[fake-prisma] ${model}.update 未命中：${JSON.stringify(args.where)}`);
        Object.assign(row, args.data);
        return attach(model, cloneRow(row));
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
      aggregate: async (args = {}) => {
        record(model, "aggregate", args);
        const rows = findRows(model, args.where);
        const result = { _count: { _all: rows.length } };
        if (args._sum) {
          result._sum = {};
          for (const field of Object.keys(args._sum)) {
            let total = new Prisma.Decimal(0);
            for (const row of rows) total = total.plus(new Prisma.Decimal(row[field] ?? 0));
            result._sum[field] = total;
          }
        }
        return result;
      },
      groupBy: async (args = {}) => {
        record(model, "groupBy", args);
        return [];
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

/* ------------------------------------------------------------------ 种子数据 */

const SUBJECTS = [
  { id: "sub-raw", category: "资产类", name: "原材料", deletedAt: null, isActive: true, sortOrder: 180, balanceDirection: "借" },
  { id: "sub-cost", category: "损益类", name: "主营业务成本", deletedAt: null, isActive: true, sortOrder: 810, balanceDirection: "借" },
  { id: "sub-ap", category: "负债类", name: "应付账款", deletedAt: null, isActive: true, sortOrder: 420, balanceDirection: "贷" },
  { id: "sub-ar", category: "资产类", name: "应收账款", deletedAt: null, isActive: true, sortOrder: 110, balanceDirection: "借" },
  { id: "sub-rev", category: "损益类", name: "主营业务收入", deletedAt: null, isActive: true, sortOrder: 770, balanceDirection: "借" },
  { id: "sub-input-tax", category: "负债类", name: "应交税费-进项税", deletedAt: null, isActive: true, sortOrder: 520, balanceDirection: "借" },
  { id: "sub-bank", category: "资产类", name: "银行存款", deletedAt: null, isActive: true, sortOrder: 5000, balanceDirection: "借" },
  { id: "sub-admin", category: "损益类", name: "管理费用", deletedAt: null, isActive: true, sortOrder: 700, balanceDirection: "借" },
  // 同名跨类目：科目表允许 @@unique([category, name])，所以同名两条必须让 subject_id 留空（不猜）。
  { id: "sub-dup-1", category: "资产类", name: "其他应收款", deletedAt: null, isActive: true, sortOrder: 150, balanceDirection: "借" },
  { id: "sub-dup-2", category: "损益类", name: "其他应收款", deletedAt: null, isActive: true, sortOrder: 900, balanceDirection: "借" },
];

function makeStack(seed, options = {}) {
  const db = makeDb({ accountingSubject: SUBJECTS, ...seed }, options);
  const audit = makeAudit();
  const vouchers = new VoucherService(db, audit);
  const cashFlow = new CashFlowService(db, audit, undefined, vouchers);
  const payable = new SupplierPayableService(db, audit, cashFlow, undefined, vouchers);
  const receivable = new ReceivableService(db, audit, cashFlow, undefined, vouchers);
  const supplierPayments = new SupplierPaymentService(db, audit, payable, cashFlow, undefined, vouchers);
  const customerPayments = new CustomerPaymentService(db, audit, receivable, cashFlow, undefined, vouchers);
  return { db, audit, vouchers, cashFlow, payable, receivable, supplierPayments, customerPayments };
}

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
    id: "v-1", voucherNo: "记-2026-11-0001", voucherDate: new Date("2026-11-10T00:00:00.000Z"),
    period: "2026-11", sourceType: SOURCE_PAYABLE, sourceId: "ap-1", summary: "挂账", currency: "CNY",
    debitTotal: D("100.00"), creditTotal: D("100.00"), status: "posted", deletedAt: null, deletedBy: null,
    createdAt: new Date("2026-11-10T00:00:00.000Z"), ...overrides,
  };
}

function voucherLinesOf(db, voucherId) {
  return db.state.voucherLine.filter((line) => line.voucherId === voucherId);
}

const payableEntryRow = (overrides = {}) => ({
  id: "ap-1", payableNo: "AP-202611-0001", orderNo: "PO-1", supplierId: "sup-1",
  sourceType: "raw_material_inbound", status: "confirmed", amount: D("100.00"), currency: "CNY",
  subjectId: null, invoiceType: null, taxRate: null, remark: "", deletedAt: null,
  supplier: { name: "供应商A" }, payableSource: { status: "received" }, outsourcePayableSource: null, ...overrides,
});

const receivableRow = (overrides = {}) => ({
  id: "ar-1", sourceNo: "AR-1", orderNo: "SO-1", customerId: "cus-1", status: "confirmed",
  amount: D("100.00"), currency: "CNY", remark: "", deletedAt: null,
  customer: { name: "客户A" }, createdAt: new Date("2026-11-01T00:00:00.000Z"), ...overrides,
});

const supplierPaymentRow = (overrides = {}) => ({
  id: "pay-1", paymentNo: "SPAY-1", paymentDate: new Date("2026-11-10T00:00:00.000Z"),
  amount: D("100.00"), currency: "CNY", paymentMethod: "银行转账", payeeName: null,
  supplierId: "sup-1", orderNo: "PO-1", status: "draft", remark: "", deletedAt: null, bankId: null, subjectId: null, ...overrides,
});

const customerPaymentRow = (overrides = {}) => ({
  id: "cpay-1", paymentNo: "CPAY-1", paymentDate: new Date("2026-11-10T00:00:00.000Z"),
  amount: D("100.00"), currency: "CNY", paymentMethod: "银行转账", payerName: null,
  customerId: "cus-1", orderNo: "SO-1", status: "draft", remark: "", deletedAt: null, bankId: null, subjectId: null, ...overrides,
});

/* ------------------------------------------------------------------ D4 强制核销额 = 单据额 */

async function verifyD4() {
  group("D4-强制核销额");

  await check("D4-01", "应付：核销额 ≠ 未核销余额 → 422 ALLOCATION_MUST_SETTLE_PAYABLE（不允许部分核销）", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      supplierPayment: [supplierPaymentRow({ amount: D("60.00") })],
      supplierPayableEntry: [payableEntryRow({ amount: D("100.00") })],
      supplierPayableReconciliation: [],
    });
    const audit = makeAudit();
    const vouchers = new VoucherService(db, audit);
    const cashFlow = new CashFlowService(db, audit, undefined, vouchers);
    const payable = new SupplierPayableService(db, audit, cashFlow, undefined, vouchers);
    const payments = new SupplierPaymentService(db, audit, payable, cashFlow, undefined, vouchers);

    const error = await expect422(
      payments.post("pay-1", [{ payable_entry_id: "ap-1", amount: "60" }], USER),
      "ALLOCATION_MUST_SETTLE_PAYABLE",
      "部分核销",
    );
    assertEqual(error.details[0]?.available_amount, "100", "details 必须给出未核销余额");
    assertEqual(error.details[0]?.requested_amount, "60", "details 必须给出请求核销额");
    assertEqual(db.state.supplierPayment[0].status, "draft", "被拒后付款仍是草稿（事务回滚）");
    assertEqual(db.state.supplierPaymentAllocation.length, 0, "被拒时不得留下核销行");
    return error;
  });

  await check("D4-02", "应付：核销额=余额但付款金额 ≠ 核销合计 → 422 PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      supplierPayment: [supplierPaymentRow({ amount: D("110.00") })],
      supplierPayableEntry: [payableEntryRow({ amount: D("100.00") })],
      supplierPayableReconciliation: [],
    });
    const audit = makeAudit();
    const vouchers = new VoucherService(db, audit);
    const cashFlow = new CashFlowService(db, audit, undefined, vouchers);
    const payable = new SupplierPayableService(db, audit, cashFlow, undefined, vouchers);
    const payments = new SupplierPaymentService(db, audit, payable, cashFlow, undefined, vouchers);

    const error = await expect422(
      payments.post("pay-1", [{ payable_entry_id: "ap-1", amount: "100" }], USER),
      "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION",
      "付款金额与核销合计不一致",
    );
    assertEqual(db.state.supplierPayment[0].status, "draft", "被拒后付款仍是草稿");
    assertEqual(db.state.supplierPaymentAllocation.length, 0, "被拒时不得留下核销行");
    return error;
  });

  await check("D4-03", "应收：核销额 ≠ 未收余额 → 422 ALLOCATION_MUST_SETTLE_RECEIVABLE", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      customerPayment: [customerPaymentRow({ amount: D("60.00") })],
      receivableSource: [receivableRow({ amount: D("100.00") })],
      receivableReconciliation: [],
    });
    const audit = makeAudit();
    const vouchers = new VoucherService(db, audit);
    const cashFlow = new CashFlowService(db, audit, undefined, vouchers);
    const receivable = new ReceivableService(db, audit, cashFlow, undefined, vouchers);
    const payments = new CustomerPaymentService(db, audit, receivable, cashFlow, undefined, vouchers);

    const error = await expect422(
      payments.post("cpay-1", [{ receivable_source_id: "ar-1", amount: "60" }], USER),
      "ALLOCATION_MUST_SETTLE_RECEIVABLE",
      "部分核销",
    );
    assertEqual(db.state.customerPayment[0].status, "draft", "被拒后收款仍是草稿");
    assertEqual(db.state.receivableAllocation.length, 0, "被拒时不得留下核销行");
    return error;
  });

  await check("D4-04", "应收：核销额=余额但收款金额 ≠ 核销合计 → 422 PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      customerPayment: [customerPaymentRow({ amount: D("110.00") })],
      receivableSource: [receivableRow({ amount: D("100.00") })],
      receivableReconciliation: [],
    });
    const audit = makeAudit();
    const vouchers = new VoucherService(db, audit);
    const cashFlow = new CashFlowService(db, audit, undefined, vouchers);
    const receivable = new ReceivableService(db, audit, cashFlow, undefined, vouchers);
    const payments = new CustomerPaymentService(db, audit, receivable, cashFlow, undefined, vouchers);

    const error = await expect422(
      payments.post("cpay-1", [{ receivable_source_id: "ar-1", amount: "100" }], USER),
      "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION",
      "收款金额与核销合计不一致",
    );
    assertEqual(db.state.customerPayment[0].status, "draft", "被拒后收款仍是草稿");
    assertEqual(db.state.receivableAllocation.length, 0, "被拒时不得留下核销行");
    return error;
  });

  await check("D4-05", "历史 partially_paid：只结余款（available=60）→ 付款 60 核销 60 成功，单据转 paid", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      supplierPayment: [supplierPaymentRow({ amount: D("60.00") })],
      supplierPayableEntry: [payableEntryRow({ amount: D("100.00"), status: "partially_paid" })],
      // 历史部分核销：已核销 40（posted 付款的 active 核销行），剩余可核销 60 —— D4 不要求回算原单据金额 100。
      supplierPaymentAllocation: [{ id: "alloc-old", paymentId: "pay-old", payableEntryId: "ap-1", amount: D("40.00"), currency: "CNY", status: "active", deletedAt: null, payment: { status: "posted" } }],
      cashFlowEntry: [],
      supplierPayableReconciliation: [],
    });
    const audit = makeAudit();
    const vouchers = new VoucherService(db, audit);
    const cashFlow = new CashFlowService(db, audit, undefined, vouchers);
    const payable = new SupplierPayableService(db, audit, cashFlow, undefined, vouchers);
    const payments = new SupplierPaymentService(db, audit, payable, cashFlow, undefined, vouchers);

    const posted = await payments.post("pay-1", [{ payable_entry_id: "ap-1", amount: "60" }], USER);
    assertEqual(posted.status, "posted", "付款应过账成功");
    const entry = db.state.supplierPayableEntry[0];
    assertEqual(entry.status, "paid", "结清剩余 60 后应付转为已付款");
    const active = db.state.supplierPaymentAllocation.filter((row) => row.payableEntryId === "ap-1" && row.deletedAt === null && row.status === "active");
    assertEqual(active.length, 2, "历史核销 + 本次核销各一条");
    assertEqual(active.reduce((sum, row) => sum.plus(new Prisma.Decimal(row.amount)), new Prisma.Decimal(0)).toString(), "100", "累计核销 = 单据金额");
    assertEqual(db.state.cashFlowEntry.length, 1, "付款过账自动写一条收支流水");
    return { entryStatus: entry.status, activeAllocations: active.map((row) => row.amount.toString()) };
  });
}

/* ------------------------------------------------------------------ D5 进项税拆分 */

const TAX_ACCRAWL = (overrides = {}) => accrualInput({
  source_type: SOURCE_PAYABLE, source_id: "ap-tax", document_no: "AP-TAX-1", amount: "11300.00",
  contra_subject_names: ["原材料", "主营业务成本"], invoice_type: "special", tax_rate: "0.13",
  business_subject_id: "sub-raw",
  ...overrides,
});

async function createAccrualFor(seed, input, options = { post: true }) {
  const db = makeDb(seed);
  const audit = makeAudit();
  const service = new VoucherService(db, audit);
  const result = await service.createAccrual(input, USER, options);
  return { db, audit, service, result };
}

async function verifyD5() {
  group("D5-进项税");

  await check("D5-01", "专票 11300 / 13% → 借 原材料 10000 + 借 进项税 1300 / 贷 应付账款 11300，借贷严格相等", async () => {
    const { db, result } = await createAccrualFor({ accountingSubject: SUBJECTS }, TAX_ACCRAWL());
    assert(result, "专票挂账必须生成凭证");
    assertEqual(result.status, "posted", "生成即 posted");
    const voucher = db.state.voucher[0];
    const lines = voucherLinesOf(db, voucher.id).sort((left, right) => left.lineNo - right.lineNo);
    assertEqual(lines.length, 3, "专票必须是三行分录");
    const debit = lines.filter((line) => line.direction === "debit");
    const credit = lines.filter((line) => line.direction === "credit");
    assertEqual(debit.length, 2, "两行借方（不含税业务科目 + 进项税）");
    assertEqual(credit.length, 1, "一行贷方（含税应付账款）");
    const netLine = debit.find((line) => line.subjectLabel === "原材料");
    const taxLine = debit.find((line) => line.subjectLabel === "应交税费-进项税");
    assert(netLine, "借方必须有不含税的业务科目行");
    assert(taxLine, "借方必须有进项税行");
    assertEqual(new Prisma.Decimal(netLine.amount).toFixed(4), "10000.0000", "不含税 = 11300 ÷ 1.13");
    assertEqual(new Prisma.Decimal(taxLine.amount).toFixed(4), "1300.0000", "税额 = 11300 − 10000");
    assertEqual(new Prisma.Decimal(credit[0].amount).toFixed(4), "11300.0000", "贷方是含税总额");
    const debitTotal = debit.reduce((sum, line) => sum.plus(new Prisma.Decimal(line.amount)), new Prisma.Decimal(0));
    const creditTotal = credit.reduce((sum, line) => sum.plus(new Prisma.Decimal(line.amount)), new Prisma.Decimal(0));
    assertEqual(debitTotal.toFixed(4), creditTotal.toFixed(4), "借贷必须严格相等（税额由含税额减出来）");
    assertEqual(debitTotal.toFixed(4), "11300.0000", "借方合计等于含税总额");
    assertEqual(netLine.subjectId, "sub-raw", "业务行落记账科目 id");
    assertEqual(taxLine.subjectId, "sub-input-tax", "进项税行落科目 id");
    assertEqual(credit[0].subjectId, "sub-ap", "贷方应付账款落科目 id");
    assertEqual(netLine.businessSubjectId, "sub-raw", "不含税行带业务科目辅助维度");
    assertEqual(netLine.businessSubjectLabel, "原材料", "业务科目名称快照");
    return { lines: lines.map((line) => `${line.direction}:${line.subjectLabel}:${new Prisma.Decimal(line.amount).toFixed(4)}`), debitTotal: debitTotal.toFixed(4) };
  });

  await check("D5-02", "普票（general）不拆：两行、全额进业务科目（即使传了税率也忽略）", async () => {
    const { db } = await createAccrualFor({ accountingSubject: SUBJECTS }, TAX_ACCRAWL({ invoice_type: "general" }));
    const voucher = db.state.voucher[0];
    const lines = voucherLinesOf(db, voucher.id);
    assertEqual(lines.length, 2, "普票保持两行");
    assertEqual(lines.some((line) => line.subjectLabel === "应交税费-进项税"), false, "普票不能出现进项税行");
    const debit = lines.find((line) => line.direction === "debit");
    assertEqual(new Prisma.Decimal(debit.amount).toFixed(4), "11300.0000", "普票全额进成本");
    assertEqual(debit.subjectLabel, "原材料", "业务科目候选链首选仍生效");
    return { lines: lines.length, debit: new Prisma.Decimal(debit.amount).toFixed(4) };
  });

  await check("D5-03", "专票缺税率 → 422 INVOICE_TAX_RATE_REQUIRED（不猜 13%）", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const error = await expect422(
      service.createAccrual(TAX_ACCRAWL({ tax_rate: null }), USER, { post: true }),
      "INVOICE_TAX_RATE_REQUIRED",
      "专票缺税率",
    );
    assertEqual(db.state.voucher.length, 0, "被拒时不得落库");
    return error;
  });

  await check("D5-04", "税率 r≥1（百分数写法 13）→ 422 INVALID_TAX_RATE（防「看起来有净额有税额、实际全错」）", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const error = await expect422(
      service.createAccrual(TAX_ACCRAWL({ tax_rate: "13" }), USER, { post: true }),
      "INVALID_TAX_RATE",
      "税率越界",
    );
    assertEqual(db.state.voucher.length, 0, "被拒时不得落库");
    return error;
  });

  await check("D5-05", "专票但科目表没有进项税科目 → 422 INPUT_TAX_SUBJECT_MISSING（不静默换科目）", async () => {
    const subjects = SUBJECTS.filter((subject) => subject.name !== "应交税费-进项税");
    const db = makeDb({ accountingSubject: subjects });
    const service = new VoucherService(db, makeAudit());
    const error = await expect422(
      service.createAccrual(TAX_ACCRAWL(), USER, { post: true }),
      "INPUT_TAX_SUBJECT_MISSING",
      "缺进项税科目",
    );
    assertEqual(db.state.voucher.length, 0, "被拒时不得落库");
    return error;
  });
}

/* ------------------------------------------------------------------ R3-1 科目 id 落库 */

async function verifySubjectIds() {
  group("R3-1-科目id");

  await check("SID-01", "挂账凭证全部行落 subject_id；业务科目维度落 business_subject_id / label", async () => {
    const { db } = await createAccrualFor(
      { accountingSubject: SUBJECTS },
      accrualInput({ source_id: "ap-sid", amount: "500.00", contra_subject_names: ["原材料", "主营业务成本"], business_subject_id: "sub-cost" }),
    );
    const voucher = db.state.voucher[0];
    const lines = voucherLinesOf(db, voucher.id);
    const debit = lines.find((line) => line.direction === "debit");
    const credit = lines.find((line) => line.direction === "credit");
    assertEqual(debit.subjectId, "sub-raw", "借方记账科目 id = 原材料");
    assertEqual(credit.subjectId, "sub-ap", "贷方记账科目 id = 应付账款");
    assertEqual(debit.businessSubjectId, "sub-cost", "业务科目辅助维度 = 条目科目");
    assertEqual(debit.businessSubjectLabel, "主营业务成本", "业务科目名称快照");
    assertEqual(credit.businessSubjectId, null, "贷方（往来科目行）没有业务科目维度");
    return { debit: { subjectId: debit.subjectId, businessSubjectId: debit.businessSubjectId }, credit: { subjectId: credit.subjectId } };
  });

  await check("SID-02", "同名跨类目 → subject_id 留空（不猜分类），subject_label 快照照旧保留", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const created = await service.createManual({
      voucher_date: "2026-11-10",
      lines: [
        { direction: "debit", subject_label: "其他应收款", amount: "100" },
        { direction: "credit", subject_label: "银行存款", amount: "100" },
      ],
    }, USER);
    const lines = voucherLinesOf(db, created.id).sort((left, right) => left.lineNo - right.lineNo);
    assertEqual(lines[0].subjectLabel, "其他应收款", "文本快照保留");
    assertEqual(lines[0].subjectId, null, "同名跨类目（资产类/损益类各一条）必须留空，不能猜");
    assertEqual(lines[1].subjectId, "sub-bank", "唯一命中的科目正常落 id");
    return { ambiguous: { label: lines[0].subjectLabel, subjectId: lines[0].subjectId }, unique: lines[1].subjectId };
  });

  await check("SID-03", "红冲沿用原行的 subject_id / business_subject_id（不按名称重新解析）", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      voucher: [voucherRow({ id: "v-origin", status: "posted", sourceType: SOURCE_PAYABLE, sourceId: "ap-origin" })],
      voucherLine: [
        { id: "l1", voucherId: "v-origin", lineNo: 1, direction: "debit", subjectKey: "资产类/原材料", subjectLabel: "原材料", summary: "", amount: D("100.00"), currency: "CNY", bankId: null, subjectId: "sub-raw", businessSubjectId: "sub-cost", businessSubjectLabel: "主营业务成本", deletedAt: null },
        { id: "l2", voucherId: "v-origin", lineNo: 2, direction: "credit", subjectKey: "负债类/应付账款", subjectLabel: "应付账款", summary: "", amount: D("100.00"), currency: "CNY", bankId: null, subjectId: "sub-ap", businessSubjectId: null, businessSubjectLabel: null, deletedAt: null },
      ],
    });
    const service = new VoucherService(db, makeAudit());
    // 红冲前把科目行改名/停用：若红冲按名称重新解析，就会解析不到或挂错 id。
    for (const subject of db.state.accountingSubject) if (subject.id === "sub-raw") subject.name = "原材料（已改名）";
    const red = await service.reverse("v-origin", "科目错", USER);
    const redLines = voucherLinesOf(db, red.id).sort((left, right) => left.lineNo - right.lineNo);
    assertEqual(red.sourceType, SOURCE_VOUCHER, "红字凭证来源类型");
    assertEqual(redLines[0].subjectId, "sub-raw", "红字行沿用原行的记账科目 id（改名前解析不到也不许换）");
    assertEqual(redLines[0].businessSubjectId, "sub-cost", "辅助维度同样沿用");
    assertEqual(redLines[1].subjectId, "sub-ap", "贷方行沿用原行 id");
    assertEqual(db.state.voucher.find((row) => row.id === "v-origin").status, "reversed", "原凭证被红冲");
    return { redId: red.id, redLines: redLines.map((line) => ({ subjectId: line.subjectId, businessSubjectId: line.businessSubjectId })) };
  });
}

/* ------------------------------------------------------------------ R3-4 部分唯一索引 */

async function verifyPartialIndex() {
  group("R3-4-部分索引");

  await check("IDX-01", "迁移 DDL：部分唯一索引只约束「未删 + 未红冲 + 有来源」，旧全局唯一键被替换", async () => {
    const migration = fs.readFileSync(MIGRATION, "utf8");
    assert(/DROP INDEX IF EXISTS "vouchers_source_type_source_id_key"/.test(migration), "必须删除旧全局唯一键");
    const partial = migration.match(/CREATE UNIQUE INDEX "vouchers_source_active_key"[\s\S]*?;/)?.[0] ?? "";
    assert(/ON "vouchers" \("source_type", "source_id"\)/.test(partial), "部分唯一索引键是 (source_type, source_id)");
    assert(/WHERE "deleted_at" IS NULL/.test(partial), "排除软删行");
    assert(/"status" <> 'reversed'/.test(partial), "排除已红冲行");
    assert(/"source_id" IS NOT NULL/.test(partial), "手工凭证（source_id 为空）不进约束");
    const schema = fs.readFileSync(SCHEMA, "utf8");
    const voucherModel = /model Voucher \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    assert(/@@index\(\[sourceType, sourceId\]\)/.test(voucherModel), "schema 声明普通 @@index");
    assert(!/@@unique\(\[sourceType, sourceId\]\)/.test(voucherModel), "schema 不能再声明全局 @@unique");
    return { condition: partial.split("WHERE")[1]?.trim() };
  });

  await check("IDX-02", "红冲后可再建：来源只有 reversed 行时 createAccrual(post) 新建 posted（部分索引不把红冲行算占位）", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      voucher: [voucherRow({ id: "v-reversed", voucherNo: "记-2026-11-0001", status: "reversed", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
    });
    const service = new VoucherService(db, makeAudit());
    const result = await service.createAccrual(accrualInput(), USER, { post: true });
    assertEqual(result.status, "posted", "新凭证生成即 posted");
    assertEqual(db.state.voucher.length, 2, "红冲历史行 + 新 posted 行并存");
    const created = db.state.voucher.find((row) => row.id !== "v-reversed");
    assert(created, "必须新建一张，而不是复用红冲行");
    assertEqual(created.status, "posted", "新行状态");
    assertEqual(db.state.voucher.find((row) => row.id === "v-reversed").status, "reversed", "红冲历史行原样保留");
    const activeCount = db.state.voucher.filter((row) => row.sourceId === "ap-1" && row.deletedAt === null && row.status !== "reversed").length;
    assertEqual(activeCount, 1, "同一来源同时只有一张有效凭证");
    return { voucherCount: db.state.voucher.length, newStatus: created.status, activeCount };
  });

  await check("IDX-03", "双 active 被拦：同一来源已有 posted 时再确认 → 幂等复用（replayed=true），不新建第二张", async () => {
    const db = makeDb({
      accountingSubject: SUBJECTS,
      voucher: [voucherRow({ id: "v-posted", status: "posted", sourceType: SOURCE_PAYABLE, sourceId: "ap-1", debitTotal: D("100.00") })],
    });
    const service = new VoucherService(db, makeAudit());
    const result = await service.createAccrual(accrualInput(), USER, { post: true });
    assertEqual(result.replayed, true, "幂等命中");
    assertEqual(db.state.voucher.length, 1, "不得出现第二张有效凭证");
    assertEqual(db.calls.some((call) => call.model === "voucher" && call.method === "create"), false, "不得调用 create");
    // 断言替身本身确实在模拟唯一约束：绕过服务层直插同来源有效行会被拦。
    const error = await expectThrow(
      db.voucher.create({ data: { voucherNo: "记-2026-11-9999", sourceType: SOURCE_PAYABLE, sourceId: "ap-1", status: "posted", deletedAt: null } }),
      (caught) => caught.code === "P2002" && String(caught.message).includes("vouchers_source_active_key"),
      "直插第二条同来源有效凭证",
    );
    return { replayed: result.replayed, vouchers: db.state.voucher.length, constraint: error.code };
  });
}

/* ------------------------------------------------------------------ R3-5 冲销联动 */

function flowRow(overrides = {}) {
  return {
    id: "flow-1", entryNo: "CF-20261110-1", entryDate: new Date("2026-11-10T00:00:00.000Z"),
    counterpartyName: "供应商A", direction: "expense", amount: D("100.00"), currency: "CNY",
    subjectId: "sub-raw", categorySubjectId: null, settlementMethod: "银行转账", bankId: null,
    sourceType: "supplier_payment", sourceId: "pay-1", status: "posted", remark: "", deletedAt: null,
    subject: { id: "sub-raw", category: "资产类", name: "原材料" }, categorySubject: null,
    settlementAccount: null, bank: null, orderNo: null, paymentNature: null, createdAt: new Date("2026-11-10T00:00:00.000Z"),
    ...overrides,
  };
}

function postedFlowVoucher(overrides = {}) {
  return {
    voucher: [voucherRow({ id: "v-flow", voucherNo: "记-2026-11-0100", sourceType: SOURCE_CASH_FLOW, sourceId: "flow-1", status: "posted", debitTotal: D("100.00"), creditTotal: D("100.00") })],
    voucherLine: [
      { id: "fl1", voucherId: "v-flow", lineNo: 1, direction: "debit", subjectKey: "资产类/原材料", subjectLabel: "原材料", summary: "", amount: D("100.00"), currency: "CNY", bankId: null, subjectId: "sub-raw", businessSubjectId: null, businessSubjectLabel: null },
      { id: "fl2", voucherId: "v-flow", lineNo: 2, direction: "credit", subjectKey: "资产类/银行存款", subjectLabel: "银行存款", summary: "", amount: D("100.00"), currency: "CNY", bankId: null, subjectId: "sub-bank", businessSubjectId: null, businessSubjectLabel: null },
    ],
    ...overrides,
  };
}

async function verifyReversalLinkage() {
  group("R3-5-冲销联动");

  await check("LINK-01", "付款冲销 → 回冲流水 + 红冲该流水凭证（红字凭证 posted、来源 = 被红冲凭证）", async () => {
    const stack = makeStack({
      supplierPayment: [supplierPaymentRow({ status: "posted", amount: D("100.00") })],
      supplierPaymentAllocation: [{ id: "alloc-1", paymentId: "pay-1", payableEntryId: "ap-1", amount: D("100.00"), currency: "CNY", status: "active", deletedAt: null, payment: { status: "posted" } }],
      supplierPayableEntry: [payableEntryRow({ status: "confirmed" })],
      supplierPayableReconciliation: [],
      cashFlowEntry: [flowRow()],
      ...postedFlowVoucher(),
    });
    await stack.supplierPayments.reverse("pay-1", "供应商记错", USER);

    const payment = stack.db.state.supplierPayment.find((row) => row.id === "pay-1");
    assertEqual(payment.status, "reversed", "付款单已冲销");
    const allocation = stack.db.state.supplierPaymentAllocation.find((row) => row.id === "alloc-1");
    assertEqual(allocation.status, "reversed", "核销行已冲销");
    const flow = stack.db.state.cashFlowEntry.find((row) => row.id === "flow-1");
    assertEqual(flow.status, "reversed", "流水已回冲");
    const original = stack.db.state.voucher.find((row) => row.id === "v-flow");
    assertEqual(original.status, "reversed", "流水凭证已红冲（原凭证置 reversed）");
    const red = stack.db.state.voucher.find((row) => row.sourceType === SOURCE_VOUCHER && row.sourceId === "v-flow");
    assert(red, "必须生成红字凭证");
    assertEqual(red.status, "posted", "红字凭证 direct posted");
    const redLines = voucherLinesOf(stack.db, red.id);
    assertEqual(redLines.find((line) => line.direction === "debit").subjectLabel, "银行存款", "红字借贷对调");
    return { payment: payment.status, flow: flow.status, originalVoucher: original.status, redVoucher: red.voucherNo };
  });

  await check("LINK-02", "流水冲销 → 红冲其已过账凭证；重复冲销幂等（不产生第二张红字）", async () => {
    const stack = makeStack({
      cashFlowEntry: [flowRow()],
      ...postedFlowVoucher(),
    });
    await stack.cashFlow.reverse("flow-1", "流水记错", USER);
    const original = stack.db.state.voucher.find((row) => row.id === "v-flow");
    assertEqual(original.status, "reversed", "流水凭证被红冲");
    const reds = stack.db.state.voucher.filter((row) => row.sourceType === SOURCE_VOUCHER);
    assertEqual(reds.length, 1, "恰好一张红字凭证");

    const second = await stack.vouchers.reverseBySource(SOURCE_CASH_FLOW, "flow-1", "再冲一次", USER);
    assertEqual(second, null, "重复冲销幂等：没有有效凭证就返回 null");
    assertEqual(stack.db.state.voucher.filter((row) => row.sourceType === SOURCE_VOUCHER).length, 1, "不产生第二张红字");
    return { original: original.status, reds: reds.length, idempotent: second === null };
  });

  await check("LINK-03", "流水冲销且凭证还是草稿 → 软删草稿（不生成红字，草稿不是账务事实）", async () => {
    const stack = makeStack({
      cashFlowEntry: [flowRow()],
      voucher: [voucherRow({ id: "v-draft-flow", voucherNo: "记-2026-11-0101", sourceType: SOURCE_CASH_FLOW, sourceId: "flow-1", status: "draft", debitTotal: D("100.00"), creditTotal: D("100.00") })],
      voucherLine: [
        { id: "dl1", voucherId: "v-draft-flow", lineNo: 1, direction: "debit", subjectKey: "资产类/原材料", subjectLabel: "原材料", summary: "", amount: D("100.00"), currency: "CNY", bankId: null, subjectId: "sub-raw" },
        { id: "dl2", voucherId: "v-draft-flow", lineNo: 2, direction: "credit", subjectKey: "资产类/银行存款", subjectLabel: "银行存款", summary: "", amount: D("100.00"), currency: "CNY", bankId: null, subjectId: "sub-bank" },
      ],
    });
    const action = await stack.vouchers.reverseBySource(SOURCE_CASH_FLOW, "flow-1", "流水冲销", USER);
    assertEqual(action.action, "draft_discarded", "草稿凭证按作废处理");
    assertEqual(action.redVoucherNo, null, "不生成红字");
    const draft = stack.db.state.voucher.find((row) => row.id === "v-draft-flow");
    assert(draft.deletedAt instanceof Date, "草稿必须被软删");
    assertEqual(draft.deletedBy, USER.id, "软删记录操作人");
    assertEqual(stack.db.state.voucher.length, 1, "数量不变（没有新增红字）");
    return { action: action.action, deletedAt: draft.deletedAt instanceof Date };
  });
}

/* ------------------------------------------------------------------ R3-7 自动过账 + 流水护栏 */

async function verifyAutoPost() {
  group("R3-7-自动过账");

  await check("AUTO-01", "由流水自动生成的凭证 = posted（留 voucher.post auto 审计），业务科目维度取收支类目", async () => {
    const stack = makeStack({
      cashFlowEntry: [flowRow({ id: "flow-auto", categorySubjectId: "sub-cost", categorySubject: { id: "sub-cost", category: "损益类", name: "主营业务成本" } })],
    });
    const created = await stack.vouchers.createFromCashFlowEntry("flow-auto", USER);
    assertEqual(created.status, "posted", "生成即过账");
    const voucher = stack.db.state.voucher[0];
    assertEqual(voucher.status, "posted", "落库状态");
    assertEqual(voucher.sourceType, SOURCE_CASH_FLOW, "来源类型");
    const postEvent = stack.audit.events.find((event) => event.action === "voucher.post" && event.details?.reason === "cash_flow_auto_post");
    assert(postEvent, "必须留 voucher.post（reason=cash_flow_auto_post）");
    assertEqual(postEvent.details.auto, true, "自动过账审计 auto=true");
    const lines = voucherLinesOf(stack.db, voucher.id);
    const businessLine = lines.find((line) => line.direction === "debit");
    assertEqual(businessLine.businessSubjectId, "sub-cost", "业务科目 = 流水的收支类目");
    assertEqual(businessLine.businessSubjectLabel, "主营业务成本", "业务科目名称快照");
    assert(businessLine.subjectId, "记账科目 id 已落库");
    return { status: created.status, businessSubjectId: businessLine.businessSubjectId };
  });

  await check("AUTO-02", "已过账凭证的流水不可直接改 → 422 CASH_FLOW_HAS_POSTED_VOUCHER；无凭证的流水仍可改", async () => {
    const blocked = makeStack({
      cashFlowEntry: [flowRow()],
      ...postedFlowVoucher(),
    });
    const error = await expect422(
      blocked.cashFlow.update("flow-1", { remark: "想直接改" }, USER),
      "CASH_FLOW_HAS_POSTED_VOUCHER",
      "改已过账凭证的流水",
    );
    assertEqual(blocked.db.state.cashFlowEntry.find((row) => row.id === "flow-1").remark, "", "被拒时流水一个字都没改");
    assertEqual(error.details[0]?.voucher_no, "记-2026-11-0100", "details 带出凭证号");

    const editable = makeStack({ cashFlowEntry: [flowRow({ id: "flow-free", sourceType: "manual", sourceId: null })] });
    const updated = await editable.cashFlow.update("flow-free", { remark: "更正备注", counterparty_name: "供应商B" }, USER);
    assertEqual(updated.remark, "更正备注", "无凭证的流水可以改");
    assertEqual(updated.counterpartyName, "供应商B", "对方名称被更新");
    return { blocked: error.code, updated: updated.remark };
  });
}

/* ------------------------------------------------------------------ R3-6 reaccrue + accrual_status */

async function verifyReaccrue() {
  group("R3-6-重算与状态");

  await check("RE-01", "挂账凭证被红冲后 reaccrue → 新建 posted 凭证；accrual_status 变为 posted", async () => {
    const stack = makeStack({
      supplierPayableEntry: [payableEntryRow({ status: "confirmed", subjectId: "sub-cost" })],
      // 红冲历史行：source 仍是 ap-1，但已红冲（activeVoucherOf 不把它当有效凭证）。
      voucher: [voucherRow({ id: "v-reversed", status: "reversed", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
      supplierPayableReconciliation: [],
    });
    const result = await stack.payable.reaccrue("ap-1", USER, "红冲后重算");
    assertEqual(result.status, "posted", "重算凭证生成即 posted");
    assertEqual(result.replayed, false, "这是新建，不是幂等复用");
    assert(result.voucherNo.startsWith("记-"), "返回凭证号");
    const accrualVouchers = stack.db.state.voucher.filter((row) => row.sourceType === SOURCE_PAYABLE && row.sourceId === "ap-1");
    assertEqual(accrualVouchers.length, 2, "红冲历史行 + 新重算行并存");
    assertEqual(accrualVouchers.filter((row) => row.status === "posted").length, 1, "恰好一张有效 posted");
    const detail = await stack.payable.get("ap-1");
    assertEqual(detail.accrual_status, "posted", "详情 accrual_status = posted");
    return { result, vouchers: accrualVouchers.map((row) => row.status), accrualStatus: detail.accrual_status };
  });

  await check("RE-02", "已有 posted 挂账凭证时 reaccrue → 422 ACCRUAL_ALREADY_POSTED（绝不静默挂第二笔）", async () => {
    const stack = makeStack({
      supplierPayableEntry: [payableEntryRow({ status: "confirmed" })],
      voucher: [voucherRow({ id: "v-posted", status: "posted", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
      supplierPayableReconciliation: [],
    });
    const error = await expect422(stack.payable.reaccrue("ap-1", USER), "ACCRUAL_ALREADY_POSTED", "已过账重算");
    assertEqual(stack.db.state.voucher.length, 1, "不得新建凭证");
    assert(String(error.message).includes("红冲"), "提示必须先红冲");
    return error;
  });

  await check("RE-03", "accrual_status 四态：posted / draft / reversed / none（posted > draft > reversed）", async () => {
    const stack = makeStack({
      supplierPayableEntry: [
        payableEntryRow({ id: "ap-posted", status: "confirmed" }),
        payableEntryRow({ id: "ap-draft", status: "confirmed" }),
        payableEntryRow({ id: "ap-reversed", status: "confirmed" }),
        payableEntryRow({ id: "ap-none", status: "confirmed" }),
        // 同一来源同时有红冲行 + 新 posted：必须按 posted 优先（不能显示「已红冲」）
        payableEntryRow({ id: "ap-both", status: "confirmed" }),
      ],
      voucher: [
        voucherRow({ id: "v1", sourceType: SOURCE_PAYABLE, sourceId: "ap-posted", status: "posted" }),
        voucherRow({ id: "v2", sourceType: SOURCE_PAYABLE, sourceId: "ap-draft", status: "draft" }),
        voucherRow({ id: "v3", sourceType: SOURCE_PAYABLE, sourceId: "ap-reversed", status: "reversed" }),
        voucherRow({ id: "v4", sourceType: SOURCE_PAYABLE, sourceId: "ap-both", status: "reversed" }),
        voucherRow({ id: "v5", sourceType: SOURCE_PAYABLE, sourceId: "ap-both", status: "posted" }),
      ],
      supplierPayableReconciliation: [],
    });
    const statuses = {};
    for (const id of ["ap-posted", "ap-draft", "ap-reversed", "ap-none", "ap-both"]) {
      statuses[id] = (await stack.payable.get(id)).accrual_status;
    }
    assertDeep(statuses, { "ap-posted": "posted", "ap-draft": "draft", "ap-reversed": "reversed", "ap-none": "none", "ap-both": "posted" }, "四态 + 优先级");
    return statuses;
  });
}

/* ------------------------------------------------------------------ 反证（≥2） */

async function verifyCounterExamples() {
  group("CX-反证");

  await check("CX-01", "反证 1：去掉部分唯一索引条件（恢复全局唯一）→ 红冲后重算必须失败（证明 IDX-02 不是假通过）", async () => {
    const seed = {
      accountingSubject: SUBJECTS,
      voucher: [voucherRow({ id: "v-reversed-global", voucherNo: "记-2026-11-0001", status: "reversed", sourceType: SOURCE_PAYABLE, sourceId: "ap-1" })],
    };
    // 正例（迁移 DDL 语义）：可以重算。
    const partialDb = makeDb(seed, { unique: "partial" });
    const ok = await new VoucherService(partialDb, makeAudit()).createAccrual(accrualInput(), USER, { post: true });
    assertEqual(ok.status, "posted", "部分索引语义下重算应成功");
    assertEqual(partialDb.state.voucher.length, 2, "新凭证已建");

    // 反例（旧全局唯一键语义）：红冲行仍占着 (source_type, source_id) → 重算必须失败。
    const globalDb = makeDb(seed, { unique: "global" });
    const error = await expectThrow(
      new VoucherService(globalDb, makeAudit()).createAccrual(accrualInput(), USER, { post: true }),
      (caught) => caught.code === "P2002",
      "全局唯一键语义下重算",
    );
    assertEqual(globalDb.state.voucher.length, 1, "全局唯一键下建不出第二张（必须失败）");
    return { partialIndex: "允许重算", globalUnique: `失败：${error.code}` };
  });

  await check("CX-02", "反证 2：去掉进项税行 → 借贷不相等（证明 D5 拆税行分录是平衡的必要条件）", async () => {
    // 用与 D5-01 完全相同的金额，但人为漏掉「借 应交税费-进项税 1300」这一行。
    const db = makeDb({ accountingSubject: SUBJECTS });
    const service = new VoucherService(db, makeAudit());
    const error = await expect422(
      service.createManual({
        voucher_date: "2026-11-10",
        lines: [
          { direction: "debit", subject_label: "原材料", amount: "10000" },
          { direction: "credit", subject_label: "应付账款", amount: "11300" },
        ],
      }, USER),
      "VOUCHER_NOT_BALANCED",
      "漏掉进项税行",
    );
    assertEqual(db.state.voucher.length, 0, "不平衡凭证不得落库");
    assert(String(error.message).includes("11300"), "错误信息要给出借贷合计");
    return { code: error.code, message: error.message };
  });
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log("== 2026-11-09 财务治理 R2/R3 独立探针 ==");
  console.log(`dist: ${FIN}`);
  await verifyD4();
  await verifyD5();
  await verifySubjectIds();
  await verifyPartialIndex();
  await verifyReversalLinkage();
  await verifyAutoPost();
  await verifyReaccrue();
  await verifyCounterExamples();

  const passed = results.filter((item) => item.status === "PASS").length;
  const failed = results.filter((item) => item.status === "FAIL").length;
  const counterExamples = results.filter((item) => item.group === "CX-反证" && item.status === "PASS").length;
  const summary = { total: results.length, passed, failed, counterExamples };
  console.log("== summary ==");
  console.log(`PASS ${passed} / FAIL ${failed} / TOTAL ${results.length}（反证 PASS ${counterExamples}/2）`);

  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2), "utf8");
  console.log(`results.json: ${RESULTS_JSON}`);

  if (failed > 0 || counterExamples < 2) process.exitCode = 1;
}

await main();
