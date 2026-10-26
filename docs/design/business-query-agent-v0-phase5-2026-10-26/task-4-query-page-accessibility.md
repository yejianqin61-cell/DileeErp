## 1. Where this task sits

- **Phase 5 用户恢复体验与异常闭环**：查询页在键盘、状态与长答案下可使用。
- **本任务推进 R-10 查询页状态机**：收口页面可读性与可操作反馈。
- **开始于** T3 的终态呈现。**后续等待它**：端到端验收。

## 2. What the developer needs to know

**Read first**

- `app/business-query/page.tsx` — 输入、取消、进度、来源和历史 run 的页面结构。
- `components/ui/textarea.tsx` — 键盘输入的原生语义。
- `components/feedback/states.tsx` — loading/error 的统一呈现。
- `test/testid-pages.test.ts` — 页面稳定定位规则。
- `business-query-state.ts` — 页面可展示的 phase 与错误。

**Settled**

- Enter 提交，Shift+Enter 换行；取消按钮可键盘操作。
- 状态、错误和工具进度使用可读文本，不展示原始参数。
- 长答案保留换行且不横向截断。

**Edges and seam**

- 触及查询页与组件测试；不改全局设计系统。
- 缝是 `BusinessQueryPage` 渲染结果。

**Run**

- `npm run test:components --workspace=@dilee/web`。
- `npm run typecheck --workspace=@dilee/web`。

**Unknowns**

- 若组件测试运行时间超出执行窗口，记录其状态，不把未完成当通过。

## 3. The workflow

1. 阅读第 2 部分并复述：页面须让键盘用户看懂并控制 run。
2. 为键盘、状态提示、来源和长答案写失败用例。
3. 用现有组件和语义属性修复最小页面缺口。
4. 检查页面稳定 test id。
5. 回归组件测试与 web typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | Enter | 提交且阻止默认换行 | textarea |
| 2 | Shift+Enter | 保留换行 | textarea |
| 3 | 活动 run | 取消控件可见且可点击 | 页面渲染 |
| 4 | 长答案 | 保留文本换行 | 页面渲染 |
| 5 | 错误提示 | 有 alert 语义 | 页面渲染 |
