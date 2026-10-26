# Phase 6 发布验收与回退演练总结

日期：2026-10-26

范围：`b7e9902` 至 `dadaeb4`。

基线：[Phase 5 总结](business-query-agent-v0-phase5-summary-2026-10-26.md)。

术语：新增表示此前不存在；修正表示既有行为已改正。

状态：已完成表示仓库内实现和检查完成；进行中表示已开始但缺外部证据；未开始表示尚未执行。

## 1. 摘要

**本轮完成了 Phase 6 的仓库内发布防线；真实预发布验收尚不能签核。**

| # | 变更 | 位置 | 类型 | 状态 | 对读者的含义 |
| --- | --- | --- | --- | --- | --- |
| C-1 | 生产配置硬门禁 | 部署脚本、Compose、`.env.example` | 修正 | 已完成 | 缺少专用账号或 DeepSeek 配置时不能启动 |
| C-2 | 数据库最小权限证明 | `scripts/verify-agent-database-privileges.mjs` | 新增 | 进行中 | 预发布可证明读业务、拒业务写与状态边界 |
| C-3 | 31 项 operation 目录审计 | `agent-tool-catalog-audit.test.cjs` | 修正 | 进行中 | 目录与已完成的财务实现保持一致 |
| C-4 | 本地安全与恢复回归 | Agent 单元测试集 | 新增 | 进行中 | 权限、注入拒绝、状态、SSE 与脱敏有本地证据 |
| C-5 | Agent 入口回退开关 | `BUSINESS_QUERY_ENABLED` | 新增 | 进行中 | 关闭后不创建新 run，也不调用模型 |
| C-6 | DeepSeek 双角色订单链路 | 预发布环境 | 新增 | 未开始 | 真实角色、订单与模型输出尚未验收 |

例行项：每项 Phase 6 工作都有独立 conventional commit；既有用户未跟踪文件未纳入提交。

## 2. 这意味着什么

部署路径现在要求业务只读账号、Agent 状态账号与 DeepSeek 配置，避免生产环境退回共享业务凭据或假模型。
关闭 `BUSINESS_QUERY_ENABLED=false` 会在统一权限守卫拒绝 Agent 路由，因而不会创建新 run、查询角色或调用模型。
现有 `agent_sessions`、`agent_runs` 与 `agent_run_events` 不会被删除或改写。

本地验证通过：数据库权限脚本单测 1 项、目录和财务权限测试 16 项、发布安全与恢复测试 39 项。
专用数据库集成测试被环境门禁阻止，未把本地或业务数据库当作测试库。

## 3. 仍未完成

- 预发布没有 `AGENT_READ_DATABASE_URL` 与 `AGENT_STATE_DATABASE_URL`，所以权限证明尚无真实数据库结果。
- 预发布没有 API 地址、DeepSeek 密钥、full 与 operational 账号，真实双角色链路尚无结果。
- 没有脱敏代表订单和结构化日志访问方式，订单口径、模型用量与时延没有可签核基线。
- 没有专用 `TEST_DATABASE_URL`，31 项 operation 的真库夹具集成测试尚未运行。
- 回退开关尚未在预发布做关闭与恢复演练，生产业务 API 的真实连续性尚未证明。
