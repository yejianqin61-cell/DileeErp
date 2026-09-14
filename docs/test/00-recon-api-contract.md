# HTTP API 契约与错误语义审计（Recon）

> 目的：为接口测试计划提供**逐条可引用**的契约事实。
> 范围：`apps/api`（NestJS + Prisma）HTTP 层、鉴权授权层、分页/过滤、幂等/并发/事务，以及 `apps/web` 的调用面。
> 方法：只读静态审计。所有结论均给出 `文件:行号`。凡未能通过代码直接证实的内容，一律标注 **未验证**。
> 审计基线：仓库当前工作区（未提交状态）。全局前缀 `api/v1`。

---

## 1. 概览

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 框架 | NestJS 11 + Express 5 + Prisma 6 | `apps/api/package.json` |
| 全局前缀 | `api/v1` | `apps/api/src/main.ts:14` |
| 控制器总数 | 37 个 `.controller.ts`（其中 1 个文件含 2 个控制器） | 见 §5 鉴权矩阵 |
| 全局中间件 | `cookieParser()` → `RequestIdMiddleware` → `RequestLogMiddleware` | `apps/api/src/main.ts:16-18` |
| 全局管道 | `ValidationPipe{ whitelist, transform, forbidNonWhitelisted }` | `apps/api/src/main.ts:19-28` |
| 全局拦截器 | `ResponseEnvelopeInterceptor` | `apps/api/src/main.ts:29` |
| 全局过滤器 | `ApiExceptionFilter`（`@Catch()`，捕获一切） | `apps/api/src/main.ts:30`、`api-exception.filter.ts:6` |
| CORS | `app.enableCors()`，无 origin 白名单、**未开启 credentials** | `apps/api/src/main.ts:15` |
| ETag | 显式关闭 | `apps/api/src/main.ts:13` |
| 监听端口 | `process.env.PORT ?? 3001` | `apps/api/src/main.ts:32` |
| Prisma 客户端 | 原生 `PrismaClient`，无 `$extends`、无全局事务默认隔离级别 | `platform/database/prisma.service.ts:5-7` |

**关键风险（先看这三条）**

1. **`meta.request_id` 实际上恒为 `undefined`（即从不出现在响应体里）**。`RequestIdMiddleware` 只把 request id 写到**响应头** `x-request-id`（`request-id.middleware.ts:7`），并把值挂到 `request.id` 属性上（`:8`）；但拦截器与过滤器读的是**请求头** `request.header("x-request-id")`（`response-envelope.interceptor.ts:9`、`api-exception.filter.ts:24`）。全仓库无任何位置把 `x-request-id` 写回 `request.headers`（已全量 grep `apps/`，仅上述 6 处命中）。因此只有**客户端自己带 `x-request-id` 请求头**时，`meta.request_id` 才会出现在 body 里。现有测试 `assert.deepEqual(response.body.meta, {})`（`apps/api/test/http/platform-http.test.cjs:12`）正是因为该字段为 `undefined` 被 `JSON.stringify` 丢弃而通过的。→ 追踪链路只能靠**响应头**。
2. **`POST /api/v1/attachments` 与 `DELETE /api/v1/attachments/:id` 必然序列化失败**（BigInt）。`schema.prisma:190` 声明 `fileSize BigInt`，`attachments.service.ts:24` 与 `:43` 直接返回含 `fileSize` 的整行；`attachments.controller.ts:17`、`:25` 原样包进 `data`。全仓库无 `BigInt.prototype.toJSON` 补丁（已 grep）。`JSON.stringify(BigInt)` 抛 `TypeError` → 落到 500。**未实测**（静态分析结论；建议列为第一批契约测试）。
3. **登录返回 201，不是 200**。`ResponseEnvelopeInterceptor.getStatusByMethod` 对 POST 默认 201，`auth.controller.ts:15` 未加 `@HttpCode(200)`；现有测试已固化该行为（`apps/api/test/http/sales-orders-pagination-http.test.cjs:11` 断言 `login.status === 201`）。

---

## 2. 成功响应契约

### 2.1 Envelope 形状

声明（`platform/http/api-contract.ts`）：

```ts
export interface ApiSuccess<T> { data: T; meta: ApiMeta; }        // :3-6
export interface PaginatedMeta extends ApiMeta {                  // :17-21
  page: number; page_size: number; total: number;
}
export const apiSuccess = <T>(data: T, meta: ApiMeta = {}): ApiSuccess<T> => ({ data, meta });   // :23
export const paginated = <T>(...) => ({ data, meta: { page, page_size, total } });               // :25-28
```

`apiSuccess` / `paginated` **在两个 controller 之外从未被调用**：全仓库业务 controller 都是手写 `{ data, meta: {} }` 字面量。`platform-api.test.cjs:9-15` 只单测了这两个 helper，不覆盖真实 HTTP 响应。

实际生效逻辑（`platform/http/response-envelope.interceptor.ts:10-16`）：

```ts
return next.handle().pipe(map((data: unknown) => {
  if (data && typeof data === "object" && "data" in data) {          // :11
    const envelope = data as { data: unknown; meta?: Record<string, unknown> };
    return { data: envelope.data, meta: { ...envelope.meta, request_id: requestId } };  // :13
  }
  return { data: data ?? null, meta: { request_id: requestId } };    // :15
}));
```

**契约判定**

| 问题 | 结论 |
| --- | --- |
| `data` 是否必存在 | **是**。任何返回值都会被包成 `{ data: … , meta: … }`；返回 `undefined`/`null` 时 `data` 为 `null`（`:15`）。 |
| `meta` 是否必存在 | **是，且永远是对象**。至少包含 `request_id` 键（实际为 `undefined` → 被 JSON 丢弃）。见 §1 风险 1。 |
| `meta` 是否可为空对象 | 是。GET 列表类接口大量返回 `meta: {}`（如 `dictionaries.controller.ts:18`）。 |
| 分页字段名 | `page` / `page_size` / `total`（下划线）。`paginated()` 与全部 controller 手写字面量一致。 |
| `data` 永远是数组还是对象 | 随接口而定：分页接口 `data` 是**裸数组**，分页信息在 `meta`；详情接口 `data` 是对象。 |
| **陷阱** | 若 handler 返回 `{ data, ...其他兄弟键 }` 且未提供 `meta`，拦截器会**丢弃所有兄弟键**（`api-contract.ts:13` 只取 `.data` 与 `.meta`）。当前无接口命中此陷阱（已核对全部 controller 返回值），但新增接口极易踩。 |
| 未走 `{data,meta}` 显式包裹的接口 | 仅 `admin/users` 4 个路由（`admin-users.controller.ts:25,28,31,34` 直接 `return this.auth.*`），靠拦截器 `:15` 分支兜底，**最终形状相同**。 |

### 2.2 绕过拦截器的端点（`@Res()` 原始响应）

判定依据：`@Res()`（非 `passthrough`）时 handler 自行 `response.send()`，拦截器 `map` 的结果被丢弃；响应体不是 envelope。

| # | METHOD | 路径 | 位置 | 响应体 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/v1/attachments/:id/download` | `platform/attachments/attachments.controller.ts:19-24` | 原始二进制 + `content-disposition` |
| 2 | GET | `/api/v1/reports/:report/export` | `modules/reports/reports.controller.ts:11`（`@Get(":report/export")`） | `text/csv; charset=utf-8`（带 BOM，`reports.service.ts:23`） |
| 3 | GET | `/api/v1/production/reports/operation-payroll.xlsx` | `modules/production/production-payroll-export.controller.ts:21` | xlsx |
| 4 | GET | `/api/v1/production/reports/order-operation-payroll.xlsx` | 同上 `:22` | xlsx |
| 5 | GET | `/api/v1/production/reports/monthly-operations-payroll.xlsx` | 同上 `:23` | xlsx |
| 6 | GET | `/api/v1/production/reports/order-material-production.xlsx` | 同上 `:24` | xlsx |
| 7 | GET | `/api/v1/production/reports/material-issue.xlsx` | `modules/production/material-slip-export.controller.ts:31-36` | xlsx |
| 8 | GET | `/api/v1/production/reports/material-slips.xlsx` | 同上 `:39-45` | xlsx |
| 9 | GET | `/api/v1/procurement/reports/purchase-order.xlsx` | `modules/procurement/purchase-order-export.controller.ts:29-34` | xlsx |
| 10 | GET | `/api/v1/procurement/reports/purchase-orders.xlsx` | 同上 `:37-43` | xlsx |
| 11 | GET | `/api/v1/production/employees/export.xlsx` | `modules/production/production-master-data.controller.ts:66` | xlsx |
| 12 | GET | `/api/v1/production/employees/import-template.xlsx` | 同上 `:67` | xlsx |

**注意**：上述 12 个端点**在出错时仍返回标准错误 envelope**（异常发生在 `response.send()` 之前，由全局过滤器处理），因此客户端必须按 `Content-Type` 判断成功/失败，不能靠 body 形状。

**非 bypass 但特殊**：`auth.controller.ts:15` 与 `:21` 使用 `@Res({ passthrough: true })` → **仍走拦截器**。`POST /auth/logout` 因 `@HttpCode(204)`（`:21`）无响应体：`logout()` 返回 `undefined` → 拦截器产出 `{data:null, meta:{…}}`，但 Express 对 204 会清空 body（`res.send` 对 204 置 `chunk = ''` 并移除 `Content-Type`/`Content-Length`）。前端 `apiRequest` 对空 body 的 `response.json()` 失败后 `catch(() => ({}))`，`response.ok` 为真 → 不抛错（`apps/web/lib/api-client.ts:37-39`）。

---

## 3. 错误响应契约

### 3.1 形状

```ts
// platform/http/api-error.ts:5-9
export class ApiError extends HttpException {
  constructor(status, code, message, details: ApiErrorDetail[] = []) {
    super({ code, message, details }, status);
  }
}
```

过滤器输出（`platform/http/api-exception.filter.ts:22-25`）：

```json
{
  "error": { "code": "…", "message": "…", "details": [ … ] },
  "meta": { "path": "<request.url>", "request_id": undefined }
}
```

**注意**：`ApiError` 类**全仓库未被使用**（已 grep，无 import 点）。实际抛的都是 Nest 内建异常。`meta` 中 `request_id` 恒为 `undefined`（§1 风险 1），所以错误响应体里 `meta` 通常只有 `path`。

### 3.2 归一化逻辑（`api-exception.filter.ts`）

```
status = (P2002 ? 409 : HttpException.getStatus() : 500)                       // :14-15
if status >= 500 → logger.error(method + url, stack)                            // :16-19
payload = P2002 ? uniquePayload(exception)                                      // :28-37
        : HttpException ? exception.getResponse() : undefined                   // :20
normalized = normalizePayload(payload, status)                                  // :39-46
```

`normalizePayload` 的分支：

| 输入 | 输出 |
| --- | --- |
| `payload` 是字符串 | `{ code: errorCode(status), message: <字符串>, details: [] }`（`:40`）— **注意此时 code 是通用码** |
| `payload.message` 是数组 | `message: "请求参数校验失败"`，`details` = 数组逐项 `{message}`（`:43-44`） |
| 对象且带 `code`/`message`/`details` | 原样保留（`:45`） |
| 其它 | `{ code: errorCode(status), message: "请求处理失败"（500 时 "服务器内部错误"）, details: [] }`（`:43`） |

`errorCode(status)` 映射表（`:48-56`）：

| status | code |
| --- | --- |
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 422 | `BUSINESS_RULE_VIOLATION` |
| **其它（含 500 / 413 / 503）** | `REQUEST_ERROR` |

