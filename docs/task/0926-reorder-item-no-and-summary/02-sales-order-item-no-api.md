# T02 货号字段：写读侧与归一

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §三.1
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T01](./01-sales-order-item-no-schema.md)（列与 Prisma Client 字段）。后续 [T03](./03-item-no-on-printing-exports.md)、
[T04](./04-sales-order-item-no-web.md)、[T05](./05-reorder-create-service.md)、[T07](./07-reorder-articles-api.md) 都依赖本任务的归一函数。

## 目标

销售单能存、能改、能搜货号；版本快照每版都记货号；**归一逻辑只有一处实现**，供后续按货号分组的所有功能复用。

## 关联决策

- 货号**可空、不阻断确认**（设计文档 §三.1 与 §九.2）。
- 货号**不进 `coreFields`**：它不锁下游。
- 存原样展示、按归一键匹配（批次 README 口径红线）。

## 范围与非范围

**范围**

- 新增 `apps/api/src/modules/sales/item-no.ts`（归一函数，纯函数）。
- `sales-orders.controller.ts` 的 `SalesOrderDto` 加两个可选字段。
- `sales-orders.service.ts`：`SalesOrderBaseInput`、`create`、`update`、`snapshot`、`list` 搜索。
- `apps/api/test/sales-order-chain.test.cjs` 增补用例。
- 新增 `apps/api/test/unit/item-no.test.cjs`（归一函数的向量表）。

**非范围**

