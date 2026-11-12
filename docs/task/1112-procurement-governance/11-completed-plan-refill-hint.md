# 11 — 计划列表里完成态计划加补料提示

## 1. Where this task sits

- **Phase 3 让界面把出路递到手上**.
- **This task moves R-4 「这份 BOM 已有计划」时的补料出路要在界面上说清楚** 的另一半：新建弹窗已经会说（Phase 1），列表里那份**已经完成的计划**自己也要说明「还能在这里加行」。
- **Starts after**: `04 计划页渲染原因`. **Waits on it**: `12 Phase 3 的证明`.

## 2. What the developer needs to know

**Read first**

- `apps/web/app/procurement/plans/page.tsx` 的 `planSummaryTitle()` — 计划级汇总挂在「计划编号」那一格的 `title` 上，明细列里没有计划级列（口径 7）。补料提示走同一条通路。
- 同文件 `STATUS_TABS` 与 `statusLabel` — `completed` 的文案是「已完成」。
- `apps/api/src/modules/procurement/purchase-plans.service.ts` 的 `remove()` — 有已下单行的计划**删不掉**（422），所以「重建一份」这条路不存在；加行是唯一出路。

**Settled**

- 提示挂在 `title` 上，不新增列（1366px 的列宽预算已经用完）。
- 只在 `status === "completed"` 时出现；`partial` 不需要（它本来就还有未下单行）。
- 措辞必须给出动作：「补料请在这份计划里加一行」，不是「已完成的计划不能改」。

**Edges and seam**

- Touches `plans/page.tsx` 的 `planSummaryTitle()`。
- Leaves 表格列、筛选 tab、详情 Sheet 不动。

**Run**

- `npm run test:unit --workspace=@dilee/web`

**Unknowns**

- `title` 是被测断言过的（`expect(title).toContain("未下单 1 / 共 2 行")`）；加句子不能改动已有那几段，否则老用例变红而原因是"文案被重写"。

## 3. The workflow

1. 读三处入口，用一句话复述。
2. 在 `planSummaryTitle()` 末尾按状态追加一句。
3. 跑 web 用例。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `completed` 的计划 | title 里出现「补料请在这份计划里加一行」 | 计划列表 |
| 2 | `partial` 的计划 | title 里没有那句话 | 计划列表 |
| 3 | `completed` 的计划 | title 里原本那三段仍在 | 计划列表 |
