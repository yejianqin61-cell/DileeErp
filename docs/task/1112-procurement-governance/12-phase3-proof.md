# 12 — Phase 3 的证明：两个页面各走一遍

## 1. Where this task sits

- **Phase 3 让界面把出路递到手上**, and this is its proof task.
- **This task moves R-4 「这份 BOM 已有计划」时的补料出路要在界面上说清楚 and R-5 采购单详情页要有行级退回入口** to *proven*：两页的 jsdom 用例覆盖各自的验收项。
- **Starts after**: `10 采购单详情页每行加「退回这一行」`, `11 计划列表里完成态计划加补料提示`.

## 2. What the developer needs to know

**Read first**

- `apps/web/test/procurement-orders.test.tsx`（或同类）— 采购单详情页现在怎么被驱动、`stubApi` 怎么给详情接口回数据。
- `apps/web/test/procurement-plans.test.tsx` 的 `stubList()` 与 `planSummary()` — 计划列表的桩，已支持传 `status`。
- `apps/web/test/helpers/api-stub.ts` — `apiOk(data, meta)` 带第二参数，`apiErr(status, code, message)` 造失败。

**Settled**

- 证明在**页面层**，不新起 seam；不进真实后端（本地没有库）。
- 两条验收项各至少一条用例：行级退回按钮的出现条件 + 完成态计划的补料提示。
- 已有用例不许为了让新用例通过而放宽。

**Edges and seam**

- Touches 两个 web 用例文件。
- Leaves 生产代码不动：若必须改代码才能过，说明 `10`/`11` 漏了东西，回去改那两个任务。

**Run**

- `npm run test:unit --workspace=@dilee/web`
- `npm run typecheck`

**Unknowns**

- 计划页的新建弹窗与行级按钮都可能要 `await` 动画帧；用 `findBy*` 而不是 `getBy*` 等首帧。

## 3. The workflow

1. 读三个入口，用一句话复述。
2. 补详情页的两条（按钮出现条件、提交打到哪个路径）。
3. 补列表页的两条（完成态有提示、部分下单没有）。
4. 跑全量 web 用例与 typecheck。
5. 记录数字。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 详情页：一行有到货、一行没有 | 只有零到货那行有「退回这一行」 | 详情页 |
| 2 | 详情页：点按钮、填原因、提交 | 请求路径与 body 正确 | 详情页 |
| 3 | 列表页：`completed` | title 含补料提示 | 计划列表 |
| 4 | 列表页：`partial` | title 不含补料提示 | 计划列表 |