**契约后果**
- 业务异常（`ConflictException({code})` / `UnprocessableEntityException({code})` / `NotFoundException({code})`）会**自带语义化 code**，例如 `ORDER_NO_CONFLICT`、`INSUFFICIENT_INVENTORY`、`PRODUCTION_ORDER_NOT_FOUND`。
- 未带 code 的异常会退化成通用码。典型：`auth.service.ts:37,39` 的 `new UnauthorizedException()`（无参）→ Nest `createBody(undefined, "Unauthorized", 401)` → **`message: "Unauthorized"`（英文）**，`code: "UNAUTHENTICATED"`。
- 400 字符串形式（`BadRequestException("未提供文件")`，`attachments.service.ts:18-19`；`state-machine.service.ts:24-26,35`）→ `code` 强制为 `VALIDATION_ERROR`，即使并非 DTO 校验失败。
- 413（`PayloadTooLargeException`）与非 HTTP 异常一律 `REQUEST_ERROR`。

### 3.3 P2002 专用分支（唯一约束）

`api-exception.filter.ts:28-37` 直接把 Prisma 的 `P2002` 映射为 **409 `UNIQUE_VALUE_CONFLICT`**，并按 `meta.target[0]` 生成中文业务文案：

`labels` 表（`:32`）：`idempotency_key`→幂等键、`employee_no`→员工编号、`operation_code`→工序编码、`production_order_no`→生产单号、`purchase_order_no`→采购单号、`receipt_no`→到货单号、`inbound_no`→入库单号、`material_code`→物料编码、`production_order_operation_id`/`operation_daily_reports_active_business_key`→工序与日期组合、`employee_daily_reports_active_business_key`→员工/工序/日期/计薪方式组合。

`objectType`（`:35`）只会是「工序员工日报 / 工序日报 / 业务记录」三者之一。`details` 形状：`[{ object, field, field_label, target }]`（`:36`）。
已有单测：`apps/api/test/http/api-exception-filter.test.cjs:5-20`（覆盖 `idempotency_key` 与复合 target）。

`platform/database/prisma-error.ts`（全文 20 行）**只提供 P2002 判定**，无 P2025/P2003 映射：

```ts
export function isUniqueConstraintViolation(error)              // :2-4  → code === "P2002"
export function isUniqueConstraintViolationOn(error, ...columns) // :11-19
```

`isUniqueConstraintViolationOn` 的列名归一化（`:14-19`）：`meta.target` 支持数组或字符串；统一 `toLowerCase()` 后比较，且去掉下划线再比一次（`flatten`），以兼容 `customer_code` / `customerCode` / `customers_customer_code_key` 三种写法；拿不到 target 时**保守返回 false**（不重试）。

**关键缺口**：除 `production-master-data.service.ts:192`（导入行内文案）外，**没有任何 P2025（记录不存在）或 P2003（外键约束）到 HTTP 状态码的映射**（已 grep `P2025|P2003|P2034`）。因此：
- `P2025`（未做前置存在性检查的 `update`/`delete`）→ **500 `REQUEST_ERROR`**，而非 404。
- `P2003`（删除被引用的主数据）→ **500 `REQUEST_ERROR`**，而非 409。
- `P2034`（Serializable 冲突）只在 `raw-material-movements.service.ts:207,302,357` 与 `outsource-logistics.service.ts:123` 被捕获转 409 `VERSION_CONFLICT`；其它事务路径未捕获 → 500。

### 3.4 ValidationPipe 行为（whitelist / transform / forbidNonWhitelisted）

`apps/api/src/main.ts:19-28`：

```ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  exceptionFactory: (errors) => new BadRequestException({
    code: "VALIDATION_ERROR",
    message: "请求参数校验失败",
    details: errors.flatMap((error) =>
      Object.entries(error.constraints ?? {}).map(([rule, message]) => ({ field: error.property, rule, message }))),
  }),
}));
```

| 问题 | 答案 |
| --- | --- |
| whitelist 是否开启 | **是**（`:20`）。 |
| transform 是否开启 | **是**（`:21`）。`@Type(() => Number)` 会把 query 字符串转成数字。 |
| forbidNonWhitelisted 是否开启 | **是**（`:22`）。未知字段 → **400**，不会被静默丢弃。 |
| 未知字段的错误 details | `{ field: <未知字段名>, rule: "whitelistValidation", message: "property <name> should not exist" }`（class-validator 默认英文文案）。 |
| **作用范围不是全局的** | ValidationPipe 只对**类**（class）metatype 生效。Nest 的 `toValidate` 排除 `[String, Boolean, Number, Array, Object, Buffer, Date]`（`node_modules/@nestjs/common/pipes/validation.pipe.js` 中 `toValidate`/`types` 数组）。因此：<br>• `@Query() q: SomeDto`（类）→ **校验生效**，未知 query 参数 → 400；<br>• `@Query() q: { order_no?: string }`（TS 类型字面量 → 运行时 `Object`）→ **完全跳过校验**，未知参数被静默忽略、也不做任何转换；<br>• `@Query("order_no") x?: string` / `@Body("reason") r: string` → metatype 是原始类型 → **跳过校验**。 |
| 嵌套 DTO 的 details | **丢失**。`exceptionFactory` 只读取每个 error 的**顶层** `error.constraints`（`:26`），不递归 `error.children`。因此 `@ValidateNested({each:true})` 的嵌套失败（如 `PurchaseOrderDto.items[]`、`FormDefinitionDto.fields[]`、`BatchOperationsDto.operations[]`）会得到 **`details: []`**，客户端无法定位字段。 |

**跳过校验的 query 参数端点（未验证 = 不会 400，未知参数被忽略）**

| 路径 | 位置 |
| --- | --- |
| `GET /production/operation-reports` | `operation-daily-reports.controller.ts:20` |
| `GET /production/employee-reports` | `employee-daily-reports.controller.ts:23` |
| `GET /production/payroll-sources` | `employee-daily-reports.controller.ts:30` |
| `GET /production/finished-goods-inbound-notices` | `finished-goods-inbound-notices.controller.ts:23` |
| `GET /finished-goods/inbound-notices` | 同上 `:37` |
| `GET /production/daily-alerts` | `production-daily-alerts.controller.ts:18` |

**走 DTO 校验（未知参数 → 400）的端点**：`GET /health`（`health.controller.ts:11`，注意它**接收** `page/page_size/sort/search`）、`GET /sales-orders`、`GET /customers`、`GET /reports/*`、`GET /reports/:report/export`、`GET /alerts`、`GET /order-workbench/orders`、`GET /production-progress/*`、`GET /production/employees`、全部导出端点的 query DTO。

---

## 4. 状态码矩阵

`ResponseEnvelopeInterceptor` 不参与状态码；状态码由 Nest 默认规则 + `@HttpCode` 决定：**POST → 201**，其余方法（GET/PATCH/PUT/DELETE）→ **200**（`node_modules/@nestjs/core/router/router-response-controller.js` 的 `getStatusByMethod`）。

| status | 触发条件 | 代码位置 | 是否已有测试 |
| --- | --- | --- | --- |
| **200** | GET / PATCH / PUT / DELETE 成功；任何显式 `@HttpCode(200)` | Nest 默认（`router-response-controller.js#getStatusByMethod`） | ✅ 部分：`platform-http.test.cjs:9`（health 200） |
| **201** | **所有 POST 成功**（未加 `@HttpCode`），含 `POST /auth/login` | Nest 默认；`auth.controller.ts:15` | ✅ `sales-orders-pagination-http.test.cjs:11`（login 201） |
| **204** | `POST /auth/logout`（唯一） | `auth.controller.ts:21` `@HttpCode(204)` | ❌ 无 |
| **400** | (a) DTO 校验失败 / 未知字段 | `main.ts:23-27` `exceptionFactory` | ❌ 无 |
| | (b) `BadRequestException`（字符串或对象） | `attachments.service.ts:18,19`；`state-machine.service.ts:26` | ❌ 无 |
| | (c) multipart 非 size 类错误 | `@nestjs/platform-express` `multer.utils.js#transformException` → `BadRequestException` | ❌ 无 |
| **401** | (a) 无 `dilee_session` cookie | `auth.service.ts:37` `UnauthorizedException()` → `message:"Unauthorized"` | ✅ 部分：`platform-http.test.cjs:16-22,24-33,35-40`；`production-daily-reports-http.test.cjs:7-23` |
| | (b) session 过期/无效/用户被停用或软删 | `auth.service.ts:38-39`（`expiresAt > now` 且 `user.isActive && deletedAt == null`） | ❌ 无 |
| | (c) 登录用户名/密码错误 | `auth.service.ts:22-25` `UnauthorizedException("用户名或密码错误")` | ✅ E2E：`tests/e2e/authentication.spec.mjs:9-15`（UI 层） |
| | (d) 登录失败 ≥5 次后被限流 60s | `auth.service.ts:9-10,99-109`（内存 `Map`，多实例不共享 → **未验证**） | ✅ 单测：`platform-api.test.cjs:33-37` |
| **403** | (a) 命中 `@RequireAdministrator()` 而非管理员 | `module-permission.guard.ts:24` `ForbiddenException("需要管理员权限")` | ❌ 无 |
| | (b) 缺少所需模块权限（AND）/ 任一模块权限（ANY） | `module-permission.guard.ts:26,27` `ForbiddenException("无模块访问权限")` | ❌ 无 |
| | (c) 未认证进入 `ModulePermissionGuard` | `module-permission.guard.ts:20` `ForbiddenException()` | ❌ 无（**实际不可达**：所有使用该 guard 的控制器都同时挂了 `AuthenticationGuard`，后者先抛 401） |
| **404** | (a) 路由不存在**或方法不匹配**（Nest 的 404 handler 同时覆盖两者，无 405） | `node_modules/@nestjs/core/router/routes-resolver.js#registerNotFoundHandler` → `NotFoundException("Cannot GET /api/v1/…")`；`message` 为**英文**，`code` = `NOT_FOUND` | ❌ 无 |
| | (b) 业务对象不存在（带语义 code） | `customers.service.ts:25`、`sales-orders.service.ts:22`、`boms.service.ts:17,23`、`order-workbench.service.ts:20,24,30`、`auth.service.ts:71,79,89,114`、`forms.service.ts:17`、`dictionaries.service.ts:19,33,34`、`alerts.service.ts:21`、`attachments.service.ts:48`、`state-machine.service.ts:24,35` 等 | ❌ 无 |
| **409** | (a) **任意未捕获的 Prisma `P2002`**（全局兜底） | `api-exception.filter.ts:14-15,28-37`，code = `UNIQUE_VALUE_CONFLICT` | ✅ 单测 `api-exception-filter.test.cjs:5-20` |
| | (b) 服务层显式 `ConflictException` | 例：`sales-orders.service.ts:121`（`ORDER_NO_CONFLICT`）、`customers.service.ts:104`（`CUSTOMER_CONFLICT`）、`boms.service.ts:27,38`（`BOM_ALREADY_EXISTS`）、`auth.service.ts:64,70,119`、`raw-material-movements.service.ts:180,207,208,302,303,357,358`、`outsource-logistics.service.ts:122,123`、`finished-goods-outbound-notice.service.ts:128`、`forms.service.ts:40`、`raw-material-inbound-notices.service.ts:87` | ❌ 无（路由层） |
| **413** | 上传文件超过 Multer `limits.fileSize`：附件 > 20MB、员工导入 > 10MB | `attachments.controller.ts:16`（20MB）、`production-master-data.controller.ts:68`（10MB）；映射在 `multer.utils.js#transformException` | ❌ 无 |
| **422** | 业务规则不满足（`UnprocessableEntityException`，必带语义 code） | 全仓库 200+ 处，代表：`sales-orders.service.ts:43,51,74,83,87,93,102`、`raw-material-movements.service.ts:167,171,175,188,233,258,259,261,263`、`finished-goods-outbound.service.ts:30,99,188,201,202,218,243,252,269,270`、`finished-goods-inventory.service.ts:102,111,122,131,156`、`reports.service.ts:16,17`、`employee-daily-reports.controller.ts:26`（批量行校验）等 | ❌ 无 |
| **500** | `@Catch()` 兜底任何非 `HttpException`：未映射 Prisma 错误（**P2025 / P2003 / 未捕获的 P2034**）、`TypeError`、BigInt 序列化（§1 风险 2）等 | `api-exception.filter.ts:15,43`；code = `REQUEST_ERROR`，message = `"服务器内部错误"` | ❌ 无 |
| **503** | 数据库不可用 | `health.controller.ts:16` `ServiceUnavailableException({code:"DEPENDENCY_UNAVAILABLE"})` | ✅ 单测 `platform-api.test.cjs:29-30`（直调 controller，非 HTTP 层） |

