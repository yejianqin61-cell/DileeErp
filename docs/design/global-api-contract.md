# 全局 API 与错误处理契约

## 状态

已确认，2026-08-21。适用于所有 `/api/v1` 接口。

## 目标

让前端、后端和各业务模块对资源路径、数据字段、成功响应、错误响应、并发冲突和跨模块引用使用同一口径。业务模块不得自行发明响应信封或错误结构。

## 请求约定

- URL 使用复数资源名和小写 kebab-case，例如 `/api/v1/sales-orders`、`/api/v1/purchase-orders`。
- `GET` 查询，`POST` 创建或执行非幂等业务动作，`PATCH` 局部修改，`DELETE` 逻辑删除。
- 业务动作使用子资源或动作名，例如 `POST /sales-orders/{id}/confirm`；不得用 `PATCH` 直接写入状态值绕过状态机。
- JSON 字段使用 `snake_case`；实体主键为 UUID 字符串 `id`，关联键为 `{entity}_id`；可读业务编号与 `id` 分离。
- 所有订单相关请求与响应使用 `order_no`；跨模块来源引用统一包含 `source_type`、`source_id`、`source_version`（有版本时）和 `order_no`（适用时）。
- 日期时间以 ISO 8601 字符串传输；金额、单价、数量以十进制字符串传输，禁止 JSON 浮点数作为业务计算输入。
- 列表查询使用 `page`、`page_size`、`sort`、`search`；`page` 从 1 起，`page_size` 范围为 1-200。
- 客户端不得提交 `id`、审计字段、软删除字段或状态机内部记录；服务端从当前登录用户写入审计字段。

## 成功响应

所有成功响应均为：

```json
{
  "data": {},
  "meta": {
    "request_id": "uuid"
  }
}
```

列表 `data` 是数组，`meta` 额外包含 `page`、`page_size`、`total`。业务模块可增加不改变含义的元数据，但不得移除上述字段。

## 错误响应

所有失败响应均为：

```json
{
  "error": {
    "code": "ORDER_NO_CONFLICT",
    "message": "订单号已存在",
    "details": []
  },
  "meta": {
    "request_id": "uuid",
    "path": "/api/v1/sales-orders"
  }
}
```

`message` 面向操作员；前端逻辑只依赖稳定的 `code`，不解析中文提示文本。`details` 为数组：字段校验项使用 `{ "field", "rule", "message" }`；业务冲突可包含受影响实体、当前版本或数量等只读上下文，严禁返回密码、会话或内部堆栈。

## HTTP 状态与机器错误码

| HTTP | 默认 code | 使用场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | DTO、分页和请求格式校验失败 |
| 401 | `UNAUTHENTICATED` | 未登录或会话无效 |
| 403 | `FORBIDDEN` | 无模块权限或无操作权限 |
| 404 | `NOT_FOUND` | 资源不存在或不可访问 |
| 409 | `CONFLICT` | 唯一性冲突、乐观并发冲突、重复操作 |
| 422 | `BUSINESS_RULE_VIOLATION` | 非法状态流转、库存不足、下游已确认等业务规则阻止 |
| 500 | `INTERNAL_ERROR` | 未预期服务端错误 |

业务模块可在 `409` 或 `422` 下使用更精确的大写下划线码，例如 `ORDER_NO_CONFLICT`、`VERSION_CONFLICT`、`INVALID_STATE_TRANSITION`、`INSUFFICIENT_INVENTORY`、`DOWNSTREAM_RECORD_EXISTS`。新增错误码必须写入对应模块设计和测试，且一经发布不得改变其含义。

## 版本与兼容性

- `/api/v1` 内只允许兼容性新增：新增可选字段、资源或错误码。
- 删除、重命名、改变字段类型/含义、改变既有错误码含义，均为破坏性变更，必须新增 API 版本并记录迁移方案。
- 所有写操作必须经过鉴权、DTO 校验、业务规则/状态机、数据库事务和审计记录；影响下游时先提供影响预览，再执行确认操作。

## 实现边界

此契约固定传输和错误处理方式，不提前固定 BOM、QC 或其他模块的业务字段。各模块在专用设计中定义资源、状态和业务错误码。
