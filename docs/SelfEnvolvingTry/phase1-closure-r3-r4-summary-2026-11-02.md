# 阶段一收口 R-3/R-4 批次总结

窗口：2026-11-02｜基线：[阶段一收口设计](phase1-closure-design-and-build-plan-2026-11-02.md)｜输出：Markdown

术语：种类使用“新增、变更、修复、移除”；状态使用“完成、进行中、未开始”。

## 1. Headline

**本批次完成真实修订冻结、返工证据绑定和受限实库读取；真实模型生成仍未完成。**

| # | Change | Where | Kind | State | What it means for the reader |
| --- | --- | --- | --- | --- | --- |
| C-1 | 候选修订冻结 | `apps/coding-worker` | 新增 | 完成 | 宿主可固定实现和 Builder 测试的字节集合 |
| C-2 | Builder 审查绑定 | `apps/coding-worker` | 变更 | 完成 | 旧 Builder 会话或旧 Activation 的报告不能批准新修订 |
| C-3 | 订单工序授权 | `apps/coding-worker` | 变更 | 完成 | 越权请求在触达 adapter 前被拒绝 |
| C-4 | 专用实库 adapter | `apps/coding-worker` | 新增 | 完成 | 网关可从 `dilee_phase1_test` 读取最小日报投影 |
| C-5 | 受控 JSONL 通道 | `apps/coding-worker` | 新增 | 完成 | 候选只能经宿主上下文请求允许的数据 |
| C-6 | 真实模型返工 | `apps/coding-worker` | 新增 | **未开始** | 缺模型 relay 配置，不能运行真实文件生成实验 |

例行项：R-3 相关测试 9 项通过；R-4 网关测试 11 项通过；类型检查通过。

## 2. What it means

候选不再只靠 Agent 自报哈希。宿主能冻结文件，并要求 Validator 证明审查了对应 Builder 会话和 Activation。

数据网关现在把授权范围放在宿主上下文中，并从专用测试库读取投影结果。候选提供的请求不能扩大其订单或工序权限。

## 3. Still open

- 模型 relay 的内部网络、地址和短期令牌尚未配置，真实模型生成和返工没有运行证据。
- 独立 ERP 门禁和双工具母会话仍未开始。

## 变更记录

- 2026-11-02：提交 `0b90215`、`1ff98bb`、`8ad390e`、`b8e68a0` 与 `96b4109`；真实模型 relay 仍未配置。
