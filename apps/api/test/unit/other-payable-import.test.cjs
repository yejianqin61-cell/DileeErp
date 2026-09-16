// 「其他应付」批量导入（非原料类支出）的单元测试。
//
// 用户 2026-09-16：「应付管理，因为有一些非原料类的支出，也就是其他应付，现在要支持批量导入
// 这类应付对账条目。我们提供模板，用户填写上传，直接进入应付对账，然后再流转到确认应付。」
//
// 两层：
//   1. 纯函数层（other-payable-import.ts）：表头按名字认列、逐行校验、行级错误不连坐、重复行、
//      金额/币种/日期归一化、模板闭环（模板自己能被自己的解析器读回）；
//   2. 服务层（SupplierPayableService.importOther）：供应商匹配与自动建档、一个事务写库、
//      审计、以及「没有文件 / 文件读不了」的 422。
const assert = require("node:assert/strict");
const test = require("node:test");
const XLSX = require("xlsx");
const { Prisma } = require("@prisma/client");
const { parseOtherPayableRows, otherPayableTemplateWorkbook, normalizeAmountCell, OTHER_PAYABLE_MAX_ROWS } = require("../../dist/modules/finance/other-payable-import.js");
const { SupplierPayableService } = require("../../dist/modules/finance/supplier-payable.service.js");

/** 用真实 xlsx 打一次往返：解析器吃的就是 Excel 里读出来的形状，而不是手搓的数组。 */
function workbookBuffer(rows, sheetName = "其他应付导入") {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function sheetRows(buffer, sheetName) {
  const book = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = sheetName ? book.Sheets[sheetName] : book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
}

const HEADER = ["供应商编码", "供应商名称", "应付金额", "币种", "费用说明", "确认日期", "备注"];

/** 解析一份「表头 + 若干数据行」的文件。 */
function parse(rows) { return parseOtherPayableRows(sheetRows(workbookBuffer([HEADER, ...rows]))); }

// ---------------------------------------------------------------------------
// 纯函数：表头与模板
// ---------------------------------------------------------------------------

test("模板闭环：下载的模板能被自己的解析器读回，两行示例都通过校验", () => {
  const parsed = parseOtherPayableRows(sheetRows(otherPayableTemplateWorkbook()));

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.total, 2);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.ignoredColumns, []); // 模板列必须全部属于口径，否则操作员会以为填了没用
  assert.equal(parsed.headerRow, 1);
  assert.equal(parsed.rows[0].currency, "CNY");
  assert.equal(parsed.rows[0].confirmationDate, "2026-09-16");
  // 第二行故意留空币种与日期：要给「按 CNY / 按今天」的提示，而不是静默替换
  assert.match(parsed.hints.join(" "), /币种/);
  assert.match(parsed.hints.join(" "), /确认日期/);
});

test("按表头名认列：列顺序打乱、多余列被忽略、缺列不影响其它列", () => {
  const parsed = parseOtherPayableRows(sheetRows(workbookBuffer([
    ["费用说明", "备注", "应付金额", "供应商名称", "币种", "摊销月份", "供应商编码", "确认日期"],
    ["9 月厂房租金", "银行转账", "1200", "上海房东", "CNY", "2026-09", "SUP-1", "2026-09-16"],
  ])));

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.ignoredColumns, ["摊销月份"]);
  assert.deepEqual(parsed.rows[0], {
    row: 2, supplierCode: "SUP-1", supplierName: "上海房东", amount: "1200",
    currency: "CNY", description: "9 月厂房租金", confirmationDate: "2026-09-16", remark: "银行转账",
  });
});

test("缺必需列：只回一条整体错误、一行都不解析（不是把每行都报一遍）", () => {
  const parsed = parseOtherPayableRows(sheetRows(workbookBuffer([
    ["供应商名称", "备注"],
    ["上海房东", "缺了金额与费用说明"],
  ])));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].reason, /应付金额/);
  assert.match(parsed.errors[0].reason, /费用说明/);
  // 表头里有「供应商名称」，所以供应商这一组不算缺（编码与名称二者其一即可）
  assert.deepEqual(parsed.missingColumns, ["应付金额", "费用说明"]);
});

