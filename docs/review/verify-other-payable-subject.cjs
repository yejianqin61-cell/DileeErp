/**
 * 独立对抗性复核脚本（verifier-api，2026-10-12）。
 *
 * 只做两件事，都用**真实 dist 代码**跑，不碰 src / test：
 *   A. 「确认应付」两条入口（逐条 confirm / 勾选 batchConfirm）在条目自己填过科目时，
 *      挂账用的对方科目到底取的是谁 —— 条目科目，还是按来源类型的候选链？
 *   B. 采购对账明细的「费用说明」取值在反例输入下的表现。
 *
 * 跑法：node docs/review/verify-other-payable-subject.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(ROOT, "apps", "api", "dist", "modules", "finance");
const { SupplierPayableService } = require(path.join(DIST, "supplier-payable.service.js"));
const { FinanceReportQueryService } = require(path.join(DIST, "finance-report-query.service.js"));
const { Prisma } = require("@prisma/client");

const results = [];
const record = (label, ok, detail) => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
};
/** 只记录观察，不参与通过/失败判定（例如「口径如此、但值得写进报告」的行为）。 */
const note = (label, detail) => console.log(`INFO  ${label}${detail ? `\n      ${detail}` : ""}`);

const USER = { id: "user-1" };
const auditStub = () => ({
  update: () => ({ updatedBy: "user-1" }),
  recordWithOrderNo: async () => {},
  record: async () => {},
});
const cashFlowStub = () => ({ requireSubject: async () => null, recordConfirmation: async () => null });

/* ------------------------------------------------------------------ A. 确认应付挂账科目 */

function confirmHarness(entry) {
  const accrualCalls = [];
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => entry,
      update: async ({ data }) => ({ ...entry, ...data }),
    },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry }),
  };
  const vouchers = {
    createAccrual: async (input) => { accrualCalls.push(input); return { id: "voucher-1", replayed: false }; },
  };
  return { service: new SupplierPayableService(prisma, auditStub(), cashFlowStub(), undefined, vouchers), accrualCalls };
}

function batchHarness(rows) {
  const accrualCalls = [];
  let findManyArgs = null;
  const entryTable = {
    findMany: async (args) => { findManyArgs = args; return rows.filter((row) => args.where.id.in.includes(row.id) && row.status === "draft"); },
    updateMany: async ({ where }) => ({ count: rows.filter((row) => where.id.in.includes(row.id) && row.status === "draft").length }),
  };
  const prisma = {
    supplierPayableEntry: entryTable,
    $transaction: async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: entryTable }),
  };
  const vouchers = {
    createAccrual: async (input) => { accrualCalls.push(input); return { id: `voucher-${accrualCalls.length}`, replayed: false }; },
  };
  return { service: new SupplierPayableService(prisma, auditStub(), cashFlowStub(), undefined, vouchers), accrualCalls, select: () => findManyArgs?.select };
}

const allowance = {
  id: "payable-allowance",
  payableNo: "APO-1",
  status: "draft",
  orderNo: null,
  supplierId: "supplier-1",
  amount: new Prisma.Decimal("485"),
  currency: "CNY",
  sourceType: "other",
  // 建单/导入时手选的科目（2026-10-12 新增的那一列）
  subjectId: "subject-allowance",
  supplier: { name: "周金红" },
  payableSource: null,
  outsourcePayableSource: null,
};

