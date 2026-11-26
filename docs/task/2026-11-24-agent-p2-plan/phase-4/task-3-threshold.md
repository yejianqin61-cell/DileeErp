<task-brief>

## 1. Where this task sits

- **阶段 4 缺口变成候选**，目标是同一差异只攒一条候选、达门槛交一次建单器。
- **本任务交付 R-6 的门槛与建单器接口**：第三个不同会话到达时升为 `ready`，把工单内容交给注入的建单器一次。
- **Starts after**：任务 2。**Waits on it**：任务 4。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/gap-candidates.ts`（任务 2）— `record` 现状。
- `docs/design/dilee-consultant-p2-tool-catalog-2026-11-24.md` §4.2 — 工单正文允许有什么。
- `apps/api/src/modules/business-query-agent/observability.ts` — 本模块记日志的方式（用 Nest `Logger`，不记业务值）。

**Settled**

- 导出 `GAP_PROMOTION_THRESHOLD = 3`；接口 `GapTicketBuilder { build(ticket): Promise<{ dispatched: boolean }> }`；构造参数变为 `(client, builder)`。
- 工单内容键恰为：`candidate_id, nearest_operation, missing, missing_details, missing_params, needed_fields, unverified_fields, session_count`。四个数组按记录先后去重合并。**不含**会话号、轮次号、原话。
- 升级用 `updateMany({ where: { id, status: "accumulating" }, data: { status: "ready" } })`，只有改到 1 行的那次才调建单器；`dispatched: true` 时写 `dispatchedAt`。建单器抛错则吞掉记一行日志（README）。
- 默认实现 `LoggingGapTicketBuilder`：记「缺口候选达到门槛」加候选号、operation、差异类型，返回 `{ dispatched: false }`。

**Edges and seam**

- 只改 `gap-candidates.ts` 与它的测试。
- Seam：`record` 配假建单器。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-candidates.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 两个并发的第三次声明：靠带状态条件的更新保证只调一次。测不出并发时不要加锁或事务，停下报告。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1、2（门槛前后），红，再实现升级与调用。
3. 写用例 3（工单内容），红，再补合并。
4. 写用例 4（只调一次与送出时间），红，再补。
5. 写用例 5（建单器抛错与默认实现），红，再补；跑 Run 的命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 两个不同会话各报一次同键 | 建单器调用 0 次，状态 `accumulating`（来源：门槛 3） | `record` |
| 2 | 同一会话三个轮次报同键 | 调用 0 次 | `record` |
| 3 | s1、s2、s3 依次报，短语为「按仓库分组」「分仓库看」「按仓库分组」 | 恰调 1 次；`missing_details` 为 `["按仓库分组","分仓库看"]`，`session_count` 3，键恰为 Settled 所列 | `record` |
| 4 | 接着 s4 再报；假建单器返回 `dispatched: true` 与 `false` 各跑一遍 | 总调用仍 1 次；返回 `true` 时 `dispatchedAt` 非空，`false` 时为空；状态都是 `ready` | `record` |
| 5 | 假建单器抛错；另一次直接调 `LoggingGapTicketBuilder.build` | `record` 正常返回，状态 `ready`、`dispatchedAt` 空；默认实现返回 `{ dispatched: false }` | `record` |

</task-brief>
