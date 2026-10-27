// 销售单改号：全链联动登记表 + 改名域函数 + schema 覆盖守卫 + 接口/DTO 源码守卫。
//
// 用户原话（2026-09-30）：「创建销售单，订单号写错了要支持编辑和修改。要做好全链条订单号的联动调整」
// 设计：docs/design/sales-order-no-rename-2026-09-30.md §四
// 口径：任何时候都能改、版本快照跟改、审计保留旧号、不加"曾用单号"列。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { ConflictException } = require("@nestjs/common");
const {
  ORDER_NO_RENAME_TARGETS, ORDER_NO_RENAME_EXEMPT, normalizeOrderNo,
  countVersionSnapshotsWithOrderNo, orderNoRenameImpact, renameSalesOrderNo,
} = require("../../dist/modules/sales/sales-order-order-no.js");

const repoRoot = path.join(__dirname, "..", "..");
const schemaSource = fs.readFileSync(path.join(repoRoot, "prisma", "schema.prisma"), "utf8");

/** schema.prisma 里所有「带 order_no 列的模型名」。 */
function modelsWithOrderNoColumn(source) {
  const found = new Set();
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    const start = /^model\s+(\w+)\s*\{/.exec(line);
    if (start) { current = start[1]; continue; }
    if (current && /^\}/.test(line.trim())) { current = null; continue; }
    if (current && /@map\("order_no"\)/.test(line)) found.add(current);
  }
  return found;
}

/** 登记表的 key 是 Prisma **模型名**（`Bom`），而 `tx.bom` 是首字母小写的委托名 —— 桩按后者取模型。 */
const propOf = (model) => model.charAt(0).toLowerCase() + model.slice(1);
const expectedProps = ORDER_NO_RENAME_TARGETS.map((item) => propOf(item.key)).sort();

/**
 * 假事务：一个 Proxy，任何 `tx.<model>` 访问都得到一个能对 `state` 做 updateMany/count 的委托。
 *
 * 为什么不逐个模型手写 38 份桩：那样测试会跟着登记表一起"抄错也一起错" —— 桩只对写对的那几个
 * 模型生效，其余静默返回 0，漏改反而测不出来。这里按 where/data 的**键名**泛型处理，
 * 登记表里任何一项都能被真实扫到；`touched` 又反过来证明**38 项真的都被扫了**。
 */
function createFakeTx(rows = [], hooks = {}) {
  const state = rows.map((row) => ({ ...row }));
  const touched = [];
  const overrides = {
    salesOrderVersion: {
      findMany: async ({ where }) => state.filter((row) => row.model === "salesOrderVersion" && row.salesOrderId === where.salesOrderId),
      update: async ({ where, data }) => { const row = state.find((item) => item.id === where.id); if (!row) throw new Error(`version ${where.id} not found`); Object.assign(row, data); return row; },
    },
  };
  const delegate = (model) => ({
    updateMany: async ({ where, data }) => {
      const key = Object.keys(where)[0];
      const hit = state.filter((row) => row.model === model && row[key] === where[key]);
      for (const row of hit) row[key] = data[key];
      touched.push({ model, key, count: hit.length });
      hooks.onSweep?.({ model, key, state });
      return { count: hit.length };
    },
    count: async ({ where }) => { const key = Object.keys(where)[0]; return state.filter((row) => row.model === model && row[key] === where[key]).length; },
  });
  const tx = new Proxy({}, { get: (_target, prop) => overrides[prop] ?? delegate(String(prop)) });
  return { tx, state, touched };
}

// ------------------------------------------------------------------ 覆盖守卫

test("守卫：带 order_no 列的模型**一个不漏**地登记（集合相等，不是「至少包含」）", () => {
  const declared = modelsWithOrderNoColumn(schemaSource);
  const registered = new Set(ORDER_NO_RENAME_TARGETS.map((item) => item.key));
  const exempt = new Set(ORDER_NO_RENAME_EXEMPT.map((item) => item.model));
  const missing = [...declared].filter((model) => !registered.has(model) && !exempt.has(model));
  const stale = [...registered, ...exempt].filter((model) => !declared.has(model));
  assert.deepEqual(missing, [], `这些表带 order_no 列却没登记（会漏改）：${missing.join("、")}`);
  assert.deepEqual(stale, [], `登记/豁免清单里的模型在 schema 里没有 order_no 列（清单过期）：${stale.join("、")}`);
  // 除源头与审计，其余全在登记表里。40 = 38 张下游表 + 源头 + 审计。
  assert.equal(declared.size, 40, "带 order_no 列的表数变了：新增表请先登记进 ORDER_NO_RENAME_TARGETS");
  assert.equal(ORDER_NO_RENAME_TARGETS.length, 38, "登记表项数变了：确认新表已登记后同步这个数字");
  assert.deepEqual([...exempt].sort(), ["AuditEvent", "SalesOrder"], "豁免清单只能有源头与审计两类");
});

