// 销售单改号（服务层）：守卫、事务内联动、审计、影响面预览、唯一冲突映射。
//
// 设计：docs/design/sales-order-no-rename-2026-09-30.md §四.2~§四.5
// 这里测的是 `SalesOrdersService.update()` —— 改号不是一个额外接口，而是"这次保存"的一部分：
// 用户改的是同一张表单上的一格，系统必须在同一个事务里把全链一起改掉。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException, UnprocessableEntityException } = require("@nestjs/common");
const { SalesOrdersService } = require("../../dist/modules/sales/sales-orders.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "sales", display_name: "销售测试" };
const OLD = "DL26001";
const NEW = "DL260001";
const propOf = (model) => model.charAt(0).toLowerCase() + model.slice(1);

function orderFixture(overrides = {}) {
  return {
    id: "so-1", orderNo: OLD, status: "confirmed", customerId: "c-1", contactId: null,
    currentVersion: 2, orderDate: new Date("2026-09-01T00:00:00.000Z"), quantity: "100", unit: "支",
    currency: "USD", productName: "伞", extensionData: {}, reorderFromOrderNo: null,
    customer: { id: "c-1", name: "客户" }, contact: null, boms: [], versions: [], specDetails: [], materialRefs: [],
    ...overrides,
  };
}

/** 下游行的默认缺口：一张 BOM + 两张采购单（挂在同一销售单下）+ 一条应付台账 + 别的单上的返单来源。 */
function downstreamRows() {
  return [
    { model: propOf("Bom"), id: "bom-1", orderNo: OLD, salesOrderId: "so-1" },
    { model: propOf("PurchaseOrder"), id: "po-1", orderNo: OLD, salesOrderId: "so-1" },
    { model: propOf("PurchaseOrder"), id: "po-2", orderNo: OLD, salesOrderId: "so-1" },
    { model: propOf("SupplierPayableEntry"), id: "ap-1", orderNo: OLD },
    { model: propOf("SalesOrder"), id: "so-2", orderNo: "DL26002", reorderFromOrderNo: OLD },
    { model: propOf("SalesOrderVersion"), id: "v-1", salesOrderId: "so-1", snapshot: { order_no: OLD, product_name: "伞" } },
  ];
}

function createHarness(options = {}) {
  const order = options.order ?? orderFixture();
  const state = { ...order };
  const rows = (options.rows ?? downstreamRows()).map((row) => ({ ...row }));
  const recorded = [];
  const locks = [];
  const created = [];
  const audit = {
    create: () => ({ createdBy: user.id, updatedBy: user.id }),
    update: () => ({ updatedBy: user.id }),
    record: async (...args) => { recorded.push(args); },
  };
  /** 按 where/data 的**键名**泛型处理：登记表里任何一张表都能被真实扫到 / 计数。 */
  const generic = (model) => ({
    updateMany: async ({ where, data }) => {
      const key = Object.keys(where)[0];
      const hit = rows.filter((row) => row.model === model && row[key] === where[key]);
      for (const row of hit) row[key] = data[key];
      options.onSweep?.({ model, key, rows });
      return { count: hit.length };
    },
    count: async ({ where }) => { const key = Object.keys(where)[0]; return rows.filter((row) => row.model === model && row[key] === where[key]).length; },
  });
  const overrides = {
    salesOrder: {
      ...generic(propOf("SalesOrder")),
      update: async ({ data }) => { if (options.updateThrows) throw options.updateThrows; Object.assign(state, data); return state; },
    },
    salesOrderVersion: {
      findMany: async ({ where }) => rows.filter((row) => row.model === propOf("SalesOrderVersion") && row.salesOrderId === where.salesOrderId),
      update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); Object.assign(row, data); return row; },
      create: async ({ data }) => { created.push(data); return data; },
    },
    salesOrderSpecDetail: { updateMany: async () => ({ count: 0 }), createMany: async ({ data }) => ({ count: data.length }) },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async ({ data }) => ({ count: data.length }) },
  };
  const baseProxy = (extra) => new Proxy({}, { get: (_target, prop) => extra[prop] ?? generic(String(prop)) });
  const tx = baseProxy({ ...overrides, $queryRaw: async (strings) => { locks.push(String(strings)); return []; } });
  const prisma = baseProxy({
    ...overrides,
    salesOrder: {
      ...overrides.salesOrder,
      findFirst: async (args) => {
        if (args.where && args.where.orderNo !== undefined) return options.taken && options.taken.orderNo === args.where.orderNo ? options.taken : null;
        return state;
      },
    },
    customer: { findFirst: async () => ({ id: "c-1", customerCode: "CUS-1", name: "客户", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async () => [] },
    $transaction: async (fn) => fn(tx),
  });
  return { service: new SalesOrdersService(prisma, audit), state, rows, recorded, locks, created };
}

const eventsOf = (recorded, action) => recorded.filter(([name]) => name === action);

// ------------------------------------------------------------------ 正常改名

test("改号：已确认单**已有 BOM/采购**也能改 —— 它不动金额，不该逼用户先回退整条链", async () => {
  const harness = createHarness({ order: orderFixture({ boms: [{ id: "bom-1" }] }) });
  const result = await harness.service.update("so-1", { order_no: NEW, reason: "单号手误" }, user);

  assert.equal(harness.state.orderNo, NEW, "源头那一格必须改成新号");
  assert.equal(result.order_no_changed, true);
  assert.equal(result.previous_order_no, OLD);
  assert.equal(result.orderNo, NEW);
  // 核心字段守卫不该被触发：改号不在 coreFields 里（否则最常见的场景仍然走不通）。
  assert.equal(eventsOf(harness.recorded, "sales_order.update").length, 1);
});

test("改号：全链在同一个事务里一起改，报告里带每张表的条数", async () => {
  const harness = createHarness();
  const result = await harness.service.update("so-1", { order_no: NEW, reason: "单号手误" }, user);
  for (const row of harness.rows.filter((item) => item.model !== propOf("SalesOrder") && item.model !== propOf("SalesOrderVersion"))) {
    assert.notEqual(row.orderNo, OLD, `${row.model} 还有旧号残留`);
  }
  assert.equal(harness.rows.find((row) => row.id === "po-1").orderNo, NEW);
  assert.equal(harness.rows.find((row) => row.id === "so-2").reorderFromOrderNo, NEW, "别的单上的返单来源要跟着改");
  assert.equal(result.rename_report.total, 4, "BOM 1 + 采购单 2 + 应付台账 1");
  assert.deepEqual(Object.fromEntries(result.rename_report.targets.map((row) => [row.key, row.count])), { PurchaseOrder: 2, Bom: 1, SupplierPayableEntry: 1 });
  assert.equal(result.rename_report.reorder_references, 1);
  assert.equal(result.rename_report.version_snapshots, 1);
});

test("改号：先锁本单行，再扫全链（顺序不能反）", async () => {
  const harness = createHarness();
  await harness.service.update("so-1", { order_no: NEW, reason: "单号手误" }, user);
  assert.equal(harness.locks.length, 1, "必须对销售单行 FOR UPDATE");
  assert.match(harness.locks[0], /SELECT id FROM sales_orders WHERE id = .* FOR UPDATE/);
});

test("改号：版本快照跟着改（含历史版本），新增的那一版记的也是新号", async () => {
  const harness = createHarness();
  await harness.service.update("so-1", { order_no: NEW, reason: "单号手误" }, user);
  assert.equal(harness.rows.find((row) => row.id === "v-1").snapshot.order_no, NEW, "历史版本快照跟改");
  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0].version, 3);
  assert.equal(harness.created[0].snapshot.order_no, NEW, "新版本快照记新号");
});

