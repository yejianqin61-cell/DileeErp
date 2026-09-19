// 工资付款按月导出（`payroll-payment-sheet.ts`）的版式与口径测试。
//
// 这张表是纯函数构造的 `ReportTable`，测试直接断言**构造出来的单元格**：
//   - 列名与列序按用户要求固定（18 列）；
//   - 三个金额列必须是数值列，且落到单元格的值必须是 JS number ——
//     `finance-report-workbook.ts` 对数值列收到非数值会直接抛错，写字符串型数字正是老表的毛病；
//   - 「是否付款」四种取值、付款单号截断、单币种才有合计（绝不跨币种相加）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const { PAYROLL_PAYMENT_SHEET_COLUMNS, buildPayrollPaymentSheetTable } = require("../../dist/modules/hr/payroll-payment-sheet.js");
const { renderReportWorkbook } = require("../../dist/modules/finance/finance-report-workbook.js");

const dec = (value) => new Prisma.Decimal(value);

const HEADERS = [
  "月份", "工号", "姓名", "部门", "岗位", "员工类型", "币种",
  "应发工资", "已付", "未付", "是否付款", "台账状态", "付款笔数",
  "末次付款日期", "末次付款方式", "发放银行", "付款单号", "备注",
];

/** 一行台账来源（默认：已确认、应发 1000、一分未付）。 */
function source(over = {}) {
  return {
    month: "2026-03",
    employeeNo: "E-001",
    employeeName: "张三",
    departmentName: "生产部",
    positionName: "缝制工",
    employeeType: "workshop",
    currency: "CNY",
    payableAmount: dec("1000"),
    paidAmount: dec("0"),
    outstandingAmount: dec("1000"),
    status: "confirmed",
    remark: null,
    payments: [],
    ...over,
  };
}

function payment(over = {}) {
  return { paymentNo: "SALARY-1", paymentDate: new Date("2026-03-05T00:00:00.000Z"), paymentMethod: "银行转账", bankName: "农业银行", accountNumber: "5706", ...over };
}

/** 列下标（0 基），避免用例里散落魔法数字。 */
const COL = Object.fromEntries(HEADERS.map((header, index) => [header, index]));

function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const name = workbook.SheetNames[0];
  return { name, sheet: workbook.Sheets[name] };
}

/* ------------------------------------------------------------ 列定义 */

test("payroll-payment-sheet：sheet 名与 18 列的列名列序按用户要求固定", () => {
  const table = buildPayrollPaymentSheetTable([source()]);
  assert.equal(table.sheetName, "工资付款");
  assert.deepEqual(table.columns.map((column) => column.header), HEADERS);
  assert.deepEqual(table.columns.map((column) => column.header), PAYROLL_PAYMENT_SHEET_COLUMNS.map((column) => column.header));
});

test("payroll-payment-sheet：只有三个金额列是数值列（带 numFmt），其余是文本列", () => {
  const numeric = PAYROLL_PAYMENT_SHEET_COLUMNS.filter((column) => column.numFmt).map((column) => column.header);
  assert.deepEqual(numeric, ["应发工资", "已付", "未付"], "数值列少一个 → 数字会落成文本（Excel 里 SUM 得 0）；多一个 → 文本列被当成金额");
});

/* ------------------------------------------------------------ 行内容 */

test("payroll-payment-sheet：金额列落成 JS number，缺字段留空（空单元格 ≠ 0）", () => {
  const table = buildPayrollPaymentSheetTable([
    source(),
    // 金额缺失（理论上不该有，但导出层不能因此炸）：留空，不写 0，也不写 ""
    source({ employeeNo: "E-002", employeeName: "李四", payableAmount: null, paidAmount: null, outstandingAmount: null }),
  ]);
  const [first, second] = table.rows;
  for (const header of ["应发工资", "已付", "未付"]) {
    assert.equal(typeof first[COL[header]], "number", `${header} 必须是数值类型`);
  }
  assert.equal(first[COL["应发工资"]], 1000);
  assert.equal(first[COL["已付"]], 0, "确实为零就要写 0（不是空单元格）");
  assert.equal(second[COL["应发工资"]], null);
  assert.equal(second[COL["已付"]], null);
  assert.equal(second[COL["未付"]], null);
});

