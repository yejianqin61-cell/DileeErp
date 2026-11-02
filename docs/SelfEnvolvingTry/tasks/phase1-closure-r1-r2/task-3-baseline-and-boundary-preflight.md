## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是让真实模型和本地脱敏数据能在受控边界相遇。
- **R-1 本地数据基线可重复、R-2 完整 Harness 受 Linux 边界约束**：给两项前置条件提供一个严格、可复跑的宿主预检。
- **Starts after**：前两项完成。**Waits on it**：R-3 真实生成、R-4 实库授权和最终一键验收。

## 2. What the developer needs to know

**Read first**

- `phase1-closure-design-and-build-plan-2026-11-02.md` — 第一关必须保存的环境、数据和边界证据。
- `apps/coding-worker/src/linux-isolation-probe.ts` — 已有 Linux 探针结果。
- `apps/coding-worker/src/runtime-contract.ts` — SDK 与 CLI 版本契约。
- `apps/coding-worker/test/run-tests.ts` — 当前测试筛选约定。

**Settled**

- 缺 Docker Linux、基线库或模型转发配置一律失败，不能标记跳过。
- 预检不发起真实模型生成，不读取密钥值，也不写源库。
- 证据只输出当前提交、镜像、数据清单和探针布尔结果。

**Edges and seam**

- 触及 Coding Worker 的命令入口和前两项返回值；不实现候选生成或数据授权。
- 接缝是一个明确的宿主预检函数，阶段验收入口以后组合它。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- phase1-preflight`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 本机模型转发服务是否已配置。若缺少主机名或短期令牌名，预检必须返回具体缺项。
- Docker 网络名称在不同机器是否不同。若必须推断网络名，停止并改为显式配置。

## 3. The workflow

1. 阅读第 2 部分，并用一句话重述本任务：严格预检只证明环境可开始真实实验。
2. 为缺 Linux、缺基线和缺转发配置写失败测试，产出明确错误码。
3. 组合数据清单、运行时契约和 Linux 边界探针，产出结构化预检结果。
4. 加入提交、镜像和配置摘要，产出不含密钥的证据索引。
5. 添加 npm 脚本，产出可由阶段验收复用的严格命令。
6. 运行本任务命令和类型检查，产出通过记录。
7. 提交本任务。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | Docker 不是 Linux | `LINUX_DOCKER_ENGINE_REQUIRED` | 严格预检 |
| 2 | 未找到基线描述 | `PHASE1_BASELINE_REQUIRED` | 严格预检 |
| 3 | 缺转发网络或地址 | `MODEL_RELAY_CONFIGURATION_REQUIRED` | 严格预检 |
| 4 | 合法模拟依赖 | 返回提交、镜像和基线哈希 | 严格预检 |
| 5 | 输出含环境变量 | 不含令牌或连接凭据 | 证据序列化 |
