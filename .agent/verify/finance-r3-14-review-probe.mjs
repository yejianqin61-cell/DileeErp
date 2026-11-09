/**
 * R3-14 报表口径独立复核探针（2026-11-09，task-30）。
 *
 * 只读复核，不写业务代码：加载 `apps/api/dist`（13:36 构建，晚于全部 src），用**手写 Prisma 替身**
 * 跑真实 service / 内核，逐条断言：
 *   A. 科目 id 归集对齐：写入端（VoucherService.createAccrual）只落 subject_id；读取端
 *      （FinanceThreeStatementsService + 报表内核）一条分录只产一个键；期初 label 键只解析一次；
 *      同一凭证同时有 subject_id 与 subject_label 时不会进两个桶；报表取数不写库。
 *   B. 进项税拆分后的归行：三行挂账（借 管理费用 net / 借 应交税费-进项税 tax / 贷 应付账款 total）
 *      在资产负债表归「应交税费」负债行（借方余额 → 负数冲减）、利润表只吃净额、勾稽仍平；
 *      报表方向来自行 `side` 而非 `balanceDirection`（不翻号）。
 *   C. D4 全额核销对报表/台账金额口径：D4 门禁（核销额=未核销余额、付款额=核销合计）；
 *      台账 paid/outstanding/status 刷新逻辑；报表应付/应收=挂账凭证−付款凭证（账面余额），
 *      与 D4 自洽（结清后报表余额为 0）。
 *
 * 运行：node .agent/verify/finance-r3-14-review-probe.mjs
 * 产物：.agent/verify/finance-r3-14-review-results.json
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist");
const FIN = path.join(DIST, "modules", "finance");
const SRC = path.join(REPO_ROOT, "apps", "api", "src", "modules", "finance");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "finance-r3-14-review-results.json");

require("reflect-metadata");
const { Prisma } = require("@prisma/client");
const kernel = require(path.join(FIN, "finance-three-statements.js"));
const { VoucherService, SOURCE_PAYABLE } = require(path.join(FIN, "voucher.service.js"));
const { SupplierPayableService } = require(path.join(FIN, "supplier-payable.service.js"));
const { FinanceThreeStatementsService } = require(path.join(FIN, "finance-three-statements.service.js"));

const USER = { id: "probe-user", username: "probe" };
const D = (v) => new Prisma.Decimal(String(v));
const yuan = (units) => (units === null || units === undefined ? null : Number(units) / 10000);

/* ------------------------------------------------------------------ 断言/结果 */

class AssertionError extends Error {}
const results = [];
let currentGroup = "";
function group(name) { currentGroup = name; }
function assert(c, m) { if (!c) throw new AssertionError(m); }
function eq(a, b, m) { if (a !== b) throw new AssertionError(`${m}（expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}）`); }
function deepEq(a, b, m) { const l = JSON.stringify(a); const r = JSON.stringify(b); if (l !== r) throw new AssertionError(`${m}\n expected=${r}\n actual  =${l}`); }

/** 同时兼容 check(id, title, fn) 与 check("id 标题", fn)。 */
async function check(idOrTitle, maybeTitle, maybeFn) {
  let id; let title; let fn;
  if (typeof maybeTitle === "function") {
    fn = maybeTitle; title = idOrTitle;
    const match = /^([A-Z]\d{1,2})\s+/.exec(idOrTitle);
    id = match ? match[1] : idOrTitle.slice(0, 12);
  } else { id = idOrTitle; title = maybeTitle; fn = maybeFn; }
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, title, status: "PASS", detail: detail ?? null });
    console.log(`[PASS] ${id} ${title}`);
  } catch (error) {
    results.push({ id, group: currentGroup, title, status: "FAIL", detail: { message: error.message } });
    console.log(`[FAIL] ${id} ${title}\n       ${String(error.message).split("\n").join("\n       ")}`);
  }
}

/* ------------------------------------------------------------------ 手写 Prisma 替身 */

const MODELS = ["accountingSubject", "voucher", "voucherLine", "bank", "cashFlowEntry", "supplierPayableEntry", "supplierPaymentAllocation", "auditEvent"];
const clone = (row) => ({ ...row });
const stateOf = (seed) => Object.fromEntries(MODELS.map((m) => [m, (seed[m] ?? []).map(clone)]));

