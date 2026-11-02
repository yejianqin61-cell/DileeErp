## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是模型出口只能到固定上游。
- **R-3 实际生成与返工绑定真实修订**：实现 relay 的固定路径、令牌和请求上限。
- **Starts after**：宿主凭据映射。**Waits on it**：真实生成实验。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/container-policy.ts` — 容器网络模式。
- `docs/review/agent-sdk-wire-proof-2026-10-26.md` — DeepSeek 聊天完成端点。
- `apps/coding-worker/src/phase1-preflight.ts` — relay 前置条件。

**Settled**

- 只接受 `POST /v1/chat/completions`。
- 令牌不匹配、其他路径、过大 body 和非 POST 一律拒绝。
- relay 只代理固定 DeepSeek 上游，不实现 CONNECT 或任意 URL。

**Edges and seam**

- 触及 Worker relay 服务；不修改候选网关或数据库。
- 接缝是 relay HTTP handler。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- model-relay`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- DSH 的真实 provider 配置若不支持自定义 base URL，停止在 provider 预检。

## 3. The workflow

1. 阅读第 2 部分，并重述：relay 不成为通用代理。
2. 写路径、令牌和 body 上限的失败测试。
3. 实现 HTTP handler，产出固定上游转发。
4. 运行测试和类型检查，产出通过记录。
5. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 正确令牌和固定路径 | 转发请求 | relay handler |
| 2 | 错误令牌 | 401 | relay handler |
| 3 | 非固定路径 | 404 | relay handler |
| 4 | 超大 body | 413 | relay handler |
