# W4 第一波执行结果（HTTP 契约测试批量补齐）

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 范围：`docs/test/01-test-master-plan.md` §5.1 **W4（P2 HTTP 契约）**，第一波 9 个目标
- 方式：9 个 agent 并行，各自针对**运行中的真实 API** 编写并跑通

---

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 新增契约测试文件 | **9 个** |
| 新增用例 | **336**（HTTP 层 19 → **355**，其中 1 例因缺少非管理员凭据而 skip） |
| 覆盖控制器 | **37/37**（鉴权矩阵强制自检，不漏） |
| 生产代码改动 | **0**（`apps/api/src` 干净，已核验） |
| 实测 | `node --test --test-concurrency=1 apps/api/test/http/**` → **355 tests / 354 pass / 0 fail / 1 skip**，连跑稳定 |

**四级门禁仍全绿**：单元 **992**（后端 844 + 前端 lib 108 + 前端组件 40）、集成 **9**、契约 **355**、E2E **5**。

**顺带解决了一个困扰多轮的随机失败**（见 §3），根因是 API 的单会话语义 + 测试并行，而非任何代码缺陷。

---

## 2. 逐文件清单

| 测试文件 | 用例 | 覆盖要点 |
| --- | ---: | --- |
| `authorization-matrix-contract` | **230** | **横切鉴权矩阵**：37/37 控制器的匿名 401、无模块 403、管理员短路、角色矩阵正负两侧、类级与方法级 AND 语义、仅需登录端点；用 `seedTestUsers` 真造 8 种角色用户并清理（残留 0） |
| `production-orders-contract` | 17 | 13 路由；状态码 200/400/401/404/422/500；无 405；批量工序嵌套校验；422 精确业务码 |
| `customers-contract` | 15 | 9 路由；分页信封；客户与联系人子资源；`code_mode` 校验；无 405 |
| `purchase-orders-contract` | 14 | 13 路由；含 `revert-draft`/`revert-arrivals` 的 400/422 分支与 `receipts` 子资源 |
| `finance-contract` | 13 | **42 路由逐个匿名探测**；18 个 GET 信封；8 个详情 404；17 个 POST + 4 个 PATCH 的 400 |
| `production-master-data-contract` | 13 | 35 路由；`@Res()` xlsx 旁路（MIME / Content-Disposition / 不是 JSON 信封）、导入 multer 的 422/413、未知 query 分裂 |
| `finished-goods-outbound-contract` | 13 | 15 路由全覆盖；出库/发货/签收/冲销/客户退货；探测前后行数 0，零业务写入 |
| `sales-orders-contract` | 11 | 11 路由；**不重复**已有分页测试；路由顺序护栏（`/impact-preview` 未被 `GET /:id` 吞掉） |
| `hr-contract` | 10 | 32 路由逐个匿名 401；工资台账/应付/支付；404 用模块级精确码 |
| **合计** | **336** | |

---

## 3. 根因定位：困扰多轮的「随机 401」不是代码缺陷

**症状**：HTTP 套件偶发 1 例失败（约 1/4 概率），单文件跑却从不失败。之前我把它当作"数据库竞争导致 /health 503"，那是**误判**。

**真因**（这次抓到了具体断言输出）：

```
AssertionError: customers 期望状态码 200，实际 401：{"error":{"code":"UNAUTHENTICATED", ...}}
```

`AuthService.login()` 会**先删该用户的全部 session 再建新的**（`auth.service.ts:29`，刻意的单会话设计）。
而 `node --test` 默认**并行执行多个文件** —— 多个契约文件同时以 admin 登录时，
后登录的会把先前登录的 Cookie **作废**，于是先拿到 401 的那个用例失败。

**修复**：`test:api:raw` 加 `--test-concurrency=1`（该层总耗时 ~18s，串行代价可接受）。
**修复后连跑 8 次全绿。** 需要真并行时应改为「每个文件用不同用户」。

已写入 Runbook §7.5，并在 `tests/helpers/api-client.cjs` 的 `login()` 上加了醒目注释 ——
因为 W4 后续波次每个 agent 都会登录，不写清楚必然重复踩坑。

