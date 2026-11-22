# P0 尺子：顾问查询工具评测黄金集

设计：[`docs/design/dilee-consultant-governance-2026-11-22.md`](../../design/dilee-consultant-governance-2026-11-22.md) §6.1。

**这一批只做尺子。** 不改工具、不改解析器、不改前端。目标是把「失败率高」变成可读的数字，
之后的每个改动都拿同一把尺子量。

## 阶段目标

跑一条命令，得到：总用例数、通过率、按组通过率、失败码分布、每条未通过用例的原因。

## 任务

| # | 任务 | 产物 | 依赖 |
|---|---|---|---|
| 1 | [用例集格式与装载器](task-1-case-format.md) | `scripts/agent/golden-cases.mjs` | — |
| 2 | [评测运行器](task-2-runner.md) | `scripts/agent/golden-runner.mjs` | 1 |
| 3 | [判定器](task-3-judge.md) | `scripts/agent/golden-judge.mjs` | 1 |
| 4 | [报告生成](task-4-report.md) | `scripts/agent/golden-report.mjs` | 3 |
| 5 | [用例内容：入口与错号](task-5-cases-entry.md) | `apps/api/test/agent-golden/cases/entry*.json`、`miss*.json` | 1 |
| 6 | [用例内容：关系、追问、权限](task-6-cases-relation.md) | `apps/api/test/agent-golden/cases/relation*.json`、`followup*.json`、`permission*.json` | 1 |
| 7 | [基线数据、接线与基线报告](task-7-baseline.md) | `package.json` 脚本、`docs/review/agent-golden-baseline-2026-11-22.md` | 2, 4, 5, 6 |

## 命令

```bash
npm run test:agent-golden                    # 跑全量，打印报告
npm run test:agent-golden -- --group entry   # 只跑一组
npm run test:agent-golden -- --validate      # 只校验用例，不调模型
npm run test:agent-golden:unit               # 只跑四个纯模块的单测
```

## 本批明确不做

- 不做录制回放。基线是「某一天、某个数据基线、某个模型」的快照。
- 不把 `model_steps` 纳入判定：SSE 协议不暴露它，只有观测日志有（见任务 2 的未知项）。
- 不做 CI 门禁阈值。先有数，再定门槛。