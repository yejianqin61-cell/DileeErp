# 顾问查询工具黄金集基线报告

生成时间：2026-11-22T16:51:15.638Z（由快照重渲染）｜API：http://127.0.0.1:3111/api/v1｜模型：deepseek-chat（AGENT_LLM_PROVIDER=deepseek）

## 1. 结论

**61 条用例，通过 61 条，未通过 0 条，基线缺失 0 条，通过率 100.0%。**

另一条独立的数：**7 条用例过程中出现过工具失败（11.5%），其中 7 条靠模型自纠拿到结论。**

通过率的分母是「总数 − 基线缺失」：缺数据的用例不算工具失败，但要单独计数。

## 2. 分组

| 分组 | 总数 | 通过 | 未通过 | 基线缺失 | 通过率 |
| --- | --- | --- | --- | --- | --- |
| entry | 22 | 22 | 0 | 0 | 100.0% |
| followup | 6 | 6 | 0 | 0 | 100.0% |
| miss | 12 | 12 | 0 | 0 | 100.0% |
| permission | 5 | 5 | 0 | 0 | 100.0% |
| relation | 16 | 16 | 0 | 0 | 100.0% |

## 3. 失败码分布

| 失败码 | 出现次数 |
| --- | --- |
| AGENT_TOOL_ARGUMENT_INVALID | 3 |
| ORDER_REF_INVALID | 3 |
| ORDER_SEARCH_REQUIRED | 1 |

### 3.1 工具调用失败率（过程信号）

**7 / 61 条用例（11.5%）在过程中出现过至少一次工具失败；其中 7 条被模型自行纠正后仍拿到终态 completed。**

这条才是「工具调用失败率高」的直接度量：结论对了，不等于调用过程是干净的。每次失败都在消耗模型的失败预算（上限 3 次），也在拉长时延。

自纠成功的用例：entry-batch-recent、entry-batch-status-filter、followup-production-then-reports、followup-purchase-then-inspection、miss-cross-forged-ref、miss-unknown-long-garbage、relation-cross-low-stock

## 4. 未通过清单

全部通过。

## 5. 数据基线

由 scripts/seed-mock-data.mjs 生成的 MOCK-* 幂等种子数据。

## 6. 未覆盖

- 正向财务用例未覆盖：本地库只有 administrator（数据档位 operational），没有 laoban/caiwu 账号，财务读取的通过路径本批无法验证。
- model_steps 未采集：SSE 协议不下发该字段，只有服务端观测日志有；本批只用 tool_calls 与 answer_chunks 做预算判断。
- permission 组用的是负向断言（来源不得含财务类 business_type）；若模型根本不去碰财务工具，该断言恒真，信息量偏弱。
- 答案数值正确性未断言：本批只断言终态、来源单据、调用的 operation、失败码与工具次数预算。通过率高说明链路能跑通、单据能定位，不等于答案里的数字都对。数值正确性要另设一组「已知口径」用例，P1 再做。
- 失败码是过程信号不是终局：非空失败码的用例只要模型自纠成功仍判通过。所以失败码分布比通过率更能反映工具接口的粗糙程度。

## 7. 附录：本次观测（不参与判定）

- 用例总数：61（entry/miss/relation/followup/permission 五组）
- 基线单号池：9 个可识别单号（销售 / 采购 / 生产三源合并）
- 未调用模型即判定的用例：0 条（基线缺单号）
- 满宽、全角、部分单号（ORD-001）三条用例都把归一化交给了模型：模型自己把 ＭＯＣＫ－ＯＲＤ－００１ 转成 MOCK-ORD-001 再检索。服务端归一化仍是空白，模型换版本就会变。
- 逐条终态、来源、失败码与答案全文见同名 JSON 快照。

## 8. 缺陷分析（人工撰写，不由脚本生成）

**通过率 100% 不等于「工具调用没问题」。7 条用例在过程中踩过工具失败，全部靠模型自纠才拿到结论。**
把每个失败码追到具体提问，本轮的病灶只有三类，且都不是「模型不聪明」：

### D-1 列表 / 聚合问题没有工具入口（Major，2 条）

