// 财务报表导出的「制表人 / 制表时间」表尾（2026-09-16 操作人与操作时间全站治理）。
//
// 为什么报表走表尾而不是每行两列：报表是**期间聚合**口径（一行往往跨多条业务记录），
// 给行加「创建人 / 最后修改人」说不清这一行的操作人是谁。审计要回答的是「这份文件从哪来」，
// 所以口径是：每行给不出操作人的报表，在表尾写清**谁、什么时候生成的**，时间固定北京时间。
//
// 本文件钉住三条：
//   1. 8 个导出端点共用的出口真的加上了这一行（含姓名与北京时间）；
//   2. **预览不加**——预览是 JSON（列由接口下发），里面出现「制表人」会让「页面看到的」和
//      「导出的」不一致，而这两者共用同一个 ReportTable 正是这套报表的设计前提；
//   3. 表尾不得出现 UUID（验收标准 ①）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const { FinanceReportController } = require("../../dist/modules/finance/finance-report.controller.js");

/** 假响应：sendWorkbook 只用 setHeader 与 send，另外从 req.currentUser 取制表人。 */
function fakeResponse(currentUser = { id: "user-1", username: "caiwu", display_name: "财务小李" }) {
  const headers = {};
  return {
    headers,
    body: null,
    req: { currentUser },
    setHeader(name, value) { headers[name] = value; },
    send(body) { this.body = body; return body; }
  };
}

function fakeReports() {
  return {
    currencyLabels: async () => new Map([["CNY", "人民币"]]),
    cashFlowDetail: async () => [],
  };
}

const allCells = (buffer) => {
  const sheet = XLSX.read(buffer, { type: "buffer" }).Sheets["收支明细"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  return rows.flat();
};

test("导出表尾带「制表人 + 制表时间（北京时间）」", async () => {
  const controller = new FinanceReportController(fakeReports());
  const response = fakeResponse();

  await controller.exportCashFlowDetail({}, response);

  assert.ok(Buffer.isBuffer(response.body), "应当下发 xlsx 二进制");
  const cells = allCells(response.body);
  const stamp = cells.find((cell) => typeof cell === "string" && cell.includes("制表人："));
  assert.ok(stamp, `表尾缺少制表人行：${JSON.stringify(cells.slice(-6))}`);
  assert.match(stamp, /制表人：财务小李/);
  assert.match(stamp, /制表时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, "制表时间要到秒");
  assert.match(stamp, /北京时间/, "必须写明时区口径，否则跨时区读文件的人会误判");
});

test("姓名取不到时留空，绝不把 id 写进表尾", async () => {
  const controller = new FinanceReportController(fakeReports());
  const response = fakeResponse({ id: "user-1", username: "caiwu" });

  await controller.exportCashFlowDetail({}, response);

  const cells = allCells(response.body);
  const stamp = cells.find((cell) => typeof cell === "string" && cell.includes("制表人："));
  assert.match(stamp, /制表人：；/, "没有 display_name 时姓名位置留空");
  for (const cell of cells) {
    assert.equal(typeof cell === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(cell), false, `表尾出现了 UUID：${String(cell)}`);
  }
  assert.equal(cells.some((cell) => cell === "user-1"), false, "表尾不得出现用户 id");
});

test("预览不加制表人：页面看到的列与导出的同源，不能一边有一边没有", async () => {
  const controller = new FinanceReportController(fakeReports());

  const preview = await controller.cashFlowDetail({});

  assert.equal(preview.data.footnotes.some((line) => line.includes("制表人")), false, "预览的脚注里不该有制表人");
  assert.ok(preview.data.footnotes.length > 0, "原本的老表说明要保留");
});

test("外汇一览导出是多工作表：两张表的脚注都带上制表人", async () => {
  const controller = new FinanceReportController({
    currencyLabels: async () => new Map(),
    forexReceipts: async () => ({ rows: [], footnotes: ["外汇表说明"] }),
  });
  const response = fakeResponse();

  await controller.exportForexReceipts({}, response);

  const book = XLSX.read(response.body, { type: "buffer" });
  assert.equal(book.SheetNames.length, 2, "外汇一览导出含明细 + 客户汇总两张表");
  for (const name of book.SheetNames) {
    const cells = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: "" }).flat();
    assert.ok(cells.some((cell) => typeof cell === "string" && cell.includes("制表人：财务小李")), `${name} 缺制表人`);
  }
});
