# T12 历史单未填货号补录

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §六
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T07](./07-reorder-articles-api.md)（`unassigned=true`）、[T11](./11-reorder-page.md)（页面容器）、
[T02](./02-sales-order-item-no-api.md)（`item_no` 可更新）。

## 目标

让「货号为空的历史销售单」有一个可见的待办清单，并且能被逐个/批量指派——**而不是让实现者去数据库里 UPDATE**。

## 关联决策

- 设计文档 §六：**绝不从品名/品番自动猜货号**。猜错会把两批不同的货合并成一个货号，
  比空着糟糕得多（空着只是查不到，猜错是查到错的）。
- 不新增批量接口，逐条走既有 `PATCH /sales-orders/:id`：批量接口会绕开"已确认单改货号要填原因"的守卫与审计。

## 范围与非范围

**范围**

- `/reorder` 页面上的「未填货号」入口与待办表。
- 逐行指派（单选既有货号或输新货号）、勾选批量指派（前端循环调用既有接口）。
- `apps/web/test/reorder-page.test.tsx` 增补。

**非范围**

- 不做数据迁移/回填脚本（**明确不做**：让系统自己写出货号需要人判断，脚本只能靠猜）。
- 不强制确认时有货号（那是 [T02](./02-sales-order-item-no-api.md) 决策记录里留的口子，需用户单独拍板）。
- 不改历史已关闭单的其它字段。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/web/components/reorder/article-list.tsx` | 「未填货号（N）」页签/入口，走 `GET /reorder/articles?unassigned=true` |
| `apps/web/components/reorder/unassigned-panel.tsx` | 新建：待办表 + 指派 |
| `apps/web/test/reorder-page.test.tsx` | 增补约 6 条 |

## 实施要点

**1. 待办表列**

销售单号 / 客户 / 产品名称 / 数量+单位 / 下单日期 / 状态 / 操作。
按 `order_date desc` 排（最近的历史单最可能要补）。**不要**显示 `item_no` 列（全是空）。

**2. 指派**

- 单行：货号输入用 [T04](./04-sales-order-item-no-web.md) 的 `ItemNoInput`（建议来自 `GET /sales-orders/item-nos`）。
- 批量：勾选多行 → 弹出一次输入（既有 `ActionDialog` 或 `Dialog`，**不要**用 `window.prompt`——
  全站治理轮已移除原生弹窗）→ **逐条**发 `PATCH /sales-orders/:id`，请求体
  `{ item_no, reason }`；已确认单（`status === "confirmed"`）必须带上原因，
  原因输入框在同一次弹窗里获得（文案：「已确认单改货号需填原因」）。
- 逐条结果要**逐条反馈**：成功 N 条、失败 M 条并列出失败的单号与后端 message。
  静默失败会让业务以为补完了、实际没补——这类缺陷在财务批量导入上出现过（见
  [other-payable-batch-import 相关设计](../../design/finance-batch-payment-and-transfer-slip-2026-09-24.md) 同族问题）。
- 每条成功后从待办表里移除该行（局部更新，不要整表重拉；重拉会让用户丢失勾选状态）。

**3. 口径一致性**

补录写的值和 [T02](./02-sales-order-item-no-api.md) 的归一函数处理的是同一个字段，
所以**输入框不要自己 trim/大写**——把原样交给服务端。前端只做「非空」判断。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 待办表只显示货号为空的销售单（含已关闭，排除软删） | `reorder-page.test.tsx` |
| 2 | 单行指派成功后该行消失、其余行与勾选状态保留 | 同上 |
| 3 | 已确认单指派时必须填原因，未填不发请求并给出提示 | 同上 |
| 4 | 批量指派逐条发请求；部分失败时列出失败单号与原因 | 同上 |
| 5 | 指派后不往 `/reorder` 汇总里塞未归一的值（大小写变体归到同一货号） | 同上 |
| 6 | 后端 422（如 `CORRECTION_REASON_REQUIRED`）时页面显示后端原文 | 同上 |

命令：`npm run typecheck` → `cd apps/web; npm run test:unit`。

## 决策记录

- **不做自动回填脚本**：见「关联决策」。
- **不做批量接口**：见「关联决策」。

## 完成记录

（认领后填写。若业务要求"以后必须填货号才能确认"，在这里记下当时的决定与改动点。）
