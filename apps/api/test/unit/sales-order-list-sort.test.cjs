// 销售单列表排序的单元测试（2026-11-13；默认口径与数值比较 2026-11-19 T-0022）。
//
// 用户原话：「针对销售模块，用户需要给销售单排序，支持按照销售单号字典序排序，创建时间排序。」
// T-0022：「订单列表默认按订单号升序（从小到大）；纯数字订单号按数值比较（9 排在 10 之前）；
// 分页后整体顺序保持一致；空值排在最后。」
//
// 本文件钉的是**排序口径**本身（纯函数，不连数据库）。为什么值得单独钉：
//   · 接口是分页的，排序做在服务端 —— 映射写错的表现是"某一页顺序不对"，
//     那种错看起来总是像"数据库抽风"，很难追；
//   · 默认值必须与需求逐字一致（订单号升序），否则用户进来看到的仍是旧顺序；
//   · 纯数字按数值比较、空值最后、同值用 id 兜底，这三件事共同决定"翻页会不会重复/漏行"。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  salesOrderListOrderBy,
  salesOrderListSortKey,
  salesOrderListDirection,
  compareSalesOrderNo,
  sortSalesOrderRowsByOrderNo,
  SALES_ORDER_LIST_SORTS,
  SALES_ORDER_LIST_DIRECTIONS,
  SALES_ORDER_LIST_SORT_LABELS,
  DEFAULT_SALES_ORDER_LIST_SORT,
  DEFAULT_SALES_ORDER_LIST_DIRECTION,
} = require("../../dist/modules/sales/sales-order-list-sort.js");

test("销售单排序：不传参数 = 订单号升序（T-0022 的默认口径）", () => {
  assert.deepEqual(salesOrderListOrderBy(), [{ orderNo: "asc" }, { id: "asc" }]);
  assert.equal(DEFAULT_SALES_ORDER_LIST_SORT, "order_no");
  assert.equal(DEFAULT_SALES_ORDER_LIST_DIRECTION, "asc");
  assert.equal(salesOrderListSortKey(undefined), "order_no");
  assert.equal(salesOrderListDirection(undefined), "asc");
});

test("销售单排序：订单号映射（升/降）", () => {
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
  assert.deepEqual(salesOrderListOrderBy("nope", "asc"), [{ orderNo: "asc" }, { id: "asc" }], "键认不出 → 落到默认键，但方向是有效的，照用");
  assert.deepEqual(salesOrderListOrderBy("order_no", "sideways"), [{ orderNo: "asc" }, { id: "asc" }], "方向认不出 → 落到默认方向（升序），键照用");
  assert.deepEqual(salesOrderListOrderBy(null, null), [{ orderNo: "asc" }, { id: "asc" }], "两个都不给 = 默认（订单号升序）");
});

test("销售单排序：六个组合都有中文文案（下拉里少一项就是少一条出路）", () => {
  const combos = SALES_ORDER_LIST_SORTS.flatMap((sort) => SALES_ORDER_LIST_DIRECTIONS.map((direction) => `${sort}:${direction}`));
  assert.deepEqual(Object.keys(SALES_ORDER_LIST_SORT_LABELS).sort(), [...combos].sort());
  const labels = Object.values(SALES_ORDER_LIST_SORT_LABELS);
  assert.equal(new Set(labels).size, labels.length, "六条文案不能有两项同名 —— 下拉里会有两个一样的选项");
  assert.equal(SALES_ORDER_LIST_SORT_LABELS["order_no:asc"], "订单号（从小到大）");
  assert.equal(SALES_ORDER_LIST_SORT_LABELS["order_no:desc"], "订单号（从大到小）");
});

test("订单号比较：纯数字按数值，不受位数/前导零影响（9 排在 10 之前）", () => {
  assert.ok(compareSalesOrderNo("9", "10") < 0, "9 < 10（字符串序会反过来）");
  assert.ok(compareSalesOrderNo("99", "100") < 0, "两位数 < 三位数");
  assert.ok(compareSalesOrderNo("2", "10") < 0);
  assert.ok(compareSalesOrderNo("10", "2") > 0);
  // 超过 Number.MAX_SAFE_INTEGER 也要保持精度：9007199254740993 与 ...992 用 Number 会相等。
  assert.ok(compareSalesOrderNo("9007199254740993", "9007199254740992") > 0, "BigInt 比较不能丢精度");
  // 数值相等时用原始字符串兜底，保证同一批数据每次排序结果一致。
  assert.equal(compareSalesOrderNo("09", "9") < 0, true, "数值相等时 09 在 9 前（确定的兜底，不是随机顺序）");
});

test("订单号比较：非纯数字按字符串；纯数字组在升序时排在非纯数字前", () => {
  assert.ok(compareSalesOrderNo("A-1", "B-1") < 0);
  assert.ok(compareSalesOrderNo("DL10", "DL2") < 0, "非纯数字仍按字符串序（T-0022 只要求纯数字按数值）");
  assert.ok(compareSalesOrderNo("9", "DL2") < 0, "升序：纯数字组在前");
  assert.ok(compareSalesOrderNo("DL2", "9") > 0);
  assert.ok(compareSalesOrderNo("DL2", "9", "desc") < 0, "降序整体反转：非纯数字组在前");
});

test("订单号比较：null / undefined / 空白一律排最后，升序降序都一样", () => {
  for (const direction of [undefined, "asc", "desc"]) {
    assert.ok(compareSalesOrderNo(null, "1", direction) > 0, `${direction}: null 在非空后`);
    assert.ok(compareSalesOrderNo("1", null, direction) < 0, `${direction}: 非空在 null 前`);
    assert.ok(compareSalesOrderNo("   ", "1", direction) > 0, `${direction}: 纯空白等同 null`);
    assert.ok(compareSalesOrderNo(undefined, "DL2", direction) > 0, `${direction}: undefined 最后`);
    assert.equal(compareSalesOrderNo(null, "   ", direction), 0, `${direction}: 两个空值相等`);
  }
});

test("订单号排序：全序 + 分页切片 = 整体顺序（翻页不重复、不遗漏）", () => {
  const rows = [
    { id: "08", orderNo: "10" },
    { id: "03", orderNo: "9" },
    { id: "01", orderNo: "2" },
    { id: "99", orderNo: null },
    { id: "00", orderNo: "" },
    { id: "07", orderNo: "A-1" },
  ];
  const ascending = sortSalesOrderRowsByOrderNo(rows).map((row) => row.id);
  assert.deepEqual(ascending, ["01", "03", "08", "07", "00", "99"], "2 → 9 → 10 → A-1 → 空值（空值内按 id 升序）");

  // 每页 2 条：三页拼起来必须逐字等于整体顺序，且没有重复/漏行。
  const pages = [0, 1, 2].map((index) => sortSalesOrderRowsByOrderNo(rows).slice(index * 2, (index + 1) * 2).map((row) => row.id));
  assert.deepEqual(pages.flat(), ascending);
  assert.equal(new Set(pages.flat()).size, rows.length);

  const descending = sortSalesOrderRowsByOrderNo(rows, "desc").map((row) => row.id);
  assert.deepEqual(descending, ["07", "08", "03", "01", "00", "99"], "降序整体反转，但空值仍最后");

  // 方向非法与不传同义（回落到默认升序），不能让排序悄悄变成 undefined。
  assert.deepEqual(sortSalesOrderRowsByOrderNo(rows, "sideways").map((row) => row.id), ascending);
});
