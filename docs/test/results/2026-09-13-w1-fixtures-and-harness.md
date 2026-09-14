# W1 地基 B 执行结果（夹具 / 测试用户 / 契约 harness / 不变量）

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 对应阶段：`docs/test/01-test-master-plan.md` §5.1 **W1**
- 环境：Windows 11 / PowerShell 5.1 / Docker 29.7.2 / Node v24.15.0
- 测试库：`dilee_test`（模板）+ `dilee_test_01..04`（worker）

---

## 1. 结论

**W1 达成**。四块地基建全部落地并自测通过：

| 项 | 交付物 | 结果 |
| --- | --- | --- |
| **S3** 夹具工厂 | `tests/fixtures/factories.cjs` | ✅ 跨模块链路工厂 + **零残留**清理（实测证明） |
| **S4** 测试用户与 RBAC | `tests/fixtures/seed-users.cjs` | ✅ 8 种角色（含无模块权限用户）+ 会话签发 |
| **S9** 契约 harness | `tests/helpers/api-client.cjs` | ✅ Cookie 会话登录 + 信封/状态码断言 |
| **S10** 跨模块不变量 | `tests/helpers/business-invariants.cjs` | ✅ 6 → **25 个断言**，含精确十进制运算 |

**自测**：单元层 +16 例、集成层 +3 例，全部通过。整体单测从 415 → **431**。

**重要**：编写自测的过程中，在**生产代码里发现 3 处审计缺口**（见 §4）。这正是"先建地基、再写用例"的价值 —— 地基的第一批消费者立刻照出了真实问题。

---

## 2. 实跑证据

| 命令 | 结果 | 退出码 |
| --- | --- | ---: |
| `npm run test:unit` | **551 通过 / 0 失败**（后端 431 + 前端 lib 108 + 前端组件 12） | **0** |
| `node --test apps/api/test/unit/w1-harness-self-test.test.cjs` | 16 / 16 通过 | 0 |
| `node --test apps/api/test/integration/**` | **5 通过 / 4 失败**（失败为既有 4 条陈旧用例，见 Runbook §7） | 1 |
| W1 集成自测 | **3 / 3 通过** | 0 |

对比 W0：集成层从 **2 通过** 提升到 **5 通过**（+3 条 W1 自测），且**未引入任何回归**。

### 零残留实测

连续两次运行 W1 集成自测，前后对 21 张表计数快照**逐字节一致**：

```
BEFORE / after run 1 / after run 2 完全相同：
{"audit_events":18,"inventory_facts":1,"payable_sources":1,"raw_material_inbounds":2,
 "raw_material_inbound_notices":1,"incoming_inspections":2,"purchase_receipts":2,
 "purchase_order_items":4,"purchase_orders":4,"bom_items":4,"boms":6,"sales_order_versions":6,
 "sales_orders":8,"customers":8,"suppliers":4,"materials":6,"units":13,"users":1,"roles":1,
 "role_permissions":0,"sessions":1}
```

`audit_events` 不增长尤其关键 —— 见 §4.1，这是最容易漏的一项。

---

## 3. 交付细节

### 3.1 S3 夹具工厂（`tests/fixtures/factories.cjs`）

把"每条用例手写 15-25 行播种 + 20-30 行逆序 DELETE"（改造前 `raw-material-issues.test.cjs:19-30` 与 `:70-86`）压缩成三行：

```js
const fx = createFactories({ prisma, prefix: "procurement" });
try {
  const chain = await fx.procurementChain();   // 客户→销售单→BOM→采购单→到货→QC
  ...
} finally {
  await fx.cleanup();
}
```

提供的方法：`createMaterialAndUnit`、`createCustomer`、`createSupplier`、`createProductionLocation`、`createOutsourceSite`、`createOperationCatalog`、`createDepartment`、`createPosition`、`createEmployee`、`createOperationRate`、`salesChain`、`createPublishedBom`、`createBomItem`、`createPurchaseOrder`、`createPurchaseOrderItem`、`createReceipt`、`createIncomingInspection`、`procurementChain`、`productionChain`、`seedInventoryFact`。

**清理设计（本次迭代了三轮才正确）**：

| 版本 | 做法 | 结果 |
| --- | --- | --- |
| v1 | 只删登记过 id 的行，手写固定删除顺序 | ❌ service 自建的行（`payable_source`）未登记 → 外键阻塞父表 → 级联失败 |
| v2 | 加 orderNo 清扫（DMMF 派生） | ❌ `salesOrderVersion` 无 `order_no` 且不在主数据清单 → 阻塞 `salesOrder` |
| **v3（最终）** | 每轮「删登记项 → orderNo 清扫 → 关系子表清扫」，整轮重试直到零失败 | ✅ 零残留 |