test("缺必需列：供应商编码与名称两列都没有时才算缺「供应商」", () => {
  const parsed = parseOtherPayableRows(sheetRows(workbookBuffer([
    ["应付金额", "费用说明"],
    ["1200", "房租"],
  ])));

  assert.equal(parsed.status, "failed");
  assert.deepEqual(parsed.missingColumns, ["供应商编码或供应商名称"]);
  assert.match(parsed.errors[0].reason, /供应商编码或供应商名称/);
});

test("误传别的表（没有表头）时只回一条错误，不产生一堆行级错误", () => {
  const parsed = parseOtherPayableRows(sheetRows(workbookBuffer([
    ["花色生产单"], ["订单号", "SO-1", "数量", "100"],
  ])));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].reason, /表头/);
});

test("表头下面没有数据行：整批失败并点名该从哪一行开始填", () => {
  const parsed = parseOtherPayableRows(sheetRows(workbookBuffer([HEADER])));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.total, 0);
  assert.match(parsed.errors[0].reason, /没有数据行/);
});

// ---------------------------------------------------------------------------
// 纯函数：逐行校验
// ---------------------------------------------------------------------------

test("行级错误不连坐：坏行逐条报错，好行照常进入待入库", () => {
  const parsed = parse([
    ["SUP-1", "上海房东", "1200", "CNY", "9 月厂房租金", "2026-09-16", ""],
    ["SUP-2", "顺丰", "-5", "CNY", "快递费", "2026-09-16", ""],
    ["SUP-3", "电网", "abc", "CNY", "电费", "2026-09-16", ""],
    ["SUP-4", "水务", "300", "CNY", "水费", "2026-02-31", ""],
    ["SUP-5", "物业", "500", "", "", "2026-09-16", ""],
    ["", "", "600", "CNY", "没有供应商", "2026-09-16", ""],
  ]);

  assert.equal(parsed.status, "partial");
  assert.equal(parsed.total, 6);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].supplierCode, "SUP-1");
  const reasons = Object.fromEntries(parsed.errors.map((error) => [error.row, `${error.field ?? ""}:${error.reason}`]));
  assert.match(reasons[3], /应付金额/);
  assert.match(reasons[4], /应付金额/);
  assert.match(reasons[5], /确认日期/);
  assert.match(reasons[6], /费用说明/);
  assert.match(reasons[7], /供应商编码或供应商名称/);
});

test("同一份文件里的重复行会被拒绝，并指出与第几行重复", () => {
  const parsed = parse([
    ["SUP-1", "上海房东", "1200", "CNY", "9 月厂房租金", "2026-09-16", ""],
    ["SUP-1", "上海房东", "1200", "CNY", "9 月厂房租金", "2026-09-16", "重复填了一次"],
  ]);

  assert.equal(parsed.status, "partial");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 3);
  assert.match(parsed.errors[0].reason, /与本文件第 2 行重复/);
});

test("金额归一化：千分位、货币符号、全角数字与数字单元格都认；非法写法报错", () => {
  assert.equal(normalizeAmountCell("1,200.00"), "1200.00");
  assert.equal(normalizeAmountCell("￥1200"), "1200");
  assert.equal(normalizeAmountCell("１２００"), "1200");
  assert.equal(normalizeAmountCell(1200.5), "1200.5");
  assert.equal(normalizeAmountCell(" 1 200 "), "1200");
  for (const bad of ["", "abc", "-1", "1.2.3", null, undefined]) assert.equal(normalizeAmountCell(bad), "", `${bad} 不该被当成金额`);

  const parsed = parse([["SUP-1", "", "1,200.00", "人民币", "房租", "2026-09-16", ""]]);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.rows[0].amount, "1200.00");
  assert.equal(parsed.rows[0].currency, "CNY");
});

