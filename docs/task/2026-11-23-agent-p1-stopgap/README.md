# P1 止血：按实测缺陷定位，不按猜测重构

设计：[`docs/design/dilee-consultant-governance-2026-11-22.md`](../../design/dilee-consultant-governance-2026-11-22.md) §6.2。
基线：[`agent-golden-baseline-2026-11-22.md`](../../review/agent-golden-baseline-2026-11-22.md)。

## 阶段目标

**工具调用失败率从 11.5% 压到 0，通过率保持 100%，并把 P0 留下的三个盲区全部验掉。**

## 与设计稿的一处偏离（有证据，不是口味）

设计稿 §6.2 写的是「实体解析器 + 工具面扁平化成 ~10 个」。P0 的基线数据推翻了那个前提的一半：

- 现状不是「模型选错 operation」，而是**工具目录缺动作**（D-1 列表/筛选、D-2 跨单聚合）；
- 扁平化是破坏性重构：6 个工具 × 31 个 operation 折成 10 个，会同时改掉模型 schema、执行器、
  前端步骤文案、31 条既有单测。它解决的是「选错 operation」，而实测里那类失败只占 3/7。

所以 P1 改成**按缺陷补能力**：加两个入口（列表/筛选、无根聚合）、补服务端归一、改根缺失的引导文案。
扁平化留成一项独立改造，等有数据证明「选错 operation」真的是主要失败来源时再做。

## 任务

| # | 任务 | 解决的 | 依赖 |
|---|---|---|---|
| 1 | [服务端单号归一](task-1-normalize.md) | 未解项：归一靠模型 | — |
| 2 | [列表与筛选入口](task-2-list-documents.md) | D-1（2 条失败） | 1 |
| 3 | [无根聚合与根缺失引导](task-3-unrooted.md) | D-2（1 条失败） | 1 |
| 4 | [正向财务路径验证](task-4-finance-positive.md) | 盲区 1 | — |
| 5 | [答案数值正确性](task-5-answer-values.md) | 盲区 2 | 1, 2 |
| 6 | [model_steps 采集与 P1 报告](task-6-report.md) | 盲区 3 + 收尾 | 全部 |

## 命令

```bash
npm run test:unit:api         # 31 个既有 operation 的回归面（本批会动到）
npm run test:agent-golden:unit
npm run test:agent-golden     # 真机全量，需要 GOLDEN_PASSWORD
```

## 本批不做

- 工具面扁平化（理由见上）。
- 跨轮句柄（D-3）：句柄按轮失效是安全设计，改它要先定跨轮的安全边界，不塞进止血轮。
- 前端、上下文厚度、流式节流：属于 P2。
- 注释全量清除：独立一轮。