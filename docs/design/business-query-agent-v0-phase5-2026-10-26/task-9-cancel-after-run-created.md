## 1. Where this task sits

- **Phase 5 用户恢复体验与异常闭环**：用户取消必须落到稳定终态。
- **本任务推进 R-7 持久状态与幂等**：只在已有服务端 run 时开放取消。
- **开始于** Task 8 浏览器复核。**后续等待它**：Phase 5 完成审计。

## 2. What the developer needs to know

**Read first**

- `apps/web/app/business-query/page.tsx` — 提交、run ID 与取消入口的先后关系。
- `tests/e2e/business-query-recovery.spec.mjs` — 用户可见取消终态的失败证据。
- `apps/web/lib/business-query-state.ts` — `submitting` 与 `connecting` 的状态含义。

**Settled**

- 浏览器不能取消尚未由服务端创建的 run。
- 用户不丢提问；请求失败仍由既有草稿回填处理。

**Edges and seam**

- 触及查询页的取消入口。保留 API、reducer 和流协议。

**Run**

- `npx playwright test tests/e2e/business-query-recovery.spec.mjs`
- `npm run typecheck --workspace=@dilee/web`

**Unknowns**

- 若 run ID 已写入仍不能取消，停止并检查 API 状态迁移。

## 3. The workflow

1. 阅读第 2 部分并复述：取消只针对已创建的 run。
2. 保留现有浏览器取消失败作为红色证据。
3. 在取消入口增加最小的 run ID 前置条件。
4. 运行浏览器套件，确认取消落到“已取消”。
5. 运行 Web 类型检查。
6. 提交本任务。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 提交后立即可见的取消 | 取消最终显示“已取消” | 查询页 |
| 2 | run 尚未创建 | 页面不提供无效取消 | 查询页 |
| 3 | 已创建活动 run | 取消请求仍能发送 | 查询页 |
