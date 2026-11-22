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