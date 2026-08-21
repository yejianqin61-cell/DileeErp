# 0821-02-07 采购至应付来源前端链路

## 状态

待认领

## 认领

负责人：
开始日期：

## 目标

在既有 Web 应用中提供采购员、仓库/QC 和财务可完成并追溯本纵向链路的真实页面，不展示伪造业务数据或孤立库存余额编辑入口。

## 关联决策

- `docs/design/bom-procurement-inbound-qc-payable-chain-implementation-design.md`
- `docs/design/frontend-initialization-plan.md`
- `docs/task/0821-02/03-procurement-orders-and-batch-receipts-api.md`
- `docs/task/0821-02/04-incoming-quality-control-api.md`
- `docs/task/0821-02/05-raw-material-inbound-inventory-payable-source.md`
- `docs/task/0821-02/06-reversals-impact-preview-and-alerts.md`

## 范围

- 基于 TanStack Table、shadcn/ui 和 React Hook Form 实现物料/供应商/单位维护页面；
- 实现采购单列表、详情、从确认销售单/BOM 选择来源、手工明细录入、下单和分批到货页面；
- 实现 QC 待检、检验录入和合格/条件接收/不合格数量分流页面；
- 实现原料入库草稿、过账、库存追溯、应付来源列表/详情页面；
- 在编辑、过账、冲销和风险操作前显示 API 返回的影响预览、告警与明确确认控件；
- 以既有会话守卫与 RBAC 控制模块入口，适配 API 统一成功/错误信封和无演示数据空状态。

## 非范围

- 移动端、离线、打印、采购单 Excel 导出；
- 财务付款/核销、生产领料和仓位管理；
- 未确认的复杂 QC 模板设计器。

## 验收与验证

1. 采购员可以从已确认销售单的指定 BOM 版本创建采购单，页面始终展示 `order_no` 和来源版本。
2. 仓库可登记多次到货并完成 QC；QC 数量分流错误得到字段级提示。
3. 原料入库操作只能选择 API 返回的可入库数量，过账后显示库存事实与对应应付来源。
4. 页面没有直接编辑库存余额的入口；受影响操作必须先展示预览与风险。
5. 无权限、未登录、冲突和业务错误符合现有前端反馈规范；Web build/typecheck 通过。

## 决策记录

本任务是后端链路的操作界面，不复制服务端的数量、状态或幂等规则。

## 完成记录

负责人：
完成日期：
验证：
