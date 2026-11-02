# 阶段一收口 R-3/R-4 批次总结

窗口：2026-11-02｜基线：[阶段一收口设计](phase1-closure-design-and-build-plan-2026-11-02.md)｜输出：Markdown

术语：种类使用“新增、变更、修复、移除”；状态使用“完成、进行中、未开始”。

## 1. Headline

**本批次完成真实模型候选生成、修订返工证据绑定和专用只读实库读取。**

| # | Change | Where | Kind | State | What it means for the reader |
| --- | --- | --- | --- | --- | --- |
| C-1 | 候选修订冻结 | `apps/coding-worker` | 新增 | 完成 | 宿主可固定实现和 Builder 测试的字节集合 |
| C-2 | Builder 审查绑定 | `apps/coding-worker` | 变更 | 完成 | 旧 Builder 会话或旧 Activation 的报告不能批准新修订 |
| C-3 | 订单工序授权 | `apps/coding-worker` | 变更 | 完成 | 越权请求在触达 adapter 前被拒绝 |
| C-4 | 专用实库 adapter | `apps/coding-worker` | 新增 | 完成 | 网关只用专用角色读取测试库最小投影 |
| C-5 | 受控 JSONL 通道 | `apps/coding-worker` | 新增 | 完成 | 候选只能经宿主上下文请求允许的数据 |
| C-6 | 真实模型生成 | `apps/coding-worker` | 新增 | 完成 | relay 驱动 Builder 在空候选目录写出实现和测试 |
| C-7 | 专用只读身份 | `apps/coding-worker` | 变更 | 完成 | 数据库身份不能建库、建角色或写日报表 |

例行项：Worker 103/104 测试通过；唯一跳过项只适用于 Linux 的符号链接测试；类型检查通过。

## 2. What it means

候选不再只靠 Agent 自报哈希。宿主能冻结文件，并要求 Validator 证明审查了对应 Builder 会话和 Activation。

真实模型运行经本地 relay 使用宿主凭据。它启动两个子 Agent，并在临时候选目录写出 `tool.ts` 和 `tool.test.ts`。

数据网关把授权范围放在宿主上下文中。专用角色能读取日报表，但 PostgreSQL 拒绝其 `INSERT`。

## 3. Still open

- 独立 ERP 门禁和双工具母会话仍未开始。

- 真实模型实验只验证了文件生成。完整的真实模型 Validator 拒绝后返工，仍使用确定性 Harness 纵切作为证据。

## 变更记录

- 2026-11-02：提交 `0b90215`、`1ff98bb`、`8ad390e`、`b8e68a0` 与 `96b4109`，建立修订、授权和数据通道边界。
- 2026-11-02：提交 `d8d5c6d`，接入 OpenAI-compatible relay、真实模型验收脚本和专用只读角色。
- 2026-11-02：真实模型验收通过：152 个根事件、2 个子 Agent 启动、2 个候选文件。