test("币种：留空按 CNY 并给提示，中文/大小写写法都认，乱写报错", () => {
  const parsed = parse([
    ["SUP-1", "", "100", "", "留空", "2026-09-16", ""],
    ["SUP-2", "", "100", "美元", "中文", "2026-09-16", ""],
    ["SUP-3", "", "100", "usd", "小写", "2026-09-16", ""],
    ["SUP-4", "", "100", "RMB", "别名", "2026-09-16", ""],
    ["SUP-5", "", "100", "人民币", "乱写", "2026-09-16", ""],
    ["SUP-6", "", "100", "人民币元整", "认不出", "2026-09-16", ""],
  ]);

  const byCode = Object.fromEntries(parsed.rows.map((row) => [row.supplierCode, row.currency]));
  assert.equal(byCode["SUP-1"], "CNY");
  assert.equal(byCode["SUP-2"], "USD");
  assert.equal(byCode["SUP-3"], "USD");
  assert.equal(byCode["SUP-4"], "CNY");
  assert.equal(byCode["SUP-5"], "CNY");
  assert.equal(parsed.errors.filter((error) => error.row === 7).length, 1);
  assert.match(parsed.hints.join(" "), /1 行没有填币种/);
});

test("日期：文本、Excel 序列号、留空各按其分；越界数字与翻滚日期都报错", () => {
  // 序列号按 1899-12-30 起算（与 parseRosterDate 同一换算），窗口外的一律拒绝
  const serial = (Date.UTC(2026, 8, 16) - Date.UTC(1899, 11, 30)) / 86400000;
  const parsed = parse([
    ["SUP-1", "", "100", "CNY", "文本", "2026/9/16", ""],
    ["SUP-2", "", "100", "CNY", "序列号", serial, ""],
    ["SUP-3", "", "100", "CNY", "留空", "", ""],
    ["SUP-4", "", "100", "CNY", "越界", 2026, ""],
    ["SUP-5", "", "100", "CNY", "翻滚", "2026-02-31", ""],
  ]);

  const dates = Object.fromEntries(parsed.rows.map((row) => [row.supplierCode, row.confirmationDate]));
  assert.equal(dates["SUP-1"], "2026-09-16");
  assert.equal(dates["SUP-2"], "2026-09-16");
  assert.equal(dates["SUP-3"], null);
  assert.equal(parsed.errors.filter((error) => error.row === 5).length, 1);
  assert.equal(parsed.errors.filter((error) => error.row === 6).length, 1);
  assert.match(parsed.hints.join(" "), /1 行没有填确认日期/);
});

test("文档形态（表头不在第一行）：到第一个空行为止，表尾批注不计入", () => {
  const parsed = parseOtherPayableRows(sheetRows(workbookBuffer([
    ["迪礼应付明细（2026 年 9 月）"],
    HEADER,
    ["SUP-1", "上海房东", "1200", "CNY", "房租", "2026-09-16", ""],
    ["SUP-2", "顺丰", "86.5", "CNY", "快递费", "2026-09-16", ""],
    [],
    ["说明：本表由财务手工维护", "", "", "", "", "", ""],
  ])));

  assert.equal(parsed.documentLayout, true);
  assert.equal(parsed.headerRow, 2);
  assert.equal(parsed.dataStartRow, 3);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.ignoredTrailingRows, 2);
  assert.equal(parsed.status, "ok");
});

// ---------------------------------------------------------------------------
// 服务层：供应商匹配、自动建档、一个事务写库
// ---------------------------------------------------------------------------

const auditStub = () => ({ record: async () => {}, create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }) });
const cashFlowStub = () => ({ requireItem: async () => null, recordConfirmation: async () => null });
const USER = { id: "user-1" };

function prismaStub(options = {}) {
  const createdEntries = [];
  const createdSuppliers = [];
  const usedTransaction = { count: 0 };
  const suppliers = options.suppliers ?? [
    { id: "sup-1", supplierCode: "SUP-0001", name: "上海房东" },
    { id: "sup-2", supplierCode: "SUP-0002", name: "顺丰速运" },
  ];
  const supplier = {
    findMany: async (args) => (args?.where?.supplierCode?.startsWith ? [{ supplierCode: "SUP-20260916-0001" }] : suppliers),
    create: async ({ data }) => {
      if (options.failSupplierCreate) throw new Error("supplier-create-failed");
      createdSuppliers.push(data);
      return { id: `sup-new-${createdSuppliers.length}`, supplierCode: data.supplierCode, name: data.name };
    },
  };
  const supplierPayableEntry = {
    create: async ({ data }) => {
      if (options.failEntryCreateAt === createdEntries.length + 1) throw new Error("entry-create-failed");
      createdEntries.push(data);
      return { id: `entry-${createdEntries.length}`, payableNo: data.payableNo, amount: data.amount };
    },
  };
  const prisma = {
    supplier,
    supplierPayableEntry,
    $transaction: async (fn) => { usedTransaction.count += 1; return fn({ supplier, supplierPayableEntry }); },
  };
  return { prisma, createdEntries, createdSuppliers, usedTransaction };
}

