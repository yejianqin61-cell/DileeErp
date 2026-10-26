// 来源展示（lib/agent-sources.ts）的单元测试：类型翻译、去重与条数上限。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOURCE_TYPE_LABELS, sourceLabel, sourceTypeLabel, uniqueSources } from "./agent-sources.ts";

test("常见单据类型翻成中文；认不出的类型不把英文标识甩给用户", () => {
  assert.equal(sourceTypeLabel("sales_order"), "销售单");
  assert.equal(sourceTypeLabel("purchase_order"), "采购单");
  assert.equal(sourceTypeLabel("production_order"), "生产单");
  assert.equal(sourceTypeLabel("finished_goods_outbound"), "成品出库");
  assert.equal(sourceTypeLabel("some_future_type"), "单据");
  assert.equal(SOURCE_TYPE_LABELS.receivable_source, "应收来源");
});

test("来源标签 = 类型 + 单号", () => {
  assert.equal(sourceLabel({ business_type: "sales_order", business_no: "SO-2026-001" }), "销售单 SO-2026-001");
  assert.equal(sourceLabel({ business_type: "unknown_type", business_no: "X-1" }), "单据 X-1");
});

test("同一单据被多次工具调用重复产出时去重，顺序保持首次出现", () => {
  const sources = [
    { business_type: "sales_order", business_no: "SO-1" },
    { business_type: "purchase_order", business_no: "PO-1" },
    { business_type: "sales_order", business_no: "SO-1" },
    { business_type: "sales_order", business_no: "SO-2" },
  ];
  assert.deepEqual(uniqueSources(sources).map((source) => `${source.business_type}:${source.business_no}`), ["sales_order:SO-1", "purchase_order:PO-1", "sales_order:SO-2"]);
});

test("来源超过上限时截断，避免来源区把回答挤下去", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ business_type: "sales_order", business_no: `SO-${index}` }));
  assert.equal(uniqueSources(many).length, 12);
  assert.equal(uniqueSources(many, 3).length, 3);
  assert.deepEqual(uniqueSources([]), []);
});