test("守卫：登记项的 key 是 real 模型名、label 非空、key 不重复", () => {
  const modelNames = new Set([...schemaSource.matchAll(/^model\s+(\w+)/gm)].map((match) => match[1]));
  const seen = new Set();
  for (const item of ORDER_NO_RENAME_TARGETS) {
    assert.ok(modelNames.has(item.key), `${item.key} 不是 schema 里的模型名`);
    assert.ok(item.label.trim().length > 0, `${item.key} 缺中文名（影响面确认框要显示它）`);
    assert.ok(!seen.has(item.key), `${item.key} 重复登记`);
    seen.add(item.key);
    assert.equal(typeof item.sweep, "function");
    assert.equal(typeof item.count, "function");
  }
});

// ------------------------------------------------------------------ 改名域函数

const ROWS = [
  { model: propOf("SalesOrder"), id: "so-1", orderNo: "DL26001" }, // 源头：由调用方改，本函数不动
  { model: propOf("Bom"), orderNo: "DL26001" },
  { model: propOf("PurchaseOrder"), orderNo: "DL26001" },
  { model: propOf("PurchaseOrder"), orderNo: "DL26001" },
  { model: propOf("PurchaseOrder"), orderNo: "DL99999" }, // 别的单：不许动
  { model: propOf("ProductionOrder"), orderNo: "DL26001" },
  { model: propOf("SupplierPayment"), orderNo: "DL26001" },
  { model: propOf("SupplierPayment"), orderNo: null }, // 可空列
  { model: propOf("CashFlowEntry"), orderNo: "DL26001" },
  { model: propOf("AuditEvent"), orderNo: "DL26001", action: "sales_order.create" }, // 审计：必须留在原处
  { model: propOf("SalesOrder"), id: "so-2", orderNo: "DL26002", reorderFromOrderNo: "DL26001" }, // 别的单上的返单来源
  { model: propOf("SalesOrderVersion"), id: "v-1", salesOrderId: "so-1", snapshot: { order_no: "DL26001", product_name: "伞" } },
  { model: propOf("SalesOrderVersion"), id: "v-2", salesOrderId: "so-1", snapshot: { order_no: "DL26001", factory: "A 厂" } },
  { model: propOf("SalesOrderVersion"), id: "v-3", salesOrderId: "so-1", snapshot: { order_no: "DL26002" } }, // 已是新号：不动
  { model: propOf("SalesOrderVersion"), id: "v-4", salesOrderId: "so-9", snapshot: { order_no: "DL26001" } }, // 别的单的版本：不动
];

test("改名：**38 张表全部被扫到**，其它单/审计/版本快照按各自口径处理", async () => {
  const { tx, state, touched } = createFakeTx(ROWS);
  const report = await renameSalesOrderNo(tx, { salesOrderId: "so-1", from: "DL26001", to: "DL260001" });

  const swept = new Set(touched.map((row) => row.model));
  const notSwept = expectedProps.filter((prop) => !swept.has(prop));
  assert.deepEqual(notSwept, [], `这些登记项没被扫到：${notSwept.join("、")}`);
  assert.deepEqual([...swept].filter((prop) => !expectedProps.includes(prop) && prop !== propOf("SalesOrder")), [], "除了返单来源引用，不该有第 39 张表被扫");
  for (const model of ["Bom", "PurchaseOrder", "ProductionOrder", "SupplierPayment", "CashFlowEntry"]) {
    const left = state.filter((row) => row.model === propOf(model) && row.orderNo === "DL26001");
    assert.deepEqual(left, [], `${model} 还有旧号残留`);
  }
  assert.ok(state.some((row) => row.model === propOf("PurchaseOrder") && row.orderNo === "DL99999"), "别的单的号不许动");
  assert.equal(state.find((row) => row.model === propOf("SupplierPayment") && row.orderNo === null).orderNo, null, "null 不受影响");
  assert.equal(state.find((row) => row.model === propOf("AuditEvent")).orderNo, "DL26001", "审计必须保留旧号");
  assert.equal(state.find((row) => row.id === "so-1").orderNo, "DL26001", "源头那一格由调用方在同事务里改，本函数不动它");

  // 返单来源引用：`reorder_from_order_no` 存的是文本而非外键，不改就会指向一个不存在的单号。
  assert.equal(report.reorder_references, 1);
  assert.equal(state.find((row) => row.id === "so-2").reorderFromOrderNo, "DL260001");

  // 版本快照：本单的 2 条跟改、已改过的不动、别的单的不动。
  assert.equal(report.version_snapshots, 2);
  assert.equal(state.find((row) => row.id === "v-1").snapshot.order_no, "DL260001");
  assert.equal(state.find((row) => row.id === "v-1").snapshot.product_name, "伞", "只改 order_no 那一格，别的键一字不碰");
  assert.equal(state.find((row) => row.id === "v-2").snapshot.factory, "A 厂");
  assert.equal(state.find((row) => row.id === "v-3").snapshot.order_no, "DL26002");
  assert.equal(state.find((row) => row.id === "v-4").snapshot.order_no, "DL26001", "别的单的版本快照不许动");
});