**未产生但常被假设的状态码**：405（方法不允许 → 实际 404）、429（限流 → 实际 401）、304（ETag 被显式关闭，`main.ts:13`）。

---

## 5. 鉴权与授权矩阵

### 5.1 机制

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 登录 payload | `{ username: string(1..100), password: string(8..200) }` | `auth.controller.ts:6-9` |
| 登录成功响应 | `{ data: { user: { id, username, display_name } }, meta: {} }`，HTTP **201** | `auth.controller.ts:15-19`、`auth.service.ts:123` |
| 会话持久化 | 表 `session`：`tokenHash = sha256(token)`，TTL 12h；登录时**先删该用户全部 session 再建一条**（单会话） | `auth.service.ts:8,27-31` |
| Cookie | 名 `dilee_session`，`httpOnly:true`，`sameSite:"lax"`，`path:"/"`，`maxAge:12h`，`secure` 依据 `COOKIE_SECURE==="true"` 或（`NODE_ENV==="production"` 且未显式 `"false"`） | `auth.controller.ts:13,17,22` |
| token vs cookie | **只有 cookie**。没有 `Authorization: Bearer` 支持：`AuthenticationGuard` 只读 `request.cookies?.dilee_session` | `authentication.guard.ts:12`；`tests/helpers/api-client.cjs:5` 里的 `Bearer` 头是测试工具遗留，**后端不认** |
| 密码哈希 | argon2id，最小长度 10 且须同时含字母与数字、不得有首尾空白 | `auth.service.ts:11,117-120` |
| 登录限流 | 进程内 `Map`，同一 username 5 次失败 → 封 60s | `auth.service.ts:15,99-109`（多实例/重启后失效 → **未验证** 生产实际效果） |
| `GET /auth/me` | 自行读 cookie，无 guard；无/失效 cookie → 401 | `auth.controller.ts:20`；`auth.service.ts:36-41` |
| `POST /auth/logout` | 无 guard；无 cookie 时静默成功（204） | `auth.controller.ts:21-23`；`auth.service.ts:43-48` |
| 改密/停用/改角色 | 均 `session.deleteMany({userId})`（踢下线） | `auth.service.ts:72,80,94` |

### 5.2 `AuthenticationGuard`

`authentication.guard.ts:10-14`：调用 `AuthService.currentUser(request.cookies?.dilee_session)`，把结果写到 `request.currentUser`，**永远 `return true`**。
- 无 cookie → `UnauthorizedException()`（401，message `"Unauthorized"`）
- hash 查不到 / `expiresAt <= now` / `user.isActive === false` / `user.deletedAt != null` → `UnauthorizedException()`（401）
- 该 guard 每次请求都打一次 DB（`session.findFirst ... include user`，`auth.service.ts:38`），无缓存。

### 5.3 `ModulePermissionGuard`

`module-permission.guard.ts:13-29`，求值顺序**严格**如下：

```
1. modules              = reflector.getAllAndOverride(REQUIRED_MODULES,        [handler, class])   // :14
   anyModules           = reflector.getAllAndOverride(REQUIRED_ANY_MODULES,    [handler, class])   // :15
   requiresAdministrator = reflector.getAllAndOverride(REQUIRE_ADMINISTRATOR,  [handler, class])   // :16
2. 三者都为空 → return true（不做任何权限检查）                                                     // :17
3. userId 为空 → throw ForbiddenException()（403；实际不可达，见 §4）                              // :19-20
4. 载入该用户全部未删除角色及其 permissions                                                        // :21
5. 若任一角色 key === "administrator" → return true（**超管短路，跳过后续全部检查**）              // :22-23
6. 若 requiresAdministrator → throw ForbiddenException("需要管理员权限")                           // :24
7. 若 modules 非空 → 必须 **全部命中**，否则 throw ForbiddenException("无模块访问权限")             // :26
8. 若 anyModules 非空 → 必须 **至少命中一个**，否则 throw ForbiddenException("无模块访问权限")      // :27
```

**关键语义（易被误判，务必写进测试计划）**

- **方法级覆盖只对「同一种元数据」生效**。`getAllAndOverride` 按 `[handler, class]` 取第一个已定义值，因此：
  - 类级 `@RequireModules("X")` + 方法级 `@RequireModules("Y")` → 只用 `Y`（覆盖）。
  - 类级 `@RequireModules("X")` + 方法级 `@RequireAnyModules("Y","Z")` → **`modules=["X"]` 与 `anyModules=["Y","Z"]` 同时生效（AND）**：必须同时满足 `X` 与（`Y` 或 `Z`）。代码注释已明确记录这个坑：`modules/procurement/master-data-read.controller.ts:12-18`、`modules/finance/payable-notification.controller.ts:20-27`。
  - 类级 `@RequireAdministrator()` + 方法级 `@RequireModules("Y")` → **两者都生效**，但 `:24` 先于 `:26`，非管理员直接 403「需要管理员权限」。
- **管理员短路在第 5 步**，所以 `administrator` 角色对**任何**接口都通（包括 `@RequireModules`）。`module-key.ts` 里 `MODULE_KEYS = ["sales","procurement","production","warehouse","finance","hr"]`（`module-key.ts:1`）**不含** `administrator`；`administrator` 是 `role.key` 而非 `permission.moduleKey`。
- **无任何装饰器的控制器 = 只要求登录**（第 2 步直接放行）。见下表 `attachments`、`dictionaries` 的 GET。

### 5.4 逐控制器矩阵（37 个控制器全覆盖）

| # | 控制器 (file:line) | 类级要求 | 方法级覆盖 | Guard 链 |
| --- | --- | --- | --- | --- |
| 1 | `health.controller.ts:6` | 无 | 无 | **无 guard → 公开** |
| 2 | `platform/auth/auth.controller.ts:11` | 无 | 无 | **无 guard → 公开**（`me`/`logout` 自行读 cookie） |
| 3 | `platform/authorization/admin-users.controller.ts:18-20` | `@RequireAdministrator()` | 无 | Authentication + ModulePermission → **仅 administrator**（4 路由） |
| 4 | `platform/attachments/attachments.controller.ts:12-13` | **无模块要求** | 无 | **仅 AuthenticationGuard**（无 ModulePermissionGuard）→ **任意登录用户**（4 路由） |
| 5 | `platform/dictionaries/dictionaries.controller.ts:14-15` | 无 | GET×3 无装饰器 → 仅登录；POST/PATCH/DELETE×5 加 `@RequireAdministrator()`（`:19,21,23,24,25`） | Authentication + ModulePermission |
| 6 | `platform/forms/forms.controller.ts:25-27` | `@RequireModules("sales")` | 无 | Authentication + ModulePermission（4 路由，全部要求 `sales`） |
| 7 | `platform/inventory/inventory.controller.ts:8-10` | `@RequireAnyModules("warehouse","procurement")` | 无 | 3 个 GET |
| 8 | `modules/alerts/alerts.controller.ts:11` | `@RequireAnyModules(sales,procurement,production,warehouse,finance,hr)` | 无 | 2 路由 |
| 9 | `modules/order-workbench/order-workbench.controller.ts:11-13` | 同上（6 模块 ANY） | 无 | 3 路由 |
| 10 | `modules/reports/reports.controller.ts:10` | 同上（6 模块 ANY） | 无 | 6 路由（含 `:report/export`） |
| 11 | `modules/finance/finance.controller.ts:62-64` | `@RequireModules("finance")` | 无 | **全部 ~47 路由仅 finance** |
| 12 | `modules/finance/payable-notification.controller.ts:29-31` | `@RequireAnyModules("finance","procurement")` | 无 | 2 路由 |
| 13 | `modules/hr/hr.controller.ts:28-30` | `@RequireModules("hr")` | 无 | **33 路由仅 hr** |
| 14 | `modules/procurement/incoming-inspections.controller.ts:15` | `@RequireModules("warehouse")` | 无 | 5 路由 |
| 15 | `modules/procurement/master-data-read.controller.ts:20-22` | `@RequireAnyModules("procurement","warehouse","production","sales")` | 无 | `GET /units`、`GET /materials` |
| 16 | `modules/procurement/procurement-master-data.controller.ts:23-25` | `@RequireModules("procurement")` | 无 | 14 路由（units/materials/suppliers 写） |
| 17 | `modules/procurement/purchase-order-export.controller.ts:22-24` | `@RequireModules("procurement")` | `@RequireAdministrator()`（`:30,38`） | procurement **且** admin（admin 短路） |
| 18 | `modules/procurement/purchase-orders.controller.ts:17-19` | `@RequireModules("procurement")` | 无 | 13 路由 |
| 19 | `modules/procurement/raw-material-inbound-notices.controller.ts:13-14` | **无类级要求** | `:19` ANY(procurement,warehouse)；`:25` ANY(procurement,warehouse)；`:31` procurement；`:37` warehouse | **4 路由各自声明** |
| 20 | `modules/procurement/raw-material-inbounds.controller.ts:13` | **无类级要求** | 7 路由各自 `@RequireModules("warehouse")`；`GET payable-sources` → `@RequireAnyModules("finance","procurement")` | **8 路由各自声明** |
| 21 | `modules/production/employee-daily-reports.controller.ts:18-20` | `@RequireModules("production")` | `:30` `@RequireAnyModules("hr","finance")` | ⚠️ **AND**：`production` **且**（`hr` 或 `finance`） |
| 22 | `modules/production/finished-goods-inbound-notices.controller.ts:18-20` / `:32-34` | 第 1 个 `production`；第 2 个 `warehouse` | 无 | 5 + 2 路由 |
| 23 | `modules/production/finished-goods-qc.controller.ts:17-18` | **无类级要求** | 每个路由 `@RequireModules("warehouse")`（`:21-32`） | 12 路由各自声明 |
| 24 | `modules/production/material-slip-export.controller.ts:24-26` | `@RequireModules("production")` | `@RequireAdministrator()`（`:32,40`） | production 且 admin |
| 25 | `modules/production/operation-daily-reports.controller.ts:15-17` | `@RequireModules("production")` | 无 | 8 路由 |
| 26 | `modules/production/outsource-logistics.controller.ts:21-22` | **无类级要求** | `production`（`:25,27,28,31`）、`finance`（`:26`）、`warehouse`（`:29,30,37-47`）、`procurement`（`:32-36,48,49`） | **25 路由各自声明** |
| 27 | `modules/production/production-daily-alerts.controller.ts:13-15` | `@RequireModules("production")` | 无 | 6 路由 |
| 28 | `modules/production/production-master-data.controller.ts:49-51` | `@RequireModules("production")` | 写路由 + 导入/导出加 `@RequireAdministrator()`（`:55-59,61-68,70-73,75-79,81-85,87-88`）；读路由（`:54,60,69,74,80,86`）仅类级 | 读=production，写=production 且 admin |
| 29 | `modules/production/production-orders.controller.ts:18-20` | `@RequireModules("production")` | 无 | 13 路由 |
| 30 | `modules/production/production-payroll-export.controller.ts:16-18` | `@RequireModules("production")` | `@RequireAdministrator()`（`:21-24`） | production 且 admin |
| 31 | `modules/production/production-progress.controller.ts:19-20` | **无类级要求** | `:24` ANY(production,finance,hr)；`:25,:26` ANY(production,sales,finance,hr)；`:27` `@RequireAdministrator()` | 4 路由各自声明 |
| 32 | `modules/production/raw-material-movements.controller.ts:23-25` | `@RequireModules("production")` | 无 | 18 路由 |
| 33 | `modules/sales/sales-orders.controller.ts:74-76` | `@RequireModules("sales")` | 无 | 13 路由 |
| 34 | `modules/sales/boms.controller.ts:29-31` | `@RequireModules("procurement")` | 无 | 5 路由（**BOM 归 procurement**） |
| 35 | `modules/sales/customers.controller.ts:53-55` | `@RequireModules("sales")` | 无 | 9 路由 |
| 36 | `modules/warehouse/finished-goods-inventory.controller.ts:13-14` | **无类级要求** | 每个路由 `@RequireModules("warehouse")`（`:17-24`） | 8 路由 |
| 37 | `modules/warehouse/finished-goods-outbound.controller.ts:16-18` | `@RequireModules("warehouse")` | 无 | 15 路由 |

