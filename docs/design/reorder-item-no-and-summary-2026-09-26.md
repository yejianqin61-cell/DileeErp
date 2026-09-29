# 销售单货号 + 返单与总结（2026-09-26）

> 老板原话：「每个销售单多一个字段，叫做货号。以后客户返单，从系统里面调取，返单客户货号不变。
> 可以调取该货号。查看当时该批货号的采购，生产，QC 的所有表单，信息。」
> 用户建议：「可以直接左边的栏加一个 tab 叫做返单与总结。」
>
> **已拍板（2026-09-26）**：
> ① **货号挂在销售单这一层**（单头一个货号），明细行的「品番/品名」保持现状；
> ② **不建货号主数据表**，货号清单从销售单投影，编辑器下拉喂既有货号、可输新货号；
> ③ 返单**全带工艺口径**（37 标量 + 明细 + 材料引用），数量/下单日/交期必须重填，单价照带但标「待复核」。

---

## 一、链路通读结论

### 1.1 主干只有一根线：订单号

下游每一张单都冗余存了 `order_no` 并建了索引（`@@index([orderNo, ...])`）：

```
SalesOrder.orderNo ─┬─ Bom.orderNo ── PurchaseOrder.orderNo ─ PurchaseOrderItem
                    │                                      └ PurchaseReceipt.orderNo
                    │                                        └ IncomingInspection.orderNo ─ RawMaterialInbound
                    ├─ ProductionOrder.orderNo ─┬─ RawMaterialMovement（领料/补料）
                    │                           ├─ OperationDailyReport（工序日报）
                    │                           └─ FinishedGoodsInspectionSubmission.orderNo
                    │                                └ FinishedGoodsQcRecord.orderNo
                    │                                   └ FinishedGoodsInbound / Defective / Outbound
                    └─ ReceivableSource / 应付链（PurchaseOrder 起）
AuditEvent.orderNo  （时间线来源）
```

结论：**任何一张单都能按订单号捞出来**，所以货号查询不必给下游加列。

### 1.2 已存在的能力（不要重复造）

| 已有 | 位置 | 边界 |
| --- | --- | --- |
| 按订单号的全链路只读汇总 | `GET /order-workbench/orders…`，页面 `/`（工作台） | **只给计数与金额，不列单据**；无货号轴、无返单动作、不跨订单汇总 |
| 模块深链 | 工作台卡片 → `${path}?order_no=` | 只有 `/production`、`/qc`、`/qc/finished-goods`、`/warehouse/raw-material-storage` 真正读 `order_no`；**采购页与财务页不读**（见 §9） |
| 版本快照 | `SalesOrderVersion.snapshot` | 37 标量 + 明细 + 材料引用；返单复制的天然来源 |
| 审计时间线 | `AuditEvent.orderNo` | 工作台已按订单号查，货号页按「订单号集合」查即可 |

### 1.3 差距

| 需求 | 现状 | 差距 |
| --- | --- | --- |
| 销售单多一个「货号」 | 全库 grep `货号/itemNo/articleNo/styleNo` = 0 命中 | 加列 + 进版本快照 + 印上工艺单/采购单 |
| 客户返单，货号不变，从系统调取 | 无复制/返单功能 | 按来源单复制工艺口径直接建新草稿；货号沿用 |
| 调取该货号看那时那批的采购/生产/QC | 工作台按订单看状态，不列单据 | 按货号聚合 + 单据清单 + 跨批次汇总 |

补充事实：工艺单模板表头**没有货号格**（现为 工厂/客户单号/客户代码/下单日期/数量/品名规格/地区/完工日期/注意事项）；
`sales_order_spec_details.name`（品番/品名）是**花色级**的（样本1 一张单 12 个品番），与订单级货号是并存关系。

---

## 二、数据层

三处改动，全部可空、无默认值：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `sales_orders.item_no` | `VARCHAR(100) NULL` | 货号。索引 `(item_no, order_date)` |
| `sales_orders.reorder_from_order_no` | `VARCHAR(100) NULL` | 返单来源快照。**存文本不建自引用外键**：订单号本身唯一，而返单链不该因为老单被删/改而断 |

**货号不冗余到采购/生产/QC。** 那些表已经冗余了 `orderNo`，再加一列就有两个真源（改一次货号要改 N 张表，漏一张就出现「同一批货两种拼写」）。查询走
`货号 → 订单号集合 → 下游 by orderNo`，正好吃现有索引。唯一例外是**纸上要印货号**的导出（工艺单、采购单打印），导出时 join 销售单取值，不落列。

