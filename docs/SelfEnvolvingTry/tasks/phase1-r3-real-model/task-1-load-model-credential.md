## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是让真实模型凭据只留在宿主。
- **R-3 实际生成与返工绑定真实修订**：把本地 `DEEPSEEK_KEY` 映射为 relay 的上游凭据。
- **Starts after**：真实 API 健康探针。**Waits on it**：内部 relay。

## 2. What the developer needs to know

**Read first**

- `.env` — 本地模型密钥别名，不得输出值。
- `apps/coding-worker/src/container-policy.ts` — 容器凭据白名单。
- `docs/review/agent-sdk-wire-proof-2026-10-26.md` — 已验证的 DeepSeek 端点。

**Settled**

- 宿主读取 `DEEPSEEK_KEY`，relay 使用该值作为上游 Bearer 凭据。
- 构建容器只能取得 relay 令牌，不能取得上游密钥。

**Edges and seam**

- 触及 Worker 宿主启动配置；不改 API 服务环境。
- 接缝是 relay 配置解析。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- model-relay`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 密钥若被撤销，停止真实实验并只报告认证失败码。

## 3. The workflow

1. 阅读第 2 部分，并重述：上游密钥只在宿主 relay 使用。
2. 写缺密钥和错误别名的失败测试。
3. 实现别名解析，产出受限 relay 配置。
4. 运行测试和类型检查，产出通过记录。
5. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | `DEEPSEEK_KEY` 存在 | relay 配置可用 | 配置解析 |
| 2 | 无上游密钥 | 明确拒绝 | 配置解析 |
| 3 | 容器环境 | 不含上游密钥 | 容器参数 |
