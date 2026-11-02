## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是让真实模型和本地脱敏数据能在受控边界相遇。
- **R-2 完整 Harness 受 Linux 边界约束**：构建容器只能通过固定模型转发网络离开，测试容器仍保持断网。
- **Starts after**：无。**Waits on it**：真实 SDK/Harness 纵切和 R-3 真实生成返工。

## 2. What the developer needs to know

**Read first**

- `phase1-closure-design-and-build-plan-2026-11-02.md` — R-2 的网络、凭据和镜像决定。
- `apps/coding-worker/src/container-policy.ts` — 当前断网、挂载和凭据白名单。
- `apps/coding-worker/src/linux-isolation-probe.ts` — 当前 Linux 运行时边界探针。
- `apps/coding-worker/test/container-policy.test.ts` — 容器参数的独立期望。

**Settled**

- 候选测试容器继续使用 `--network none`，不取得模型凭据。
- 构建容器只能连接调用者提供的内部网络和固定转发主机名。
- 上游模型密钥不进入构建容器；当前阶段只传入转发所需的短期令牌名。

**Edges and seam**

- 触及容器参数构造和 Linux 探针；不改变 SDK provider、模型选择或业务数据入口。
- 接缝是 `buildCodingContainerArgs()`，其调用者必须显式选择构建或验证模式。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- container-policy linux-isolation`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 现有模型服务是否能放进仅供内部网络访问的转发器。若没有固定服务地址，停止在预检，不回退为公网直连。
- SDK 是否在运行时加载遥测或插件。若探针发现额外出口，停止并列出进程和地址。

## 3. The workflow

1. 阅读第 2 部分，并用一句话重述本任务：构建容器的唯一网络出口是受限模型转发。
2. 为构建网络缺失、验证网络存在和非白名单凭据写失败测试。
3. 把容器模式和网络参数收敛到既有参数构造处，产出可审计 Docker 参数。
4. 扩展 Linux 探针，产出构建模式可达转发器、不可达任意外网的观察结果。
5. 保持验证模式断网，产出构建与验证两种模式的独立断言。
6. 运行本任务命令和类型检查，产出通过记录。
7. 提交本任务。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 验证模式 | `--network none` | `buildCodingContainerArgs()` |
| 2 | 构建模式与内部网络 | 仅该网络和转发令牌出现 | `buildCodingContainerArgs()` |
| 3 | 构建模式缺网络 | 创建前拒绝 | `buildCodingContainerArgs()` |
| 4 | 数据库或上游密钥名 | 创建前拒绝 | `buildCodingContainerArgs()` |
| 5 | Linux 构建容器 | 转发器可达、外网不可达 | Linux 探针 |
