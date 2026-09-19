# 任务：采购单打印信息 + 单张导出入口 + 供应商地址

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-16

## 来源需求（用户原话）

> 「采购模块
> 1.供应商，需要多一个字段，地址
> 2.现在，需要允许导出 excel 采购单出来
> 采购单里面要有 订单号，供应商名称，供应商联系人，采购人，操作人，下单录入的时间，操作时间，备注，
> 序号，产品名称，规格型号，数量，含税单价，总价，交货日期，付款方式，交期条款，交货地址，
> 厂家回签意见，厂家回签，主管签字
> 其中，订单号，供应商名称，供应商联系人，采购人，操作人，下单录入的时间，操作时间，总价，交货日期，
> 付款方式，交期条款，交货地址作为表头
> 厂家回签意见，厂家回签，主管签字这些作为表尾，提供大格子
> 3.对应的，系统中采购单，也要支持对这些字段进行填写和设置。
> 4.付款方式，有月结30天，月结60天，当月付款」

用户对追问的选择：

1. **采购人 / 操作人 保持现状**（创建人 / 最后修改人，自动记，不新增可填字段）；
2. **表尾三格：系统存文本、导出留空手写**；
3. **付款方式：固定三项下拉、存文本**（以后加值只改前端）；
4. **明细保留现有 9 列**（含单位 / 供应商 / 交货日期）。

设计见 [采购单打印信息与 Excel 导出](../../design/purchase-order-print-fields-and-export-2026-09-16.md)。

## 目标

- 供应商多一个「地址」字段（新建 / 编辑 / 列表 / 搜索都能用）；
- **把单张采购单的 Excel 导出入口接上**（版式早就有了，缺的是按钮）；
- 导出表头按用户清单排（12 项 + 原模板的电话与采购单号），表尾三个大格子；
- 采购单上能填这些字段，且**下单之后也能补**（厂家回签发生在下单之后）。

## 关联决策

- **导出接口与版式不重做**：`purchase-order-export.service.ts` 已含 9 列明细、小计、备注、交易条款、
  表尾三格与 A4 分页；本轮只补表头缺的字段与入口；
- **打印信息单独一个端点**（`PATCH /purchase-orders/:id/print-fields`）：不放开「草稿才可整体编辑」，
  但它只碰与明细/金额无关的字，所以四种状态都能填；
- **不塞 `extension_data`**：要在页面直接编辑、要被打印逐格读、要被审计，JSON 三样都做不到；
- **回签三格存文本但不回填打印**（用户选择），代码里写明「不是漏了」；
- **付款方式不做枚举校验**：存文本 + 前端三项，加值不改后端；
- **导出失败要把可读原因告诉用户**：`downloadFile` 抛的是普通 Error（超时 / HTTP 码 / 服务端 message），
  不能套 `messageOf` 的兜底压成光秃秃的「导出失败」；
- **弹窗提交必须把 Promise 交回 ActionDialog**：它靠抛错决定「保持弹窗打开」，
  写成 `void submit(...)` 会吞掉异常、关窗、用户填的字全丢。

## 范围与非范围

**做**：

- `apps/api/prisma/schema.prisma` + 迁移 `20260919100000_purchase_order_print_fields_and_supplier_address`：
  `suppliers.address`、`purchase_orders` 六个打印字段；
- `procurement-master-data.{controller,service}.ts`：供应商地址进 DTO 与读写；
- `purchase-orders.{controller,service}.ts`：`updatePrintFields` + `PATCH :id/print-fields` + `PrintFieldsDto`；
- `purchase-order-export.service.ts`：表头网格重排（4 行 12 格 + 交货地址/交期条款整行）、
  总价与交货日期、表尾三格改名并加高到 4 行、行号改由常量推出；
- `apps/web/app/procurement/orders/page.tsx`：每行「打印信息」与「导出」两个入口；
- `apps/web/app/procurement/suppliers/page.tsx`：地址字段 / 列 / 搜索；
- `apps/web/lib/purchase-order-print.ts`（+ 测试）：付款方式三项、哨兵值转换、请求体与初值；
- 测试：见下方验收清单。

**不做**：

- 不新增可填的采购人 / 操作人（用户选择）；
- 不回填打印回签三格（用户选择）；
- 不做付款方式的字典与枚举校验；
- 不改明细 9 列的列序（原模板顺序不变）；
- 不改 `PATCH :id` 的草稿门禁；
- 不做导出留档（导出是只读，不进审计）。

## 验收与验证

