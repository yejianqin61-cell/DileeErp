# T13 采购页 `?order_no=` 深链补口（独立小改动）

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §九.1
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

无。可插在任何空档；[T11](./11-reorder-page.md) 的跳转映射期望它落地（但**不阻塞** T11——
T11 的单据清单本来就在页内列出）。

## 目标

修一个**既有缺陷**：工作台（与将来的 `/reorder`）给出 `/procurement?order_no=DL260001-1` 这样的链接，
但采购侧根本不读这个参数，落点是一个没筛选的页面。

> 现状证据：`apps/web/app/workbench.tsx:52` 的模块卡指向 `/procurement`；
> `apps/web/app/procurement/page.tsx:15` 是 `ProcurementHub`（只有板块入口，不读查询串）；
> 真正读查询参数的是 `/production`（`app/production/page.tsx:42`）、`/qc`（`app/qc/page.tsx:16-17`）、
> `/qc/finished-goods`、`/qc/incoming`、`/warehouse/raw-material-storage`。

## 关联决策

- 本任务**只做采购侧**；财务侧（应收/应付）留作可选小节，理由见下。

## 范围与非范围

**范围**

- `/procurement/orders` 接受 `?order_no=` 并预置筛选。
- 工作台模块卡改直达 `/procurement/orders?order_no=`（保留 hub 以兼容老书签）。
- 测试增补。

**非范围**

- 不改采购单列表的**业务行为**（过滤仍然是前端 `visible` 那条链，见 `app/procurement/orders/page.tsx:149`）。
- 不改财务侧（可选小节，默认不做）。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/web/app/procurement/orders/page.tsx` | `useSearchParams` 取 `order_no` 作为 `query` 初值 |
| `apps/web/app/workbench.tsx` | 模块卡里「采购 / 应付」的目标路径改为 `/procurement/orders` |
| `apps/web/test/workbench.test.tsx` | 若断言了卡片 `href`，按新行为同步（这是**行为变更**，不是放宽断言） |
| `apps/web/test/procurement-*.test.tsx` | 增补「带 `order_no` 进来即已筛选」 |

## 实施要点

**1. 预置筛选的写法**

照 `app/production/page.tsx:42`：

```ts
const searchParams = useSearchParams();
const [query, setQuery] = useState(searchParams.get("order_no") ?? "");
```

`/procurement/orders` 是 `"use client"` 页面，`useSearchParams` 在客户端页里可直接用
（仓库里 `qc`、`production` 都是这么用的）。**不要**引 `window.location.search`。

**2. hub 要不要透传**

`ProcurementHub`（`app/procurement/page.tsx`）目前是纯入口页。两种做法：

- **A（推荐）**：只改工作台卡片直达 `/procurement/orders?order_no=`，hub 不动。
  少一跳、改动最小、老书签仍然有效。
- **B**：hub 也读查询串并透传到子页。收益是 `/procurement?order_no=` 这种老链接也能用，
  代价是把一个纯静态页变成读 `searchParams` 的页面（服务端组件 + `Suspense` 的既有坑）。

选 A；若选 B，在「决策记录」里写明理由。

**3. 财务侧（可选，默认不做）**

`/finance/receivable`、`/finance/payable` 的筛选在**客户端组件内部**
（`ReceivableWorkspace` / `PayableWorkspace`），页面是服务端组件只读 `tab`
（`app/finance/receivable/page.tsx`）。要做就得把 `order_no` 作为 prop 透传到 workspace 并预置筛选，
**面比采购侧大得多**。默认不做；[T11](./11-reorder-page.md) 里对应按钮的文案已按"打开模块页"
（不承诺筛选）处理。要做就一并做完并在完成记录里写明。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | `/procurement/orders?order_no=X` 首屏即筛选出该单 | `procurement-*.test.tsx` |
| 2 | 手工清空搜索框后能看回全部（预置值不是硬锁） | 同上 |
| 3 | 工作台「采购 / 应付」卡片 href 变成 `/procurement/orders?order_no=…` | `workbench.test.tsx` |
| 4 | 采购页其它筛选（状态、币种等）行为不变 | 既有用例全绿 |

命令：`npm run typecheck` → `cd apps/web; npm run test:unit`。

## 决策记录

- **选 A 而不是 B**：见实施要点 2。
- **财务侧默认不做**：见实施要点 3。这是一个**有意的范围裁剪**，不是漏做。

## 完成记录

**2026-09-26 完成**（提交 `a2534a7`）。

- 交付物：`apps/web/app/procurement/orders/page.tsx` 读 `?order_no=` 作 `query` 初值；
  `apps/web/app/workbench.tsx` 的「采购 / 应付」卡片改直达 `/procurement/orders`；
  新增 `apps/web/test/procurement-order-deeplink.test.tsx`（3 条）；
  三个既有采购测试文件补 `next/navigation` 的 mock。
- 决策落地：**选 A**（只改工作台卡片直达列表页，hub 不动）——少一跳、改动最小、老书签仍有效。
- 与计划的差异 / 顺手处理的一件事：**页面开始读 `searchParams` 之后，三个既有采购测试文件会直接抛错**
  （jsdom 里没有 App Router 上下文）。给它们补上 `vi.mock("next/navigation", …)`，
  这是"让页面能读查询参数"的必要代价，不是顺手的重构。
- 财务侧（应收/应付）**本轮不做**：筛选在客户端 workspace 组件内部、页面是服务端只读 `tab`，
  透传 `order_no` 的面比采购侧大得多 —— 有意的范围裁剪，已在提交信息里写明。
- 验证：`npm run typecheck` 通过；web lib **284/284**；web 组件 **58 文件 1004 条**（当时）。
- **未验证**：真实浏览器里点一遍「工作台 → 采购单列表已筛选」的整条交互。
