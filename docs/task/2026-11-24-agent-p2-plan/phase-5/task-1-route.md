# 任务 1：`/agent` 接管页面与导航

<task-brief>

## 1. 在哪里

- **阶段 5 顾问换外壳**：从旧路径进入即到新页面，行为等价。
- **本任务推进 R-8**：页面搬到 `/agent`，导航与门禁认新路径。行为不变。
- **开工前提**：无。**后续**：任务 2、任务 4。

## 2. 要知道的

**先读**

- `apps/web/app/business-query/page.tsx`：要搬的页面全部内容。
- `apps/web/lib/surface-permission.ts`：路径与栏目在哪两处对应。
- `apps/web/components/layout/app-shell.tsx`：导航项与 `data-layout="fixed"` 的判断。
- `apps/web/test/testid-pages.test.ts`：新页面要登记什么。

**已定**

- 只改前端路由。接口路径 `/business-query/*`、栏目键 `business-query`、页内 `business-query-*` testid 都不动。
- 用 `git mv`；组件改名 `AgentPage`；根节点 testid 改 `page-agent`；搬过来的文件删掉所有散文注释。

**边界与接缝**

- 动 `app/`、`surface-permission.ts`、`app-shell.tsx` 与引用旧页面路径的测试。接缝：现有组件测试与 lib 测试。

**运行**

- `npm run test:unit --workspace=@dilee/web`，然后 `npm run typecheck`。

**可能卡住**

- 测试里 `"/business-query/sessions"` 一类是**接口路径**，不要替换。分不清就停下上报。
- 除下表列出的路径与 testid 外，有现有断言必须改才能绿：停下上报。

## 3. 步骤

1. 读上面四个文件，用一行复述任务。
2. 先改测试到新期望（下表），跑一次，看到变红。
3. `git mv` 页面到 `apps/web/app/agent/page.tsx`，改名与根 testid，删注释。
4. `surface-permission.ts`：`SECTION_PATHS` 与 `SECTION_BY_PREFIX` 两处改为 `/agent`，旧前缀删掉。
5. `app-shell.tsx`：导航 href 改 `/agent`；固定布局条件改为 `pathname === "/agent" || pathname.startsWith("/agent/")`。
6. 跑单测与类型检查。
7. 提交：`feat(agent): /agent 接管顾问页面与导航`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `sectionOfPath("/agent")`、`sectionOfPath("/agent/x")` | 都是 `business-query` | lib 测试 |
| 2 | `sectionOfPath("/agentx")` | `dashboard` | lib 测试 |
| 3 | `SECTION_PATHS["business-query"]` | `/agent` | lib 测试 |
| 4 | AppShell 在 `/agent`，账号有顾问栏目 | `app-main` 带 `data-layout="fixed"`；`nav-link-agent` 的 href 是 `/agent` | `app-shell.test.tsx` |
| 5 | 两份现有页面测试改为渲染 `app/agent/page` | 全绿，根节点是 `page-agent`；`testid-pages` 登记 `agent/page.tsx` | 组件测试 |

</task-brief>