**不建货号主数据表。** 货号清单 = 对 `sales_orders` 的 GROUP BY 投影，不漂移、不用回填；
编辑器下拉喂这份既有货号（选已有或直接输新的，输入即用）。
只有当老板要「每个货号挂图片/常驻规格/负责人/停用状态」时，才升级成 `product_articles` 主数据。

**归一规则**：存原样显示，**匹配时 trim + 忽略大小写与内部空格**（`27621` 与 ` 27621 ` 是同一个货号）。
全站「不跨单位合计」的规则同样适用于货号汇总：数量按单位分行、金额按币种分行。

---

## 三、接口层

### 3.1 销售单（写侧）

- DTO 与 `SalesOrdersService` 加 `item_no`、`reorder_from_order_no`（basic 字段，不在 `SPEC_SCALAR_FIELDS` 里），
  写进 `SalesOrderVersion.snapshot`，回看时能回答「这批当时货号怎么写的」。
- 已确认单改货号**强制填 `reason`**（`reason` 机制已有，只需把 `item_no` 纳入「确认后改动需原因」的集合），
  但**不进 `coreFields`**——货号不锁下游，误把 `item_no` 放进去会让「下单后发现货号打错」变成要回退 BOM/采购/生产才能改。
- `list()` 搜索加货号（现在只搜 `orderNo`/`productName`）。
- 返单：`POST /sales-orders` 带 `reorder_from_order_no`，服务端按来源单复制
  **37 个工艺标量 + `spec_details` + `material_refs`**，**不复制** status / 版本 / 数量 / 下单日 / 交期；
  单价照带。**走同一条 `create` 校验路径**，避免「复制」绕过校验（唯一键、币种、材料存在性等）。
- `GET /sales-orders/:id/reorder-preview`：把「会带过来什么 / 必须重填什么」摆给编辑器，不直接建单。

### 3.2 新模块 `reorder`（只读 + 一个写入口）

权限同工作台：`@RequireAnyModules("sales","procurement","production","warehouse","finance","hr")`。

| 接口 | 内容 |
| --- | --- |
| `GET /reorder/articles?q=&customer_id=&include_closed=&include_deleted=` | **货号清单**：货号 + 订单数 + 累计数量（按单位分行）+ 金额（按币种分行）+ 首次/最近下单 + 最近交期 + 客户 + QC 合格率 |
| `GET /reorder/articles/:item_no` | 该货号的**订单序列**（哪几批）+ 汇总 + 风险（QC 不合格、超单、延期） |
| `GET /reorder/articles/:item_no/documents?order_no=` | **单据清单**：按模块分组返回「单号/日期/数量/单位/状态/来源 id + 前端跳转路径」 |
| `GET /reorder/articles/:item_no/timeline` | 该货号全部订单的 `AuditEvent` 合并按时间倒排 |

金额与数量**一律 Decimal 字符串**，滚动汇总在服务端算，前端不重算（与 `order-workbench.service.ts` 同一口径）。

---

## 四、界面层

### 4.1 左侧导航与权限

- 新增导航项 **「返单与总结」→ `/reorder`**，位置在「客户与销售」之后；
  同步 `apps/web/test/app-shell.test.tsx` 的导航断言清单（该清单是逐项写死的）。
- 建议**新开表面栏目 `reorder`**：`apps/api/src/platform/authorization/surface-scope.ts` 与
  `apps/web/lib/surface-permission.ts` 都是代码里的表，加一节**不需要数据库迁移**；
  归入 `full` 与 `general` 范围（老板/财务/其他能看，人事看不到）。
  页面内的模块卡片继续按 `canVisitPath` 过滤（工作台已有这套做法）。
- 备选（省事但语义差）：落在 `/sales/reorder`，自动归「客户与销售」栏目，零权限改动。

### 4.2 页面结构（一屏走完「查货号 → 看批次 → 看单据」）

1. **货号搜索**：货号 / 客户 / 是否含已关闭、已删除 → 货号列表（含「历史单未填货号」入口）。
2. **选中货号**：汇总卡（按单位/币种分行的数量与金额、QC 合格率、交期达成）+ **订单时间线**，
   每批一个 **「以此返单」** 按钮。
3. **选中某一批**：**单据清单**（采购 / 到货 / 来料质检 / 原料入库 / 生产 / 领料 / 日报 / 成品送检 / QC /
   成品入库 / 次品 / 出库 / 应收应付），每行带单号 + 日期 + 数量 + 状态 + 跳转。

单据清单**在页内直接列出**，跳转只是加速——因此不受 §9「采购/财务不读 `order_no`」那个缺口影响。

### 4.3 销售单

