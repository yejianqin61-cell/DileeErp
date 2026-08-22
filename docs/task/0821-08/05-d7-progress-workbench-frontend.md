# D7 生产进度与订单推进工作台前端

## 状态
已完成

## 认领
负责人：Codex
开始日期：2026-08-22

## 目标

在现有 Web UI 中提供按订单查看生产计量、生产单进度、阻塞告警和来源时间线的工作台。

## 依赖

`02-d7-progress-read-model-and-rebuild-api.md`、`04-d7-order-status-timeline-and-permissions.md`。

## 范围

- 订单列表：订单号、客户、生产单数、状态、完成率、阻塞数量和更新时间。
- 订单详情：生产单、工序/外加工来源、目标/完成/差额/超单、单位分组和状态。
- 按日期、生产单、工序、执行方式、状态和来源筛选。
- 告警/阻塞详情、审计时间线、来源详情和重算时间。
- 复用 shadcn/ui、TanStack Table、现有请求封装和权限守卫。
- 汇总页面不提供直接编辑；修改入口链接 D5/D6 原始事实页面。

## 非范围

不新增移动端页面、不做客户端汇总、不新增状态编辑表单。

## 验收与验证

- 登录后可完成订单列表 -> 订单详情 -> 来源/告警详情的真实流程。
- 混合单位、超单、阻塞和 `capability_not_implemented` 显示不重叠且文案可理解。
- 无权限用户看不到重算入口；接口错误显示请求 ID。
- Web typecheck/build 和 Playwright 工作台流程通过。

## 决策记录

- 所有数值和状态来自服务端，不在组件中重算。

## 完成记录

已移除工作台演示数据，接入 D7 订单状态、生产单进度、生产计量和审计时间线 API；增加服务端状态标签、阻塞建议、能力未启用提示、筛选、详情和刷新工作流，页面不再自行计算汇总。

验证：`npm run typecheck --workspace=@dilee/web`、`npm run build --workspace=@dilee/web` 通过。

提交：`3defae8 feat: connect d7 progress workbench`