test("改号：审计写两条 —— update 带 previous_order_no，另有 rename_order_no 事件带 from→to 与影响面", async () => {
  const harness = createHarness();
  await harness.service.update("so-1", { order_no: NEW, reason: "单号手误" }, user);

  const update = eventsOf(harness.recorded, "sales_order.update");
  assert.equal(update.length, 1);
  assert.equal(update[0][4].order_no, NEW);
  assert.equal(update[0][4].previous_order_no, OLD);

  const rename = eventsOf(harness.recorded, "sales_order.rename_order_no");
  assert.equal(rename.length, 1, "改号必须有自己的审计事件（审计列上的旧号不回写，靠它回答「什么时候改的」）");
  assert.equal(rename[0][1], "sales_order");
  assert.equal(rename[0][3], "so-1", "第 4 个参数是销售单 id（审计靠它关联）");
  assert.equal(rename[0][4].from, OLD);
  assert.equal(rename[0][4].to, NEW);
  assert.equal(rename[0][4].reason, "单号手误");
  assert.equal(rename[0][4].total, 4);
  assert.equal(rename[0][4].version_snapshots, 1);
  assert.equal(rename[0][4].reorder_references, 1);
});

test("改号：订单号相同（值没变）不触发联动，也不写改名审计", async () => {
  const harness = createHarness();
  const result = await harness.service.update("so-1", { order_no: `  ${OLD} `, reason: "看了一眼" }, user);
  assert.equal(result.order_no_changed, false);
  assert.equal(result.previous_order_no, null);
  assert.equal(result.rename_report, null);
  assert.equal(harness.locks.length, 0, "没改号就不该锁行、不该扫全链");
  assert.equal(eventsOf(harness.recorded, "sales_order.rename_order_no").length, 0);
  assert.ok(harness.rows.some((row) => row.orderNo === OLD), "下游一行都不该被碰");
});

