## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是候选无法获得 ERP 数据库写权限。
- **R-4 受限入口能安全读取实库**：在测试库建立专用只读角色。
- **Starts after**：固定测试库。**Waits on it**：adapter 身份锁定。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/postgres-restricted-data.ts` — adapter 的数据库接缝。
- `apps/coding-worker/src/phase1-data-baseline.ts` — 测试库重建位置。
- `apps/coding-worker/test/postgres-restricted-data.test.ts` — 当前查询边界。

**Settled**

- 角色仅用于 `dilee_phase1_test`。
- 角色可连接、使用 `public`、读取日报表。
- 角色不能写表、建库、建角色或提升权限。

**Edges and seam**

- 触及 Worker 的 PostgreSQL adapter。
- 接缝是数据库命令参数。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- postgres-restricted-data`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 容器认证若拒绝角色登录，停止并报告认证配置。

## 3. The workflow

1. 阅读第 2 部分，并重述：测试库只有只读角色可提供业务读取。
2. 写角色 SQL 形状的失败测试。
3. 实现角色配置函数，产出最小授权命令。
4. 在本地容器执行配置，产出角色存在证据。
5. 运行测试和类型检查，产出通过记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 测试库 | 固定只读角色 | provisioning |
| 2 | 公共角色 | 无连接和表权限 | provisioning |
| 3 | 日报表 | 角色有 SELECT | provisioning |
| 4 | 其他数据库 | 不生成授权 | provisioning |

