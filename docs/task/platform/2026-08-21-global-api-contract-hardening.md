# 全局 API 契约与错误处理加固

## 状态

已完成

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

把全局 REST/JSON、成功响应、错误响应、请求追踪和 DTO 校验规则固化为可复用实现，供所有业务模块直接使用。

## 关联文档

- `docs/design/global-api-contract.md`
- `docs/product/SRS.md` 第 7 节
- `.agent/constitution/constitution.md`

## 完成内容

- 成功响应统一注入 `meta.request_id`；
- 异常过滤器支持自定义稳定错误码和结构化 `details`；
- DTO 校验错误统一为 `VALIDATION_ERROR`，详情包含 `field`、`rule`、`message`；
- 补充 `409 CONFLICT`、`422 BUSINESS_RULE_VIOLATION` 默认映射及 `ApiError`；
- 新增全局契约文档，明确 URL、字段、日期/金额、来源引用、版本兼容和错误码规则。

## 验证

- `npm run build --workspace=@dilee/api` 通过；
- `npm run test` 通过，3 项平台契约/审计测试通过。

## 非范围

- 不实现任何业务资源端点；
- 不提前定义 BOM、QC 或模块字段；
- 不改变现有 API 版本前缀。