function matchField(value, cond) {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return new Date(value).getTime() === cond.getTime();
  if (typeof cond === "object" && cond !== null) {
    if ("in" in cond) return (cond.in ?? []).some((v) => matchField(value, v));
    if ("not" in cond) return !matchField(value, cond.not);
    if ("startsWith" in cond) return typeof value === "string" && value.startsWith(cond.startsWith);
    if ("lte" in cond) return new Date(value).getTime() <= new Date(cond.lte).getTime();
    if ("gte" in cond) return new Date(value).getTime() >= new Date(cond.gte).getTime();
    if (Object.keys(cond).length === 0) return true;
    return false; // 关系过滤：本探针另行处理（见 aggregate / 覆盖边界）
  }
  return value === cond;
}
function matches(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => (k === "OR" ? cond.some((b) => matches(row, b)) : matchField(row[k], cond)));
}

let seq = 0;
function linesOf(state, voucherId) {
  return state.voucherLine.filter((line) => line.voucherId === voucherId).sort((a, b) => a.lineNo - b.lineNo).map(clone);
}
function makeDb(seed = {}) {
  const state = stateOf(seed);
  const calls = [];
  const txCount = { value: 0 };
  const record = (m, method, args) => calls.push({ model: m, method, args });

  const db = { state, calls, txCount };
  for (const model of MODELS) {
    const isVoucher = model === "voucher";
    db[model] = {
      findFirst: async (args = {}) => {
        record(model, "findFirst", args);
        const row = state[model].find((item) => matches(item, args.where));
        if (!row) return null;
        return isVoucher ? { ...clone(row), lines: linesOf(state, row.id) } : clone(row);
      },
      findMany: async (args = {}) => {
        record(model, "findMany", args);
        return state[model]
          .filter((item) => matches(item, args.where ?? {}))
          .map((row) => (isVoucher ? { ...clone(row), lines: linesOf(state, row.id) } : clone(row)));
      },
      create: async (args = {}) => {
        record(model, "create", args);
        const row = { id: args.data?.id ?? `${model}-${++seq}`, ...args.data };
        state[model].push(row);
        return clone(row);
      },
      update: async (args = {}) => {
        record(model, "update", args);
        const row = state[model].find((item) => matches(item, args.where));
        if (!row) throw new Error(`[fake] ${model}.update 未命中`);
        Object.assign(row, args.data);
        return clone(row);
      },
      updateMany: async (args = {}) => {
        record(model, "updateMany", args);
        const rows = state[model].filter((item) => matches(item, args.where ?? {}));
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      },
      deleteMany: async (args = {}) => {
        record(model, "deleteMany", args);
        const before = state[model].length;
        state[model] = state[model].filter((item) => !matches(item, args.where));
        return { count: before - state[model].length };
      },
      createMany: async (args = {}) => {
        record(model, "createMany", args);
        const rows = (Array.isArray(args.data) ? args.data : [args.data]).map((data) => ({ id: data.id ?? `${model}-${++seq}`, ...data }));
        state[model].push(...rows);
        return { count: rows.length };
      },
      count: async (args = {}) => {
        record(model, "count", args);
        return state[model].filter((item) => matches(item, args.where ?? {})).length;
      },
      aggregate: async (args = {}) => {
        record(model, "aggregate", args);
        if (model === "supplierPaymentAllocation") {
          const where = { ...(args.where ?? {}) };
          const wantedPaymentStatus = where.payment?.status;
          delete where.payment; // 关系过滤单独判：种子行自带嵌套 payment
          const sum = state[model]
            .filter((row) => matches(row, where) && (!wantedPaymentStatus || row.payment?.status === wantedPaymentStatus))
            .reduce((acc, row) => acc.plus(new Prisma.Decimal(row.amount)), new Prisma.Decimal(0));
          return { _sum: { amount: sum.toString() } };
        }
        return { _sum: { amount: "0" }, _count: { _all: 0 } };
      },
    };
  }
  db.$queryRaw = async () => [];
  db.$executeRaw = async () => 0;
  db.$transaction = async (fn) => {
    if (typeof fn !== "function") return fn;
    txCount.value += 1;
    return fn(db);
  };
  return db;
}

function makeAudit() {
  const events = [];
  return {
    events,
    create: (u) => ({ createdBy: u.id, updatedBy: u.id }),
    update: (u) => ({ updatedBy: u.id }),
    softDelete: (u) => ({ deletedAt: new Date(), deletedBy: u.id, updatedBy: u.id }),
    record: async (action, entityType, actorId, entityId) => { events.push({ action, entityType, entityId }); },
    recordWithOrderNo: async (action, entityType, orderNo, actorId, entityId) => { events.push({ action, entityType, orderNo, entityId }); },
  };
}
function makeCashFlowStub() { return { reverseSourceFlowInTransaction: async () => [] }; }

