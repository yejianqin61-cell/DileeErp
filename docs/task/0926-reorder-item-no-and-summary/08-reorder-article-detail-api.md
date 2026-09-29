# T08 货号详情：批次序列与跨批汇总

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §三.2
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T07](./07-reorder-articles-api.md)（模块骨架、归一、分行汇总、`reorder.domain.ts`）。
后续 [T09](./09-reorder-documents-and-timeline-api.md)、[T11](./11-reorder-page.md) 依赖它。

## 目标

给定一个货号，返回**它做过的每一批**（销售单）与跨批汇总，让业务一眼看到「这个货做过几次、每次多少、QC 怎么样」，
并知道哪一批可以拿去返单。

## 关联决策

- 货号是分组键，销售单是"批"（设计文档 §一.3、§五）。
- **不重复实现工作台的阻塞计算**：本接口只给「跨批汇总 + 每批状态」，阻塞与推进看工作台（见下）。

## 范围与非范围

**范围**

- `GET /reorder/articles/:item_no`。
- `apps/api/test/unit/reorder-article-detail.test.cjs`。

**非范围**

- 单据清单与时间线（[T09](./09-reorder-documents-and-timeline-api.md)）。
- 工作台 `order-workbench.service.ts` 的改动——**一行都不要改**（它被 37 条契约测试钉着）。
- 毛利、交期达成（[T14](./14-reorder-summary-enhancement.md)）。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/reorder/reorder.controller.ts` | `@Get("articles/:item_no")` |
| `apps/api/src/modules/reorder/reorder.service.ts` | `articleDetail(itemNo, filter)` |
| `apps/api/test/unit/reorder-article-detail.test.cjs` | 新建（约 10 条） |
| `apps/api/test/http/authorization-matrix-contract.test.cjs` | 端点登记 |

## 实施要点

**1. 路径参数的归一**

`:item_no` 由前端 `encodeURIComponent` 传入。服务端拿到后先 `itemNoKey()`，再按归一键匹配
（库里存原样，所以匹配要拉出候选行在内存里比 key——与 [T07](./07-reorder-articles-api.md) 同一套办法，
**复用 T07 里已经写好的候选筛选函数，不要抄第二遍**）。

货号里有 `/`、空格、中文都可能（`27621 流水花扇PKY`），必须走 `encodeURIComponent`；
控制器不用做特殊处理，Nest 会解码。

**2. 响应形状**

```jsonc
{
  "data": {
    "item_no": "27621",              // 该货号下订单里出现最多的那个写法（展示用）
    "item_no_key": "27621",
    "summary": {
      "order_count": 3,
      "open_order_count": 1,          // 还有未完工生产单的批次数
      "first_order_date": "…", "last_order_date": "…", "last_delivery_date": "…",
      "quantities": [{ "unit": "支", "quantity": "5880" }],
      "purchase_amounts": [{ "currency": "CNY", "amount": "37036.8000" }],
      "receivable_amounts": [{ "currency": "USD", "amount": "7056.0000" }],
      "qc": { "inspected": "5880", "qualified": "5790", "conditional": "0", "rejected": "90", "qualified_rate": "0.9847" },
      "customers": [{ "customer_id": "…", "name": "FLOWER1", "order_count": 3 }]
    },
    "orders": [{
      "sales_order_id": "…", "order_no": "DL260001-1", "order_date": "…",
      "delivery_date": "…", "status": "closed", "quantity": "1960", "unit": "支",
      "customer": { "id": "…", "name": "FLOWER1" },
      "current_version": 2,
      "bom_versions": [1, 2],
      "purchase_order_count": 2, "production_order_count": 1,
      "qc_qualified_quantity": "1930", "qc_rejected_quantity": "30",
      "finished_inbound_quantity": "1930", "outbound_quantity": "1930",
      "reorder_from_order_no": null,
      "can_reorder": true, "can_reorder_reason": null
    }]
  },
  "meta": {}
}
```

- `orders` 按 `order_date` **升序**（时间线从最早到最近），同日按 `order_no` 升序——稳定排序，前端不做二次排序。
- 数量/金额一律字符串；空集合返回 `[]`。
- Decimal 0 也要给字符串 `"0"`，不要给 `null`（`null` 表示"没有事实"）。

**3. `can_reorder` 由服务端给（前端只读这个布尔）**

| 条件 | `can_reorder` | `can_reorder_reason` |
| --- | --- | --- |
| 状态 `confirmed` / `closed` 且有货号 | `true` | `null` |
| 状态 `draft` | `false` | `"草稿单不能作为返单来源"` |
| 该批（异常地）没有货号 | `false` | `"该批没有货号：请先补货号"` |

理由必须**由服务端给中文字面量**：前端自己拼条件，改口径时就会出现「按钮亮着、点了 422」——
这类不一致在仓库里已经出现过（见 [0917-采购单收束与编辑.md](../0917-procurement-collapse-and-edit.md) 的
「BOM 外新增原因无处可填」）。

**4. 阻塞与推进不在这里算**

工作台的 `summary()` 有 20 个查询、一大堆配平规则（`reconciliationBlockers`）与阻塞优先级。
本接口**只做货号轴上的汇总**，每批的状态字段（生产单数、QC 数、出货数）已经足够让业务判断"哪批值得返"。
详细阻塞给一个跳转：响应里带 `workbench_href: "/?order_no=…"`（前端展示为「看该批全链路」）。
**决策理由**：两套阻塞计算一定会漂移，而漂移的后果是业务在 `/reorder` 看到"没问题"、在工作台看到"卡住了"。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 归一键匹配：用 `27621`、` 27621 `、小写变体都能取到同一组批次 | `unit/reorder-article-detail.test.cjs` |
| 2 | 批次按 `order_date` 升序、同日按 `order_no` 升序 | 同上 |
| 3 | 跨批汇总的数量按单位分行、金额按币种分行 | 同上 |
| 4 | `qualified_rate` 分母为 0 → `null` | 同上 |
| 5 | 软删订单默认排除、`include_deleted=true` 纳入；已关闭默认纳入 | 同上 |
| 6 | `can_reorder` 三态与理由文案（草稿 / 无货号 / 可返） | 同上（逐条断言中文文案） |
| 7 | 货号不存在 → `data: null` 还是 404？**实现时二选一并写进决策记录**（建议 404 `ARTICLE_NOT_FOUND`，与工作台 `ORDER_NOT_FOUND` 一致） | 同上 |
| 8 | 每批带 `workbench_href`，且与工作台路由一致 | 同上 |
| 9 | 0 值给 `"0"` 而不是 `null` | 同上 |
| 10 | 日期一律 ISO 字符串（不要返回 `Date` 对象让 JSON 自己转） | 同上 |

命令：`npm run typecheck` → `npm run test:unit:api`。

## 决策记录

- **不在本模块重算阻塞**：见实施要点 4。
- **404 vs 空对象**：实现时按建议取 404，并把最终选择写进「决策记录」——两种都能用，
  但**必须只选一种**，否则前端要写两套分支。

## 完成记录

（认领后填写。）