test("改名：报告只列非零项、按条数降序，并按表给中文名（确认框直接用它渲染）", async () => {
  const { tx } = createFakeTx(ROWS);
  const report = await renameSalesOrderNo(tx, { salesOrderId: "so-1", from: "DL26001", to: "DL260001" });
  assert.equal(report.from, "DL26001");
  assert.equal(report.to, "DL260001");
  assert.deepEqual(Object.fromEntries(report.targets.map((row) => [row.key, row.count])), { PurchaseOrder: 2, Bom: 1, CashFlowEntry: 1, ProductionOrder: 1, SupplierPayment: 1 });
  assert.equal(report.total, 6, "total 是目标表的改动行数合计（不含返单来源引用与版本快照）");
  assert.ok(report.targets.every((row) => row.count > 0 && row.label.length > 0));
  for (let index = 1; index < report.targets.length; index += 1) assert.ok(report.targets[index - 1].count >= report.targets[index].count, "必须按条数降序");
});

test("改名：残留校验非零 → 409 ORDER_NO_RENAME_CONFLICT（并发建单时宁可回滚让用户重试）", async () => {
  // 模拟：扫过采购单之后，另一笔并发写入又落了一行旧号。
  const { tx } = createFakeTx(ROWS, {
    onSweep: ({ model, key, state }) => { if (model === propOf("PurchaseOrder") && key === "orderNo") state.push({ model: propOf("PurchaseOrder"), orderNo: "DL26001" }); },
  });
  await assert.rejects(
    () => renameSalesOrderNo(tx, { salesOrderId: "so-1", from: "DL26001", to: "DL260001" }),
    (error) => error instanceof ConflictException && error.getResponse().code === "ORDER_NO_RENAME_CONFLICT" && error.getResponse().message.includes("采购单"),
  );
});

test("改名：没有任何下游时是一次空扫（不报错、不假装改了东西）", async () => {
  const { tx } = createFakeTx([{ model: propOf("SalesOrder"), id: "so-1", orderNo: "DL26001" }]);
  const report = await renameSalesOrderNo(tx, { salesOrderId: "so-1", from: "DL26001", to: "DL260001" });
  assert.deepEqual(report.targets, []);
  assert.equal(report.total, 0);
  assert.equal(report.reorder_references, 0);
  assert.equal(report.version_snapshots, 0);
});

test("影响面预览：只统计非零项并降序（与执行共用同一份登记表）", async () => {
  const { tx } = createFakeTx(ROWS);
  const impact = await orderNoRenameImpact(tx, "DL26001");
  assert.deepEqual(Object.fromEntries(impact.targets.map((row) => [row.key, row.count])), { PurchaseOrder: 2, Bom: 1, CashFlowEntry: 1, ProductionOrder: 1, SupplierPayment: 1 });
  assert.equal(impact.targets[0].key, "PurchaseOrder", "最多的排最前");
  assert.equal(impact.total, 6);
  // 预览不含审计与源头：它们本来就不在联动范围内。
  assert.ok(!impact.targets.some((row) => ["SalesOrder", "AuditEvent"].includes(row.key)));
});

test("版本快照条数：只数「还写着旧号」的那几条", async () => {
  const { tx } = createFakeTx(ROWS);
  assert.equal(await countVersionSnapshotsWithOrderNo(tx, "so-1", "DL26001"), 2);
  assert.equal(await countVersionSnapshotsWithOrderNo(tx, "so-1", "DL26002"), 1);
  assert.equal(await countVersionSnapshotsWithOrderNo(tx, "so-1", "DL00000"), 0);
});