关键取舍：**不维护人工拓扑顺序**，改为让重试自然收敛（实测该链需 3~4 轮，上限取 8）。
`ORDER_NO_DELEGATES` 由 `Prisma.dmmf.datamodel.models` **运行时派生**（79 个模型中 38 个带 `orderNo`），schema 新增表时自动跟上，不会因为忘记维护常量而漏清。

### 3.2 S4 测试用户与 RBAC（`tests/fixtures/seed-users.cjs`）

- 8 种角色：`administrator`（共享，靠 `role.key` 短路）、`sales` / `procurement` / `warehouse` / `finance` / `production` / `hr` 操作员，外加 **`noModule`（零模块权限）** —— 用于断言 403「无模块访问权限」，此前该场景在整个仓库中无法构造。
- 操作员角色 key 带 run 后缀（`sales_operator-<id>`）以隔离；`administrator` 只 upsert 不删除。
- `createSession(userName)` 直接落 `sessions` 行（`tokenHash = sha256(token)`，与 `auth.service.ts:122` 一致），适用于直接调 service 的集成测试；走真实登录链路的用 S9 的 `loginAs`。

### 3.3 S9 契约 harness（`tests/helpers/api-client.cjs`）

修正了一个**会导致鉴权用例静默失效**的旧缺陷：原实现在请求头放 `Authorization: Bearer`，而后端只认 `request.cookies.dilee_session`（`authentication.guard.ts:12`），所以"带 token 的调用"实际上一直是匿名请求。

新增：`login` / `loginAs`（真实登录，断言 201 与提取 Cookie）、`apiClient(baseUrl, {cookie})`，以及 `expectSuccessEnvelope` / `expectErrorEnvelope` / `expectUnauthenticated` / `expectForbidden` / `expectNotFound` / `expectBusinessRuleViolation` / `expectConflict` / `expectValidationError` / `expectNoContent` / `expectRequestIdHeader`。

设计要点：**400/409/422 不固定 `code`**。契约明确允许模块使用更精确的大写下划线码（`global-api-contract.md:69`，如 `ORDER_NO_CONFLICT`、`INSUFFICIENT_INVENTORY`），固定默认码会把合法业务码判成失败。改为固定「状态码 + 信封形状 + `code` 必须是大写下划线形式」，需要精确匹配时显式传 `{ code }`。

### 3.4 S10 跨模块不变量（`tests/helpers/business-invariants.cjs`）

按自述方案 `:156-187` 的四类补齐，并**用 BigInt 缩放实现精确十进制**（绝不使用 JS 浮点数，遵 `global-api-contract.md:18`）：

| 类别 | 新增断言 |
| --- | --- |
| 6.1 身份与来源 | `assertSourceVersionConsistency`、`assertSoftDeletedSourceNotReferenceable` |
| 6.2 审计与可追溯 | `assertServerOwnsAuditFields`（客户端 `created_by` 不得覆盖服务端身份）、`assertAuditEventRecorded`（**真的查 audit_events 表**）、`assertReversalHasReason` |
| 6.3 数量与金额 | `assertDecimalEquals`、`assertAmountBalance`、`assertAllocationWithinBalance`、`assertNoNegativeInventory`、`assertDecimalTransport`、`sumDecimals`/`scaledCompare` |
| 6.4 状态与回退 | `assertStateTransition`、`assertStatusUnchanged`、`assertReversalPreservesOriginal`、`assertIdempotent`、`assertIdempotentReplay` |
| 组合 | `assertChainConsistency`（单号贯穿 + 审计 + 身份，P3 链路收口用） |

原有 6 个断言保持导出，向后兼容（`business-invariants.test.cjs` 与 `outsource-logistics-invariants.test.cjs` 未改动仍通过）。

---

## 4. 生产代码发现（本次勘察新发现，建议单独立项）

> 三条均与**审计可追溯性**有关。依据 `docs/design/testing-system-and-tooling-plan.md:167-172`
> 「创建、编辑、状态动作、冲销和逻辑删除均有审计事件」「冲销/调整包含原因、操作人、时间和原事实引用」。

### 4.1 `AuditService.record()` 从不写 `orderNo` 列 —— 审计事件无法按订单追溯

