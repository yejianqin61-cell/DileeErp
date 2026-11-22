<task-brief>

## 1. Where this task sits

- **Phase P0 尺子**，目标是让「查询工具失败率高」变成可读的数字。
- **本任务交付 R-7 基线数据、命令接线与基线报告**：一条命令跑出数，一份文档存下数。
- **Starts after**：任务 2、4、5、6。**Waits on it**：无（本批收尾）。

## 2. What the developer needs to know

**Read first**

- `package.json`（仓库根）— `test:deploy` 已用 `node --test scripts/*.test.mjs` 的模式，照它加。
- `scripts/seed-mock-data.mjs` — 数据基线的生成者；幂等（`upsert` 固定 UUID）。
- `docs/review/agent-tool-invocation-audit-2026-10-27.md` — 报告格式的参照：先结论、再缺陷、每条带证据。
- `apps/api/src/platform/config/validate-environment.ts` — 生产必须 `AGENT_LLM_PROVIDER=deepseek` + 密钥，本任务不改它。

**Settled**

- 前置依赖缺失（库没种子数据、账号没有 `full` 档）在报告里如实写「未覆盖」，不用绿勾掩盖。
- 基线报告必须写明：跑在哪个库、哪个模型、什么时候、哪些用例红、红的失败码是什么。
- 单测（四个纯模块）进 `test:deploy` 的名单；**调模型的评测不进 CI**，只留一条手动命令。

**Edges and seam**

- 改根 `package.json`（只加 script）；新增 `docs/review/agent-golden-baseline-2026-11-22.md`。
- 不改 `apps/api/src`、不改前端。

**Run**

- `npm run test:agent-golden:unit`
- `npm run test:agent-golden -- --validate`
- `npm run test:agent-golden`

**Unknowns**

- 现有脚本 `test:deploy` 已挂 4 个文件，追加 4 个会让 `npm test` 变慢。若单测总耗时超过 20 秒，停下来报告，别默默把全量单测挪出 CI。

## 3. The workflow

1. 读四个文件，一句话复述本任务。
2. 起一个指向目标库的 API（`PORT=3111`，`AGENT_LLM_PROVIDER=deepseek`），确认 `/health` 通。
3. 跑 `npm run db:seed:mock` 建数据基线，验证 `MOCK-ORD-001` 在 `order-workbench` 里查得到。
4. 加三个 script：`test:agent-golden`（跑全量）、`test:agent-golden:unit`（四个纯模块单测）、`test:agent-golden:validate`；把四个单测文件加进 `test:deploy`。
5. 用真实模型跑一次全量，把报告落到 `docs/review/agent-golden-baseline-2026-11-22.md`。
6. 报告里写清：总数、通过率、分组表、失败码分布、每条红的原因、未覆盖项（正向财务、`model_steps`）。
7. 跑 `npm run test:agent-golden:unit` 与 `npm test --workspace=@dilee/web` 之外的相关门禁，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `npm run test:agent-golden:unit` | 四个测试文件全绿，退出码 0 | 命令 |
| 2 | `npm run test:agent-golden -- --validate` | 全部用例格式合法，退出码 0 | 命令 |
| 3 | `npm run test:agent-golden` | 打印报告，含总数与通过率 | 命令 |
| 4 | 报告文件 | 含「数据基线」「模型」「未覆盖」三个小节 | 文件 |
| 5 | 缺种子的库 | 相关用例记 `baseline_missing` 而非 fail | `judge()` |

</task-brief>