// ------------------------------------------------------------------ 守卫

test("守卫：改号必须填原因（文案带上旧号→新号）", async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.service.update("so-1", { order_no: NEW }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "CORRECTION_REASON_REQUIRED" && error.getResponse().message.includes(OLD) && error.getResponse().message.includes(NEW),
  );
  assert.equal(harness.state.orderNo, OLD, "被拒绝时一个字都不许改");
});

test("守卫：空串/纯空白不是「不动」，而是 422 —— 静默丢弃正是本轮要修的病", async () => {
  for (const value of ["", "   "]) {
    const harness = createHarness();
    await assert.rejects(
      () => harness.service.update("so-1", { order_no: value, reason: "想清空" }, user),
      (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "ORDER_NO_REQUIRED",
      `order_no=${JSON.stringify(value)} 必须被顶回来`,
    );
  }
});

test("守卫：新号被别的单占用 → 409 ORDER_NO_CONFLICT（软删单占的号也算）", async () => {
  for (const taken of [{ id: "so-9", orderNo: NEW, status: "draft", deletedAt: null }, { id: "so-9", orderNo: NEW, status: "closed", deletedAt: new Date() }]) {
    const harness = createHarness({ taken });
    await assert.rejects(
      () => harness.service.update("so-1", { order_no: NEW, reason: "手误" }, user),
      (error) => error instanceof ConflictException && error.getResponse().code === "ORDER_NO_CONFLICT",
      taken.deletedAt ? "软删单占着的号也要拦（唯一索引跨软删行）" : "普通占用要拦",
    );
    assert.equal(harness.state.orderNo, OLD);
  }
});

test("守卫：已关闭单可以单独改号（要原因），但带上别的字段一律拒绝", async () => {
  const allowed = createHarness({ order: orderFixture({ status: "closed" }) });
  await allowed.service.update("so-1", { order_no: NEW, reason: "结案后才发现单号写错" }, user);
  assert.equal(allowed.state.orderNo, NEW);

  const rejected = createHarness({ order: orderFixture({ status: "closed" }) });
  await assert.rejects(
    () => rejected.service.update("so-1", { order_no: NEW, reason: "顺手改个产品名", product_name: "别的伞" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALES_ORDER_CLOSED",
  );
  assert.equal(rejected.state.orderNo, OLD);
});

test("守卫：已关闭单补货号的老口径不受影响（有原因可改、没原因报补货号文案）", async () => {
  const harness = createHarness({ order: orderFixture({ status: "closed" }) });
  await assert.rejects(
    () => harness.service.update("so-1", { item_no: "27621" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "CORRECTION_REASON_REQUIRED" && error.getResponse().message.includes("补货号"),
  );
  await harness.service.update("so-1", { item_no: "27621", reason: "历史单补货号" }, user);
  assert.equal(harness.state.itemNo, "27621");
});

test("守卫：并发写入留下的旧号 → 409 ORDER_NO_RENAME_CONFLICT（整事务回滚，宁可让用户重试）", async () => {
  const harness = createHarness({
    onSweep: ({ model, key, rows }) => { if (model === propOf("PurchaseOrder") && key === "orderNo") rows.push({ model: propOf("PurchaseOrder"), id: "po-race", orderNo: OLD }); },
  });
  await assert.rejects(
    () => harness.service.update("so-1", { order_no: NEW, reason: "手误" }, user),
    (error) => error instanceof ConflictException && error.getResponse().code === "ORDER_NO_RENAME_CONFLICT",
  );
});

test("守卫：只有改号时才把 P2002 翻译成 ORDER_NO_CONFLICT；不改号时不许套这个帽子", async () => {
  const racing = createHarness({ updateThrows: Object.assign(new Error("unique"), { code: "P2002" }) });
  await assert.rejects(
    () => racing.service.update("so-1", { order_no: NEW, reason: "手误" }, user),
    (error) => error instanceof ConflictException && error.getResponse().code === "ORDER_NO_CONFLICT",
    "并发抢同一个新号时，用户该看到「订单号已存在」",
  );

  const other = createHarness({ order: orderFixture({ status: "draft" }), updateThrows: Object.assign(new Error("version conflict"), { code: "P2002" }) });
  await assert.rejects(
    () => other.service.update("so-1", { product_name: "另一把伞" }, user),
    (error) => error.message === "version conflict",
    "版本号并发冲突不能被说成「订单号已存在」",
  );
});

// ------------------------------------------------------------------ 影响面预览

test("影响面预览：给出当前号、新号、逐表条数、版本快照数，并说明必须填原因", async () => {
  const harness = createHarness();
  const impact = await harness.service.orderNoImpact("so-1", NEW);
  assert.equal(impact.current_order_no, OLD);
  assert.equal(impact.next_order_no, NEW);
  assert.equal(impact.changed, true);
  assert.equal(impact.conflict, null);
  assert.equal(impact.reason_required, true);
  assert.equal(impact.total, 4);
  assert.equal(impact.version_snapshots, 1);
  // 版本快照与"别的单上的返单来源"不在登记表里，但一样会被改 —— 预览必须把它们也算上，
  // 否则确认框会少说一项（前端的文案读的就是这两个字段）。
  assert.equal(impact.reorder_references, 1);
  assert.deepEqual(Object.fromEntries(impact.targets.map((row) => [row.key, row.count])), { PurchaseOrder: 2, Bom: 1, SupplierPayableEntry: 1 });
  assert.ok(impact.targets.every((row) => row.label.length > 0), "确认框要显示中文单据名");
});

test("影响面预览：新号已被占用时先把冲突说出来（软删单也认），不装作没事", async () => {
  const harness = createHarness({ taken: { id: "so-9", orderNo: NEW, status: "closed", deletedAt: null } });
  const impact = await harness.service.orderNoImpact("so-1", NEW);
  assert.equal(impact.conflict.order_id, "so-9");
  assert.equal(impact.conflict.deleted, false);
  assert.match(impact.conflict.message, /已被另一张销售单占用/);

  const deleted = createHarness({ taken: { id: "so-9", orderNo: NEW, status: "closed", deletedAt: new Date() } });
  assert.match((await deleted.service.orderNoImpact("so-1", NEW)).conflict.message, /已删除/);
});

test("影响面预览：号没变时返回空影响面（前端据此不弹确认框）", async () => {
  const harness = createHarness();
  const impact = await harness.service.orderNoImpact("so-1", `  ${OLD}  `);
  assert.equal(impact.changed, false);
  assert.deepEqual(impact.targets, []);
  assert.equal(impact.total, 0);
  assert.equal(impact.version_snapshots, 0);
  assert.equal(impact.reorder_references, 0);
  assert.equal(impact.next_order_no, OLD, "预览里回显的是归一后的号");
});

test("影响面预览：空号直接 422，不返回一个没法执行的预览", async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.service.orderNoImpact("so-1", "   "),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "ORDER_NO_REQUIRED",
  );
});
