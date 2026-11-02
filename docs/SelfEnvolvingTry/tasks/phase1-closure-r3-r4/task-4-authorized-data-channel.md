## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是候选无法自行扩大实库读取权限。
- **R-4 受限入口能安全读取实库**：宿主把用户、订单和工序授权绑定到一次受控数据请求。
- **Starts after**：只读 adapter。**Waits on it**：候选 Linux 执行和独立门禁。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/restricted-data-gateway.ts` — 当前请求验证和 host access level。
- `apps/coding-worker/src/order-a-candidate-slice.ts` — 候选离线容器边界。
- `apps/api/src/modules/auth` — 线上角色口径的可复用入口。
- `phase1-closure-design-and-build-plan-2026-11-02.md` — 用户、订单、工序绑定决定。

**Settled**

- 候选消息不能携带 access level、用户或授权订单。
- 宿主上下文每次调用重查；范围外订单或工序拒绝。
- 标准输入输出只传固定请求和投影结果，不传数据库连接串。

**Edges and seam**

- 触及 Worker 网关上下文；不开放 HTTP 或 SQL 接口。
- 接缝是 `RestrictedDataGateway.read()`。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- restricted-data-gateway`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 现有角色服务是否能无 HTTP 上下文读取当前角色。若不能，停止并显式定义宿主角色提供器。

## 3. The workflow

1. 阅读第 2 部分，并重述：宿主而非候选决定可读范围。
2. 写跨订单、换工序和伪造档位的失败测试。
3. 扩展受信上下文，产出订单和工序范围检查。
4. 把 adapter 绑定到网关，产出受控读取入口。
5. 运行测试和类型检查，产出通过记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 被授权订单和工序 | 返回投影结果 | `RestrictedDataGateway.read()` |
| 2 | 另一订单 | 调用 adapter 前拒绝 | `RestrictedDataGateway.read()` |
| 3 | 同订单另一工序 | 调用 adapter 前拒绝 | `RestrictedDataGateway.read()` |
| 4 | 候选伪造档位 | 请求无效 | `RestrictedDataGateway.read()` |
| 5 | 无有效授权 | 调用 adapter 前拒绝 | `RestrictedDataGateway.read()` |