- 不做前端（[T04](./04-sales-order-item-no-web.md)）。
- 不改 `confirm()`：**本轮不强制**确认时必须有货号。
- 不做货号下拉的候选来源接口（[T07](./07-reorder-articles-api.md) 提供）。
- 不改 `specScalarRow` / `SPEC_SCALAR_FIELDS`——货号是 basic 字段，不是那 37 个细化标量。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/sales/item-no.ts` | 新建：`ITEM_NO_MAX_LENGTH`、`normalizeItemNo`、`itemNoKey`、`itemNoKeyOrNull` |
| `apps/api/src/modules/sales/sales-orders.controller.ts` | `SalesOrderDto` 加 `item_no`、`reorder_from_order_no` |
| `apps/api/src/modules/sales/sales-orders.service.ts` | `SalesOrderBaseInput` 加两键；`create` 落库；`update` 分支；`snapshot()` 与 `specSnapshotFields` 同级补货号；`list()` 搜索加 `itemNo` |
| `apps/api/test/unit/item-no.test.cjs` | 新建 |
| `apps/api/test/sales-order-chain.test.cjs` | 增补约 7 条 |

## 实施要点

**归一函数（唯一真源）**

```ts
export const ITEM_NO_MAX_LENGTH = 100;
/** 展示用：去掉首尾空白、把内部连续空白折叠成一个空格。存进库的是这个值。 */
export function normalizeItemNo(value: string | null | undefined): string | null;
/** 匹配/分组用：normalize 之后去空白 + 转大写。库里不存这个值，查询与分组一律用它。 */
export function itemNoKey(value: string | null | undefined): string;
export function itemNoKeyOrNull(value: string | null | undefined): string | null;
```

理由写进函数注释：OCR/手抄过来的货号会有 `27621`、` 27621 `、`27621`（全角空格）三种写法，
不归一就会出现「同一个货号两个分组」，而那正是老板要「调取该货号」时最怕的结果。

**DTO 语义**（与 `SalesOrderSpecDto` 的注释保持一致）

- `item_no`：`@IsOptional() @IsString() @MaxLength(ITEM_NO_MAX_LENGTH) item_no?: string | null;`
  **空串的语义是「清除货号」**（落 `NULL`），不是「不动」——与 37 个细化标量的口径一致，别写反。
- `reorder_from_order_no`：`@IsOptional() @IsString() @MaxLength(100)`。这个键由 [T05](./05-reorder-create-service.md)
  写入，**更新接口要拒绝改它**（返单来源是既成事实）：`update()` 里显式忽略该键的请求值。

**写入**

- `create()`：`itemNo: normalizeItemNo(input.item_no)`、`reorderFromOrderNo: input.reorder_from_order_no ?? null`。
- `update()`：`...(input.item_no === undefined ? {} : { itemNo: normalizeItemNo(input.item_no) })`；
  `reorder_from_order_no` **不接受更新**（保持已有值）。
- 已确认单改货号的「必须填原因」**已经由现成代码保证**（`sales-orders.service.ts` 里
  `current.status === "confirmed" && !input.reason?.trim()` → 422 `CORRECTION_REASON_REQUIRED`），
  本任务**只需确认它没被绕过**，不要新增守卫、也**不要**把 `item_no` 加进 `coreFields`。
  加进 `coreFields` 的后果：下单后想改一个打错的货号，必须先回退 BOM/采购/生产——那是不可接受的。

**版本快照**

- `snapshot()` 与 `specSnapshotFields()` 现在按固定键清单拷贝。货号要**每个版本都记**
  （没填记 `null`），理由与 37 个标量相同：只记「这次改了哪几个」会让回看时以为当时货号是空的。
- `get()` 返回的是 Prisma 行，`itemNo` 会自动带上，**不要**再加一个 snake_case 别名
  （那个坑在 `specScalarRow` 的注释里记着：两套键名丢过一次数据）。

**搜索**

- `list()` 的 `where.OR` 现在只有 `orderNo` / `productName`，加 `itemNo`。
  注意：`contains` + `mode: "insensitive"` 覆盖大小写，但**不覆盖内部空格**——
  搜「27621」要能命中存成「27621 流水花扇」的货号吗？**不要**在这里做模糊归一搜索：
  只做 `contains`，精确的按货号查由 `T07` 的 `q` 参数负责。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 归一：首尾空白/内部多空白/全角空格 → 同一个 key | `unit/item-no.test.cjs` |
| 2 | 归一不改变大小写以外的语义（存原样、key 大写） | 同上 |
| 3 | 新建销售单可带货号；不传时为空 | `sales-order-chain.test.cjs` |
| 4 | 空串 = 清除货号（落 `NULL`），不是「不动」 | 同上 |
| 5 | 版本快照 v1、v2 都含货号（改了货号后 v2 记新值、v1 仍是旧值） | 同上 |
| 6 | 已确认单改货号必须填原因 | 同上（现有守卫的回归断言） |
| 7 | **已确认单改货号不锁下游**：已有 BOM/采购/生产时仍可改 | 同上（对照 `SALES_ORDER_CORE_FIELDS_LOCKED` 的用例形状） |
| 8 | 列表按货号搜索命中 | 同上 |
| 9 | `reorder_from_order_no` 不能被 update 改写 | 同上 |

命令：`npm run typecheck` → `npm run test:unit:api`。

## 决策记录

- **不强制货号**（不阻断 `confirm`）：历史单没有货号，强制会让既有「确认」动作变成破坏性变更。
  真要对老板承诺「每张单都有货号」，只需在 `confirm()` 里加一处守卫 + 一次性补录——
  这个口子留在 [T12](./12-reorder-history-backfill.md)，届时由用户拍板。
- **`item_no` 不进 `coreFields`**：见实施要点。

## 完成记录

**2026-09-26 完成**（提交 `6e81848`）。

- 交付物：`apps/api/src/modules/sales/item-no.ts`（`ITEM_NO_MAX_LENGTH` / `normalizeItemNo` / `itemNoKey` / `itemNoKeyOrNull`）；
  DTO 两个字段；`create` / `update` / `snapshot` / `list` 搜索；`apps/api/test/unit/item-no.test.cjs`（6 条向量与语义）+ 
  `sales-order-chain.test.cjs` 增补 6 条（共 18 条）。
- 与计划的差异：
  1. `SalesOrderUpdate` 直接在**类型层排除** `reorder_from_order_no`（比"实现里忽略"更硬），
     并配一条测试：用 `reorder_from_order_no` 硬塞进去也不会被写。
  2. 快照里的货号**先归一**再入快照 —— 原计划只说"进快照"，不归一会出现「库里 `27621`、快照 ` 27621 `」。
  3. 货号写进 `nextInput` 的回填：`update` 没传货号时也要把**当前值**写进快照（每版快照是全量口径）。
- **踩到的坑（被测试抓住）**：插入 `item_no` 分支时我漏掉了 `...this.specScalars(input)`，
  于是 37 个细化标量在更新时全部写不进去 —— `sales-order-spec.test.cjs` 的
  「更新：没传的细化键不动，传空串 = 清除这一格」直接红了。这正是本仓库那条"加列时别把旁边的东西挤掉"的教训。
- 验证：`npm run typecheck` 通过；`npm run test:unit:api` **2044/2044**。
- **未验证**：`GET /sales-orders` 的货号搜索只在假 Prisma 上验过 where 形状，未在真实库上跑 SQL。
- 未做（按设计留的口子）：**不强制**确认时必须有货号；`confirm()` 未改动。