const SUBJECTS = [
  { id: "sub-bank", category: "资产类", name: "银行存款", deletedAt: null, isActive: true, sortOrder: 20 },
  { id: "sub-mgmt", category: "损益类", name: "管理费用", deletedAt: null, isActive: true, sortOrder: 1030 },
  { id: "sub-raw", category: "资产类", name: "原材料", deletedAt: null, isActive: true, sortOrder: 180 },
  { id: "sub-ap", category: "负债类", name: "应付账款", deletedAt: null, isActive: true, sortOrder: 420 },
  { id: "sub-tax", category: "负债类", name: "应交税费-进项税", deletedAt: null, isActive: true, sortOrder: 520, balanceDirection: "借" },
];
const REFS = new Map(SUBJECTS.map((s) => [`@id:${s.id}`, { category: s.category, name: s.name }]));

function accrualInput(overrides = {}) {
  return {
    source_type: SOURCE_PAYABLE,
    source_id: "ap-1",
    document_no: "AP-1",
    voucher_date: "2026-11-10",
    currency: "CNY",
    amount: "113.00",
    counterparty_name: "供应商A",
    contra_subject_names: ["原材料", "主营业务成本"],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ A. 科目 id 归集对齐 */

async function blockA() {
  group("A-科目id归集");

  await check("A1 内核：一条分录同时有 subjectId 与 subjectKey 只产出一个 id 键（不进两个桶）", async () => {
    const summed = kernel.sumVoucherLines([
      { subjectKey: "损益类/管理费用", subjectId: "sub-mgmt", direction: "debit", amount: "100.00" },
      { subjectKey: "损益类/管理费用", subjectId: "sub-mgmt", direction: "debit", amount: "50.00" },
    ]);
    eq(summed.size, 1, "两行同 id 应合成一个桶");
    assert(summed.has("@id:sub-mgmt"), `键应为 @id:sub-mgmt，实际 ${[...summed.keys()]}`);
    eq(yuan(summed.get("@id:sub-mgmt").debit), 150, "借方累计 150（不是 300）");
    return { keys: [...summed.keys()], debit: yuan(summed.get("@id:sub-mgmt").debit) };
  });

  await check("A2 写入端：createAccrual 落库分录只写一个 subject_id（按名称解析），label 保留快照", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const vouchers = new VoucherService(db, makeAudit());
    const result = await vouchers.createAccrual(accrualInput({ amount: "100.00" }), USER, { post: true });
    const lines = db.state.voucherLine;
    eq(lines.length, 2, "两条分录");
    eq(result.status, "posted", "挂账直接过账");
    for (const line of lines) {
      assert(line.subjectId, `每行都必须落 subject_id（label=${line.subjectLabel}）`);
      assert(line.subjectLabel, "label 快照必须保留（渲染/兜底用）");
    }
    deepEq(lines.map((l) => l.subjectId), ["sub-raw", "sub-ap"], "借方=原材料 id、贷方=应付账款 id（按名称唯一解析）");
    deepEq(lines.map((l) => l.businessSubjectId ?? null), [null, null], "无业务科目输入时业务维度为空");
    return { voucherId: result.id, lines: lines.map((l) => ({ direction: l.direction, subjectId: l.subjectId, label: l.subjectLabel })) };
  });

  await check("A3 读取端：整链路（挂账 + 付款）三表各归集一次、金额不翻倍", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const vouchers = new VoucherService(db, makeAudit());
    await vouchers.createAccrual(accrualInput({ amount: "100.00" }), USER, { post: true });
    const pay = await vouchers.createManual({
      voucher_date: "2026-11-12",
      currency: "CNY",
      summary: "付款",
      lines: [
        { direction: "debit", subject_key: "负债类/应付账款", subject_label: "应付账款", amount: "100.00" },
        { direction: "credit", subject_key: "资产类/银行存款", subject_label: "银行存款", amount: "100.00" },
      ],
    }, USER);
    await vouchers.post(pay.id, USER); // 手工凭证默认 draft；报表只取 posted

    const statements = new FinanceThreeStatementsService(db);
    const sheet = await statements.balanceSheet({ from: "2026-11-01", to: "2026-11-30" });
    eq(yuan(sheet.current.assets.find((r) => r.row === 9).value), 100, "存货（原材料）=100，只算一次");
    eq(yuan(sheet.current.equities.find((r) => r.row === 5).value), 0, "应付账款 = 挂账100 − 付款100 = 0");
    eq(yuan(sheet.current.totalAssets), 0, "资产总计 0（存货 100 被银行付款 100 抵掉）");
    eq(sheet.current.balanced, true, "勾稽仍平");
    return { lines: db.state.voucherLine.map((l) => `${l.direction}:${l.subjectLabel}:${l.subjectId}`), totalAssets: yuan(sheet.current.totalAssets) };
  });

  await check("A4 读取端：label 被改错时仍按 subject_id 归行（证明读 id 不是读文本）", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const vouchers = new VoucherService(db, makeAudit());
    await vouchers.createAccrual(accrualInput({ amount: "100.00" }), USER, { post: true });
    const rawLine = db.state.voucherLine.find((l) => l.subjectId === "sub-raw");
    rawLine.subjectLabel = "管理费用";
    rawLine.subjectKey = "损益类/管理费用";
    const statements = new FinanceThreeStatementsService(db);
    const sheet = await statements.balanceSheet({ from: "2026-11-01", to: "2026-11-30" });
    const income = await statements.incomeStatement({ from: "2026-11-01", to: "2026-11-30" });
    eq(yuan(sheet.current.assets.find((r) => r.row === 9).value), 100, "仍按 id 归「存货」");
    eq(yuan(income.current.lines.find((r) => r.row === 5).value), 0, "不会被错 label 归到「管理费用」");
    return { stock: 100, mgmt: 0 };
  });

  await check("A5 读取端只读：生成三表期间不对 voucher / voucher_line 做任何写操作", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const vouchers = new VoucherService(db, makeAudit());
    await vouchers.createAccrual(accrualInput({ amount: "100.00" }), USER, { post: true });
    const before = db.calls.length;
    const statements = new FinanceThreeStatementsService(db);
    await statements.balanceSheet({ from: "2026-11-01", to: "2026-11-30" });
    await statements.incomeStatement({ from: "2026-11-01", to: "2026-11-30" });
    await statements.cashFlowStatement({ from: "2026-11-01", to: "2026-11-30" });
    const writes = db.calls.slice(before).filter((call) => (call.model === "voucher" || call.model === "voucherLine") && ["create", "createMany", "update", "updateMany", "deleteMany"].includes(call.method));
    deepEq(writes, [], "报表取数必须只读");
    return { queryCount: db.calls.length - before, writes: writes.length };
  });

  await check("A6 期初合并只归一次：期初 subject_key 解析成 id 键后与凭证 id 行相加（不翻倍）", async () => {
    const db = makeDb({ accountingSubject: SUBJECTS });
    const vouchers = new VoucherService(db, makeAudit());
    const incomeVoucher = await vouchers.createManual({
      voucher_date: "2026-11-12",
      currency: "CNY",
      summary: "收款",
      lines: [
        { direction: "debit", subject_key: "资产类/银行存款", subject_label: "银行存款", amount: "200.00" },
        { direction: "credit", subject_key: "损益类/主营业务收入", subject_label: "主营业务收入", amount: "200.00" },
      ],
    }, USER);
    await vouchers.post(incomeVoucher.id, USER);
    const openings = { effectiveForAll: async () => [{ currency: "CNY", asOfDate: "2026-11-01", rows: [{ subjectKey: "资产类/银行存款", direction: "debit", amount: "1000.00" }] }] };
    const statements = new FinanceThreeStatementsService(db, openings);
    const sheet = await statements.balanceSheet({ from: "2026-11-01", to: "2026-11-30" });
    eq(yuan(sheet.current.assets.find((r) => r.row === 1).value), 1200, "货币资金 = 期初 1000 + 凭证 200（若期初被 label+id 计两次会是 2200）");
    const cash = await statements.cashFlowStatement({ from: "2026-11-01", to: "2026-11-30" });
    eq(yuan(cash.cashOpening), 1000, "期初现金 1000");
    return { money: yuan(sheet.current.assets.find((r) => r.row === 1).value), cashOpening: yuan(cash.cashOpening) };
  });
}

