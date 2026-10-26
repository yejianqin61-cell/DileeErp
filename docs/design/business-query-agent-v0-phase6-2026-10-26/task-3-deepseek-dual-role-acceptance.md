## 1. Where this task sits

- **Phase 6 发布验收与回退演练**：真实模型和真实角色走通订单问答。
- **本任务推进 R-2 两档数据权限、R-4 DeepSeek 查询编排**：证明 full 与 operational 的实际输出边界。
- **开始于** Task 1、Task 2。**后续等待它**：发布签核。

## 2. What the developer needs to know

**Read first**

- `deepseek-llm-provider.ts` — 真实请求、超时和错误映射。
- `query-permission.guard.ts` — 两档权限的服务端来源。
- `business-query-contract.test.cjs` — 登录与 run 的 HTTP 契约。
- `task-4-downgrade-and-finance-evidence.md` — full/operational 的已验证边界。

**Settled**

- 真实模型只在预发布使用脱敏代表订单。
- operational 不得取得财务事实；full 可取得授权财务事实。

**Edges and seam**

- 触及预发布 API 和真实模型。保留本地 fake 验证用途。

**Run**

- 预发布双角色 E2E 命令。
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 无 DeepSeek 密钥、预发布地址或两类账号时，停止并请求这些外部条件。

## 3. The workflow

1. 阅读第 2 部分并复述：真实模型不得跨过当前角色档位。
2. 记录两个脱敏代表订单与预期非财务/财务字段。
3. 分别以 operational、full 登录并完成问答。
4. 保存 run ID、模型、耗时、来源和稳定错误码摘要。
5. 对照两档输出，确认无越权字段。
6. 提交验收记录。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | operational 订单进度 | 有来源的非财务答案 | 预发布 API |
| 2 | operational 财务问题 | 拒绝或无财务字段 | 预发布 API |
| 3 | full 财务问题 | 授权财务事实 | 预发布 API |
| 4 | 无效模型密钥 | 稳定启动拒绝 | 配置闸门 |
