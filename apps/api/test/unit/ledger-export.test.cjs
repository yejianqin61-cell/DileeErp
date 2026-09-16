// 「确认应收 / 确认应付」的筛选口径与导出工作簿。
//
// 两组断言都是**用户明确要求**的落地防线：
//   ①「如果是已付或者已收款，那个条目就不要出现在那里了」+「按已付未付、已收未收筛选」+「按时间范围筛选」
//      → ledger-filter.ts 的分档与区间口径（应收/应付共用）；
//   ②「两处表单要支持导出 excel」→ 导出的金额/数量必须是 **Excel 数值类型**
//      （文本型数字在 Excel 里 SUM 得 0、筛选分不出数值区间，见 finance-report-workbook.ts 顶部说明）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const {
  PAID_LEDGER_STATUSES, ledgerDateText, matchesLedgerFilter, paymentBucket, paymentCounts,
} = require("../../dist/modules/finance/ledger-filter.js");
const {
  buildPayableLedgerTable, buildReceivableLedgerTable, payablePaymentText, receivablePaymentText,
} = require("../../dist/modules/finance/ledger-workbook.js");
const { renderReportWorkbook } = require("../../dist/modules/finance/finance-report-workbook.js");

// --------------------------------------------------------------------------
// 一、筛选口径
// --------------------------------------------------------------------------

test("付款分档：草稿=未付；已确认及以后=已付；冲销/作废/取消只在「全部」里出现", () => {
  assert.equal(paymentBucket("draft"), "unpaid");
  for (const status of PAID_LEDGER_STATUSES) assert.equal(paymentBucket(status), "paid");
  for (const status of ["reversed", "voided", "cancelled", "closed"]) assert.equal(paymentBucket(status), "void");
});

test("默认（不传 payment）不过滤状态：导出「全部」时不能把冲销的行也丢掉", () => {
  assert.equal(matchesLedgerFilter({ status: "reversed", date: null, search: [] }), true);
  assert.equal(matchesLedgerFilter({ status: "reversed", date: null, search: [] }, { payment: "all" }), true);
});

test("筛选：未付只留草稿，已付只留已确认及以后", () => {
  const rows = [{ status: "draft" }, { status: "confirmed" }, { status: "paid" }, { status: "reversed" }];
  const pick = (payment) => rows.filter((row) => matchesLedgerFilter({ ...row, date: null, search: [] }, { payment })).map((row) => row.status);
  assert.deepEqual(pick("unpaid"), ["draft"]);
  assert.deepEqual(pick("paid"), ["confirmed", "paid"]);
  assert.deepEqual(pick("all"), ["draft", "confirmed", "paid", "reversed"]);
});

test("时间范围含两端；没有日期的行在设了区间时不算命中（不能证明落在区间内就不列）", () => {
  const row = (date) => ({ status: "draft", date, search: [] });
  assert.equal(matchesLedgerFilter(row("2026-09-10T00:00:00.000Z"), { from: "2026-09-01", to: "2026-09-30" }), true);
  assert.equal(matchesLedgerFilter(row("2026-09-01T00:00:00.000Z"), { from: "2026-09-01", to: "2026-09-30" }), true, "起始日当天算命中");
  assert.equal(matchesLedgerFilter(row("2026-09-30T00:00:00.000Z"), { from: "2026-09-01", to: "2026-09-30" }), true, "结束日当天算命中");
  assert.equal(matchesLedgerFilter(row("2026-08-31T00:00:00.000Z"), { from: "2026-09-01" }), false);
  assert.equal(matchesLedgerFilter(row("2026-10-01T00:00:00.000Z"), { to: "2026-09-30" }), false);
  assert.equal(matchesLedgerFilter(row(null), { from: "2026-09-01" }), false);
  assert.equal(matchesLedgerFilter(row(null), {}), true, "不设区间时不按日期排除");
});

test("日期取 YYYY-MM-DD（与界面显示同一口径）", () => {
  assert.equal(ledgerDateText(new Date("2026-09-10T03:00:00.000Z")), "2026-09-10");
  assert.equal(ledgerDateText("2026-09-10T00:00:00.000Z"), "2026-09-10");
  assert.equal(ledgerDateText(null), null);
});

test("关键字按「与列表页搜索同一批字段」做大小写不敏感匹配", () => {
  const row = { status: "draft", date: null, search: ["AP-001", "SO-1", "晋江大田", "涤纶布"] };
  assert.equal(matchesLedgerFilter(row, { q: "ap-001" }), true);
  assert.equal(matchesLedgerFilter(row, { q: "涤纶" }), true);
  assert.equal(matchesLedgerFilter(row, { q: "   " }), true, "纯空白等于没填");
  assert.equal(matchesLedgerFilter(row, { q: "绍兴" }), false);
});