function serviceWith(stub) {
  return new SupplierPayableService(stub.prisma, auditStub(), cashFlowStub());
}

test("导入生成其他应付草稿：命中已有供应商（按编码或名称），字段与手工新建完全同形", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);
  const file = { buffer: workbookBuffer([
    HEADER,
    ["SUP-0001", "", "1200.00", "CNY", "9 月厂房租金", "2026-09-16", "银行转账"],
    ["", "顺丰速运", "86.50", "USD", "8 月快递费", "", ""],
  ]), originalname: "其他应付.xlsx" };

  const result = await service.importOther(file, USER);

  assert.equal(result.status, "ok");
  assert.equal(result.imported, 2);
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.createdSuppliers, [], "两家供应商都能匹配到，不该新建");
  assert.equal(stub.usedTransaction.count, 1, "写库必须在一个事务里");
  assert.deepEqual(stub.createdEntries.map((row) => row.supplierId), ["sup-1", "sup-2"]);
  const [first, second] = stub.createdEntries;
  assert.equal(first.sourceType, "other");
  assert.equal(first.orderNo, null);
  assert.equal(first.sourceNoSnapshot, "其他应付-9 月厂房租金");
  assert.equal(first.amount.toString(), "1200");
  assert.equal(first.unitPrice.toString(), "1200");
  assert.equal(first.quantity.toString(), "1");
  assert.equal(first.currency, "CNY");
  assert.equal(first.confirmationDate.toISOString().slice(0, 10), "2026-09-16");
  assert.equal(first.remark, "银行转账");
  assert.equal(second.currency, "USD");
  // 没填确认日期 = 按导入当天记账（与手工新建的默认值一致）
  assert.equal(second.confirmationDate.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
});

test("供应商池里没有的对方按名称自动建档，编码走 SUP-当天日期-序号，同一批同名只建一个", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);
  const file = { buffer: workbookBuffer([
    HEADER,
    ["", "新房东", "5000", "CNY", "押金", "2026-09-16", ""],
    ["", " 新 房东 ", "3000", "CNY", "首月租金", "2026-09-16", ""],
  ]) };

  const result = await service.importOther(file, USER);

  assert.equal(result.imported, 2);
  assert.equal(stub.createdSuppliers.length, 1, "同名（忽略空格）只该建一个供应商");
  assert.equal(stub.createdSuppliers[0].name, "新房东");
  assert.equal(stub.createdSuppliers[0].supplierCode, "SUP-20260916-0002", "已有 0001，新号从 0002 起");
  assert.deepEqual(result.createdSuppliers, [{ name: "新房东", supplierCode: "SUP-20260916-0002", rows: 2 }]);
  // 两行都挂到新建的那个供应商上
  assert.deepEqual(stub.createdEntries.map((row) => row.supplierId), ["sup-new-1", "sup-new-1"]);
  assert.match(result.hints.join(" "), /新增了 1 个供应商/);
  assert.match(result.hints.join(" "), /应付草稿/);
});

test("匹配忽略大小写与空格：文件里写 sup-0001 / 上海 房东 都算命中", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);
  const file = { buffer: workbookBuffer([
    HEADER,
    ["sup-0001", "", "100", "CNY", "房租", "2026-09-16", ""],
    ["", "上海 房东", "100", "CNY", "水电", "2026-09-16", ""],
  ]) };

  const result = await service.importOther(file, USER);

  assert.equal(result.imported, 2);
  assert.deepEqual(result.createdSuppliers, []);
  assert.deepEqual(stub.createdEntries.map((row) => row.supplierId), ["sup-1", "sup-1"]);
});

test("行级错误不连坐：坏行不写库，好行照常导入并在结果里逐条列出原因", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);
  const file = { buffer: workbookBuffer([
    HEADER,
    ["SUP-0001", "", "1200", "CNY", "房租", "2026-09-16", ""],
    ["SUP-0001", "", "0", "CNY", "零金额", "2026-09-16", ""],
    ["SUP-0001", "", "1200", "CNY", "房租", "2026-09-16", ""],
  ]) };

  const result = await service.importOther(file, USER);

  assert.equal(result.status, "partial");
  assert.equal(result.total, 3);
  assert.equal(result.imported, 1);
  assert.equal(result.errorCount, 2);
  assert.equal(result.errors[0].row, 3);
  assert.equal(result.errors[1].row, 4);
  assert.equal(stub.createdEntries.length, 1);
});