| 用例 | 提问 | 模型实际做了什么（按事件表 seq） | 结果 |
|---|---|---|---|
| `entry-batch-recent` | 最近有哪些订单 | `search_orders` 首次调用无有效参数 → `AGENT_TOOL_ARGUMENT_INVALID`；`search_documents(q="订单")` → 0 条；`search_orders(q="SO")` → 0 条；`search_documents(q="SO")` → 0 条 | 4 次调用、1 次参数非法、3 次 0 行，回答「查不到」 |
| `entry-batch-status-filter` | 有哪些订单已经确认了 | `search_documents(q="已确认")` → 0 条；`search_orders` 无有效参数 → `AGENT_TOOL_ARGUMENT_INVALID`；`search_documents(q="订单")` → 0 条 | 3 次调用、1 次参数非法、2 次 0 行，回答「查不到」 |

证据：run `15c80185-e967-469d-aeac-2210deb4c869` 的 `agent_run_events` 依次是
`search_orders(failed:AGENT_TOOL_ARGUMENT_INVALID)` → `search_documents(q=订单,completed)` →
`search_orders(q=SO,completed)` → `search_documents(q=SO,completed)`，三次成功调用的 `source` 事件一条都没有。

**根因**：31 个 operation 全部以「一张已知单据」为输入，没有一个 operation 是「列出 / 按条件筛」。模型手里只有检索工具，
于是把「已确认」「最近」当成检索词塞进 `search_documents`——那个工具只做单号与所属销售单号的 `ILIKE` 匹配，当然 0 行。

**这是工具面缺口，不是模型误用**：提问方式完全正常（人想「最近有哪些单」是最自然的问法），是工具目录没给它这个动作。
修法在 P1：补 `list_documents`（带状态、客户、日期、分页），或把 `search_documents` 的 `q` 拆成结构化筛选。

### D-2 跨单聚合被根查询守卫挡掉（Major，1 条）

`relation-cross-low-stock`「哪些物料库存不足」：模型先调 `get_raw_material_balance`（正确直觉），被
`ORDER_SEARCH_REQUIRED` 拒——因为它是"以订单为根"的 operation；随后退化成 `search_documents(q="库存不足")`，0 行。
证据：run `0b42af37-c80c-4790-99ea-fa403b09c8f4` 的第 3–7 条事件就是这个顺序，`tool_args` 里只有 `{"q":"库存不足"}`。

**根因与 D-1 同源**：所有查询都挂在订单根上，而「库存不足」是一个跨单的、无根的问题。守卫的报错信息还把模型引向了错误方向
（"请先 search_documents"），而不是告诉它"这个能力不存在"。

### D-3 第二轮句柄失效，模型靠重新检索兜回来（Medium，2 条）

`followup-production-then-reports`、`followup-purchase-then-inspection` 各出现一次 `ORDER_REF_INVALID`。

句柄 `o_1` 只在本轮有效（`agent-orchestrator.ts` 的 `searchRefs` 按 run 清空）。第二轮追问时模型沿用上一轮的 `o_1`，
被守卫拒绝后自行重新 `search_documents`——所以最终答对了，但多花了一次模型轮次与一次工具调用。

**这不是 bug，是设计代价**：句柄按轮失效防了串用，代价是每轮多一次检索。要动它得先想清楚跨轮句柄的安全边界（P1 议题）。

### 不是缺陷的两条

- `miss-cross-forged-ref` 的 `ORDER_REF_INVALID` 是**守卫按设计生效**：伪造句柄 `o_99` 没有触达数据库，模型也如实解释了。
- `miss-unknown-long-garbage` 的 `AGENT_TOOL_ARGUMENT_INVALID` 是 `q` 超过 100 字符上限被拒，模型自纠为 `q="MOCK"` 后给出正确答案。
  长度上限本身合理，但它以 400 错误的形式出现，模型必须花一个轮次才能读懂。

### 对 P1 的直接影响

| 优先级 | 改动 | 依据 |
|---|---|---|
| 1 | 列表 / 按条件筛选的 operation（或把检索拆成结构化筛选） | D-1 两条 + D-2 一条，都是"提问正常、工具没有" |
| 2 | 跨单聚合的独立入口（不挂在订单根上） | D-2 |
| 3 | 无根 operation 的拒绝信息改为「该能力不支持无单据提问」，而不是「请先检索单号」 | D-2，报错把模型带偏 |
| 4 | 服务端单号归一（空白 / 全角 / 大小写） | 现在全交给模型，换模型版本就会变 |

**这份基线不能当成"已完成"的证明**：它证明的是链路通、单据能定位、守卫有效；它同时暴露了"列表与聚合类提问在当前工具目录下必失败"。
下一轮衡量改进就看两组数：通过率保持 100% 的同时，`工具调用失败率` 从 11.5% 往下走；以及新增的列表 / 聚合用例从红转绿。