test("payroll-payment-sheet：员工类型与台账状态用页面同款中文标签", () => {
  const table = buildPayrollPaymentSheetTable([
    source({ employeeType: "non_workshop", status: "draft" }),
    source({ employeeNo: "E-002", employeeType: "workshop", status: "partially_paid" }),
    source({ employeeNo: "E-003", status: "paid" }),
    source({ employeeNo: "E-004", status: "expired" }),
    source({ employeeNo: "E-005", status: "closed" }),
    source({ employeeNo: "E-006", status: "confirmed" }),
  ]);
  assert.deepEqual(table.rows.map((row) => row[COL["员工类型"]]), ["非车间", "车间", "车间", "车间", "车间", "车间"]);
  assert.deepEqual(table.rows.map((row) => row[COL["台账状态"]]), ["草稿", "部分支付", "已支付", "已过期", "已关闭", "已确认"]);
});

test("payroll-payment-sheet：「是否付款」四种取值：无需付款 / 已付清 / 部分付款 / 未付款", () => {
  const table = buildPayrollPaymentSheetTable([
    // 应发 ≤ 0：本来就没有钱要发
    source({ employeeNo: "E-001", payableAmount: dec("0"), outstandingAmount: dec("0") }),
    // 未付 ≤ 0：已结清
    source({ employeeNo: "E-002", paidAmount: dec("1000"), outstandingAmount: dec("0") }),
    // 已付 > 0 但还有未付
    source({ employeeNo: "E-003", paidAmount: dec("400"), outstandingAmount: dec("600") }),
    // 一分未付
    source({ employeeNo: "E-004" }),
  ]);
  assert.deepEqual(table.rows.map((row) => row[COL["是否付款"]]), ["无需付款", "已付清", "部分付款", "未付款"]);
});

test("payroll-payment-sheet：付款笔数按付款单张数算（同一张单的多条核销只算一笔）", () => {
  const table = buildPayrollPaymentSheetTable([
    source({ payments: [payment(), payment()] }),
    source({ employeeNo: "E-002", payments: [] }),
  ]);
  assert.equal(table.rows[0][COL["付款笔数"]], 1, "记的是付款单数，不是核销行数");
  assert.equal(table.rows[1][COL["付款笔数"]], 0, "一笔都没付是「确实为零」的事实，写 0 而不是留空");
});

test("payroll-payment-sheet：末次付款日期/方式/银行取付款日期最晚的那一笔，银行写作「名称（账号）」", () => {
  const table = buildPayrollPaymentSheetTable([
    source({
      payments: [
        payment({ paymentNo: "SALARY-1", paymentDate: new Date("2026-03-05T00:00:00.000Z"), paymentMethod: "现金", bankName: "中国银行", accountNumber: "7624" }),
        payment({ paymentNo: "SALARY-2", paymentDate: new Date("2026-03-20T00:00:00.000Z"), paymentMethod: "银行转账", bankName: "农业银行", accountNumber: "5706" }),
      ],
    }),
  ]);
  const row = table.rows[0];
  assert.equal(row[COL["末次付款日期"]], "2026-03-20");
  assert.equal(row[COL["末次付款方式"]], "银行转账");
  assert.equal(row[COL["发放银行"]], "农业银行（5706）");
});

test("payroll-payment-sheet：没有付款记录时末次三列与付款单号是空单元格（不写空串）", () => {
  const table = buildPayrollPaymentSheetTable([source()]);
  const row = table.rows[0];
  for (const header of ["末次付款日期", "末次付款方式", "发放银行", "付款单号"]) {
    assert.equal(row[COL[header]], null, `${header} 没有数据就留空`);
  }
});