- 编辑器基本信息加「货号」：**可下拉选已有货号，也可直接输新货号**（防拼写漂移）。
- 返单进来的单顶部显示「由 `DL260001-1` 返单（同货号）」并可跳到来源单。
- 列表加货号列 + 搜索命中 + 「未填货号」筛选（历史单补录入口）。

### 4.4 导出

- 工艺单表头印货号（`sales-order-export.service.ts`）。
- 采购单打印表加货号：现在只印订单号 / 供应商 / 产品名称（`purchase-order-export.service.ts:83,277`）。

---

## 五、返单流程

```
返单与总结页  ──选中货号 F-27621──▶ 列出该货号的历次订单（含数量/交期/QC 结论）
      │
      └─点某一批的「以此返单」
              │
              ├─ GET /sales-orders/:id/reorder-preview   ← 摆出「带过来什么 / 必须重填什么」
              └─ 编辑器（预填工艺口径 + 货号 + 客户）
                       └─ POST /sales-orders（reorder_from_order_no=来源单号）
                                └─ 服务端复制 → 新草稿（新 order_no / 新版本）
                                         └─ 确认 → 新 BOM → 新采购/生产（老单事实一律不动）
```

要点：返单**不改老单**。老单的采购/生产/QC 事实是历史，查货号时作为「当时那批」永远可查。

---

## 六、历史数据

老单 `item_no` 为空 → 不进任何货号分组；`/reorder` 给一张「历史单未填货号」待办表，逐个指派（管理员可批量）。

**绝不从品名/品番自动猜货号**：猜错会把两批不同的货合成一个货号，比空着糟糕得多。

---

## 七、分期计划

| 期 | 内容 | 可独立上线 |
| --- | --- | --- |
| P1 | 货号字段（列 / 写侧 / 版本快照 / 列表搜索）+ 工艺单印货号 | 是 |
| P2 | 返单建单 + 编辑器货号下拉 + 来源提示 + 采购单印货号 | 是 |
| P3 | `/reorder` 四个接口 + 页面 + 导航/权限 + 历史补录 | 是 |
| P4 | 复盘增强：金额/毛利、合格率、交期达成、总结表导出 | 可后置 |

---

## 八、验收标准

1. 每个销售单可填货号；同一货号的多张单在 `/reorder` 里归到一组，大小写/空格差异不产生第二组。
2. 已确认单改货号必须填原因，且不因货号变更而锁死下游编辑。
3. 「以此返单」产出的新单：货号为原货号、来源单号可追溯、37 个工艺字段与明细/材料引用一致、
   数量与交期为空且有校验提示、老单及其下游事实**零改动**。
4. `/reorder` 能按货号列出该货号全部批次的采购 → 到货 → 来料质检 → 原料入库 → 生产 → 领料 → 日报 →
   成品送检 → QC → 成品入库 → 次品 → 出库 → 应收应付的单据，且单号/数量/状态与各模块页面一致。
5. 数量按单位分行、金额按币种分行，不跨单位/跨币种求和。
6. 未填货号的历史单不影响任何既有页面与导出（全部新列可空）。

---

## 九、已知缺口与风险

1. **采购页、财务页不读 `order_no`**：工作台卡片链接 `/procurement?order_no=…`、`/finance?order_no=…` 落不到筛选态。
   本方案的单据清单在页内列出，不受影响；顺手补上这两个页面的 `order_no` 过滤是**独立的小改动**。
2. **货号写错的历史后果**：货号把多批货归成一组，改货号会改变分组（不改变任何单据事实）。
   口径：已确认单改货号需原因 + 审计；不做级联改写下游。
3. **货号重名的跨客户场景**：同一货号卖给两个客户时，页面上要把客户列出来，不阻断下单。
4. **单位/币种不一致**：汇总必须分行，否则会出现「支 + 打」这种没有意义的合计（全站既有规则）。
5. **已关闭与软删订单**：默认排除软删，提供开关；已关闭订单**纳入**统计（返单看的是历史经营事实）。
6. `/reorder` 的汇总与工作台的 `summary()` 是两套查询。P3 用一条「两边总额一致」的交叉测试钉住口径，
   若以后漂移，再抽公共 loader（现在抽会动到工作台 37 条契约测试，收益不划算）。

---

## 十、涉及文件（预计）

