// 销售单列表排序的单元测试（2026-11-13）。
//
// 用户原话：「针对销售模块，用户需要给销售单排序，支持按照销售单号字典序排序，创建时间排序。」
//
// 本文件钉的是**排序口径**本身（纯函数，不连数据库）。为什么值得单独钉：
//   · 接口是分页的，排序做在服务端 —— 映射写错的表现是"某一页顺序不对"，
//     那种错看起来总是像"数据库抽风"，很难追；
//   · 默认值必须与改造前**逐字一致**（`updatedAt desc`），否则老调用方的顺序会静默变化。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  salesOrderListOrderBy,
  SALES_ORDER_LIST_SORTS,
  SALES_ORDER_LIST_DIRECTIONS,
  SALES_ORDER_LIST_SORT_LABELS,
  DEFAULT_SALES_ORDER_LIST_SORT,
  DEFAULT_SALES_ORDER_LIST_DIRECTION,
} = require("../../dist/modules/sales/sales-order-list-sort.js");

test("销售单排序：不传参数 = 最后修改倒序（与改造前的行为逐字一致）", () => {
  assert.deepEqual(salesOrderListOrderBy(), [{ updatedAt: "desc" }, { id: "asc" }]);
  assert.equal(DEFAULT_SALES_ORDER_LIST_SORT, "updated_at");
  assert.equal(DEFAULT_SALES_ORDER_LIST_DIRECTION, "desc");
});

test("销售单排序：订单号字典序（升/降）", () => {
  assert.deepEqual(salesOrderListOrderBy("order_no", "asc"), [{ orderNo: "asc" }, { id: "asc" }]);
  assert.deepEqual(salesOrderListOrderBy("order_no", "desc"), [{ orderNo: "desc" }, { id: "asc" }]);
});

test("销售单排序：创建时间（升/降）", () => {
  assert.deepEqual(salesOrderListOrderBy("created_at", "asc"), [{ createdAt: "asc" }, { id: "asc" }]);
  assert.deepEqual(salesOrderListOrderBy("created_at", "desc"), [{ createdAt: "desc" }, { id: "asc" }]);
});

test("销售单排序：每个键都带 `id` 作为第二排序键（否则同批量导入的行分页会重复/漏掉）", () => {
  // 同一批 Excel 补录的时间戳可能相同：只按 createdAt 排时数据库给的顺序**不确定**，
  // 同一页翻两次可能给出不同的行。id 是主键，补上它排序才是全序。
  for (const sort of SALES_ORDER_LIST_SORTS) {
    for (const direction of SALES_ORDER_LIST_DIRECTIONS) {
      const orderBy = salesOrderListOrderBy(sort, direction);
      assert.equal(orderBy.length, 2, `${sort}/${direction} 必须有两个排序键`);
      assert.deepEqual(orderBy[1], { id: "asc" }, `${sort}/${direction} 的第二排序键必须是 id`);
    }
  }
});

test("销售单排序：认不出的值回落到默认（校准入参是 DTO 的职责，这里再抛只会变成 500）", () => {
  // 两个参数**各自独立**回落 —— 一个参数拼错不该把另一个参数的意思也丢掉：
  assert.deepEqual(salesOrderListOrderBy("nope", "asc"), [{ updatedAt: "asc" }, { id: "asc" }], "键认不出 → 落到默认键，但方向是有效的，照用");
  assert.deepEqual(salesOrderListOrderBy("order_no", "sideways"), [{ orderNo: "desc" }, { id: "asc" }], "方向认不出 → 落到默认方向，键照用");
  assert.deepEqual(salesOrderListOrderBy(null, null), [{ updatedAt: "desc" }, { id: "asc" }], "两个都不给 = 默认（最后修改倒序）");
});

test("销售单排序：六个组合都有中文文案（下拉里少一项就是少一条出路）", () => {
  const combos = SALES_ORDER_LIST_SORTS.flatMap((sort) => SALES_ORDER_LIST_DIRECTIONS.map((direction) => `${sort}:${direction}`));
  assert.deepEqual(Object.keys(SALES_ORDER_LIST_SORT_LABELS).sort(), [...combos].sort());
  const labels = Object.values(SALES_ORDER_LIST_SORT_LABELS);
  assert.equal(new Set(labels).size, labels.length, "六条文案不能有两项同名 —— 下拉里会有两个一样的选项");
});
