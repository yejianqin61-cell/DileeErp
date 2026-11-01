# 任务 4：验证 Linux 隔离纵切

## 1. 任务位置

- 属于阶段一 `R-5 源码与数据只读隔离`，目标是用真实 Linux 容器验证前三项规则。
- 本任务把净化源码视图挂入容器，执行读取、越界写、凭据探测和网络探测。
- 开始条件是任务 1 至任务 3 已完成；R-6 真实工具与独立门禁等待本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/source-view.ts` — 容器实际读取的源码怎样生成。
- `apps/coding-worker/src/container-policy.ts` — Docker 参数和环境边界怎样构造。
- `apps/coding-worker/src/restricted-data-gateway.ts` — 候选工具唯一允许的数据入口是什么。
- `docs/SelfEnvolvingTry/phase1-r4-summary-2026-11-01.md` — 哪些 R-4 证据不能夸大为容器证明。

**已定**

- 纵切使用真实 Docker Linux 容器和 Node `24.9.0-alpine`，不以 Windows 文件权限代替证据。
- 对抗脚本必须能读源码、能写候选；写源码、读秘密和联网必须失败。
- 本任务只证明容器主进程内的文件、环境与网络边界，不证明生产编排和全部后代清理。

**边缘与接缝**

- 接触 Docker 集成测试、隔离探针和测试脚本。
- 接缝是真实 `docker run`；不调用外部模型，不读取业务数据，不发布候选。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- linux-isolation`
- `npm run test --workspace=@dilee/coding-worker && npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若主机没有 Docker Linux engine 或固定镜像不可取得，停止并报告环境阻塞，不降级成 Windows 证明。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为真实容器的预期探针结果写红测试。
3. 生成临时源码、候选和 state 目录并运行固定镜像。
4. 验证源码可读、候选可写、源码不可写和秘密不存在。
5. 验证无敏感环境变量且网络出口失败。
6. 运行全部 Worker 测试、类型检查和 Harness 配置装载。
7. 提交测试，再提交实现或探针修正。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 读取净化源码文件 | 成功 | Linux bind mount |
| 2 | 改写源码文件 | `EROFS` 或 `EACCES` | 只读源码挂载 |
| 3 | 写候选文件 | 成功 | 候选读写挂载 |
| 4 | 读取 `.env` 或数据库变量 | 文件不存在且变量为空 | 视图与环境边界 |
| 5 | 连接外部网络 | 失败 | `--network none` |

