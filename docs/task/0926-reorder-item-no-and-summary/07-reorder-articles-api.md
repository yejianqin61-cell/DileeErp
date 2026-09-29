# T07 货号清单接口（新模块骨架）

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §三.2
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T01](./01-sales-order-item-no-schema.md)、[T02](./02-sales-order-item-no-api.md)。后续 [T08](./08-reorder-article-detail-api.md)、
[T11](./11-reorder-page.md)、[T12](./12-reorder-history-backfill.md) 依赖它。

## 目标

建立 `reorder` 模块与「货号清单」读模型：一行一个货号，带订单数、数量、金额、客户、QC 合格率与首末下单日。

这是老板要的「**可以调取该货号**」的入口，也是「货号池」的实体——它是销售单的投影，不是新主数据。

## 关联决策

- 不建货号主数据表（设计文档 §二）。
- 数量按单位分行、金额按币种分行（批次 README 口径红线）。
- 只读模块，权限与工作台同口径：`@RequireAnyModules("sales","procurement","production","warehouse","finance","hr")`。

## 范围与非范围

**范围**

- 新建模块目录与三个文件、在 `app.module.ts` 注册。
- `GET /reorder/articles`。
- `apps/api/test/unit/reorder-articles.test.cjs`。
- `apps/api/test/http/authorization-matrix-contract.test.cjs` 登记新控制器与端点。

**非范围**

- 货号详情 [T08](./08-reorder-article-detail-api.md)、单据清单 [T09](./09-reorder-documents-and-timeline-api.md)。
- 页面与导航 [T11](./11-reorder-page.md)、[T10](./10-reorder-nav-and-permission.md)。
- 毛利与交期达成（[T14](./14-reorder-summary-enhancement.md)，P4）。
- 任何写入（本模块只有 [T12](./12-reorder-history-backfill.md) 用到的既有 `PATCH /sales-orders/:id`）。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/reorder/reorder.module.ts` | 新建 |
| `apps/api/src/modules/reorder/reorder.controller.ts` | 新建：`@Controller("reorder")` + 守卫 + `@RequireAnyModules(...)` |
| `apps/api/src/modules/reorder/reorder.service.ts` | 新建：`listArticles(filter)` |
| `apps/api/src/modules/reorder/reorder.domain.ts` | 新建：分行汇总、合格率等纯函数（可单测） |
| `apps/api/src/app.module.ts` | 注册 `ReorderModule`（照 `OrderWorkbenchModule` 的位置） |
| `apps/api/test/unit/reorder-articles.test.cjs` | 新建（约 12 条） |
| `apps/api/test/http/authorization-matrix-contract.test.cjs` | `CONTROLLER_FILES` + `ENDPOINTS` 登记 |

## 实施要点

**1. 查询参数（DTO，照 `WorkbenchQueryDto` 的写法）**

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `q` | — | 按**归一键** contains（大小写与空白不敏感） |
| `customer_id` | — | 只看买过该客户的货号 |
| `include_closed` | `true` | 已关闭订单是否纳入（默认纳入：返单看的是历史经营事实） |
| `include_deleted` | `false` | 软删销售单是否纳入 |
| `unassigned` | `false` | `true` 时**只**返回没有货号的订单（[T12](./12-reorder-history-backfill.md) 的待办表用；此时 `item_no` 为 `null` 的分组） |
| `page` / `page_size` | 1 / 20（上限 200） | 与工作台一致 |

**2. ⚠️ 归并是本地内存做的，不要在数据库里指望分组相等**

`prisma.salesOrder.groupBy({ by: ["itemNo"] })` 按**列值**分组，`27621` 与 `27621 `（尾空格）
会分成两行，而它们按业务是同一个货号。Prisma 不支持按表达式 `groupBy`。所以：

```
第一步：拉出全部匹配订单的**轻字段**（id, orderNo, itemNo, orderDate, quantity, unit, status, currency, deliveryDate, customerId）
        —— 只 select 需要的列，不要 include 关系