test("写库阶段任何失败都整批回滚（不留下半个文件），错误原样抛给调用方", async () => {
  const stub = prismaStub({ failEntryCreateAt: 2 });
  const service = serviceWith(stub);
  const file = { buffer: workbookBuffer([
    HEADER,
    ["SUP-0001", "", "1200", "CNY", "房租", "2026-09-16", ""],
    ["SUP-0002", "", "86.5", "CNY", "快递费", "2026-09-16", ""],
  ]) };

  await assert.rejects(() => service.importOther(file, USER), /entry-create-failed/);
  assert.equal(stub.usedTransaction.count, 1);
});

test("没有文件 / 传了非 Excel：422 并给出可执行的下一步", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);

  await assert.rejects(() => service.importOther(undefined, USER), (error) => error.getResponse?.().code === "PAYABLE_IMPORT_FILE_REQUIRED");
  // 传了个 CSV（控制器白名单之外，服务层再挡一次）：要直说「只支持 .xlsx/.xls」，
  // 而不是让 SheetJS 把文本读成一张表、再报「找不到表头」把操作员引到错误方向。
  await assert.rejects(() => service.importOther({ buffer: Buffer.from("a,b,c"), originalname: "其他应付.csv" }, USER), (error) => error.getResponse?.().code === "PAYABLE_IMPORT_INVALID_FILE");
  assert.equal(stub.createdEntries.length, 0);
});

test("扩展名是 .xlsx 但内容是垃圾：回一条「找不到表头」，不是 500", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);

  const result = await service.importOther({ buffer: Buffer.from("这不是一个 Excel 文件"), originalname: "其他应付.xlsx" }, USER);

  assert.equal(result.status, "failed");
  assert.equal(result.imported, 0);
  assert.match(result.errors[0].reason, /表头|模板/);
  assert.equal(stub.createdEntries.length, 0);
});

test("超过行数上限的文件被挡住（付款账目不做无上限的一次性导入）", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);
  const rows = [HEADER];
  for (let index = 0; index < OTHER_PAYABLE_MAX_ROWS + 30; index += 1) {
    rows.push(["SUP-0001", "", "1", "CNY", `费用 ${index}`, "2026-09-16", ""]);
  }

  await assert.rejects(() => service.importOther({ buffer: workbookBuffer(rows) }, USER), (error) => error.getResponse?.().code === "PAYABLE_IMPORT_ROWS_EXCEEDED");
});

test("建单口径与手工「新建其他应付」一致（同一个构造函数产出同一份数据）", async () => {
  const stub = prismaStub();
  const service = serviceWith(stub);
  stub.prisma.supplier.findFirst = async () => ({ id: "sup-1", name: "上海房东" });

  const manual = await service.createOther({ supplier_id: "sup-1", amount: "1200", currency: "CNY", description: "9 月厂房租金", confirmation_date: "2026-09-16", remark: "银行转账" }, USER);
  await service.importOther({ buffer: workbookBuffer([HEADER, ["SUP-0001", "", "1200", "CNY", "9 月厂房租金", "2026-09-16", "银行转账"]]) }, USER);

  const manualData = stub.createdEntries[0];
  const importedData = stub.createdEntries[1];
  for (const field of ["sourceType", "orderNo", "supplierId", "sourceNoSnapshot", "currency", "remark"]) {
    assert.equal(importedData[field], manualData[field], `${field} 在导入与手工新建之间不该有差别`);
  }
  assert.equal(importedData.amount.toString(), manualData.amount.toString());
  assert.equal(importedData.quantity.toString(), manualData.quantity.toString());
  assert.equal(importedData.unitPrice.toString(), manualData.unitPrice.toString());
  assert.equal(importedData.taxRate.toString(), manualData.taxRate.toString());
  assert.deepEqual(importedData.attachment, manualData.attachment);
  assert.equal(manual.payableNo.startsWith("APO-"), true);
});
