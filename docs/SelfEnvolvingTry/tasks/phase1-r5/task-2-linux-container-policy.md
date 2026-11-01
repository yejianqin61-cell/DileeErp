# 任务 2：定义 Linux 容器隔离策略

## 1. 任务位置

- 属于阶段一 `R-5 源码与数据只读隔离`，目标是 Harness preset 之外还有操作系统边界。
- 本任务生成固定 Docker 启动参数和最小环境：源码只读，候选目录可写，其余根文件系统只读。
- 开始条件是任务 1 已定义源码视图；真实 Linux 对抗实验等待本任务。

## 2. 开发者须知

**先读**

- `docs/SelfEnvolvingTry/business-query-agent-deepseek-harness-sdk-phase1-2026-10-29.md` — 容器承担哪些最终边界。
- `apps/coding-worker/src/runtime-lifecycle.ts` — Worker 当前怎样显式传入环境与工作区。
- `apps/api/Dockerfile` — 本项目现有容器约定和 Node 镜像来源。
- `tmp/deepseek-harness/SAFETY.md` — Harness sandbox 为什么不能代替容器。

**已定**

- 使用 Node `24.9.0-alpine`，禁网、只读根文件系统、非 root、丢弃 capabilities 并禁止提权。
- 只挂载源码视图为只读、候选目录为读写、独立 Harness state 为读写，并用受限 tmpfs。
- 子进程环境按名称白名单构造；数据库、Cookie、用户令牌和部署凭据不能透传。

**边缘与接缝**

- 接触 Coding Worker 的容器启动策略、环境净化和对应测试。
- 接缝是 Docker 参数构造器；不实现调度器，也不启动生产容器服务。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- container-policy`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若 Docker Desktop 与生产 Linux 的 bind mount 语义不同，保留策略测试并把差异交给任务 4 实测。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为源码挂载缺少只读标志写红测试。
3. 生成固定容器参数和三个最小挂载。
4. 加入非 root、断网、资源上限和只读根文件系统断言。
5. 加入环境白名单与敏感变量不透传用例。
6. 运行目标测试和类型检查。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 源码、候选和 state 路径 | 源码只读，另两项可写 | Docker 参数构造器 |
| 2 | 默认策略 | 禁网、非 root、根文件系统只读 | Docker 参数构造器 |
| 3 | 默认策略 | CPU、内存和 PID 有上限 | Docker 参数构造器 |
| 4 | 环境含 `DATABASE_URL` | 容器环境不含该项 | 环境净化器 |
| 5 | 显式模型凭据名 | 只透传该模型凭据 | 环境净化器 |