**授权层结论（测试重点）**

- **A1 附件无模块鉴权，且无对象级鉴权**：`attachments.controller.ts:13` 只有 `AuthenticationGuard`。任何登录用户都能 `GET /attachments/{任意UUID}/download`、`DELETE /attachments/{任意UUID}`。属横向越权（IDOR）。
- **A2 字典读取只要求登录**：`GET /dictionaries/types`、`GET /dictionaries/hr/employee-types`、`GET /dictionaries/:typeKey/items`（`dictionaries.controller.ts:18,20,22`）无模块要求。`/dictionaries` 在前端**无调用点**（已 grep `apps/web`）→ 可能为孤儿接口。**未验证**是否为有意设计。
- **A3 `production/payroll-sources` 的 AND 语义很可能与设计意图不符**：`employee-daily-reports.controller.ts:20` 类级 `production` + `:30` 方法级 `ANY(hr,finance)` ⇒ 只有 hr 或 finance 权限的用户会 403。该端点在前端**无调用点**（已 grep `apps/web` 无 `payroll-sources`）。
- **A4 一个 URL 前缀由 3 个控制器共用**：`finished-goods` 同时被 `finished-goods-qc.controller.ts:17`（production 模块文件）、`finished-goods-inventory.controller.ts:13`、`finished-goods-outbound.controller.ts:16`（warehouse 模块文件）使用。已核对无路径冲突，但**权限归属依赖每个路由的装饰器**，新增路由极易漏挂。
- **A5 模块归属与业务语义不一致**：BOM 属 `procurement`（`boms.controller.ts:31`）、表单定义属 `sales`（`forms.controller.ts:27`）、成品质检在 production 包里但要求 `warehouse`（`finished-goods-qc.controller.ts:21-32`）。

---

## 6. 分页 / 排序 / 过滤一致性

### 6.1 `PaginationQueryDto`（`platform/http/pagination-query.dto.ts`，全文 25 行）

| 字段 | 装饰器 | 默认 | 边界 |
| --- | --- | --- | --- |
| `page` | `@IsOptional() @Type(() => Number) @IsInt() @Min(1)` | `1` | ≥ 1 |
| `page_size` | `@IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)` | `20` | 1..200 |
| `sort` | `@IsOptional() @IsString()` | — | **无实现** |
| `search` | `@IsOptional() @IsString()` | — | 仅两处消费 |

**`sort` 是死字段**：已全仓库 grep `query.sort` / `.sort`，仅有 `pagination-query.dto.ts:20` 的声明本身与若干数组排序（`.sort()`）命中，**没有任何 endpoint 读取 `sort`**。传 `?sort=xxx` 会通过校验但被静默忽略。

`search` 只有两个消费点：`customers.controller.ts:58` → `customers.service.ts:17-19`（模糊匹配 `name`/`customerCode`，insensitive）；`sales-orders.controller.ts:79` → `sales-orders.service.ts:14-15`（模糊匹配 `orderNo`/`productName`）。其余接口传 `search` 会 400（DTO 在 whitelist 内则通过）或静默忽略。

### 6.2 返回**完整分页 meta**（`page` + `page_size` + `total`）的端点

| 路径 | 位置 | `total` 语义 | 支持的过滤参数 |
| --- | --- | --- | --- |
| `GET /api/v1/sales-orders` | `sales-orders.controller.ts:79` | `count(where)` ✅ 真实总数 | `page`, `page_size`, `search`, `status` |
| `GET /api/v1/customers` | `customers.controller.ts:58` | `count(where)` ✅ | `page`, `page_size`, `search` |
| `GET /api/v1/reports/orders` | `reports.controller.ts:11` | `count(where)` ✅ | `order_no, from, to, status, employee_id, supplier_id, page, page_size` |
| `GET /api/v1/reports/procurement-payables` | 同上 | ⚠️ **`rows.length`（=本页行数，不是总数）** | 同上（`from`/`to`/`employee_id` 被忽略） |
| `GET /api/v1/reports/inventory` | 同上 | ⚠️ `rows.length` | 同上（`status`/`employee_id`/`supplier_id` 被忽略） |
| `GET /api/v1/reports/production-qc` | 同上 | ⚠️ `rows.length` | 同上（`from`/`to`/`employee_id`/`supplier_id` 被忽略） |
| `GET /api/v1/reports/payroll` | 同上 | ⚠️ `rows.length` | 同上（`order_no`/`from`/`to`/`supplier_id` 被忽略） |
| `GET /api/v1/alerts` | `alerts.controller.ts:12` | `data.length`（过滤后总数）✅ | `alert_type, status, order_no, severity, page, page_size` |
| `GET /api/v1/order-workbench/orders` | `order-workbench.controller.ts:16` | `count(where)` ✅；**当传 `has_blockers` 时变为 `data.length`**（`order-workbench.service.ts:17`，因为过滤发生在分页之后） | `order_no, customer_id, status, has_blockers, from, to, page, page_size` |
| `GET /api/v1/production-progress/measurements` | `production-progress.controller.ts:24` | ✅ | `order_no, production_order_id, from, to, page, page_size` |
| `GET /api/v1/production-progress/order-statuses` | 同上 `:25` | ✅ | 同上 |

### 6.3 **部分分页 meta**（只有 `total`）

| 路径 | 位置 | meta |
| --- | --- | --- |
| `GET /api/v1/production/orders/:id/measurements` | `operation-daily-reports.controller.ts:27` | `{ total }` — **缺 `page`/`page_size`**，且内部硬编码 `page:1, page_size:200`（不可调） |

### 6.4 接受分页/过滤参数但**返回裸数组**或**不实现分页**的端点

| 路径 | 位置 | 问题 |
| --- | --- | --- |
| `GET /production/operation-reports` | `operation-daily-reports.controller.ts:20` | 查询类型是 **TS 字面量**（不校验、不转换），返回**全量裸数组**，`meta: {}` |
| `GET /production/employee-reports` | `employee-daily-reports.controller.ts:23` | 同上 |
| `GET /production/payroll-sources` | 同上 `:30` | 同上；`from`/`to` 在类型上必填但**无运行时校验**（缺失 → 由 `employee-daily-reports.service.ts:172` 抛 422 `INVALID_PAYROLL_PERIOD` 或 `date()` 抛 422 `INVALID_REPORT_DATE`） |
| `GET /production/finished-goods-inbound-notices` | `finished-goods-inbound-notices.controller.ts:23` | 字面量类型、裸数组 |
| `GET /finished-goods/inbound-notices` | 同上 `:37` | 同上 |
| `GET /production/daily-alerts` | `production-daily-alerts.controller.ts:18` | 同上 |
| `GET /alerts` | `alerts.controller.ts:9` | ⚠️ `page`/`page_size` **无 `@Type(() => Number)`、无 `@IsInt`/`@Min`/`@Max`** → 传 `?page=2` 时 `q.page` 是**字符串 `"2"`**，`meta.page` 回显字符串（`alerts.service.ts:19` 靠 `Math.min`/减法隐式转换才没崩）。**类型契约被破坏**（`meta.page` 有时是 number 有时是 string）。 |
| `GET /health` | `health.controller.ts:11` | 形参是 `PaginationQueryDto` 但**完全未使用**；副作用：`GET /health?foo=1` → **400**，`GET /health?page_size=201` → **400**（健康检查可能因此被探针判失败） |
| 其余全部 `@Query("order_no")` 形态的列表接口 | 如 `purchase-orders.controller.ts:22`、`production-orders.controller.ts:23`、`boms.controller.ts:34`、`raw-material-inbounds.controller.ts:13`、`finished-goods-*`、`finance.controller.ts:67+`、`hr.controller.ts:33+` 等 | **返回全量裸数组**，`meta: {}`，无分页；部分接口静默忽略多余参数 |

### 6.5 Inconsistency 清单（客户端最需要知道的"契约不统一"）

| # | 不一致 | 证据 |
| --- | --- | --- |
| I1 | `sort` 全局声明但**从未实现** | `pagination-query.dto.ts:20` + 全仓库无消费点 |
| I2 | `meta.total` 语义分裂：`count(where)` vs `rows.length`（本页行数） | `reports.service.ts:11`（✅count）对比 `:12,13,14,15`（❌rows.length） |
| I3 | `meta.total` 语义随参数变化 | `order-workbench.service.ts:17`（`has_blockers` 时 `data.length`） |
| I4 | 4 个报表端点的 `meta.total` 恒等于本页行数 → 客户端分页器会以为只有一页 | `reports.service.ts:12-15` |
| I5 | 一个端点只返回 `meta.total`，缺 `page`/`page_size` | `operation-daily-reports.controller.ts:27` |
| I6 | `meta.page`/`meta.page_size` 类型不稳定（number vs string） | `alerts.controller.ts:9` vs `pagination-query.dto.ts:9,16` |
| I7 | 未知 query 参数：**部分 400、部分静默忽略** | §3.4 两张清单 |
| I8 | `from`/`to`/`status`/`employee_id`/`supplier_id` 在 `ReportQueryDto` 里对所有报表端点都声明，但每个端点只实现子集 → **静默忽略** | `reports.controller.ts:9` + `reports.service.ts:11-15,18`（例如 `inventory` 用 `from/to` 过滤 `createdAt`，`procurement` 用 `status/supplier_id`，`payroll` 用 `employee_id/status`；其余参数声明了却不生效） |
| I9 | 大量列表端点完全没有分页（裸数组全量返回） | §6.4；`finance.controller.ts:67-111`、`hr.controller.ts:33-59` 全部如此 |
| I10 | `PATCH` 与 `POST` 混用表达同一语义（状态流转） | `PATCH /incoming-inspections/:id/status`（`incoming-inspections.controller.ts:15`）vs `POST /production/orders/:id/transition`（`production-orders.controller.ts:34`）vs `PATCH /raw-material-inbound-notices/:id/acknowledge`（`raw-material-inbound-notices.controller.ts:36`）——**三套写法**表达"改状态" |
| I11 | 删除：`DELETE` 与 `POST .../cancel` 混用 | `DELETE /raw-material-inbounds/:id`（硬/软删）vs `POST /raw-material-inbounds/:id/reverse`（冲销）vs `POST /sales-orders/:id/close` 等 |
| I12 | 大量 `DELETE` 路由要求**请求体**（Express 默认允许，但很多客户端/网关会剥离 DELETE body） | `operation-daily-reports.controller.ts:24`、`employee-daily-reports.controller.ts:28`、`hr.controller.ts:36,40` 均 `@Delete(...) @Body() body: …` |