test("订单号归一：只去首尾空白，不改大小写、不猜格式", () => {
  assert.equal(normalizeOrderNo("  DL26001 "), "DL26001");
  assert.equal(normalizeOrderNo("dl26001"), "dl26001");
  assert.equal(normalizeOrderNo(null), "");
  assert.equal(normalizeOrderNo(undefined), "");
});

// ------------------------------------------------------------------ 接口/DTO 源码守卫

const controllerSource = fs.readFileSync(path.join(repoRoot, "src", "modules", "sales", "sales-orders.controller.ts"), "utf8");
const serviceSource = fs.readFileSync(path.join(repoRoot, "src", "modules", "sales", "sales-orders.service.ts"), "utf8");

test("守卫：更新 DTO 必须有 order_no，且**不能**用 EmptyStringToUndefined（空串=不动 是静默丢弃）", () => {
  assert.match(controllerSource, /@IsOptional\(\) @IsNotEmpty\(\) @IsString\(\) @MaxLength\(100\) order_no\?: string;/, "UpdateSalesOrderDto 必须声明 order_no");
  const dtoStart = controllerSource.indexOf("export class UpdateSalesOrderDto");
  const dtoBody = controllerSource.slice(dtoStart, controllerSource.indexOf("\nclass SalesOrderQueryDto"));
  assert.ok(dtoBody.includes("order_no?: string"), "order_no 必须在 UpdateSalesOrderDto 里（否则 forbidNonWhitelisted 会 400）");
  const orderNoLine = dtoBody.split(/\r?\n/).find((line) => line.includes("order_no?: string"));
  assert.ok(!orderNoLine.includes("EmptyStringToUndefined"), "空串必须报 400，不能变成「不动」");
});

test("守卫：service 层不能再把 order_no 排除在更新载荷之外", () => {
  const typeLine = serviceSource.split(/\r?\n/).find((line) => line.startsWith("type SalesOrderUpdate ="));
  assert.ok(typeLine, "找不到 SalesOrderUpdate 类型");
  assert.ok(!typeLine.includes('"order_no"'), "order_no 必须从 Omit 名单里去掉（本轮修的就是这个）");
  assert.ok(typeLine.includes('"customer_id"'), "customer_id 仍不可改（客户快照不能换头）");
});

test("守卫：改号前必须锁本单行，且锁在扫全链之前（并发建单才会被挡在改名之后）", () => {
  const lockAt = serviceSource.indexOf("await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id}::uuid FOR UPDATE`");
  const sweepAt = serviceSource.indexOf("renameSalesOrderNo(tx");
  assert.ok(lockAt > 0, "update() 里必须对销售单行 FOR UPDATE");
  assert.ok(sweepAt > lockAt, "先锁行、再扫全链：顺序反了并发窗口就关不掉");
  assert.ok(serviceSource.includes("sales_order.rename_order_no"), "改号必须另记一条审计事件（审计里的旧号不回写）");
});

test("守卫：影响面预览路由声明在 :id 之前，且与执行共用同一份登记表", () => {
  const impactRoute = controllerSource.indexOf('@Get(":id/order-no-impact")');
  const byId = controllerSource.indexOf('@Get(":id") async get');
  assert.ok(impactRoute > 0, "影响面预览路由必须存在");
  assert.ok(impactRoute < byId, "Nest 按声明顺序匹配：两段路由也要在单段 :id 之前");
  assert.ok(serviceSource.includes("await orderNoRenameImpact(this.prisma, order.orderNo)"), "预览必须用登记表算，不能另写一份");
});

// ------------------------------------------------------------------ 外键一致性（阶段 5）

test("改号只改文本键：下游行的 sales_order_id 原样保留", async () => {
  const { tx, state } = createFakeTx([
    { model: "purchaseReceipt", orderNo: "DL1", salesOrderId: "so-1" },
    { model: "inventoryFact", orderNo: "DL1", salesOrderId: "so-1" },
    { model: "salesOrder", orderNo: "DL1", reorderFromOrderNo: null },
  ]);

  await renameSalesOrderNo(tx, { salesOrderId: "so-1", from: "DL1", to: "DL2" });

  for (const model of ["purchaseReceipt", "inventoryFact"]) {
    const row = state.find((item) => item.model === model);
    assert.equal(row.orderNo, "DL2", `${model} 的文本键要跟着改`);
    assert.equal(row.salesOrderId, "so-1", `${model} 的外键不该被改号动到`);
  }
});