test("筛选器上的计数：all 含冲销/作废，所以不等于 unpaid + paid", () => {
  const counts = paymentCounts([{ status: "draft" }, { status: "draft" }, { status: "confirmed" }, { status: "reversed" }]);
  assert.deepEqual(counts, { unpaid: 2, paid: 1, void: 1, all: 4 });
});

// --------------------------------------------------------------------------
// 二、导出内容与数值类型
// --------------------------------------------------------------------------

const payableRow = (extra = {}) => ({
  payableNo: "AP-001", confirmationDate: new Date("2026-09-10T00:00:00.000Z"), supplier_name: "晋江大田", supplierId: "supplier-1",
  sourceType: "raw_material_inbound", source_no: "IN-001", sourceNoSnapshot: "IN-001", orderNo: "SO-1", purchase_order_no: "PO-1",
  material_name: "涤纶布", material_specification: "150D", quantity: "100.0000", unit_name: "米",
  unitPrice: "5.0000", amount: "500.0000", currency: "CNY", status: "draft", remark: null, ...extra,
});

const receivableRow = (extra = {}) => ({
  sourceNo: "AR-001", createdAt: new Date("2026-09-07T00:00:00.000Z"), customer_name: "香港迪礼", customerId: "customer-1",
  orderNo: "SO-1", outbound_no: "OUT-001", product_name: "折叠伞", product_specification: "黑胶",
  quantity: "120.0000", unit: "打", unitPrice: "120.0000", amount: "14310.0000", currency: "USD",
  dueDate: null, status: "draft", remark: null, ...extra,
});

test("应付台账导出：付款情况/状态按中文口径，来源类型也是中文", () => {
  const table = buildPayableLedgerTable([payableRow(), payableRow({ payableNo: "AP-002", status: "confirmed" })]);
  const [first, second] = table.rows;
  assert.equal(first[14], "未付");
  assert.equal(first[15], "应付草稿");
  assert.equal(second[14], "已付", "已确认 = 钱已经从账户付出去了");
  assert.equal(second[15], "应付已确认");
  assert.equal(first[3], "原料入库");
  assert.equal(first[0], "2026-09-10");
  // 金额列（下标 12）与数量/单价是**数值**，文本列是字符串
  assert.equal(typeof first[12], "number");
  assert.equal(first[12], 500);
  assert.equal(typeof first[9], "number");
  assert.equal(typeof first[11], "number");
  assert.equal(first[1], "AP-001");
});

test("应收台账导出：收款情况/状态按中文口径", () => {
  const table = buildReceivableLedgerTable([receivableRow(), receivableRow({ sourceNo: "AR-002", status: "paid" })]);
  assert.equal(table.rows[0][13], "未收");
  assert.equal(table.rows[0][14], "草稿");
  assert.equal(table.rows[1][13], "已收清");
  assert.equal(table.rows[0][0], "2026-09-07", "时间筛选与导出用创建日期（出库过账生成来源的日期）");
  assert.equal(payablePaymentText("partially_paid"), "部分付款");
  assert.equal(receivablePaymentText("partially_paid"), "部分收款");
});

test("导出落到 Excel 里必须是数值类型（文本型数字在 Excel 里 SUM 得 0）", async () => {
  const buffer = await renderReportWorkbook([buildPayableLedgerTable([payableRow()]), buildReceivableLedgerTable([receivableRow()])]);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["应付台账", "应收台账"]);

  const sheet = workbook.Sheets["应付台账"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  assert.equal(rows[0][12], "应付金额", "第 13 列是应付金额");
  assert.equal(typeof rows[1][12], "number", "金额必须是数值型：文本型在 Excel 里求不了和");
  assert.equal(typeof rows[1][9], "number", "数量同理");
  assert.equal(rows[1][14], "未付");
  // 文本列不能被误判成数字
  assert.equal(typeof rows[1][1], "string");
});

test("含多种币种时表尾写明不做合计（跨币种相加没有意义）", () => {
  const mixed = buildPayableLedgerTable([payableRow(), payableRow({ payableNo: "AP-002", currency: "USD" })]);
  assert.equal(mixed.footnotes.length, 2);
  assert.match(mixed.footnotes[1], /共 2 种币种，金额列不做合计/);
  assert.equal(mixed.totalColumns, undefined, "不设合计行");

  const single = buildReceivableLedgerTable([receivableRow()]);
  assert.equal(single.footnotes.length, 1, "单币种只留状态口径说明");
  assert.match(single.footnotes[0], /草稿 = 未收；已确认 = 已收/);
});
