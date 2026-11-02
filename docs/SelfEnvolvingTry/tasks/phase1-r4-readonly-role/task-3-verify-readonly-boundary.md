## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是 R-4 的实库读取可验证。
- **R-4 受限入口能安全读取实库**：证明只读角色能读允许投影且不能写。
- **Starts after**：固定 adapter 身份。**Waits on it**：阶段总结。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/postgres-restricted-data.ts` — 查询和角色配置。
- `apps/coding-worker/src/restricted-data-channel.ts` — 候选读取边界。
- `docs/SelfEnvolvingTry/tasks/phase1-closure-r3-r4/task-3-read-test-database.md` — 原始验证口径。

**Settled**

- 只输出行数、权限结果和字段名单。
- 不输出订单、员工、数量或凭据。
- 写入失败才构成权限验证通过。

**Edges and seam**

- 触及本地测试容器。
- 不改源快照和生产库。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- postgres-restricted-data restricted-data-channel`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- Docker 容器不运行时，停止并报告环境前提。

## 3. The workflow

1. 阅读第 2 部分，并重述：只读角色必须读得到允许行且写不进去。
2. 执行受限查询，产出脱敏行数。
3. 执行无副作用的 INSERT 权限测试，产出拒绝码。
4. 运行 focused tests，产出通过记录。
5. 运行类型检查，产出通过记录。
6. 更新阶段总结并提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 有效范围 | 返回允许字段 | adapter |
| 2 | 只读角色 INSERT | 权限拒绝 | PostgreSQL |
| 3 | JSONL 范围外请求 | 拒绝且不读库 | channel |
| 4 | 输出记录 | 无业务值和凭据 | verification |

