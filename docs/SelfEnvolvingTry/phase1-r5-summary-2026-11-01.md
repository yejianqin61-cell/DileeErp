# 阶段一 R-5 批次总结

> 窗口：2026-11-01  
> 基线：[阶段一 R-4 批次总结](phase1-r4-summary-2026-11-01.md) 与
> [阶段一施工计划](phase1-architecture-validation-build-plan-2026-10-31.md)  
> 词汇：种类使用“新增、变更、修复、移除”；状态使用“完成、进行中、未开始”。

## 1. 结论

**R-5 的 4 项任务全部完成。净化源码、离线 Linux 边界和结构化只读入口已重新验证。**

| # | 变化 | 位置 | 种类 | 状态 | 对读者的意义 |
| --- | --- | --- | --- | --- | --- |
| C-1 | 固定基线源码视图 | `source-view.ts` | 新增 | 完成 | 本地秘密和未提交改动不进入 Builder 视图 |
| C-2 | Linux 容器策略 | `container-policy.ts` | 新增 | 完成 | 源码只读，只有候选和 state 可写 |
| C-3 | 受限数据入口 | `restricted-data-gateway.ts` | 新增 | 完成 | 候选不能提交 Prisma 或 SQL 请求 |
| C-4 | Linux 对抗探针 | `linux-isolation-probe.ts` | 新增 | 完成 | 文件、环境和断网边界有真实容器证据 |
| C-5 | R-1 至 R-5 回归 | Coding Worker 测试 | 变更 | 完成 | 49/49 测试、类型和配置检查通过 |

例行项：2026-11-02 focused 回归为 35 通过、1 项 Windows 条件跳过；Worker/API 类型检查和 Harness 配置装载通过。

## 2. 变化的含义

源码视图不复制当前工作树，而是读取指定 Git commit 的白名单 blob。
`.env`、备份、上传物、迁移 SQL、符号链接、未跟踪文件和白名单外源码都不会进入视图。
同一 revision 的文件清单和 SHA-256 清单哈希保持稳定。

容器策略固定使用 Node `24.9.0-alpine`。
真实 Linux 探针证明源码可读但不可写，candidate 与 state 可写，根文件系统只读，敏感环境为空，外网连接失败。
容器同时使用非 root、禁止提权、丢弃 capabilities 及 CPU、内存和 PID 上限。

受限入口只接受 `production.read_employee_output` 的严格 JSON 请求。
宿主适配器返回后，门禁再次核对订单和工序，只留下员工、日期、数量与来源；工资和备注等额外字段不会输出。

## 3. 仍未完成

- 当前 `runCodingBatch()` 仍在宿主启动 Harness；本轮容器策略和探针尚未组成可运行的 DSH Worker 镜像。
- 本轮 `--network none` 适合离线测试；模型出口、依赖镜像源和默认断网测试的分流尚无生产同型证据。
- 当前 Harness profile 仍装载 web、session log 和 telemetry 组件；断网探针阻断了出口，但未证明放开模型网络后的最小出口。
- 受限数据入口使用内存适配器；真实数据库读取、角色重查和跨容器 RPC 尚未接入。
- Linux 探针只证明单个容器主进程的边界；生产编排、后代进程树清理和资源耗尽恢复仍未验证。
- R-6 的订单 A 候选与独立门禁已在后续批次完成；生产发布仍不在 R-5 范围内。

## 变更记录

- 2026-11-02：以当前源码重跑 R-5/R-6 focused 回归。Linux 探针和候选纵切均实际通过。

