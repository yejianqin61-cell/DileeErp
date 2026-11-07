// 成品质检「待质检列表」的已检 / 待检数量口径（2026-11-07，设计文档
// docs/design/material-slip-order-no-and-finished-goods-pending-qc-2026-11-07.md §2.3）。
//
// 这几个数只允许有一份实现：createQcRecord / correctQc 的上限校验都是「该送检单下
// status=active 的 QC 记录 inspectedQuantity 合计」，列表接口必须与它同一口径 ——
// 否则会出现「列表说还能检 2、点进去服务端说超量」的分叉。
//
// 风格照其它 unit 测试：手写假 Prisma（只记录调用形状，任何写操作直接抛错），
// 测试 require 的是 dist，所以跑之前要先 `npm run build --workspace=@dilee/api`。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { FinishedGoodsQcService } = require("../../dist/modules/production/finished-goods-qc.service.js");

const dec = (value) => new Prisma.Decimal(value);

/** 一条 QC 记录（默认 active，可覆盖成 corrected / 已删除）。 */
const qcRecord = (overrides = {}) => ({ id: "qc-1", status: "active", inspectedQuantity: dec("4"), deletedAt: null, ...overrides });

/** 一张送检单（默认送检 10、状态质检中，qcRecords 由用例给）。 */
const submission = (overrides = {}) => ({
  id: "sub-1",
  submissionNo: "FGIS-20261107-0001",
  orderNo: "DL260001",
  productionOrderNoSnapshot: "MO-20260910-0001",
  productNameSnapshot: "自动雨伞",
  submittedQuantity: dec("10"),
  status: "inspecting",
  submissionDate: new Date("2026-11-07T00:00:00.000Z"),
  unitId: "unit-1",
  unitNameSnapshot: "把",
  qcRecords: [],
  unit: { id: "unit-1", name: "把" },
  deletedAt: null,
  ...overrides
});

/** 手写假 Prisma：列表接口只需要 finishedGoodsInspectionSubmission.findMany；写操作一律抛错。 */
function fakePrisma(rows) {
  const calls = [];
  const writes = [];
  const guard = (operation) => async () => {
    writes.push(operation);
    throw new Error(`listSubmissions 不应写库：${operation}`);
  };
  const prisma = {
    finishedGoodsInspectionSubmission: {
      findMany: async (args) => {
        calls.push(args);
        return rows;
      },
      create: guard("create"),
      createMany: guard("createMany"),
      update: guard("update"),
      updateMany: guard("updateMany"),
      upsert: guard("upsert"),
      delete: guard("delete"),
      deleteMany: guard("deleteMany")
    }
  };
  return { prisma, calls, writes };
}

function harness(rows) {
  const fake = fakePrisma(rows);
  // audit 只在写方法里用；listSubmissions 是纯读，传空对象即可。
  return { ...fake, service: new FinishedGoodsQcService(fake.prisma, {}) };
}

test("每行新增 inspectedQuantity / pendingQuantity：active 记录合计，字符串十进制", async () => {
  const { service } = harness([
    submission({
      qcRecords: [qcRecord({ id: "qc-a", inspectedQuantity: dec("4") }), qcRecord({ id: "qc-b", inspectedQuantity: dec("2.5") })]
    })
  ]);

  const [row] = await service.listSubmissions();

  assert.equal(row.inspectedQuantity, "6.5", "已检数量 = 该送检单下 active 记录合计");
  assert.equal(row.pendingQuantity, "3.5", "待检数量 = 10 − 6.5");
  assert.equal(typeof row.inspectedQuantity, "string", "数量以十进制字符串下发，前端不碰浮点");
  assert.equal(typeof row.pendingQuantity, "string");
});

test("corrected 记录不计入：更正后的旧记录不能把同一批数量重复算一次", async () => {
  const { service } = harness([
    submission({
      submittedQuantity: dec("10"),
      qcRecords: [
        qcRecord({ id: "qc-active-1", inspectedQuantity: dec("4") }),
        // 更正时原记录被标 corrected、新记录才是有效值；两条都算就会重复计数。
        qcRecord({ id: "qc-corrected", status: "corrected", inspectedQuantity: dec("999") }),
        qcRecord({ id: "qc-active-2", inspectedQuantity: dec("1") })
      ]
    })
  ]);

  const [row] = await service.listSubmissions();

  assert.equal(row.inspectedQuantity, "5", "只算 active：4 + 1，corrected 的 999 不计");
  assert.equal(row.pendingQuantity, "5");
});