---

## 7. 幂等 / 并发 / 事务分析

> 结论基于：`apps/api/prisma/schema.prisma` 的唯一约束、全仓库 `FOR UPDATE` 53 处 grep（22 个文件）、`Prisma.TransactionIsolationLevel.Serializable`、`pg_advisory_xact_lock`。
> **总体判断：本项目在库存/台账/状态流转路径上的并发防护做得相当扎实**（行级 `FOR UPDATE` + Serializable + advisory lock + 唯一幂等键），主要缺口集中在"无幂等键的写端点"和"未映射的 P2025/P2003"。

### 7.1 幂等键落库情况（`schema.prisma`）

**`idempotency_key` 有 UNIQUE 约束的表**（共 12 处）：

| 表 | schema 行 | 对应入口 |
| --- | --- | --- |
| 原料入库 `raw_material_inbounds` | `:744` | `POST /raw-material-inbounds/:id/post` |
| 采购应付来源 `payable_sources` | `:833` | 由到货/质检生成 |
| 外加工应付来源 `outsource_payable_sources` | `:899` | 外加工签收 |
| 成品入库通知 `finished_goods_inbound_notices` | `:1192` | `POST /production/finished-goods-inbound-notices` |
| 成品入库 `finished_goods_inbounds` | `:1222` | `POST /finished-goods/inbounds` |
| 不良品入库 `finished_goods_defectives` | `:1256` | `POST /finished-goods/defectives` |
| 成品出库 `finished_goods_outbounds` | `:1295` | `POST /finished-goods/outbounds` |
| 客户退货 `customer_returns` | `:1374` | `POST /finished-goods/customer-returns` |
| 成品出库通知 `finished_goods_outbound_notices` | `:1342` | `POST /sales-orders/:id/outbound-notices` |
| 原料流转 `raw_material_movements` | `:1655` | `POST /production/material-movements/:id/post`、`/reverse`、`/post-return` … |
| 工序日报 `operation_daily_reports` | `:1892`（可空） | `POST /production/operation-reports` |
| 员工日报 `employee_daily_reports` | `:1921`（可空） | `POST /production/employee-reports` |
| 外加工签收 `outsource_receipts` | `:919` 的 `outsourceReceiptId @unique` | `POST /production/outsource-logistics-batches/:id/receipts`（`idempotency_key` 必填，DTO `outsource-logistics.controller.ts:13`） |

**其它重要的业务唯一键**（防重复建单）：`sales_orders.order_no`（`:285`）、`purchase_orders.purchase_order_no`（`:553`）、`purchase_receipts.receipt_no`（`:639`）、`customers.customer_code`/`name`（`:236,237`）、`materials.material_code`（`:492`）+ `@@unique([name, specificationModel, color])`（`:519`）、`suppliers.supplier_code`/`name`（`:526,527`）、`production_orders.production_order_no`（`:1586`）、`employees.employee_no`（`:1794`）、`units.name`（`:456`）、`departments.code`/`name`（`:1755,1756`）、`production_order_operations @@unique([productionOrderId, sequenceNo])`（`:1748`）、`alerts @@unique([sourceType, sourceId, alertType])`（`:2226`）、`payroll_ledgers @@unique([employeeId, periodStart, periodEnd])`（`:2074`）、`attendance_records @@unique([employeeId, attendanceDate])`（`:2051`）。

### 7.2 库存 / 台账 / 状态流转写端点（高风险组，逐条）