/* ------------------------------------------------------------------ B. 进项税归行 */

async function specialInvoiceDb() {
  const db = makeDb({ accountingSubject: SUBJECTS });
  const vouchers = new VoucherService(db, makeAudit());
  await vouchers.createAccrual(accrualInput({
    amount: "113.00",
    invoice_type: "special",
    tax_rate: "0.13",
    contra_subject_id: "sub-mgmt",
    business_subject_id: "sub-mgmt",
  }), USER, { post: true });
  return db;
}

async function blockB() {
  group("B-进项税归行");

  await check("B1 写入端：专票挂账三行（net 100 / 进项税 13 / 应付 113），进项税行落负债类科目 id", async () => {
    const db = await specialInvoiceDb();
    const lines = db.state.voucherLine;
    eq(lines.length, 3, "专票三行");
    const debits = lines.filter((l) => l.direction === "debit");
    eq(debits.length, 2, "两行借方");
    const amounts = debits.map((l) => Number(String(l.amount))).sort((a, b) => a - b);
    deepEq(amounts, [13, 100], "借方 = 不含税 100 + 进项税 13");
    const tax = debits.find((l) => l.subjectId === "sub-tax");
    assert(tax, "进项税行必须落 subject_id=应交税费-进项税");
    eq(Number(String(tax.amount)), 13, "税额 = 含税 − 不含税");
    eq(tax.subjectLabel, "应交税费-进项税");
    const netLine = debits.find((l) => l.subjectId === "sub-mgmt");
    eq(netLine.businessSubjectId, "sub-mgmt", "业务科目（辅助）只挂在不含税借方行");
    eq(tax.businessSubjectId ?? null, null, "进项税行不挂业务科目");
    eq(Number(String(lines.find((l) => l.direction === "credit").amount)), 113, "贷方含税应付 113");
    return { lines: lines.map((l) => ({ dir: l.direction, subjectId: l.subjectId, label: l.subjectLabel, amount: Number(String(l.amount)), business: l.businessSubjectId ?? null })) };
  });

  await check("B2 资产负债表：进项税借方余额进「应交税费」负债行（−13），不翻成资产/费用，勾稽仍平", async () => {
    const db = await specialInvoiceDb();
    const sheet = await new FinanceThreeStatementsService(db).balanceSheet({ from: "2026-11-01", to: "2026-11-30" });
    eq(yuan(sheet.current.equities.find((r) => r.row === 9).value), -13, "应交税费行 = 贷−借 = −13（负数冲减负债）");
    eq(yuan(sheet.current.equities.find((r) => r.row === 5).value), 113, "应付账款 = 113");
    eq(yuan(sheet.current.equities.find((r) => r.row === 32).value), -100, "未分配利润 = −100（管理费用净额）");
    eq(yuan(sheet.current.totalAssets), 0, "资产 = 0（费用化支出，无存货/银行）");
    eq(yuan(sheet.current.totalEquities), 0, "负债和权益 = 113 − 13 − 100 = 0");
    eq(sheet.current.balanced, true, "勾稽平：资产 0 = 负债和权益 0");
    return { taxRow: -13, apRow: 113, retained: -100, balanced: sheet.current.balanced };
  });

  await check("B3 利润表：只吃净额 100，税额不进损益（净利 −100）", async () => {
    const db = await specialInvoiceDb();
    const income = await new FinanceThreeStatementsService(db).incomeStatement({ from: "2026-11-01", to: "2026-11-30" });
    eq(yuan(income.current.lines.find((r) => r.row === 5).value), 100, "管理费用 = 不含税 100");
    eq(yuan(income.current.lines.find((r) => r.row === 19).value), -100, "净利润 = −100（税额未进损益）");
    return { mgmt: 100, netProfit: -100 };
  });

  await check("B4 已知噪音（非 FAIL 判定，记录）：利润表 unmapped 会把负债类分录（应付/进项税）列为「未归位」", async () => {
    const db = await specialInvoiceDb();
    const income = await new FinanceThreeStatementsService(db).incomeStatement({ from: "2026-11-01", to: "2026-11-30" });
    const labels = income.current.unmapped.map((row) => row.subjectKey).sort();
    assert(labels.includes("负债类/应交税费-进项税"), `unmapped 应含进项税（实际 ${labels.join("、")}）`);
    assert(labels.includes("负债类/应付账款"), "unmapped 应含应付账款");
    // 对照：普票两行挂账（无税）同样会把应付账款列进 unmapped → 既有语义，不是拆分引入。
    const plainDb = makeDb({ accountingSubject: SUBJECTS });
    const vouchers = new VoucherService(plainDb, makeAudit());
    await vouchers.createAccrual(accrualInput({ amount: "100.00", contra_subject_id: "sub-mgmt" }), USER, { post: true });
    const plainIncome = await new FinanceThreeStatementsService(plainDb).incomeStatement({ from: "2026-11-01", to: "2026-11-30" });
    const plainLabels = plainIncome.current.unmapped.map((row) => row.subjectKey);
    assert(plainLabels.some((l) => l.includes("应付账款")), "两行无税凭证也列应付账款 → 既有语义");
    return { taxedUnmapped: labels, plainUnmapped: plainLabels };
  });

  await check("B5 方向来源：报表按行 side（负债行=贷−借）而非 balanceDirection；负债类借方余额 → 负值不翻号", async () => {
    for (const file of ["finance-three-statements.ts", "finance-three-statements.service.ts"]) {
      const text = fs.readFileSync(path.join(SRC, file), "utf8");
      assert(!/balanceDirection|balance_direction/.test(text), `${file} 不应读取 balanceDirection`);
    }
    const db = await specialInvoiceDb();
    const sheet = await new FinanceThreeStatementsService(db).balanceSheet({ from: "2026-11-01", to: "2026-11-30" });
    const taxRow = sheet.current.equities.find((r) => r.row === 9).value;
    assert(taxRow < 0n, "负债类借方余额应表现为负数（−13），不是 +13、也没有被挪到资产/费用行");
    return { taxRow: yuan(taxRow) };
  });

  await check("B6 现金流量表：挂账凭证无资金分录 → 不计入（nonCash=1），不因三行而多计", async () => {
    const db = await specialInvoiceDb();
    const cash = await new FinanceThreeStatementsService(db).cashFlowStatement({ from: "2026-11-01", to: "2026-11-30" });
    eq(cash.current.nonCashVouchers, 1, "无资金分录凭证计 1 张");
    eq(yuan(cash.current.netIncrease), 0, "现金流量净增加 0");
    return { nonCash: 1, net: 0 };
  });
}