test("待检数量钳到 0：历史数据里已检 > 送检时不能出现负数", async () => {
  const { service } = harness([
    submission({
      submittedQuantity: dec("10"),
      qcRecords: [qcRecord({ inspectedQuantity: dec("12") })]
    })
  ]);

  const [row] = await service.listSubmissions();

  assert.equal(row.inspectedQuantity, "12", "已检数量照实报（这是历史数据异常，要看得出来）");
  assert.equal(row.pendingQuantity, "0", "待检数量 = max(10 − 12, 0)");
  assert.ok(!row.pendingQuantity.startsWith("-"), "界面不能显示「还能检 -2」");
});

test("空 qcRecords：已检 0、待检 = 送检量", async () => {
  const { service } = harness([submission({ submittedQuantity: dec("5"), qcRecords: [] })]);

  const [row] = await service.listSubmissions();

  assert.equal(row.inspectedQuantity, "0");
  assert.equal(row.pendingQuantity, "5");
});

test("小数精确相加：0.0001 + 0.0002 不能被浮点变成 0.00030000000000000003", async () => {
  const { service } = harness([
    submission({
      submittedQuantity: dec("10.0000"),
      qcRecords: [qcRecord({ inspectedQuantity: dec("0.0001") }), qcRecord({ inspectedQuantity: dec("0.0002") })]
    })
  ]);

  const [row] = await service.listSubmissions();

  assert.equal(row.inspectedQuantity, "0.0003");
  assert.equal(row.pendingQuantity, "9.9997");
});

test("保留原字段：新字段只加不改，qcRecords / submittedQuantity / 状态都不动", async () => {
  const original = submission({
    qcRecords: [qcRecord({ id: "qc-a", inspectedQuantity: dec("4") }), qcRecord({ id: "qc-corrected", status: "corrected", inspectedQuantity: dec("1") })]
  });
  const { service, writes } = harness([original]);

  const [row] = await service.listSubmissions();

  assert.equal(row.id, "sub-1");
  assert.equal(row.submissionNo, "FGIS-20261107-0001");
  assert.equal(row.orderNo, "DL260001");
  assert.equal(row.productionOrderNoSnapshot, "MO-20260910-0001");
  assert.equal(row.status, "inspecting", "列表只读，不因累计算完就改状态（状态由 createQcRecord 维护）");
  assert.ok(row.submittedQuantity instanceof Prisma.Decimal, "送检量仍是 Decimal（既有调用方按原样消费）");
  assert.equal(row.submittedQuantity.toString(), "10");
  assert.equal(row.unit.name, "把");
  assert.equal(row.qcRecords, original.qcRecords, "qcRecords 原样带出（既有字段，corrected 记录也还在）");
  assert.equal("inspectedQuantity" in original, false, "不能就地污染传入的行对象");
  assert.deepEqual(writes, [], "列表接口是只读的");
});

test("多张送检单各自计算，不串行累计", async () => {
  const { service } = harness([
    submission({ id: "sub-1", submissionNo: "FGIS-1", submittedQuantity: dec("10"), qcRecords: [qcRecord({ inspectedQuantity: dec("4") })] }),
    submission({ id: "sub-2", submissionNo: "FGIS-2", submittedQuantity: dec("20"), qcRecords: [qcRecord({ inspectedQuantity: dec("20") })] }),
    submission({ id: "sub-3", submissionNo: "FGIS-3", submittedQuantity: dec("8"), qcRecords: [] })
  ]);

  const rows = await service.listSubmissions();

  assert.deepEqual(rows.map((row) => [row.submissionNo, row.inspectedQuantity, row.pendingQuantity]), [
    ["FGIS-1", "4", "6"],
    ["FGIS-2", "20", "0"],
    ["FGIS-3", "0", "8"]
  ], "每行的合计只来自自己的 qcRecords");
});

test("查询形状：只查未删除的送检单，qcRecords 只取未删除并按检验日期升序；orderNo 可选过滤", async () => {
  const all = harness([submission()]);
  await all.service.listSubmissions();
  assert.deepEqual(all.calls[0].where, { deletedAt: null }, "不给订单号 = 全部订单（跨订单待质检列表的数据源）");
  assert.deepEqual(all.calls[0].include.qcRecords.where, { deletedAt: null }, "已删除的 QC 记录不参与合计");
  assert.deepEqual(all.calls[0].include.qcRecords.orderBy, { inspectionDate: "asc" });
  assert.equal(all.calls[0].include.unit, true, "单位名要给列表展示");
  assert.deepEqual(all.calls[0].orderBy, { updatedAt: "desc" }, "既有排序不变");

  const filtered = harness([submission()]);
  await filtered.service.listSubmissions("DL260001");
  assert.deepEqual(filtered.calls[0].where, { deletedAt: null, orderNo: "DL260001" }, "按订单号查询的入口沿用同一实现");
  assert.deepEqual(filtered.writes, []);
});
