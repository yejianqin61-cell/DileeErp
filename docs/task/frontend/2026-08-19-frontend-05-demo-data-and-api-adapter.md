# 前端任务 05：演示数据与 API Adapter

## 状态
已完成

## 依赖
前端任务 01。

## 目标

隔离演示 fixture、页面数据 adapter 和未来 NestJS API client，确保占位页面不把示例数据误写为业务规则或生产数据。

## 范围

- typed demo fixtures 和显式来源标记。
- API client：`/api/v1` 前缀、JSON 信封、错误码、分页类型和请求状态。
- 每个首页/模块页面的数据 adapter 接口。
- 演示 adapter 默认实现；未来 API adapter 可替换。

## 非范围

不调用未确认业务 API，不写入 PostgreSQL，不实现真实认证。

## 验收与验证

- 页面不直接 import 固定演示数组，而是通过 adapter 获取数据。
- 演示模式在界面中清楚可见。
- API client 能正确解析 SRS 定义的成功与失败 JSON 信封。

## 完成记录

负责人：Codex
完成日期：2026-08-19
验证：前端 typecheck/build 通过；已加入 API client、ApiClientError、typed demo fixtures、工作台 adapter 和模块占位 adapter。