/* ------------------------------------------------------------------ C. D4 对报表/台账口径 */

async function blockC() {
  group("C-D4口径");

  await check("C1 D4 门禁：应付/应收核销额必须=未核销余额、付款额必须=核销合计", async () => {
    const payable = fs.readFileSync(path.join(SRC, "supplier-payment.service.ts"), "utf8");
    const receivable = fs.readFileSync(path.join(SRC, "customer-payment.service.ts"), "utf8");
    for (const code of ["ALLOCATION_MUST_SETTLE_PAYABLE", "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION"]) {
      assert(payable.includes(code), `supplier-payment.service.ts 缺少 ${code}`);
    }
    for (const code of ["ALLOCATION_MUST_SETTLE_RECEIVABLE", "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION"]) {
      assert(receivable.includes(code), `customer-payment.service.ts 缺少 ${code}`);
    }
    assert(/amount\.eq\(balance\.available\)/.test(payable), "应付核销额 = available");
    assert(/total\.eq\(lockedPayment\.amount\)/.test(payable), "付款额 = 核销合计");
    return { payable: ["ALLOCATION_MUST_SETTLE_PAYABLE", "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION"], receivable: ["ALLOCATION_MUST_SETTLE_RECEIVABLE", "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION"] };
  });

  await check("C2 台账口径：paid=有效已过账核销合计，outstanding=amount−paid，结清后 status=paid", async () => {
    const db = makeDb({
      supplierPayableEntry: [{ id: "ap-c2", amount: D("100.00"), status: "confirmed", deletedAt: null, remark: "" }],
      supplierPaymentAllocation: [{ id: "a1", payableEntryId: "ap-c2", amount: "100.00", status: "active", deletedAt: null, payment: { status: "posted" } }],
    });
    const service = new SupplierPayableService(db, makeAudit(), makeCashFlowStub());
    const paid = await service.refreshStatus(db, "ap-c2", USER);
    eq(paid.status, "paid", "全额核销后状态 paid");
    const balance = await service.allocationBalance("ap-c2", db);
    eq(Number(String(balance.allocated)), 100, "已核销 100");
    eq(Number(String(balance.available)), 0, "未核销余额 0");
    return { status: "paid", allocated: 100, available: 0 };
  });

  await check("C3 历史 partially_paid：按剩余 70 全额结清 → 100/0/paid（不要求等于原单据金额）", async () => {
    const db = makeDb({
      supplierPayableEntry: [{ id: "ap-c3", amount: D("100.00"), status: "partially_paid", deletedAt: null, remark: "" }],
      supplierPaymentAllocation: [{ id: "a0", payableEntryId: "ap-c3", amount: "30.00", status: "active", deletedAt: null, payment: { status: "posted" } }],
    });
    const service = new SupplierPayableService(db, makeAudit(), makeCashFlowStub());
    const before = await service.allocationBalance("ap-c3", db);
    eq(Number(String(before.available)), 70, "历史部分付款：还剩 70");
    db.state.supplierPaymentAllocation.push({ id: "a1", payableEntryId: "ap-c3", amount: "70.00", status: "active", deletedAt: null, payment: { status: "posted" } });
    const after = await service.refreshStatus(db, "ap-c3", USER);
    eq(after.status, "paid", "结清后 paid");
    const balance = await service.allocationBalance("ap-c3", db);
    eq(Number(String(balance.available)), 0, "outstanding=0");
    return { availableBefore: 70, availableAfter: 0, statusAfter: after.status };
  });

  await check("C4 报表口径（凭证余额，非台账）：挂账 113 + 付款 113 → 应付账款余额 0，勾稽平", async () => {
    const balances = kernel.sumVoucherLines([
      { subjectKey: "损益类/管理费用", subjectId: "sub-mgmt", direction: "debit", amount: "100.00" },
      { subjectKey: "负债类/应交税费-进项税", subjectId: "sub-tax", direction: "debit", amount: "13.00" },
      { subjectKey: "负债类/应付账款", subjectId: "sub-ap", direction: "credit", amount: "113.00" },
      { subjectKey: "负债类/应付账款", subjectId: "sub-ap", direction: "debit", amount: "113.00" },
      { subjectKey: "资产类/银行存款", subjectId: "sub-bank", direction: "credit", amount: "113.00" },
    ]);
    const sheet = kernel.buildBalanceSheet({ balances, subjectRefs: REFS });
    eq(yuan(sheet.equities.find((r) => r.row === 5).value), 0, "应付账款余额 0（挂账 − 付款）");
    eq(yuan(sheet.equities.find((r) => r.row === 9).value), -13, "应交税费 −13（进项税留抵）");
    eq(yuan(sheet.assets.find((r) => r.row === 1).value), -113, "货币资金 −113");
    eq(yuan(sheet.equities.find((r) => r.row === 32).value), -100, "未分配利润 −100");
    eq(sheet.balanced, true, "资产 = 负债和权益");
    return { ap: 0, tax: -13, bank: -113, retained: -100, balanced: true };
  });

  await check("C5 报表与台账自洽性：报表 AP 余额 ≡ 台账 outstanding 的前提（总额法 + 凭证已过账）", async () => {
    const db = makeDb({
      supplierPayableEntry: [{ id: "ap-c5", amount: D("100.00"), status: "confirmed", deletedAt: null, remark: "" }],
      supplierPaymentAllocation: [],
    });
    const service = new SupplierPayableService(db, makeAudit(), makeCashFlowStub());
    const b0 = await service.allocationBalance("ap-c5", db);
    eq(Number(String(b0.available)), 100, "未付款：台账 outstanding=100，与报表挂账 100 一致");
    db.state.supplierPaymentAllocation.push({ id: "x", payableEntryId: "ap-c5", amount: "100.00", status: "active", deletedAt: null, payment: { status: "posted" } });
    const b1 = await service.allocationBalance("ap-c5", db);
    eq(Number(String(b1.available)), 0, "结清后台账 outstanding=0；报表侧同样 0（C4）");
    return { before: Number(String(b0.available)), after: Number(String(b1.available)), caveat: "历史付款缺 posted 凭证时两侧会分叉（R4 数据盘点）" };
  });
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log("== R3-14 report caliber independent review probe ==");
  await blockA();
  await blockB();
  await blockC();
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("== summary ==");
  console.log(`PASS ${passed} / FAIL ${failed} / TOTAL ${results.length}`);
  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), summary: { total: results.length, passed, failed }, results }, null, 2), "utf8");
  console.log(`results.json: ${RESULTS_JSON}`);
  if (failed) process.exitCode = 1;
}

await main();