(async () => {
  {
    // 前端 confirmEntry 的科目字段是 subjectEditField("会计科目")（没有 defaultValue）
    // → 财务不重新选一遍就是 subject_id: undefined。
    const { service, accrualCalls } = confirmHarness({ ...allowance });
    await service.confirm("payable-allowance", USER, {});
    const call = accrualCalls[0];
    record(
      "A1 逐条确认（弹窗未重选科目）：挂账对方科目应取条目自己的科目 subject-allowance",
      call?.contra_subject_id === "subject-allowance",
      `实际 contra_subject_id=${JSON.stringify(call?.contra_subject_id)}，contra_subject_names=${JSON.stringify(call?.contra_subject_names)}`,
    );
  }
  {
    const { service, accrualCalls } = confirmHarness({ ...allowance, subjectId: null });
    await service.confirm("payable-allowance", USER, {});
    const call = accrualCalls[0];
    record(
      "A2 逐条确认（条目本来就没科目）：应退回候选链，contra_subject_id 为空",
      call?.contra_subject_id === undefined && call?.contra_subject_names?.[0] === "管理费用",
      `实际 contra_subject_id=${JSON.stringify(call?.contra_subject_id)}，contra_subject_names=${JSON.stringify(call?.contra_subject_names)}`,
    );
  }
  {
    const h = batchHarness([{ ...allowance, status: "draft" }]);
    await h.service.batchConfirm(["payable-allowance"], USER, {});
    const call = h.accrualCalls[0];
    record(
      "A3 勾选批量确认：挂账对方科目应取条目自己的科目 subject-allowance",
      call?.contra_subject_id === "subject-allowance",
      `实际 contra_subject_id=${JSON.stringify(call?.contra_subject_id)}，contra_subject_names=${JSON.stringify(call?.contra_subject_names)}`,
    );
    record(
      "A4 勾选批量确认 findMany 的 select 里有没有 subjectId（没读就不可能用条目科目）",
      Boolean(h.select() && h.select().subjectId),
      `select = ${JSON.stringify(h.select())}`,
    );
  }

  /* ------------------------------------------------------------------ B. 费用说明反例 */

  const stubReportPrisma = (rows) => ({
    supplierPayableEntry: {
      findMany: async () => rows,
      count: async () => 0,
    },
  });
  const otherRow = (extra) => ({
    sourceType: "other",
    sourceNoSnapshot: "其他应付-备用金",
    orderNo: null,
    remark: null,
    currency: "CNY",
    unitPrice: new Prisma.Decimal("1"),
    quantity: new Prisma.Decimal("1"),
    amount: new Prisma.Decimal("1"),
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    supplier: { name: "周金红" },
    subject: null,
    purchaseOrder: null,
    payableSource: null,
    outsourcePayableSource: null,
    ...extra,
  });
  const descriptionOf = async (row) => {
    const result = await new FinanceReportQueryService(stubReportPrisma([row])).purchaseReconciliationDetail({});
    return result.rows[0].otherDescription;
  };

  const cases = [
    ["B1 说明里本身含「-」（其他应付-周金红-备用金）", await descriptionOf(otherRow({ sourceNoSnapshot: "其他应付-周金红-备用金" })), "周金红-备用金"],
    ["B2 说明以「-」开头（其他应付--备用金）", await descriptionOf(otherRow({ sourceNoSnapshot: "其他应付--备用金" })), "-备用金"],
    ["B3 快照为空串（其他应付-）+ 备注有值", await descriptionOf(otherRow({ sourceNoSnapshot: "其他应付-", remark: "银行转账" })), "银行转账"],
    ["B4 快照为 null + 备注为 null", await descriptionOf(otherRow({ sourceNoSnapshot: null, remark: null })), null],
    ["B5 快照前后有空格（其他应付-  备用金  ）", await descriptionOf(otherRow({ sourceNoSnapshot: "其他应付-  备用金  " })), "备用金"],
    ["B6 破折号分隔（其他应付—备用金）", await descriptionOf(otherRow({ sourceNoSnapshot: "其他应付—备用金" })), "备用金"],
    ["B8 采购行即使快照是「其他应付-」也必须是 null", await descriptionOf(otherRow({ sourceType: "raw_material_inbound", sourceNoSnapshot: "其他应付-xx" })), null],
  ];
  for (const [label, actual, expected] of cases) {
    record(`${label} → 期望 ${JSON.stringify(expected)}`, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
  }
  note(
    "B7 快照没有分隔符（历史/异常：其他应付备用金）",
    `实际 ${JSON.stringify(await descriptionOf(otherRow({ sourceNoSnapshot: "其他应付备用金" })))} —— 前缀认不出时整串原样落到「费用说明」，不报错也不留空`,
  );

  {
    const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十壹"; // 31 字
    const snapshot = `其他应付-${long.slice(0, 30)}`;
    const actual = await descriptionOf(otherRow({ sourceNoSnapshot: snapshot }));
    record(
      "B9 说明超过 30 字：落库时就截断，报表如实转述（不还原全文）",
      actual === long.slice(0, 30),
      `落库快照 ${JSON.stringify(snapshot)} → 报表 ${JSON.stringify(actual)}（原文 31 字，财务看不到最后 1 字）`,
    );
  }

  {
    const prisma = stubReportPrisma([otherRow({}), otherRow({ sourceType: "raw_material_inbound", sourceNoSnapshot: "原料入库-1" })]);
    const result = await new FinanceReportQueryService(prisma).purchaseReconciliationDetail({});
    record(
      "B10 purchaseRowCount + otherRowCount === rows.length，且 sourceType 不泄漏进报表行",
      result.purchaseRowCount + result.otherRowCount === result.rows.length
        && result.rows.every((row) => !("sourceType" in row)),
      `purchaseRowCount=${result.purchaseRowCount} otherRowCount=${result.otherRowCount} rows.length=${result.rows.length} keys=${JSON.stringify(Object.keys(result.rows[0]))}`,
    );
  }

  /* ------------------------------------------------------- C. 应付台账 subject_name 与候选链 */

  const ledgerRow = (extra) => ({
    id: "p1", payableNo: "APO-1", orderNo: null, supplierId: "supplier-1",
    amount: new Prisma.Decimal("485"), currency: "CNY", sourceType: "other",
    sourceNoSnapshot: "其他应付-备用金", subjectId: null, status: "draft",
    quantity: new Prisma.Decimal("1"), unitPrice: new Prisma.Decimal("485"), taxRate: new Prisma.Decimal("0"),
    attachment: [], remark: null, confirmationDate: new Date("2026-09-16T00:00:00.000Z"),
    createdAt: new Date("2026-09-16T00:00:00.000Z"), updatedAt: new Date("2026-09-16T00:00:00.000Z"),
    createdBy: "user-1", updatedBy: "user-1", deletedAt: null, deletedBy: null,
    payableSourceId: null, outsourcePayableSourceId: null, purchaseOrderId: null, purchaseOrderItemId: null,
    outsourceLogisticsBatchId: null,
    supplier: { id: "supplier-1", name: "周金红", supplierCode: "SUP-1" },
    subject: null, allocations: [], payableSource: null, outsourcePayableSource: null,
    ...extra,
  });
  const ledgerHarness = (rows) => {
    const prisma = {
      supplierPayableEntry: { findMany: async () => rows },
      supplierPayableReconciliation: { findMany: async () => [] },
    };
    return new SupplierPayableService(prisma, auditStub(), cashFlowStub());
  };
  {
    const rows = await ledgerHarness([
      ledgerRow({ subject: { category: "资产类", name: "库存现金（备用金）" }, subjectId: "subject-allowance" }),
      ledgerRow({ payableNo: "APO-2", sourceType: "raw_material_inbound", sourceNoSnapshot: "原料入库-1" }),
    ]).list(undefined, undefined, undefined, {});
    record(
      "C1 应付台账 subject_name：条目手选科目优先，采购行按来源候选链首位",
      rows[0].subject_name === "资产类 / 库存现金（备用金）" && rows[1].subject_name === "损益类 / 主营业务成本",
      `column1=${JSON.stringify(rows[0].subject_name)} column2=${JSON.stringify(rows[1].subject_name)}`,
    );
  }
  {
    const catalog = require(path.join(DIST, "accounting-subject-catalog.js"));
    const chains = {
      raw_material_inbound: catalog.paymentSubjectNames("raw_material_inbound")[0],
      outsource_receipt: catalog.paymentSubjectNames("outsource_receipt")[0],
      other: catalog.paymentSubjectNames("other")[0],
      unknown_source: catalog.paymentSubjectNames("不存在的来源")[0],
    };
    const labels = Object.fromEntries(Object.entries(chains).map(([key, name]) => [key, `${name} → ${catalog.catalogSubjectLabel(name)}`]));
    record(
      "C2 候选链首位 + catalogSubjectLabel 的分类（台账会显示的「确认时会写入的科目」）",
      labels.other === "管理费用 → 损益类 / 管理费用"
        && labels.raw_material_inbound === "主营业务成本 → 损益类 / 主营业务成本"
        && labels.outsource_receipt === "加工费 → 成本类 / 加工费",
      JSON.stringify(labels),
    );
    const byName = new Map();
    for (const seed of catalog.ACCOUNTING_SUBJECT_SEEDS) byName.set(seed.name, (byName.get(seed.name) ?? 0) + 1);
    const duplicated = [...byName.entries()].filter(([, count]) => count > 1);
    record(
      "C3 种入科目表里名称唯一（重名会让导入按行报「重名」、台账/付款单的候选链首位变得不确定）",
      duplicated.length === 0,
      duplicated.length ? `重名科目：${JSON.stringify(duplicated)}` : `共 ${byName.size} 个唯一名称`,
    );
  }

  /* ------------------------------------------------- D. 列序/合计列的独立清点 + 跨币种 */

  {
    const tables = require(path.join(DIST, "finance-report.tables.js"));
    const columns = tables.PURCHASE_RECONCILIATION_DETAIL_COLUMNS;
    const headers = columns.map((column) => column.header);
    const totalRow = (currency, amount) => ({
      date: new Date("2026-09-08T00:00:00.000Z"), orderNo: null, purchaseOrderNo: null,
      otherDescription: null, subjectName: null, supplierName: "碧江", productName: null,
      materialCode: null, specification: null, unit: null, currency,
      unitPrice: new Prisma.Decimal(amount), quantity: new Prisma.Decimal("1"),
      amount: new Prisma.Decimal(amount),
    });
    const table = tables.buildPurchaseReconciliationDetailTable(
      [totalRow("CNY", "1000"), totalRow("USD", "500")],
      { currencyLabels: new Map([["CNY", "人民币"], ["USD", "美元"]]), purchaseRowCount: 2, otherRowCount: 0 },
    );
    record(
      "D1 逐列清点：19 列；4=费用说明、16=会计科目、17=金额、18=含税金额，金额仍是最后两列",
      headers.length === 19
        && headers[3] === "采购单号" && headers[4] === "费用说明"
        && headers[16] === "会计科目" && headers[17] === "金额" && headers[18] === "含税金额"
        && JSON.stringify(table.totalColumns) === "[17,18]",
      `headers=${JSON.stringify(headers)} totalColumns=${JSON.stringify(table.totalColumns)}`,
    );
    const totals = tables.reportTotalRow(table);
    note(
      "D2 跨币种：本表只有一组 totalColumns，没有按币种分段/不加说明",
      `CNY 1000 + USD 500 的合计行 = ${JSON.stringify(totals?.[17])}（金额列）—— 与同文件 sales-reconciliation-detail 的 :638/:723 「不跨币种相加」口径不一致；本次改动之前就是这样，不是本轮引入`,
    );
  }

  /* ------------------------------------- E. 对账单确认路径（对照组：这条路径是对的） */

  {
    const { SupplierPayableReconciliationService } = require(path.join(DIST, "supplier-payable-reconciliation.service.js"));
    const reconHarness = (entry) => {
      const accrualCalls = [];
      const current = {
        id: "recon-1", status: "matched", reconciliationNo: "APREC-1", supplierId: "supplier-1",
        supplier: { id: "supplier-1", name: "周金红" }, orderNo: null, purchaseOrderId: null,
        currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"),
        bankId: null, subjectId: null,
      };
      const tx = {
        $queryRaw: async () => [],
        supplierPayableReconciliation: {
          findFirst: async () => current,
          update: async ({ data }) => ({ ...current, ...data }),
        },
        supplierPayableEntry: {
          findMany: async () => [entry],
          update: async () => entry,
        },
      };
      const prisma = { ...tx, $transaction: async (fn) => fn(tx) };
      const vouchers = { createAccrual: async (input) => { accrualCalls.push(input); return { id: "voucher-1", replayed: false }; } };
      return { service: new SupplierPayableReconciliationService(prisma, auditStub(), cashFlowStub(), undefined, vouchers), accrualCalls };
    };
    const reconEntry = {
      id: "payable-allowance", payableNo: "APO-1", orderNo: null, amount: new Prisma.Decimal("485"),
      currency: "CNY", sourceType: "other", subjectId: "subject-allowance", status: "draft",
      payableSource: null, outsourcePayableSource: null,
    };
    const withEntrySubject = reconHarness({ ...reconEntry });
    await withEntrySubject.service.confirmPayables("recon-1", USER, {});
    record(
      "E1 按对账单确认应付：条目自己的科目生效（对照组，实现是对的）",
      withEntrySubject.accrualCalls[0]?.contra_subject_id === "subject-allowance",
      `contra_subject_id=${JSON.stringify(withEntrySubject.accrualCalls[0]?.contra_subject_id)}`,
    );
    const bothSet = reconHarness({ ...reconEntry });
    await bothSet.service.confirmPayables("recon-1", USER, { subject_id: "subject-dialog" });
    note(
      "E2 条目科目与弹窗科目同时存在时的取舍（文档写的「条目优先」）",
      `contra_subject_id=${JSON.stringify(bothSet.accrualCalls[0]?.contra_subject_id)} —— 与 design 文档 :113 的优先级一致`,
    );
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n=== ${results.length} 项断言，失败 ${failed.length} 项 ===`);
  for (const item of failed) console.log(`FAILED: ${item.label}\n  ${item.detail}`);
  process.exitCode = failed.length ? 1 : 0;
})();
