# Task 03：E3 出库、发货、签收与退货 API

## 目标

提供仓库操作员可用的 REST JSON 接口。

## 实施要求

- 暴露出库 list/create/post/shipping/sign/reverse 接口。
- 暴露客户退货 list/create/post/reverse 接口。
- 发货/签收 DTO 校验日期、数量、附件引用和原因；签收不得早于发货。
- 接入认证、`warehouse` 权限和统一异常响应。

## 完成标准

未登录 401、无权限 403；合法请求可完成出库和退货分支，接口返回 `{ data, meta }`。