test("payroll-payment-sheet：付款单号全部列出；超过 3 张只列前 3 张并注明总数", () => {
  const three = buildPayrollPaymentSheetTable([source({ payments: [payment({ paymentNo: "S-1" }), payment({ paymentNo: "S-2" }), payment({ paymentNo: "S-3" })] })]);
  assert.equal(three.rows[0][COL["付款单号"]], "S-1、S-2、S-3");

  const many = buildPayrollPaymentSheetTable([source({
    payments: [
      payment({ paymentNo: "S-1", paymentDate: new Date("2026-03-01T00:00:00.000Z") }),
      payment({ paymentNo: "S-2", paymentDate: new Date("2026-03-02T00:00:00.000Z") }),
      payment({ paymentNo: "S-3", paymentDate: new Date("2026-03-03T00:00:00.000Z") }),
      payment({ paymentNo: "S-4", paymentDate: new Date("2026-03-04T00:00:00.000Z") }),
      payment({ paymentNo: "S-5", paymentDate: new Date("2026-03-05T00:00:00.000Z") }),
    ],
  })]);
  assert.equal(many.rows[0][COL["付款单号"]], "S-1、S-2、S-3等5张", "截断必须写明总数，不能让人以为只付了 3 笔");
  assert.equal(many.rows[0][COL["付款笔数"]], 5);
});

/* ------------------------------------------------------------ 合计与表尾 */

test("payroll-payment-sheet：整批同一币种时给出三个金额列的合计", () => {
  const table = buildPayrollPaymentSheetTable([
    source({ payableAmount: dec("1000"), paidAmount: dec("400"), outstandingAmount: dec("600") }),
    source({ employeeNo: "E-002", payableAmount: dec("500.5"), paidAmount: dec("0"), outstandingAmount: dec("500.5") }),
  ]);
  assert.deepEqual(table.totalColumns, [COL["应发工资"], COL["已付"], COL["未付"]]);
});

test("payroll-payment-sheet：混币种时**不给合计**并在表尾说明（绝不跨币种相加）", () => {
  const table = buildPayrollPaymentSheetTable([
    source({ currency: "CNY" }),
    source({ employeeNo: "E-002", currency: "USD" }),
  ]);
  assert.equal(table.totalColumns, undefined, "混币种相加会得到一个没有会计意义的数");
  assert.ok(table.footnotes.some((note) => note.includes("多种币种") && note.includes("绝不跨币种求和")), "不给合计就必须在表尾说明原因");
  assert.ok(table.footnotes.some((note) => note.includes("人民币")), "要点明工资通常只以人民币核算");
});

test("payroll-payment-sheet：表尾永远说明「是否付款」口径、已付只算已过账、以及这不是银行对账单", () => {
  const table = buildPayrollPaymentSheetTable([source()]);
  const notes = table.footnotes.join("\n");
  assert.match(notes, /「是否付款」：应发工资 ≤ 0 记「无需付款」/);
  assert.match(notes, /「已付」只统计已过账/);
  assert.match(notes, /不是银行对账单/);
  assert.equal(table.footnotes.some((note) => note.includes("多种币种")), false, "单币种不该出现混币种提示");
});

test("payroll-payment-sheet：额外表尾可追加（本表自身口径不动）", () => {
  const table = buildPayrollPaymentSheetTable([source()], { footnotes: ["补充说明"] });
  assert.equal(table.footnotes[table.footnotes.length - 1], "补充说明");
});

/* ------------------------------------------------------------ 真渲染一遍 */

test("payroll-payment-sheet：渲染成工作簿后金额列仍是数值单元格（不是文本型数字）", async () => {
  const table = buildPayrollPaymentSheetTable([source({ paidAmount: dec("400"), outstandingAmount: dec("600"), payments: [payment()] })]);
  const buffer = await renderReportWorkbook([table]);
  const { name, sheet } = readSheet(buffer);
  assert.equal(name, "工资付款");
  // 第 2 行是第一条数据；H/I/J 三列（应发工资/已付/未付）必须是数值
  for (const address of ["H2", "I2", "J2"]) {
    assert.equal(sheet[address].t, "n", `${address} 必须是数值单元格（文本型数字在 Excel 里 SUM 得 0）`);
  }
  // 合计行写的是 SUM 公式 + 缓存结果
  assert.equal(sheet["H3"].f, "SUM(H2:H2)");
  assert.equal(sheet["H3"].v, 1000);
  const offenders = Object.entries(sheet).filter(([address, cell]) => !address.startsWith("!") && cell.t === "s" && typeof cell.v === "string" && /^-?\d+(\.\d+)?$/.test(cell.v.trim()));
  assert.deepEqual(offenders.map(([address]) => address), [], "不允许把数字写成文本单元格");
});