1. `apps/api/test/purchase-order-export.test.cjs`（7 条）：表头 12 项 + 顺序、空值不印 `null`、
   明细 9 列、小计/备注/表尾三格（改名 + 跨 4 行）、回签不回填、交易条款修正、批量导出与草稿标注；
2. `apps/api/test/unit/purchase-order-print-fields.test.cjs`（7 条）：八格映射、不碰明细/金额/状态、
   没传不动、空串清除、日期 null、四状态可填、已取消 422、404 与审计；
3. `apps/api/test/unit/purchase-order-print-fields-migration.test.cjs`（3 条）：七列存在/可空/无索引；
4. `apps/api/test/unit/procurement-master-data-service.test.cjs`：地址落库与清空；
5. `apps/api/test/http/purchase-orders-contract.test.cjs`：路由 14 → 15 + 新路由的只读探针；
6. `apps/web/test/procurement-order-print.test.tsx`（7 条）+ `apps/web/test/supplier-address.test.tsx`（5 条）
   + `apps/web/lib/purchase-order-print.test.mjs`（11 条）；
7. `nest build`、`tsc --noEmit`（api）通过。

## 决策记录

- **先查证再动手**：导出的版式早已存在且相当完整，用户说「需要允许导出 excel 采购单出来」，
  查下来真正的缺口是**页面上没有单张导出的按钮**（`exportPurchaseOrder` 定义了却没人调用）。
  若按字面重写一遍导出，会白改一套已经能用的版式，还丢掉「小计只对含税总价求和」这类既有口径。
- **「表头/表体/表尾」按用户的清单重排**，但保留原模板的电话与采购单号：采购单号是厂商对账的唯一抓手。
- **行号由常量推出**：上一版把行号写死在测试里，加两行表头就全线错位 —— 这次顺手把测试也改成
  「按标签/表头名定位」（`findRow` / `headerFields`），以后改版式不会再连带改十几处断言。
- **打印信息与业务编辑分开**：厂家回签是下单之后的事，塞进草稿编辑器会让「已下单」的单子永远填不上。
- **空串 = 清除，未传 = 不动**：这两者写反的后果正好相反（一个是「删了没保存上」，
  一个是「只改一格结果清了别的格」），所以用 lib 纯函数把转换钉死并逐条测试。
- **下拉加「（不填）」哨兵**：Radix Select 不接受空串 value；已有值不在三项里时照样列出来
  （否则打开弹窗看到空白下拉，用户会以为自己填的值丢了）。

## 完成记录

- 新增：`apps/api/prisma/migrations/20260919100000_purchase_order_print_fields_and_supplier_address/`、
  `apps/api/test/unit/purchase-order-print-fields.test.cjs`、
  `apps/api/test/unit/purchase-order-print-fields-migration.test.cjs`、
  `apps/web/lib/purchase-order-print.ts`、`apps/web/lib/purchase-order-print.test.mjs`、
  `apps/web/test/procurement-order-print.test.tsx`、`apps/web/test/supplier-address.test.tsx`、
  `docs/design/purchase-order-print-fields-and-export-2026-09-16.md`、本文件；
- 修改：`apps/api/prisma/schema.prisma`、`procurement-master-data.{controller,service}.ts`、
  `purchase-orders.{controller,service}.ts`、`purchase-order-export.service.ts`、
  `apps/web/app/procurement/{orders,suppliers}/page.tsx`、
  `apps/api/test/purchase-order-export.test.cjs`、
  `apps/api/test/http/purchase-orders-contract.test.cjs`、
  `apps/api/test/unit/procurement-master-data-service.test.cjs`、`docs/log/2026-09-15.md`；
- 验证：API 单测 **1561 / 1561**（该数字含同工作树另一 agent 新增的财务用例；本轮自己的新增是
  12 条：导出用例改版 5 → 7、打印信息 7 条、迁移守卫 3 条）、web 相关用例 **49 / 49**（新 12 条）、
  web lib **167 / 167**（新 11 条）、`nest build` 与 `tsc --noEmit`（api）通过。
- **未在真实数据库上验证**：迁移、打印信息的落库与审计、以及 `test/http/*` 契约测试。
- **未在真实 Excel / WPS 里打开过导出文件**（列宽、打印分页、合并格子观感）。
- 运行全量前端用例时同一工作树里另一个 agent 正在改财务模块，期间财务相关文件时红时绿；
  与采购相关的用例单独跑全绿，`tsc --noEmit`（web）当时只报财务那两个测试文件的错。