**另一处误读防护**：鉴权矩阵文件需要 `TEST_DATABASE_URL`（它要造角色用户）。
只设 `API_BASE_URL` 时它原本会**在 0.0x 毫秒内失败 14 条**，看起来像"14 条契约断言不通过"。
已改为**模块加载期抛一条明确的 `TEST_BLOCKED`**（1 test / 1 fail），并在 Runbook 写明。

---

## 4. 新发现的契约缺陷（均未改代码）

### D11：非 UUID 的路径参数返回 500，而不是 400/404（系统性问题）

**9 个 agent 中有 5 个独立报告了同一条**，可判定为路径参数层的系统性问题：

| 项 | 内容 |
| --- | --- |
| 复现 | `GET /api/v1/production/orders/not-a-uuid` → **500 `REQUEST_ERROR`「服务器内部错误」**；`GET /api/v1/customers/not-a-uuid`、`PATCH /api/v1/purchase-orders/not-a-uuid` 等同型 |
| 期望 | 400 `VALIDATION_ERROR`（可定位字段）或 404 —— 由 `docs/design/global-api-contract.md:61,64` 规定 |
| 责任 | 全仓库**无一处使用 `ParseUUIDPipe`**；`@Param("id") id: string` 直接下传 → Prisma 抛 P2023 → 落到兜底 500（`api-exception.filter.ts:15,21,43`） |
| 影响 | 任何客户端把 id 拼错都会得到一个 500，污染服务端错误率与告警；也让「500 代表真故障」这一信号失真 |

### D12：资源不存在时 404 使用模块级业务码，而非全局 `NOT_FOUND`

`docs/design/global-api-contract.md:69` 只允许 **409/422** 使用更精确的码，404 默认码应为 `NOT_FOUND`。
实测 finance 的 8 个详情路由返回 `RECEIVABLE_SOURCE_NOT_FOUND` / `CUSTOMER_PAYMENT_NOT_FOUND` /
`SUPPLIER_PAYABLE_NOT_FOUND` 等（hr、production、sales 亦同型，属全局约定），
而路由/方法不匹配仍是 `NOT_FOUND` —— **同一状态码两套码值**，使 `expectNotFound` 在这些路由上不成立。

### 覆盖缺口（非缺陷，如实记录）

| 项 | 原因 |
| --- | --- |
| 写端点的 200/201 happy path、409/422 业务码、状态机流转 | 只读纪律（多 agent 共用一个库），且属集成/E2E 层职责 |
| **12 个 `@Res()` 导出端点**只探了 4 个 | 时间；建议 W4 第二波专门补一个导出契约文件 |
| **对象级越权（IDOR）未验证**（recon A1） | 需真实上传附件才能构造「用户 B 下载用户 A 的附件」 |
| finance 的 403 | 该文件作者未造用户；**已由 `authorization-matrix-contract` 覆盖**（230 例含 403 矩阵） |

---

## 5. 下一步

- **W4 第二波**：`outsource-logistics`(25 路由)、`raw-material-movements`(18)、`raw-material-inbounds`(8)、`raw-material-inbound-notices`(4)、`incoming-inspections`(5)、`finished-goods-qc`(12)、`boms`(5)、`reports`(6)、`inventory`(3)、`dictionaries`(8)、`forms`(4)、`alerts`(2)、`attachments`(4)、`admin/users`(4)、`auth`(3)、`order-workbench`(3)、`production-progress`(4)、导出端点专项、IDOR 专项
- **W5**：P4 前端 58 文件（含把 12 个**源码正则断言**文件改造为行为测试）
- **W3 第二波**：剩余后端单元（`raw-material-movements` 462 行、`material-slip-export` 494 行等）

**建议优先修 D11**：它是本轮唯一影响**全站所有 `:id` 路由**的缺陷，且修法明确
（要么全局挂 `ParseUUIDPipe`，要么在过滤器里把 Prisma P2023 映射为 400）——不修的话，
任何一个拼错的 id 都会变成一条 500 告警，掩盖真实故障。
