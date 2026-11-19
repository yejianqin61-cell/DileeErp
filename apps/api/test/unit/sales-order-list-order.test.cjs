// 销售单列表分页（服务层）的定向单元测试 —— T-0022。
//
// 纯比较器的用例在 `sales-order-list-sort.test.cjs`；本文件钉的是 service 有没有把
// 「同一份全序」切成页：第 1 页 + 第 2 页 + … 必须等于整体顺序，不重复、不遗漏。
// 用假 Prisma 是刻意的：不连数据库、不写生产库，也不需要迁移。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { SalesOrdersService } = require("../../dist/modules/sales/sales-orders.service.js");

function rowsFixture() {
  return [
    { id: "id-08", orderNo: "10", customer: { id: "c-1", name: "客户" }, boms: [] },
    { id: "id-03", orderNo: "9", customer: { id: "c-1", name: "客户" }, boms: [] },
    { id: "id-01", orderNo: "2", customer: { id: "c-1", name: "客户" }, boms: [] },
    { id: "id-99", orderNo: null, customer: { id: "c-1", name: "客户" }, boms: [] },
    { id: "id-00", orderNo: "", customer: { id: "c-1", name: "客户" }, boms: [] },
    { id: "id-07", orderNo: "A-1", customer: { id: "c-1", name: "客户" }, boms: [] },
  ];
}

function createHarness(rows = rowsFixture()) {
  const calls = [];
  const prisma = {
    salesOrder: {
      findMany: async (args) => {
        calls.push(args);
        if (args.select) return rows.map(({ id, orderNo }) => ({ id, orderNo }));
        if (args.where?.id?.in) return args.where.id.in.flatMap((id) => rows.filter((row) => row.id === id));
        return rows;
      },
      count: async () => rows.length,
    },
    $transaction: async (operations) => Promise.all(operations),
  };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  return { service: new SalesOrdersService(prisma, audit), calls };
}

test("销售单列表默认：订单号升序，纯数字按数值（2 → 9 → 10），空值最后", async () => {
  const { service, calls } = createHarness();

  const first = await service.list(1, 2);
  const second = await service.list(2, 2);
  const third = await service.list(3, 2);

  assert.deepEqual(first.data.map((row) => row.id), ["id-01", "id-03"]);
  assert.deepEqual(second.data.map((row) => row.id), ["id-08", "id-07"]);
  assert.deepEqual(third.data.map((row) => row.id), ["id-00", "id-99"], "空值（含空串）排最后，内部按 id 升序");
  assert.equal(first.total, 6);
  assert.equal(second.total, 6);
  assert.equal(third.total, 6);

  // 排序键只取 id + orderNo 两列，不把整行/关系搬进内存。
  assert.deepEqual(calls[0].select, { id: true, orderNo: true });
  // 回取整行时按页内 id 集合查，并带齐列表需要的 customer / boms。
  assert.ok(calls[1].where.id.in.length === 2);
  assert.deepEqual(calls[1].include.boms.select, { id: true, version: true, status: true });
});

test("销售单列表：订单号降序仍把空值放最后，翻页切片与整体顺序一致", async () => {
  const { service } = createHarness();

  const pages = [];
  for (let page = 1; page <= 3; page += 1) pages.push((await service.list(page, 2, undefined, undefined, "order_no", "desc")).data.map((row) => row.id));

  assert.deepEqual(pages, [
    ["id-07", "id-08"],
    ["id-03", "id-01"],
    ["id-00", "id-99"],
  ]);
  assert.deepEqual(pages.flat(), ["id-07", "id-08", "id-03", "id-01", "id-00", "id-99"]);
  assert.equal(new Set(pages.flat()).size, 6, "翻页不能重复");
});

test("销售单列表：非订单号排序仍走 Prisma orderBy，并保留 id 第二排序键", async () => {
  const { service, calls } = createHarness();

  await service.list(1, 20, undefined, undefined, "created_at", "desc");

  const listCall = calls.find((args) => args.orderBy);
  assert.deepEqual(listCall.orderBy, [{ createdAt: "desc" }, { id: "asc" }]);
});