| 层 | 文件 |
| --- | --- |
| 数据 | `apps/api/prisma/migrations/2026xxxx_sales_order_item_no/migration.sql`、`schema.prisma` |
| 销售写侧 | `apps/api/src/modules/sales/sales-orders.controller.ts`、`sales-orders.service.ts`、`sales-order-export.service.ts` |
| 采购导出 | `apps/api/src/modules/procurement/purchase-order-export.service.ts` |
| 新模块 | `apps/api/src/modules/reorder/{reorder.module.ts,reorder.controller.ts,reorder.service.ts}`、`app.module.ts` |
| 前端 | `apps/web/components/layout/app-shell.tsx`、`apps/web/app/reorder/page.tsx`、`apps/web/components/reorder/*`、`apps/web/components/sales/sales-order-editor.tsx`、`apps/web/app/sales/page.tsx`、`apps/web/lib/surface-permission.ts` |
| 权限 | `apps/api/src/platform/authorization/surface-scope.ts` |
| 测试 | `apps/api/test/unit/reorder-*.test.cjs`、`apps/api/test/http/*`、`apps/web/test/{app-shell,reorder-page,sales-order-editor}.test.tsx` |
| 文档 | 本文件、`docs/data-dictionary.md`(+`.html`)、`docs/product/module-capability-catalog.md`、`docs/task/coding-roadmap-todolist.md`、`docs/log/2026-09-26.md` |

## 十一、实施结果

### P1 货号字段（2026-09-26 完成，4 个提交）

| 层 | 落地物 | 提交 |
| --- | --- | --- |
| 数据 | `sales_orders.item_no` / `reorder_from_order_no`（可空）+ `(item_no, order_date)` 索引；迁移 `20260927090000_sales_order_item_no` + 7 条守卫 | `3a1b7ba` |
| 接口 | `sales/item-no.ts`（归一唯一实现）；创建/更新/快照/搜索；`reorder_from_order_no` 类型层与 DTO 层都不接受改写；`GET /sales-orders/item-nos` | `6e81848` |
| 印刷 | 工艺单印在「完工日期」那一行；采购单并入「订单号」格（都不新增行列，空货号时与改造前逐字相同） | `0e2c9f3` |
| 界面 | `ItemNoInput`（可挑可输）；列表货号列 + 货号搜索 + 「未填货号（待补录）」筛选；web 侧镜像归一函数 | `257eae6` |

与设计的差异（3 处，都已写进对应任务文档的完成记录）：

1. **`item_no` 在 `update` 时按「空串 = 清除、未传 = 不动」处理，并显式补发 `null`** ——
   原设计只说"与 37 个细化标量同语义"，但编辑器里那条"空串即删除键"的循环会把它变成「不动」。
2. **采购单的货号并入「订单号」格**，而不是新增一列/一行：表头 12 格是用户点名的、明细 9 列牵着
   列宽与小计公式，改列数的代价远大于收益（详见 T03 完成记录）。
3. **建议列表用包含匹配**（输 `27621` 也列出 `DL27621`），与服务端 `q` 语义一致。

验证：`npm run typecheck` 双绿；API 单测 **2051/2051**；web lib **283/283**；web 组件 **54 文件 / 968 条**。

未验证（本机无 PostgreSQL / 无浏览器排版）：迁移未在真实库执行；http / integration / e2e 套件未跑；
两份 xlsx 导出的打印观感未在 Excel/WPS 里看过；建议下拉的定位只有 jsdom 行为断言。

### P2 返单建单与前端入口（2026-09-26 完成，2 个提交）

| 层 | 落地物 | 提交 |
| --- | --- | --- |
| 接口 | `resolveReorderSource` / `reorderPreview` / `reorderInput` / `usableMaterialRefs`；三条守卫；审计带来源；19 条单测 | `7d10cdb` |
| 界面 | `/sales/orders/new?reorder_from_order_no=…` 预填、来源横幅、「返单必填」提示、预览失败不渲染表单；9 条组件测试 | `f28a536` |

与设计的差异（2 处）：

1. **预览带物料摘要 + 复制引用时剔除已删除物料**：物料可以被删，而几年前的来源单可能引用过它；
   剔除并用 `reorder_warnings` 回报，而不是让整张返单被一个用户看不见的旧引用卡死。
2. **预览失败时整个表单不渲染**：只留错误横幅的话，下面那张空白表单仍然能提交，
   而它看起来就是「这一单本来没有工艺要求」——正是返单最不该产出的一张单。

验证：API **2070/2070**；web lib **283/283**；web 组件 **55 文件 977 条**。

后续期次 P3–P4 见任务批次清单。

### 后续任务

已拆成 15 个可直接开发的子任务：[docs/task/0926-reorder-item-no-and-summary/](../task/0926-reorder-item-no-and-summary/README.md)
（含依赖图、执行顺序、验证命令、每个任务的文件级交付物与验收清单）。