| METHOD / 路径 | 控制器 | Service | 事务 | 幂等 | 并发安全 | 证据 (file:line) | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST `/production/material-movements/:id/post` | `raw-material-movements.controller.ts:40` | `postOutbound` | ✅ `$transaction(..., {isolationLevel: Serializable})` | ✅ **要求 `idempotency_key`（必填）**，先查 `movement.idempotencyKey === key` 直接返回；键有 UNIQUE 约束 | ✅ 强：`pg_advisory_xact_lock(hashtext(material|unit))` 排序后加锁 + 事务内重读状态必须为 `draft` + 事务内重算可用量 | `raw-material-movements.service.ts:164-211`（`:178,:186,:195,:203`；错误映射 `:207-208`） | 低 |
| POST `/production/material-movements/:id/reverse` | 同上 `:44` | `reverse` | ✅ | ✅ 要求键 | ✅ `FOR UPDATE` 源单据 + 下游依赖计数在事务内重查 | `raw-material-movements.service.ts:258-303` | 低 |
| POST `/production/material-movements/:id/post-return` / `post-scrap` / `post-replenishment` | 同上 `:41,42,43` | `postDerived` | ✅ | ✅ 要求键 | ✅ `FOR UPDATE` + 事务内状态校验 | `raw-material-movements.service.ts:332-358`（`:341,:357-358`） | 低 |
| POST `/production/material-movements/:id/reopen` | 同上 `:46` | `reopen` | ✅ | ⚠️ **无幂等键**（只要求 `reason`） | ✅ 事务内 `FOR UPDATE` + 状态必须 `posted` + 下游依赖复查 | `raw-material-movements.service.ts:233-244`（`:241,:244`） | 中：重复调用第二次会 409 `MATERIAL_MOVEMENT_NOT_POSTED`（幂等副作用，不是静默重复扣减） |
| POST `/production/material-movements`（建领料单） | 同上 `:30` | `createIssue` | ✅ | ⚠️ **无幂等键** | ⚠️ 无锁；靠单据号 `movement_no` UNIQUE 兜底 | `raw-material-movements.service.ts`（create 路径）；`schema.prisma:1644` | **中高**：双击可建两张草稿单；过账前无库存影响，风险可控 |
| POST `/production/material-movements/returns` / `scraps` / `replenishments` | 同上 `:31,32,33` | `createReturn`/`createScrap`/`createReplenishment` | ✅ | ⚠️ **无幂等键** | ⚠️ 事务内校验来源领料可处分量（`:368-376`），但两次并发创建可能都通过校验（**未验证**是否靠单据号 UNIQUE 兜住） | `raw-material-movements.service.ts:364-376` | **中**：重复创建不会重复过账（过账单独要求幂等键） |
| POST `/raw-material-inbounds/:id/post` | `raw-material-inbounds.controller.ts:13` | — | ✅ | ✅ `idempotency_key` | ✅ `FOR UPDATE`（`:136,:141`） | `raw-material-inbounds.service.ts:136,141`；`schema.prisma:744` | 低 |
| POST `/raw-material-inbounds/:id/reverse` | 同上 | — | ✅ | ✅ | ✅ `FOR UPDATE`（`:211,:217,:271`） | `raw-material-inbounds.service.ts:211,217,271` | 低 |
| POST `/raw-material-inbounds`（建入库草稿） | 同上 | — | ✅ | ✅ DTO 有 `idempotency_key`（`raw-material-inbounds.controller.ts:10`） | ✅ `FOR UPDATE` 质检行（`:93`） | `raw-material-inbounds.service.ts:93` | 低 |
| POST `/incoming-inspections` / `PATCH /:id` / `PATCH /:id/status` / `POST /:id/return` | `incoming-inspections.controller.ts:15` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE`（`:18,:38,:69,:103`） | `incoming-inspections.service.ts:18,38,69,103` | 中（状态机有 `:93` 白名单校验） |
| POST `/purchase-orders/:id/items/:itemId/receipts` | `purchase-orders.controller.ts:32` | `receipt` | ✅ | ✅ `idempotency_key` —— 但**存在 `extensionData` JSON 里，没有 UNIQUE 约束**，靠事务内 `find` 去重 | ✅ `FOR UPDATE` 采购单（`:40`） | `purchase-orders.service.ts:40` | **中**：并发同键到货可能双写（去重是"事务内先读"，虽在 `FOR UPDATE` 保护下同一采购单串行化 → 实际安全，**未验证**） |
| PATCH `/purchase-orders/receipts/:receiptId` / POST `.../cancel` | 同上 `:33,34` | `updateReceipt`/`cancelReceipt` | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 到货行 + 采购单（`:41,:42`） | `purchase-orders.service.ts:41,42` | 低 |
| POST `/purchase-orders/:id/order` / `revert-draft` / `cancel` / `revert-arrivals` / `close-arrivals` | 同上 `:27-31` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE`（`:47,:72,:89,:115`） | `purchase-orders.service.ts:47,72,89,115` | 中：状态机 + 锁保证不会双流转 |
| POST `/sales-orders/:id/confirm` / `revert-draft` / `close` | `sales-orders.controller.ts:88,89,90` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE`（`:85`） | `sales-orders.service.ts:85` | 低（状态前置校验 `:74,:83,:102`） |
| POST `/sales-orders/:id/outbound-notices` | `sales-orders.controller.ts:84` | `createNotices` | ✅ | ✅ `idempotency_key`（可选）+ 通知表 UNIQUE | ✅ `FOR UPDATE` 生产单（`:95`） | `finished-goods-outbound-notice.service.ts:95,127-128`；`schema.prisma:1342` | 低 |
| POST `/finished-goods/inbounds` / `/defectives`（+ `/post`、`/reverse`） | `finished-goods-inventory.controller.ts:18-24` | — | ✅ | ✅ DTO 有 `idempotency_key`（`:10`） | ✅ `FOR UPDATE` 质检记录与单据（`:28,:44,:59,:60,:84,:85,:107,:127`） | `finished-goods-inventory.service.ts:28,44,59,60,84,85,107,127` | 低 |
| POST `/finished-goods/inspection-submissions`（+ `submit`/`cancel`/`correct`） | `finished-goods-qc.controller.ts:24-32` | — | ✅ | ⚠️ 无幂等键（`UpdateSubmissionDto` 有 `expected_version`，`:12`） | ✅ `FOR UPDATE`（`:79,:102,:116,:123,:136,:143,:169,:235,:238`） | `finished-goods-qc.service.ts:79,102,116,123,136,143,169,235,238` | 低 |
| POST `/finished-goods/outbounds`（+ `post`/`cancel`/`reverse`/`sign`/`shipping`） | `finished-goods-outbound.controller.ts:26-32` | — | ✅ | ✅ DTO 有 `idempotency_key`（`:10,:13`） | ✅ `FOR UPDATE`（`:60,:61,:103,:121,:124,:192`） | `finished-goods-outbound.service.ts:60,61,103,121,124,192` | 低 |
| POST `/finished-goods/customer-returns`（+ `post`/`reverse`） | 同上 `:35-37` | — | ✅ | ✅ `idempotency_key` | ✅ `FOR UPDATE`（`:229,:248`） | `finished-goods-outbound.service.ts:229,248`；`schema.prisma:1374` | 低 |
| POST `/production/outsource-logistics-batches` / `:id/dispatch` / `:id/receipts` 等 25 个 | `outsource-logistics.controller.ts:32-49` | — | ✅ | ⚠️ 仅 `:id/receipts` 必填 `idempotency_key`（`:13`）；其余无 | ✅ `FOR UPDATE` 共 21 处（`:45,:51,:70,:92,:157,:161,:183,:216,:235,:250,:268,:284,:301,:316,:338,:353,:371,:387,:388,:400`） | `outsource-logistics.service.ts` 上述行；错误映射 `:122-123` | 低-中 |
| POST `/production/operation-reports` | `operation-daily-reports.controller.ts:22` | — | ✅ | ✅ DTO 有 `idempotency_key`；复合唯一键 | ✅ `FOR UPDATE` 日报 + 父工序/生产单（`:87,:115,:171,:172`）+ 有序加锁避免死锁（注释 `:166-169`） | `operation-daily-reports.service.ts:87,115,171,172`；`schema.prisma:1892,1998` | 低 |
| POST `/production/employee-reports` / `batch` | `employee-daily-reports.controller.ts:25,26` | — | ✅ | ✅ `idempotency_key`（可空）+ 复合唯一 | ✅ `FOR UPDATE` 日报 + 生产单/工序（`:123,:151,:329,:338`）；更新/删除支持 `expected_version` 乐观锁（`:96,:126,:146,:154` → 422 `DAILY_REPORT_VERSION_CONFLICT`） | `employee-daily-reports.service.ts:96,123,126,146,151,154,329,338`；`schema.prisma:1921` | 低 |
| POST `/production/orders`（+ 13 个状态/工序写） | `production-orders.controller.ts:25-34` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 生产单 9 处（`:72,:127,:139,:159,:196,:225,:243,:287`）+ 销售单（`:29`） | `production-orders.service.ts` 上述行 | 中：新建生产单靠 `production_order_no` UNIQUE + 主生产单冲突检测（`:42`） |
| POST `/production/finished-goods-inbound-notices` / `:id/cancel` | `finished-goods-inbound-notices.controller.ts:25,26` | — | ✅ | ✅ `idempotency_key`（`:10`）+ `notice_no` UNIQUE | ✅ `FOR UPDATE` 生产单 + 通知（`:100,:137,:138`） | `finished-goods-inbound-notices.service.ts:100,137,138`；`schema.prisma:1176,1192` | 低 |
| POST `/raw-material-inbound-notices` / `PATCH /:id/acknowledge` | `raw-material-inbound-notices.controller.ts:30,36` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 质检 + 通知（`:35,:84`） | `raw-material-inbound-notices.service.ts:35,84` | 中 |
| POST `/production-progress/rebuild` | `production-progress.controller.ts:27` | `rebuild` | **未验证**（需读 `production-progress.service.ts`） | ⚠️ 无幂等键（幂等语义应为"重算即幂等"） | **未验证** | `production-progress.controller.ts:27` | 中：仅管理员，接受 `page`/`page_size` 但语义可疑 |
| POST `/finance/customer-payments/:id/post` / `:id/reverse` | `finance.controller.ts:79,80` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 付款 + 应收来源（`:26,:34,:52,:61`，来源 id 排序后加锁避免死锁 `:34`） | `customer-payment.service.ts:26,34,52,61` | **中**：无幂等键 ⇒ 双击过账第二次会因状态校验失败（应收已 posted）→ 422/409，非静默重复 |
| POST `/finance/supplier-payments/:id/post` / `:id/reverse` | 同上 `:105,106` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 付款 + 应付条目（`:40,:46,:65,:77`） | `supplier-payment.service.ts:40,46,65,77` | 中 |
| POST `/finance/receivable-sources/from-outbound/:outboundId` | 同上 `:69` | — | ✅ | ⚠️ **无幂等键** | ✅ `FOR UPDATE` 出库单（`:39`）；且 `schema.prisma:1399` `outboundId @unique` 防重复 | `receivable.service.ts:39`；`schema.prisma:1396,1399` | 低（唯一约束兜底） |
| POST `/finance/receivable-sources/:id/confirm` / `reopen` / `cancel` / `PATCH :id` | 同上 `:70,71,72,73` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE`（`:62,:73,:90,:103`） | `receivable.service.ts:62,73,90,103` | 低 |
| POST `/finance/receivable-adjustments` / `:id/post` / `:id/reverse` | 同上 `:85,86,87` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 调整 + 应收来源（`:78,:83,:96`） | `receivable-adjustment.service.ts:78,83,96` | 中 |
| POST `/finance/reconciliations` / `:id/resolve` | 同上 `:90,91` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE`（`:48`） | `reconciliation.service.ts:48` | 低 |
| POST `/finance/payable-entries/from-source` / `:id/confirm` / `:id/reopen` / `:id/reverse` / `PATCH :id` | `payable-notification.controller.ts:40`；`finance.controller.ts:97,98,99,100` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 来源 + 应付条目（`:34,:35,:61,:74,:88,:102`） | `supplier-payable.service.ts:34,35,61,74,88,102` | 低（`schema.prisma:954,955` 来源外键 UNIQUE 兜底） |
| POST `/hr/payroll-ledgers/generate` | `hr.controller.ts:43` | `generate` | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 员工（`:23`）；`@@unique([employeeId, periodStart, periodEnd])`（`schema.prisma:2074`） | `payroll-ledger.service.ts:23` | 低（唯一约束兜底） |
| POST `/hr/payroll-ledgers/:id/confirm`/`reopen`/`close`/`adjustments`/payable 等 | `hr.controller.ts:44-58` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE`（`payroll-ledger.service.ts:47,74,84,89,98,99,100`；`payroll-payable.service.ts:30,74,87,101`） | 上述行 | 低 |
| POST `/hr/salary-payments` / `:id/post` / `:id/reverse` | `hr.controller.ts:61,63,64` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE` 付款 + 台账（`salary-payment.service.ts:21,31,32`，台账 id 排序后加锁） | `salary-payment.service.ts:21,31,32` | 中 |
| POST/PATCH/DELETE `/hr/attendance-records`、`/hr/performance-records` | `hr.controller.ts:34-40` | — | ✅ | ⚠️ 无幂等键 | ✅ `FOR UPDATE`（`attendance-performance.service.ts:11,12,13,15,16,17`）；`@@unique([employeeId, attendanceDate])`（`schema.prisma:2051`） | 上述行 | 低 |
| POST `/alerts/:id/handle` | `alerts.controller.ts:12` | `handle` | ⚠️ 无 `$transaction`（单条 `upsert`） | ✅ **upsert**（幂等） | ✅ 依赖 `@@unique([sourceType, sourceId, alertType])`（`schema.prisma:2226`） | `alerts.service.ts:21` | 低 |
| POST `/production/daily-alerts/:id/confirm` / `merge-anomalies/:id/resolve` | `production-daily-alerts.controller.ts:20,23` | — | **未验证** | **未验证** | **未验证** | `production-daily-alerts.service.ts`（未逐行读） | **未验证** |
| POST `/inventory` 相关 | — | — | — | — | — | `platform/inventory/*` 全为只读（`inventory.controller.ts` 仅 3 个 GET） | — |

### 7.3 主数据 CRUD（低风险组，归纳）

以下端点均为「单行写 + 唯一约束兜底 + `FOR UPDATE` 保护引用」，**无幂等键**（重复提交表现为第二次 409 `*_CONFLICT` 或直接覆盖，属可接受语义）：

| 组 | 路由 | 证据 |
| --- | --- | --- |
| 单位/物料/供应商 | `POST/PATCH/DELETE /units`、`/materials`、`/suppliers`（+ `/:id/active`、`/units/:id/restore`） | `procurement-master-data.controller.ts:29-43`；服务 `procurement-master-data.service.ts:36,59-65,98,103`（`FOR UPDATE` 引用检查 `:65`） |
| 客户/联系人 | `POST/PATCH/DELETE /customers`（+ `/:id/active`、`/:id/contacts…`） | `customers.controller.ts:59-66`；`customers.service.ts:30-49`（自动编码 P2002 重试 `:44`）、`:76,87`（`isDefault` 互斥在事务内） |
| BOM | `POST /boms/from-sales-order/:salesOrderId`、`PATCH /boms/:id`、`PUT /boms/:id/items` | `boms.controller.ts:36-38`；`boms.service.ts:23-38,59-70` |
| 生产主数据 | `POST/PATCH/DELETE /production/{departments,positions,employees,locations,operations,operation-rates}`、`/:id/active`、`/:id/restore`、`/employees/import` | `production-master-data.controller.ts:55-88`；`production-master-data.service.ts:35-38,64,191-192,301,325,346,392-393,396` |
| 字典 | `POST /dictionaries/types`、`POST /dictionaries/hr/employee-types`、`POST /dictionaries/:typeKey/items`、`PATCH/DELETE /dictionaries/items/:id` | `dictionaries.controller.ts:19-25`；`dictionaries.service.ts:33,34` |
| 表单定义 | `POST /form-definitions`、`POST /form-definitions/:id/publish` | `forms.controller.ts:32,33`；`forms.service.ts:17,31,40`；`@@unique([formKey, version])`（`schema.prisma:395`） |
| 用户管理 | `POST /admin/users`、`PATCH /admin/users/:id/active`、`POST /admin/users/:id/reset-password`、`POST /admin/users/:id/roles` | `admin-users.controller.ts:24-34`；`auth.service.ts:50-97`（`setRoles` 事务 `:87`，`username @unique` `schema.prisma:12`） |
| 附件 | `POST /attachments`、`POST /attachments/:id/links`、`DELETE /attachments/:id` | `attachments.controller.ts:16-25`；⚠️ **`POST`/`DELETE` 因 BigInt 序列化必然失败**（§1 风险 2） |

### 7.4 未使用/死代码（影响测试覆盖判断）

- `StateMachineService`（`platform/state-machine/state-machine.service.ts`，含 `FOR UPDATE` `:22`）在 `app.module.ts:10,24` 注册，但**没有任何业务 service 注入或调用它**（已 grep：仅 `state-machine.module.ts` 自身与 `operation-daily-reports.service.ts:169` 的一句注释命中）。→ 无法通过接口触达，**未验证**其是否仍有用途。
- `ApiError`（`platform/http/api-error.ts`）无任何 import 点。
- `apiSuccess` / `paginated`（`platform/http/api-contract.ts:23,25`）无业务调用点。
- `PaginationQueryDto.sort`（`:20`）无消费点。
- `ModulePermissionGuard:20`（未认证 403）实际不可达。

---

## 8. 前后端契约不一致清单

> 前端入口：`apps/web/lib/api-client.ts`（42 行，全文已读）。它只有 `apiGet` / `apiRequest` / `apiPost` / `apiPatch`（`:41-42`），**没有 `apiDelete`**；所有 DELETE 调用走 `apiRequest(path, { method: "DELETE" })`。
> `apps/web/lib/adapters/module-adapter.ts` 只有 3 行，读 `demo-data` 的静态占位数据，**不调后端**；`workbench-adapter.ts` 同类。

### 8.1 `api-client.ts` 与服务端的形状约定

| 项 | 前端行为 | 后端实际 | 是否一致 |
| --- | --- | --- | --- |
| 前缀 | 硬编码 `/api/v1`（`api-client.ts:17,32`） | `main.ts:14` `api/v1` | ✅ |
| 凭据 | `credentials: "include"`（`:17,32`） | cookie `dilee_session`；CORS `enableCors()` **未开 credentials**（`main.ts:15`） | ⚠️ **同源部署才成立**；跨域部署会因缺少 `Access-Control-Allow-Credentials: true` 导致 cookie 不带。**未验证**是否跨域部署（`docker-compose.yml` 未见反代配置） |
| 成功判定 | `!response.ok \|\| "error" in body`（`:20,38`） | envelope `{data,meta}` / `{error,meta}` | ✅ |
| 204 处理 | `response.json()` 失败 → `catch(() => ({}))`（`:37`） | logout 204 空体 | ✅ |
| 超时 | GET 10s（`:17`）、非 GET 60s（`:29`） | 后端无超时 | ✅ |
| 导出/下载 | **不走 api-client**，各自 `fetch` + 二进制处理 | 12 个 `@Res()` bypass 端点 | ✅ |
| `x-request-id` | **从不发送** | 因此 `meta.request_id` 恒缺（§1 风险 1） | ⚠️ 追踪能力缺失 |

### 8.2 已核实的不一致

| # | 前端位置 | 后端位置 | 不一致描述 | 影响 |
| --- | --- | --- | --- | --- |
| M1 | `apps/web/app/warehouse/page.tsx:57`（`fetch("/api/v1/attachments", {method:"POST", body:FormData})` 后 `await response.json()` 读 `uploaded.data.id`） | `platform/attachments/attachments.controller.ts:17` → `attachments.service.ts:24`（返回含 `fileSize: BigInt` 的行） | **后端返回体含 BigInt，`JSON.stringify` 抛 `TypeError` → 500**；前端拿到 500 且 `uploaded.data` 为空 → 抛「附件上传失败」 | **功能性阻断**：原料流转附件上传/删除完全不可用。**未实测**（静态分析） |
| M2 | `apps/web/lib/api-client.ts` 无 `apiDelete`；`app/sales/page.tsx:59`、`app/procurement/page.tsx:82,88`、`app/warehouse/page.tsx:54`、`components/production/master-data-pool-page.tsx:56`、`components/production/outsource-logistics-panel.tsx:41`、`components/production/material-issues-panel.tsx:144` 等均用 `apiRequest(path, {method:"DELETE"})` | 对应 `@Delete()` 路由均无 `@Body()`（如 `customers.controller.ts:63`、`customers.controller.ts:66`、`production-orders.controller.ts:27`） | ✅ **实际一致**（DELETE 不带 body）；但 `api-client.ts` 无 DELETE 封装属**契约表达缺失**，新增带 body 的 DELETE 极易漏传 | 低（一致性风险） |
| M3 | `apps/web/components/production/daily-reports-panel.tsx:204`：`apiRequest(..., {method:"DELETE", body: JSON.stringify({reason, expected_version})})` | `operation-daily-reports.controller.ts:24` / `employee-daily-reports.controller.ts:28` 均 `@Delete(...) @Body()` | ✅ 一致；但**要求 DELETE 携带 body**，需在测试中固定该行为（部分网关/代理会剥离 DELETE body） | 中（部署环境相关） |
| M4 | `apps/web/app/warehouse/page.tsx:43`、`components/production/material-slip-editor.tsx:96`：`apiGet("/inventory/raw-material-balances")` **不带 `material_ids`** | `platform/inventory/inventory.controller.ts:14`：`(materialIds ?? "").split(",").filter(Boolean)` → `[]` → 服务返回**全量** | ✅ 一致（空数组=不过滤，`inventory.service.ts:22`） | 低 |
| M5 | 前端大量列表页用 `apiGet<X[]>("/xxx")` 直接消费 `data` 为数组 | 这些端点（§6.4）返回裸数组 | ✅ 一致 | — |
| M6 | 前端**没有任何** `payroll-sources` / `dictionaries` / `attachments` 列表 / `reports/:report/export` 的调用点（已 grep） | 这些路由存在 | **孤儿接口**：`GET /production/payroll-sources`、`GET /dictionaries/types`、`GET /dictionaries/hr/employee-types`、`GET /dictionaries/:typeKey/items`、`GET /production/operation-reports`（部分被 `daily-reports-panel` 用）等在前端无消费方 | 低（但测试计划应确认是否为对外承诺的接口） |
| M7 | `apps/web/app/login/page.tsx:10`：`await apiPost("/auth/login", …)` 后 `router.push("/")` | `auth.controller.ts:15` 返回 **201** | ✅ 前端不校验状态码（只看 `response.ok`），所以一致 | — |
| M8 | `apps/web/components/layout/app-shell.tsx:36`：`await apiPost("/auth/logout")` 再跳转 | `auth.controller.ts:21` 204 空体 | ✅ 一致 | — |
| M9 | `apps/web/app/finance/page.tsx:31`、`app/hr/page.tsx:167,177` 等使用 `apiPatch(path, body ?? {})` 发**空对象 body** | e.g. `hr.controller.ts:47` `POST /hr/payroll-ledgers/:id/confirm` **无 `@Body()`** → 多余 body 被 Express 忽略；但若走到有 `@Body()` DTO 的 PATCH 且传 `{}`，所有字段 `@IsOptional` → 通过 | ✅ 一致 | — |
| M10 | `apps/api/test/http/sales-orders-pagination-http.test.cjs:15` 请求 `?page_size=200` | `pagination-query.dto.ts:15` `@Max(200)` | ✅ 边界正好在 200；`page_size=201` → 400 | 测试应覆盖 200/201/0/`abc` |

**未能核实项（需实测）**

- M1 的精确状态码（500 还是连接悬挂）——静态分析指向 500 `REQUEST_ERROR`。
- 是否有前端调用命中**不存在的路由**（需逐调用点与 37 个控制器的路径逐一比对；本次未做到 100% 穷举）。**未验证**
- 跨域部署下 cookie 是否被浏览器发送（CORS 未开 credentials）。**未验证**
- `apps/web/lib/adapters/workbench-adapter.ts` 是否直连后端（本次只读了 `module-adapter.ts`）。**未验证**

---

## 9. 建议的契约测试用例清单

> 命名沿用仓库现有风格：`test("<module>.<case>_<expectation>")`，放 `apps/api/test/http/*.test.cjs`（现有 helper `tests/helpers/api-client.cjs` 返回 `{body, requestId, status}`，`requestId` 取自**响应头**）。
> K 前缀 = 契约域。所有用例都应断言**响应头 `x-request-id` 存在**（这是唯一可靠的关联 id）。

### K1 Envelope 契约

1. `contract.envelope.success_always_has_data_and_meta` — 遍历 `GET /health`、`GET /materials`、`GET /sales-orders`、`GET /admin/users` 之外的一批 GET：断言 `typeof body.data !== "undefined"`、`typeof body.meta === "object"`、`!Array.isArray(body.data)` 或数组皆可（按端点断言）。
2. `contract.envelope.meta_request_id_absent_unless_client_sends_header` — （a）不带 `x-request-id` → 断言 `body.meta.request_id === undefined` 且 `"request_id" in body.meta === false`（JSON 已丢弃）；（b）带 `x-request-id: fixed-123` → 断言 `body.meta.request_id === "fixed-123"`。**这条会固化 §1 风险 1，是重要的回归护栏。**
3. `contract.envelope.request_id_header_always_present` — 依次请求成功与失败端点，断言 `response.headers.get("x-request-id")` 非空且为 UUID。
4. `contract.envelope.raw_export_endpoints_bypass_envelope` — 对 12 个 `@Res()` 端点逐一：管理员登录后请求，断言 `content-type` 不是 `application/json`、body 前几字节为 `PK`（xlsx）或含 CSV BOM；并断言**不**是 `{data,meta}`。
5. `contract.envelope.export_endpoint_error_still_uses_envelope` — 用**非管理员**请求 `GET /production/reports/operation-payroll.xlsx`，断言 403 且 `content-type: application/json`、`body.error.code === "FORBIDDEN"`。
6. `contract.envelope.admin_users_routes_are_wrapped_by_fallback` — 断言 `POST /admin/users` 成功体为 `{data:{id,username,display_name,is_active,role_keys},meta:{}}`（验证拦截器 `:15` 兜底分支）。
7. `contract.envelope.logout_returns_204_with_empty_body` — 断言 `status === 204`、`content-length` 为空/0、`await res.text() === ""`。

### K2 错误 Envelope 与 code 规范

8. `contract.error.shape_is_error_code_message_details` — 取 400/401/403/404/409/422/500 各一例，断言均为 `{error:{code:string,message:string,details:Array},meta:{path:string}}`，且 `meta.path` 等于请求 URL。
9. `contract.error.unknown_route_returns_404_not_found_with_english_message` — `GET /api/v1/does-not-exist` → 404，`code === "NOT_FOUND"`，`message` 匹配 `/^Cannot GET/`。
10. `contract.error.wrong_method_returns_404_not_405` — `POST /api/v1/customers/{id}`（后端只有 PATCH）→ 断言 **404**，并断言**不是** 405。
11. `contract.error.unauthenticated_uses_generic_english_message` — 无 cookie `GET /api/v1/customers` → 401，`code === "UNAUTHENTICATED"`，`message === "Unauthorized"`（固化英文文案，供前端文案策略决策）。
12. `contract.error.expired_or_revoked_session_returns_401` — 登录拿 cookie → `POST /auth/logout` → 再用同一 cookie 请求受保护接口 → 401。
13. `contract.error.deactivated_user_session_returns_401` — 管理员停用某用户（`PATCH /admin/users/:id/active`）→ 该用户原 cookie 请求 → 401（验证 `auth.service.ts:72` 的 session 清理）。
14. `contract.error.string_payload_bad_request_maps_to_validation_error_code` — `POST /attachments`（multipart 不带 file）→ 400，`code === "VALIDATION_ERROR"`，`message === "未提供文件"`，`details === []`（固化"字符串异常强制通用码"这一行为）。
15. `contract.error.nested_dto_validation_loses_details` — `POST /purchase-orders` 传 `items:[{material_id:"not-a-uuid", quantity:"1", unit_id:"<uuid>", supplier_id:"<uuid>"}]` → 400 且 `details` **为空数组**（记录 §3.4 的已知缺口；若产品要求可定位字段，此为缺陷）。
16. `contract.error.unique_conflict_has_business_label` — 连续两次 `POST /sales-orders` 同 `order_no` → 第二次 409，`code === "ORDER_NO_CONFLICT"`（服务层捕获）或 `UNIQUE_VALUE_CONFLICT`（全局兜底，视路径而定）；两者都断言 `details` 形状。
17. `contract.error.global_p2002_fallback_uses_unique_value_conflict` — 构造一个**未在服务层 catch** 的 P2002（例如并发 `POST /production/orders` 同 `production_order_no` 两次）→ 断言 `code === "UNIQUE_VALUE_CONFLICT"`、`details[0]` 含 `{object, field, field_label, target}`。
18. `contract.error.p2025_not_mapped_yields_500` — 找一个会触发 `P2025` 的路径（候选：无前置存在性检查的 `PATCH`/`DELETE`）→ 断言实际状态码。**此用例的目的是把"未映射=500"从猜测变成事实**；若 500，则记为契约缺陷（应为 404）。
19. `contract.error.status_code_conventions` — 断言 `code` 与 status 的对应表：400→`VALIDATION_ERROR`（或业务码）、401→`UNAUTHENTICATED`、403→`FORBIDDEN`、404→`NOT_FOUND`、409→`CONFLICT`/业务码、422→`BUSINESS_RULE_VIOLATION`/业务码、413/500/503→`REQUEST_ERROR`。

### K3 校验与未知字段

20. `validation.unknown_body_field_returns_400_whitelist` — `POST /customers` 带 `{name:"x", bogus_field:1}` → 400，`details[0]` 含 `field === "bogus_field"` 且 `rule === "whitelistValidation"`。
21. `validation.unknown_query_param_returns_400_for_dto_endpoints` — `GET /customers?bogus=1` → 400（DTO 端点）；对照 `GET /raw-material-inbounds?bogus=1` → 200（字面量/无 DTO 端点），**把 §3.4 的分裂固化成回归测试**。
22. `validation.unknown_query_param_silently_ignored_for_non_dto_endpoints` — `GET /production/employee-reports?bogus=1` → 200，不报错。
23. `validation.pagination_bounds` — `GET /customers?page_size=200` → 200 且 `meta.page_size === 200`；`page_size=201` → 400；`page_size=0` → 400；`page=0` → 400；`page_size=abc` → 400；不带参数 → `meta.page===1 && meta.page_size===20`。
24. `validation.empty_string_becomes_undefined_for_optional_fields` — 按 `EmptyStringToUndefined` 的语义（`platform/http/empty-string-to-undefined.decorator.ts:14-16`）提交 `{unit_price:""}` 给 `POST /sales-orders` → 应**通过**校验（不得 400）；提交 `{product_name:"   "}` → 应 400（`@IsNotEmpty()` 在归一后生效）。
25. `validation.non_negative_decimal_regex` — `POST /sales-orders` 传 `quantity:"-1"` / `total_amount:"abc"` → 400，`details[*].message` 含「必须是不小于 0 的十进制数」。
26. `validation.set_method_enum` — `settlement_method` 传非法值 → 400；传 `"tt"` → 通过（`sales-orders.controller.ts:17,42`）。

### K4 鉴权 / 授权

27. `authz.anonymous_matrix` — 对 §5.4 中**每个**带 guard 的控制器各取 1 个代表端点（无 cookie）→ 断言 401；对 `health`/`auth/login`/`auth/me` 之外的全部 → 401。现有 `platform-http.test.cjs:16-40` 已覆盖 3 组，需补齐到全覆盖。
28. `authz.public_endpoints` — `GET /api/v1/health`（无 cookie）→ 200；`POST /api/v1/auth/login` 无 cookie → 201 或 401（凭据）。
29. `authz.module_permission_and_semantics_for_payroll_sources` — 用**只有 hr 模块**权限的用户（无 production）请求 `GET /production/payroll-sources` → 断言实际结果；预期按代码为 **403**（因为类级 `production` + 方法级 ANY 是 AND）。这条把 A3 从分析变成事实。
30. `authz.method_level_overrides_class_level_same_metadata` — 用只有 `warehouse` 权限的用户请求 `PATCH /raw-material-inbound-notices/:id/acknowledge`（类级无要求、方法级 warehouse）→ 200/业务错；用只有 `procurement` 的用户 → 403。
31. `authz.administrator_short_circuit` — administrator 用户请求任意 `@RequireModules("finance")` 端点 → 不得 403。
32. `authz.require_administrator_blocks_module_user` — 有 `production` 但非 admin 的用户请求 `POST /production/employees` → 403 且 `message === "需要管理员权限"`；`GET /production/employees` → 200。
33. `authz.attachments_has_no_module_check_idor` — 用户 A 上传附件得到 id；**用户 B（任意模块权限）**请求 `GET /attachments/{A的id}/download` → 断言实际结果（预期 200 ⇒ 记录为 A1 越权缺陷）。
34. `authz.dictionaries_get_requires_only_login` — 无模块权限但已登录的用户 `GET /dictionaries/types` → 断言实际结果（预期 200 ⇒ 记录为 A2）。
35. `authz.moduleless_controller_routes` — `GET /production-progress/measurements` 对 `finance`/`hr`/`production` 各自 → 200；对只有 `warehouse` 的用户 → 403（`production-progress.controller.ts:24`）。

### K5 分页 / 排序 / 过滤一致性

36. `pagination.meta_shape_uniform_for_paginated_endpoints` — 对 §6.2 的 11 个端点断言 `meta` 同时含 `page`/`page_size`/`total` 且均为 `number`。
37. `pagination.alerts_meta_types_are_numbers` — `GET /alerts?page=2&page_size=5` → 断言 `typeof meta.page === "number"`。**预期失败**（当前会是字符串），作为 I6 的回归护栏。
38. `pagination.total_semantics_is_real_count` — 造 >1 页的报表数据，对 `GET /reports/procurement-payables?page_size=1` 断言 `meta.total` 为真实总数而非 1。**预期失败**（`reports.service.ts:12`），作为 I2/I4 的护栏。
39. `pagination.has_blockers_changes_total_semantics` — `GET /order-workbench/orders?has_blockers=true&page_size=1` → 断言 `meta.total` 语义（当前为当前页条数），护栏 I3。
40. `pagination.measurements_meta_missing_page_fields` — `GET /production/orders/:id/measurements` → 断言 `meta` 只有 `total`、无 `page`/`page_size`（固化 I5）。
41. `pagination.sort_param_is_accepted_but_ignored` — `GET /customers?sort=name&page_size=1` 与 `?sort=-name&page_size=1` 返回**相同顺序**（固化 I1 死字段），并在计划中标注为待实现。
42. `pagination.list_endpoints_without_pagination_return_full_array` — 对 §6.4 中若干裸数组端点造 >200 条数据，断言返回条数 > 200 且 `meta` 为 `{}`（固化 I9，暴露潜在性能问题）。
43. `pagination.search_only_implemented_on_two_endpoints` — `GET /customers?search=X` 生效；`GET /purchase-orders?search=X` → 400（DTO 无 `search`）或忽略（无 DTO）——断言实际行为。
44. `pagination.report_filters_partially_ignored` — 对 `GET /reports/inventory?status=draft` 与不带 `status` 对比，断言返回一致（固化 I8 的静默忽略）。

### K6 状态码矩阵

45. `status.post_returns_201_everywhere` — 抽样若干 POST（`/auth/login`、`/customers`、`/sales-orders`、`/alerts/:id/handle`）断言 201。
46. `status.patch_put_delete_return_200` — 抽样断言 200。
47. `status.logout_204` — 见用例 7。
48. `status.upload_too_large_returns_413` — 向 `POST /attachments` 上传 >20MB 文件 → 断言 **413** 且 `code === "REQUEST_ERROR"`；`POST /production/employees/import` >10MB → 413。
49. `status.employee_import_wrong_mime_returns_422` — 上传 `.txt` → `fileFilter` 拒绝（`production-master-data.controller.ts:43-47`）→ 断言 422 且 `code === "EMPLOYEE_IMPORT_FILE_REQUIRED"`。
50. `status.health_db_down_returns_503` — 需要可控依赖（mock Prisma 或断开 DB）→ 断言 503 `DEPENDENCY_UNAVAILABLE`。**建议放在单测层**（避免污染链路环境）。
51. `status.export_limit_exceeded_422` — 让 `GET /reports/orders/export` 命中 ≥5000 行 → 422 `EXPORT_LIMIT_EXCEEDED`（`reports.service.ts:16`）。
52. `status.etag_disabled` — 任意 GET 两次，断言响应**无** `etag` 头、第二次不出现 304。

### K7 幂等 / 并发 / 事务（必须以真实 DB 跑）

53. `idempotency.material_movement_post_same_key_is_single_post` — 同一 `idempotency_key` 连续两次 `POST /production/material-movements/:id/post` → 第一次 201，第二次 **201 且返回同一单据**（`raw-material-movements.service.ts:170`），并断言 `inventory_fact` 只有一组（数量不翻倍）。
54. `idempotency.material_movement_missing_key_returns_422` — 不传 `idempotency_key` → 422 `IDEMPOTENCY_KEY_REQUIRED`（`:167`）。
55. `idempotency.outbound_notice_duplicate_returns_409` — 同一生产单重复 `POST /sales-orders/:id/outbound-notices` → 409 `OUTBOUND_NOTICE_CONFLICT`（`finished-goods-outbound-notice.service.ts:128`）。
56. `idempotency.customer_auto_code_concurrent_creates_no_duplicate` — 并发 `POST /customers {code_mode:"auto"}` × N → 断言全部成功且 `customer_code` 互不相同（验证 `customers.service.ts:44` 的 P2002 重试）。
57. `idempotency.purchase_receipt_same_key_single_receipt` — 同一 `idempotency_key` 两次 `POST /purchase-orders/:id/items/:itemId/receipts` → 断言只创建一条到货（`purchase-orders.service.ts:40` 走 `extensionData` 去重）。
58. `concurrency.material_movement_parallel_post_no_double_deduct` — 两个并发请求同时 `POST .../post`（不同 key）→ 断言恰好一个成功、另一个 409 `MATERIAL_MOVEMENT_ALREADY_POSTED` 或 409 `VERSION_CONFLICT`（P2034），且库存只扣一次。
59. `concurrency.customer_payment_double_post_no_double_allocation` — 并发两次 `POST /finance/customer-payments/:id/post` → 断言只有一个成功（`customer-payment.service.ts:26,34,52`）。
60. `concurrency.salary_payment_double_post_no_double_allocation` — 同上（`salary-payment.service.ts:21,31,32`）。
61. `concurrency.attendance_duplicate_same_day_returns_422` — 同一员工同一天两次 `POST /hr/attendance-records` → 422 `ATTENDANCE_ALREADY_EXISTS`（`attendance-performance.service.ts:11`）或 409（唯一约束兜底）。
62. `concurrency.payroll_generate_same_period_conflict` — 同员工同周期两次 `POST /hr/payroll-ledgers/generate` → 冲突（`schema.prisma:2074`）。
63. `concurrency.daily_report_expected_version_mismatch_422` — `PATCH /production/employee-reports/:id` 传过时 `expected_version` → 422 `DAILY_REPORT_VERSION_CONFLICT`（`employee-daily-reports.service.ts:96,126`）。
64. `idempotency.no_key_write_endpoints_are_not_idempotent` — 对 §7.3/§7.4 中标「无幂等键」的端点（如 `POST /production/material-movements`、`POST /finance/customer-payments`）双击 → 断言产生**两条**记录，并在报告中标注为可接受的业务风险（避免测试计划把它当成缺陷）。

### K8 前后端契约回归

65. `web.attachments_upload_roundtrip` — Playwright 或 node 脚本按 `apps/web/app/warehouse/page.tsx:57` 的方式上传附件 → 断言成功。**预期失败**（M1），作为最高优先级缺陷的验收用例。
66. `web.api_client_handles_204_logout` — 单测 `apiPost("/auth/logout")` 对 204 空体不抛错（现有 `apps/web/lib/api-client.test.mjs` 可扩展）。
67. `web.route_callsite_exists` — 静态断言：遍历 `apps/web` 中的 `/api/v1` 调用路径集合，与后端路由集合求差，报出「前端调用但后端不存在」的路径（可用 `apps/web/lib/page-data-alignment.test.mjs` 的既有模式扩展）。

---

## 10. 未验证清单（供测试计划优先实测）

| # | 未验证项 | 建议实测方式 |
| --- | --- | --- |
| U1 | `POST /attachments` / `DELETE /attachments/:id` 的实际状态码与 body（BigInt 序列化） | 直接发请求观察 |
| U2 | `P2025`/`P2003` 是否真的落到 500（需先找到一个能触发的实际路径） | 逐个 `PATCH`/`DELETE` 传随机 UUID |
| U3 | `POST /production-progress/rebuild` 的事务性、并发安全与幂等语义 | 读 `production-progress.service.ts` 并实测 |
| U4 | `production-daily-alerts.service.ts` 的 confirm/resolve 是否事务/幂等 | 读源码 + 并发实测 |
| U5 | `purchase-orders.service.ts:40` 到货幂等去重的并发正确性 | 并发同键实测 |
| U6 | 登录限流在多实例/重启下的实际行为（进程内 `Map`） | 部署环境实测 |
| U7 | 跨域部署下 cookie 是否随请求发送（CORS 未开 credentials） | 独立域部署实测 |
| U8 | 前端是否存在调用**不存在的后端路由**的调用点（本次未 100% 穷举） | 按用例 67 做静态差集 |
| U9 | `apps/web/lib/adapters/workbench-adapter.ts` 是否直连后端 | 读文件确认 |
| U10 | 12 个 `@Res()` 导出端点的 filename 编码（`filename*` 与 `filename` 两种写法混用：`production-payroll-export.controller.ts:21-24` 用 `filename*`，`production-master-data.controller.ts:66` 用 `filename=`，`reports.controller.ts:11` 用 `filename="${report}.csv"`——中文名会乱码） | 实测响应头 |
