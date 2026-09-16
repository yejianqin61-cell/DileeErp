// 「确认应收 / 确认应付」前端筛选口径的守卫。与后端 `apps/api/src/modules/finance/ledger-filter.ts`
// 是同一套口径的两份实现：界面显示、勾选范围与**导出参数**都走这里，
// 所以任何一处改了分档规则，导出的文件就会和界面不一致（「界面 3 条、文件 8 条」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAID_LEDGER_STATUSES, ledgerExportQuery, paymentBucket, paymentCounts, withinDateRange,
} from "./finance-ledger-filter.ts";

test("付款分档：草稿=未付；已确认及以后=已付；冲销/作废/取消只在「全部」里出现", () => {
  assert.equal(paymentBucket("draft"), "unpaid");
  for (const status of PAID_LEDGER_STATUSES) assert.equal(paymentBucket(status), "paid");
  for (const status of ["reversed", "voided", "cancelled", "closed"]) assert.equal(paymentBucket(status), "void");
});

test("计数：all 含作废/冲销，所以不等于未付 + 已付", () => {
  assert.deepEqual(paymentCounts([{ status: "draft" }, { status: "confirmed" }, { status: "voided" }]), { unpaid: 1, paid: 1, void: 1, all: 3 });
  assert.deepEqual(paymentCounts([]), { unpaid: 0, paid: 0, void: 0, all: 0 });
});

test("日期区间含两端；设了区间时没有日期的行不算命中", () => {
  assert.equal(withinDateRange("2026-09-10T00:00:00.000Z", "2026-09-01", "2026-09-30"), true);
  assert.equal(withinDateRange("2026-09-01T00:00:00.000Z", "2026-09-01", "2026-09-30"), true);
  assert.equal(withinDateRange("2026-09-30T00:00:00.000Z", "2026-09-01", "2026-09-30"), true);
  assert.equal(withinDateRange("2026-08-31T00:00:00.000Z", "2026-09-01", undefined), false);
  assert.equal(withinDateRange("2026-10-01T00:00:00.000Z", undefined, "2026-09-30"), false);
  assert.equal(withinDateRange(null, "2026-09-01", undefined), false);
  assert.equal(withinDateRange(null, undefined, undefined), true, "不设区间时不做日期排除");
});

test("导出查询串与界面筛选一一对应（导出的就是所见）", () => {
  assert.equal(ledgerExportQuery({ payment: "unpaid" }), "payment=unpaid");
  assert.equal(
    ledgerExportQuery({ payment: "paid", from: "2026-09-01", to: "2026-09-30", q: " 晋江 " }),
    "payment=paid&from=2026-09-01&to=2026-09-30&q=%E6%99%8B%E6%B1%9F",
  );
  assert.equal(ledgerExportQuery({ payment: "all", q: "   " }), "payment=all", "纯空白的关键字不进查询串");
});