第二步：按 itemNoKey 在内存里归并 → 得到货号全集（含 order_count / min(orderDate) / max(orderDate) / 客户集合）
第三步：排序（默认 order_count desc, item_no asc；或按 last_order_date desc —— 实现时任选一个并在响应里稳定）→ 分页切片
第四步：只对**该页货号**的订单做重量查询（采购金额、QC 汇总等聚合）
```

**为什么允许第一步全量**：销售单是千级规模，轻字段全量拉取的代价远低于「先把分组算错」；
真正贵的是下游聚合，而那只对当前页的货号做。**如果将来销售单过万**，再换成
`$queryRaw` 的 `upper(btrim(replace(...)))` 表达式分组——这个升级点在注释里写清楚，别让下一个人猜。

**3. 分行汇总（`reorder.domain.ts` 的纯函数）**

- 数量：`[{ unit, quantity }]`，**按单位分行**，单位相同才相加；单位为空归到一个 `""` 行并保留。
- 金额：`[{ currency, amount }]`，按币种分行。P3 阶段含两组：**采购金额**（`purchaseOrder.totalAmount`）
  与**应收金额**（`receivableSource.amount`）。
- QC：`{ inspected, qualified, conditional, rejected, qualified_rate }`；
  `qualified_rate = qualified / inspected`，**`inspected = 0` 时返回 `null`**（不用 `0` 冒充，
  这是全站口径：没有事实就不给数字）。字符串 Decimal，比率给 4 位小数的字符串或 `null`。
- 全部 Decimal → 字符串；日期 → ISO 字符串。

**4. 响应形状**

```jsonc
{
  "data": [{
    "item_no": "27621",
    "item_no_key": "27621",
    "order_count": 3,
    "order_nos": ["DL260001-1", "DL260140-1", "DL260233-1"],
    "customer_names": ["FLOWER1"],
    "first_order_date": "2026-05-01T00:00:00.000Z",
    "last_order_date": "2026-09-20T00:00:00.000Z",
    "last_delivery_date": "2026-10-15T00:00:00.000Z",
    "open_order_count": 1,
    "quantities": [{ "unit": "支", "quantity": "1960" }],
    "purchase_amounts": [{ "currency": "CNY", "amount": "12345.6000" }],
    "receivable_amounts": [{ "currency": "USD", "amount": "2352.0000" }],
    "qc": { "inspected": "1960", "qualified": "1930", "conditional": "0", "rejected": "30", "qualified_rate": "0.9847" }
  }],
  "meta": { "page": 1, "page_size": 20, "total": 37 }
}
```

- 命名与工作台保持一致（snake_case、金额对象 `{ amount, currency }`）。
- `total` 是**归并后**的货号总数（不是销售单数）——这一点写进响应注释，避免前端把两个数读混。

**5. 权限矩阵登记**

`apps/api/test/http/authorization-matrix-contract.test.cjs` 是**手工清单**（`CONTROLLER_FILES` 约 `:80`、
`ENDPOINTS` 约 `:152`）。新端点是**只读 + 六模块任一可读**，照 `order-workbench.orders`（`:183`）那一条写。
这条测试跑不起来（需要真实环境）也要先把登记做对，否则部署侧的验收会红。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | `27621` / ` 27621 ` / 全角空格 → **一个**分组 | `unit/reorder-articles.test.cjs` |
| 2 | 数量按单位分行，不跨单位相加 | 同上 |
| 3 | 金额按币种分行，不跨币种相加 | 同上 |
| 4 | 已关闭订单默认纳入；`include_closed=false` 时排除 | 同上 |
| 5 | 软删订单默认排除；`include_deleted=true` 时纳入 | 同上 |
| 6 | 没有货号的订单**不进**清单，但 `unassigned=true` 时单独返回 | 同上 |
| 7 | `q` 按归一键匹配（大小写/空白不敏感） | 同上 |
| 8 | 分页：`total` 是货号数；第 2 页内容不重不漏 | 同上 |
| 9 | `inspected = 0` → `qualified_rate` 为 `null` 而不是 `0` | 同上 |
| 10 | 空结果返回 `data: []`、`total: 0`，不报错 | 同上 |
| 11 | 与工作台口径一致：同一订单的采购金额、QC 合格数两边相等 | 同上（交叉测试） |
| 12 | Decimal 一律字符串（含 `0` 值） | 同上 |

命令：`npm run typecheck` → `npm run test:unit:api`。

## 决策记录

- **内存归并**而不是表达式分组：见实施要点 2（含升级触发点）。
- **`total` 语义是货号数**：与 `reports` 那几个「`meta.total` 其实是本页行数」的既有缺陷端点区隔开
  （`apps/api/test/http/contract-guardrails.test.cjs:20-23` 记着这件事），本端点从一开始就做对。

## 完成记录

**2026-09-26 完成**（提交 `e193816`，在 T08 的提交里有一处响应形状的修正）。

- 交付物：`modules/reorder/{reorder.module,reorder.controller,reorder.service,reorder.domain}.ts`；
  `app.module.ts` 注册；`GET /reorder/articles`；`apps/api/test/unit/reorder-articles.test.cjs`（21 条）；
  权限矩阵登记第 40 个控制器。
- 与计划的差异：
  1. **`unassigned` 参数改成一个独立端点 `GET /reorder/unassigned-orders`**：待补录要的是**订单行**
     （按单补货号），而货号清单是**货号组**。塞进同一个端点会让响应变成两种形状，
     前端得写两套分支。功能等价、形状更清楚，T12 因此变成纯前端任务。
  2. `LIGHT_SELECT` 里多取了 `currentVersion` / `customerId` / `reorderFromOrderNo`（T08 的详情要用），
     避免同一个查询写两遍。
  3. 排序改用**码位比较**而不是 `localeCompare`：后者受运行环境 ICU/locale 影响，
     会让"同一页里行的先后换台机器就变"，测试也变成环境相关。
- **测试暴露的一个真缺陷（在 T08 的提交里修掉）**：`aggregate()` 当时是 `{...article, ...}` 展开，
  于是清单响应**同时**给了 `itemNo`（camel）与 `item_no`（snake）两套键名 ——
  一个响应两种键名正是本仓库反复踩过的那类坑（读侧取到 undefined 而没人发现）。
  现在统一 snake_case，两个测试文件都钉住。
- 验证：`npm run typecheck` 通过；`npm run test:unit:api` **2091/2091**（T07 + T08 合计）。
- **未验证**：`groupBy`/`findMany` 的真实 SQL 只跑过假 Prisma；http 契约里的矩阵条目（第 40 个控制器）
  需真实环境才能执行。
- 踩到的坑：`localeCompare` 的那次是**测试先红**才发现的（`支` 与 `打` 的顺序），
  正好说明"顺序进响应"这件事必须用与环境无关的比较器。
