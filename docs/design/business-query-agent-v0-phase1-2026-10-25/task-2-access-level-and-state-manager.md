# T-2 两档档位与状态管理器

## 1. 位置

- 阶段：Phase 1 一条安全的订单问答链路。
- 本任务落 R-2 两档数据权限的判定核心与 R-7 的状态写入器：档位纯函数、角色读取、权限守卫、状态管理器。
- 前置：T-1 三张表已就位。后续 T-3 工具执行、T-4 控制器都调用它。

## 2. 开发者须知

**先读**

- `apps/api/src/platform/auth/auth.service.ts` 的 `withSurfaceProfile` — 现成的 user/role 查询写法与软删过滤条件。
- `apps/api/src/platform/authorization/authentication.guard.ts` — 守卫如何把 currentUser 挂上 request。
- `apps/api/src/test`（`tests/helpers/test-context.cjs` 旁的惯例）与本文件同批的 `apps/api/test/unit/authentication-guard.test.cjs` — 守卫单测的假对象风格。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「API 权限与数据表」「每个模块的 Interface」— 档位规则与 State manager 接口。
- `apps/api/src/platform/inventory/inventory.service.ts` — 模块内自定义 Prisma client 的先例形状。

**定案（不得重开）**

- 档位只由角色 key 判：`laoban`/`caiwu` → `full`；`qita`/`renshi`/`administrator` 及其他有效角色 → `operational`；无有效角色 → 拒绝。多角色取最高档。
- 角色查询限定 `users.is_active = true`、用户未软删、`roles.deleted_at IS NULL`；不读密码哈希。
- 状态迁移表：`planning → querying → responding → completed`；`planning → responding`（澄清）；活动状态均可到 `failed`/`cancelled`；终态不可离开。
- 状态与事件在同一事务提交；`transitionAndAppend` 以当前状态为条件更新。
- agent 状态走独立连接串 `AGENT_STATE_DATABASE_URL`（缺省回退 `DATABASE_URL`，生产必须显式配置）；业务只读连接是 T-3 的事。

**边界**

- 新文件都在 `apps/api/src/modules/business-query-agent/`：`access-level.ts`、`query-permission.guard.ts`、`agent-state-client.ts`、`state-manager.ts`。
- 不建控制器，不动 `app.module.ts`（T-4 的事）。不改全局平台代码。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-access-level.test.cjs apps/api/test/unit/agent-state-manager.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- 假 Prisma 的 `$transaction` 需要支持数组与回调两种形态；若条件更新在假对象里难以模拟行数返回，停下来说明。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写 `access-level.ts`：`resolveAccessLevel(roleKeys)` 纯函数；先写测试（红）。
3. 写 `agent-state-client.ts`：按 env 建独立 PrismaClient 的工厂。
4. 写 `query-permission.guard.ts`：`principal(request)`、`assertOwner(userId, resourceId)`；重查角色挂 `request.agentPrincipal`。
5. 写 `state-manager.ts`：`createRun`、`transitionAndAppend`、`eventsAfter`、`cancel`、`failInterrupted`；事务内写事件。
6. 每个 case 先红后绿，跑本任务两条命令。
7. 提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | `["laoban"]`、`["caiwu"]`、`["qita","laoban"]` | `full` | `resolveAccessLevel` |
| 2 | `["qita"]`、`["renshi"]`、`["administrator"]` | `operational` | `resolveAccessLevel` |
| 3 | `[]`、`["unknown-role"]` | `denied` | `resolveAccessLevel` |
| 4 | planning run 收 `transitionAndAppend(to:"responding")` | 成功，事件 seq=1 | `transitionAndAppend` |
| 5 | completed run 再收任何迁移 | 抛错且不写事件 | `transitionAndAppend` |
| 6 | 取消后迟到迁移 `responding` | 抛错，状态保持 `cancelled` | `transitionAndAppend` |
| 7 | 守卫对无角色用户 | 403，`agentPrincipal` 不落 request | `QueryPermissionGuard` |
