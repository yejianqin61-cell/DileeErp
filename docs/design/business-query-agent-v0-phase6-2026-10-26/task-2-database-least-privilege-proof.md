## 1. Where this task sits

- **Phase 6 发布验收与回退演练**：数据库边界必须可在预发布证明。
- **本任务推进 R-1 只读业务边界**：记录并验证只读与状态账号的最小权限。
- **开始于** Task 1 发布预检。**后续等待它**：真实预发布验收。

## 2. What the developer needs to know

**Read first**

- `query-read-client.ts` — 只读 client 的唯一配置入口。
- `agent-state-client.ts` — 状态 client 的唯一配置入口。
- `business-query-agent.module.ts` — 两个 client 的注入边界。
- `agent-tables-migration.test.cjs` — Agent 表的实际名称。

**Settled**

- 只读账号仅查业务和判权表；状态账号仅访问 `agent_*` 表。
- 授权由预发布管理员执行；仓库不保存数据库密码。

**Edges and seam**

- 触及发布证明脚本。保留业务 schema 和运行时查询。

**Run**

- `npm run build --workspace=@dilee/api`
- 预发布凭据下的权限证明命令。

**Unknowns**

- 没有预发布两组连接串时，停止在证明模板，不伪造数据库结果。

## 3. The workflow

1. 阅读第 2 部分并复述：模型路径无业务写权限。
2. 枚举实际的 Agent 表与运行连接。
3. 写失败探针，验证错误账号或越权写被拒绝。
4. 用预发布凭据执行读取、拒写和状态写证明。
5. 保存无敏感结果摘要。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 只读账号读订单 | 返回允许事实 | read client |
| 2 | 只读账号写业务表 | 数据库拒绝 | read client |
| 3 | 状态账号写 agent 表 | 成功 | state client |
| 4 | 状态账号读业务表 | 数据库拒绝 | state client |
