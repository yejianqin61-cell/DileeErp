const assert = require("node:assert/strict");
const { test } = require("node:test");
const { migrationSql } = require("../helpers/migration-guards.cjs");

// 采购订单打印字段 + 供应商地址的库级守卫。
//
// 用户 2026-09-16：「供应商，需要多一个字段，地址」+「采购单里面要有…付款方式、交期条款、交货地址、
// 厂家回签意见、厂家回签、主管签字」+「对应的，系统中采购单，也要支持对这些字段进行填写和设置」。
//
// 这里守住三件事：
//   1. 七列真的建出来了（内存替身看不到列，只有迁移 SQL 能证明）；
//   2. **全部可空**：历史采购单没有这些字，加列不能变成「必须补填」，否则升级后所有旧单都写不进去；
//   3. 不额外加唯一约束/索引：这些字只有打印与人工查看，没有按它们筛选与去重的场景。
const sql = migrationSql();

const nullableColumns = (table, column) =>
  new RegExp(`ALTER TABLE "${table}" ADD COLUMN "${column}" (VARCHAR\\(\\d+\\)|UUID|TIMESTAMP\\(3\\));`, "i").test(sql) &&
  !new RegExp(`ADD COLUMN "${column}"[^;]*NOT NULL`, "i").test(sql);

test("供应商新增 address（可空）", () => {
  assert.match(sql, /ALTER TABLE "suppliers" ADD COLUMN "address" VARCHAR\(300\);/i, "suppliers.address 必须存在");
  assert.equal(/ADD COLUMN "address"[^;]*NOT NULL/i.test(sql), false, "地址必须可空：历史供应商没有这一项");
});

test("采购订单新增六个打印字段，列名与长度固定", () => {
  const expected = {
    payment_terms: 50,
    delivery_terms: 1000,
    delivery_address: 300,
    supplier_reply: 1000,
    supplier_signed: 200,
    supervisor_signature: 200,
  };
  for (const [column, length] of Object.entries(expected)) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "purchase_orders" ADD COLUMN "${column}" VARCHAR\\(${length}\\);`, "i"),
      `purchase_orders.${column} 必须是 VARCHAR(${length})`,
    );
    assert.equal(nullableColumns("purchase_orders", column), true, `${column} 必须可空（历史采购单没有这些字）`);
  }
});

test("打印字段不加唯一约束与索引（只有打印与查看，没有按它们筛选/去重）", () => {
  for (const column of ["payment_terms", "delivery_terms", "delivery_address", "supplier_reply", "supplier_signed", "supervisor_signature"]) {
    assert.equal(new RegExp(`CREATE (UNIQUE )?INDEX[^;]*"${column}"`, "i").test(sql), false, `${column} 不应建索引`);
    assert.equal(new RegExp(`UNIQUE\\s*\\("?${column}`, "i").test(sql), false, `${column} 不应有唯一约束`);
  }
  assert.equal(/ALTER TABLE "suppliers"[^;]*ADD CONSTRAINT[^;]*"address"/i.test(sql), false, "供应商地址不参与任何约束");
});
