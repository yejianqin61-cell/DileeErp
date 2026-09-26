// `AuditService` 对 `entityId` 的规范化（2026-09-26 修的两处生产缺陷之一）。
//
// 事故现场：材料批量导入把**物料编码**（或字面量 `"batch"`）传给了第 4 个参数，而它落进
// `audit_events.entity_id` —— 一个 UUID 列。Prisma 建行的报错是
// `Inconsistent column data: Error creating UUID ... found 'M' at 1`，
// 于是**整个导入请求 500**：业务数据已经在一个事务里写好了，用户看到的却是"失败"。
//
// 这里钉住的契约有三条，缺一条都会让上面的场景复活：
//   1. 非法 entityId **绝不抛错**（审计是附带记录，不该打断业务操作）；
//   2. 那个值**不能丢**——改记到 `details.entity_id_raw`，否则追溯不到是谁的编码；
//   3. 它不是静默吞掉：要打警告，让调用方的 bug 在日志里看得见。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");

/** 只实现 auditEvent.create，并记录落库的 data。 */
function harness() {
  const rows = [];
  const warnings = [];
  const prisma = { auditEvent: { create: async ({ data }) => { rows.push(data); return { id: `audit-${rows.length}` }; } } };
  const service = new AuditService(prisma);
  const original = Logger.prototype.warn;
  Logger.prototype.warn = function warn(message) { warnings.push(String(message)); };
  return { service, rows, warnings, restore: () => { Logger.prototype.warn = original; } };
}

const ACTOR = "00000000-0000-0000-0000-0000000000aa";
const UUID = "11111111-2222-3333-4444-555555555555";

test("entityId 不是 UUID（物料编码）：不抛错、不落进 UUID 列、原始值进 details、并打警告", async () => {
  const h = harness();
  try {
    // 这三类都是真实发生过的：物料编码、字面量 "batch"、以及带空格的编码。
    for (const invalid of ["MAT-1001", "batch", "  MAT-1002  "]) {
      await assert.doesNotReject(
        () => h.service.record("material.import", "material", ACTOR, invalid, { imported: 3 }),
        "审计 entityId 格式不对绝不能让业务请求 500",
      );
    }
    assert.deepEqual(h.rows.map((row) => row.entityId), [undefined, undefined, undefined], "非法值不得落进 UUID 列");
    assert.deepEqual(h.rows.map((row) => row.details.entity_id_raw), ["MAT-1001", "batch", "  MAT-1002  "], "原始值必须留档，否则追溯不到是谁的编码");
    assert.equal(h.rows[0].details.imported, 3, "原有 details 不能被覆盖");
    assert.equal(h.warnings.length, 3, "不能静默：每个非法值都要有一条警告（否则调用方的 bug 永远看不见）");
    assert.match(h.warnings[0], /entityId 不是 UUID/);
  } finally { h.restore(); }
});

test("entityId 是合法 UUID / 空值时原样通过（不误伤正常调用）", async () => {
  const h = harness();
  try {
    await h.service.record("voucher.post", "voucher", ACTOR, UUID, { voucher_no: "V-1" });
    await h.service.record("voucher.delete", "voucher", ACTOR, undefined);
    await h.service.record("voucher.reverse", "voucher", ACTOR, "");
    assert.equal(h.rows[0].entityId, UUID, "合法 UUID 原样落库（大小写不敏感）");
    assert.equal(h.rows[1].entityId, undefined);
    assert.equal(h.rows[2].entityId, undefined, "空串当没传（调用方常用 `x || undefined`，但空串本身也该安全）");
    assert.equal(h.warnings.length, 0, "正常调用不该有警告");
  } finally { h.restore(); }
});

test("大写 UUID 也认（`@db.Uuid` 落库后回读常是大写，别把合法值当非法）", async () => {
  const h = harness();
  try {
    await h.service.record("voucher.post", "voucher", ACTOR, UUID.toUpperCase());
    assert.equal(h.rows[0].entityId, UUID.toUpperCase());
    assert.equal(h.warnings.length, 0);
  } finally { h.restore(); }
});

test("recordWithOrderNo 走同一套规范化（两个入口不能分叉）", async () => {
  const h = harness();
  try {
    await h.service.recordWithOrderNo("supplier_payable.create", "supplier_payable_entry", "DL260126", ACTOR, "PAY-0001", { amount: "1" });
    assert.equal(h.rows[0].orderNo, "DL260126");
    assert.equal(h.rows[0].entityId, undefined, "orderNo 是订单号，不该被当成 entityId；这里的 entityId 传入值本身是编码");
    assert.equal(h.rows[0].details.entity_id_raw, "PAY-0001");
    assert.equal(h.warnings.length, 1);
  } finally { h.restore(); }
});
