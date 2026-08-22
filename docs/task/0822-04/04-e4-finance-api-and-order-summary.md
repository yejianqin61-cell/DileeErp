# Task 04：E4 财务 API 与订单应收摘要

## 目标

暴露财务操作 API，并让订单号工作台可读取应收状态。

## 实施要求

- 暴露应收来源 list/from-outbound/confirm/cancel/impact-preview。
- 暴露收款 list/create/post/reverse，过账请求携带核销 allocations。
- 所有接口使用认证、`finance` 权限和 `{ data, meta }` 响应。
- 提供按订单号汇总应收金额、已核销、未核销和未分配收款。

## 完成标准

未登录 401、无财务权限 403；合法请求可完成来源确认和分批核销。