| 项 | 事实 |
| --- | --- |
| 证据 | `platform/audit/audit.service.ts:15` 只写 `{ action, entityType, actorId, entityId, details }`；`details.order_no` 是调用方自己塞的 |
| 对比 | 同一文件 `:18` 的 `recordWithOrderNo()` 才写 `orderNo` 列 |
| 影响 | 按 `WHERE order_no = ?` 查审计**查不到绝大多数事件**；`schema.prisma` 的 `audit_events.order_no` 对 `record()` 写入的行恒为 NULL |
| 佐证 | 项目自己的测试早已用 raw SQL 绕过：`integration/raw-material-issues.test.cjs:76` 写的是 `WHERE entity_id IN (...) OR details->>'order_no' = '...'` —— 说明这个口径差异是已知但未收敛的 |

**后果**：测试清理若只按 `orderNo` 列删审计事件，`audit_events` 会在每次测试后持续堆积（本项目此前正是如此）。夹具的 `auditScope()` 已同时覆盖三种关联方式（`orderNo` 列 / `details.order_no` / `entityId`），实测零增长。

**建议**：要么统一由 `record()` 从 `details.order_no` 提升到列，要么明确废弃该列并统一按 `details` 查询。

### 4.2 接收通知时补建的草稿入库单没有 `create` 审计事件

| 项 | 事实 |
| --- | --- |
| 证据 | `raw-material-inbound-notices.service.ts:92` 调用 `inbounds.createDraftForInspection(tx, ...)`；而 `raw_material_inbound.create` 审计只在 `raw-material-inbounds.service.ts:125` 的公开 `create()` 里写 |
| 影响 | 走"采购创建通知 → 仓库接收"这条正常业务路径产生的草稿入库单**没有任何创建审计** |
| 固化 | `apps/api/test/integration/w1-fixtures-self-test.test.cjs` 显式断言"当前不存在该事件"，并注明若断言失败即为缺口修复信号 |

### 4.3 通知接收的审计事件完全没有订单引用

| 项 | 事实 |
| --- | --- |
| 证据 | `raw-material-inbound-notices.service.ts:103`：`audit.record("...acknowledge", "...", user.id, id, { status: result.status })` —— 传的是 `{ status }`，**既无 `orderNo` 列也无 `details.order_no`** |
| 影响 | 该事件无法通过任何订单维度检索，只能靠 `entityId` 关联；违反"链路可追溯"要求 |
| 建议 | 补 `{ order_no: current.orderNo, status }` |

---

## 5. 自测发现的自身缺陷（"给断言库写测试"的价值验证）

断言库若"永远通过"，整套链路测试就退化为假安全 —— 正是 recon 对前端正则断言文件的批评。因此 W1 给每个断言同时写了**接受合法输入**与**拒绝非法输入**两组用例，结果立刻照出两处自身缺陷：

| # | 缺陷 | 触发 | 修复 |
| --- | --- | --- | --- |
| 1 | 十进制缩放使用**负指数幂**（`10n ** BigInt(scale - expected.scale)`），当总额小数位多于分项和时抛 `RangeError: undefined must be positive` | `assertAmountBalance("0.3", ["0.1","0.1","0.1"])` | 改为 `scaledCompare`/`scaledEquals`：先取公共标度再放大两侧，永不产生负指数 |
| 2 | `expectBusinessRuleViolation`/`expectConflict` 固定了默认 `code`，会把合法的业务精确码（`INSUFFICIENT_INVENTORY` 等）判为失败 —— 与 `global-api-contract.md:69` 冲突 | 断言 422 + `INSUFFICIENT_INVENTORY` | 改为只固定状态码与形状；`code` 必须匹配大写下划线；需要精确匹配时显式传 `{ code }` |

另有一处是**自测用例自身的错误前提**：最初断言"不同物料维度的负库存可被其它物料盈余掩盖"，实际实现按维度独立核算才是正确的（负库存不得被掩盖）。已修正用例而非实现。

---

## 6. 下一步

W1 完成后，`docs/test/01-test-master-plan.md` §5.1 的 **W2~W8** 可按计划扇出：

- **W2**：`data-testid` 插桩（S6）+ 契约护栏（S12）+ 路由差集（S11）
- **W3–W5**：P1 后端单元 / P2 HTTP 契约 / P4 前端 的大规模并行扇出（需 8 Agent）
- **W6–W7**：P3 集成与并发（27 文件）+ P5 E2E（6 spec），各自使用独立 worker 库

**仍待闭环**：4 条陈旧集成用例（Runbook §7）。它们是 CI `chain` 门禁当前唯一的红项，建议作为 P3 首个工作包 —— W1 的夹具与不变量断言已经把修复它们所需的工具备齐。
