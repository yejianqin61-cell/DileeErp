# P2 阶段 5：顾问换外壳

计划：[P2 施工计划 v1.6](../plan.md) 阶段 5。设计：[P2 设计 v1.6](../../../design/dilee-consultant-p2-tool-catalog-2026-11-24.md) §6.2、§6.3、§7.1。

**这一批只换路径、加本地缓存。** 目标：从旧路径进入即到新页面，断线续接与历史切换行为等价；
再次打开时先出本地内容，再用服务端快照覆盖。没有新体验特性，后端一行不改。

覆盖需求：R-8、R-11。

## 任务

| # | 任务 | 产物 | 依赖 |
|---|---|---|---|
| 1 | [`/agent` 接管页面与导航](task-1-route.md) | `app/agent/page.tsx`、导航、表面权限 | — |
| 2 | [旧路径 308 重定向](task-2-redirect.md) | `next.config.ts` | 1 |
| 3 | [缓存读写与档位拦截](task-3-cache.md) | `agent-cache.ts`、`agent-cache-idb.ts` | — |
| 4 | [冷启动先出缓存再对账](task-4-cold-start.md) | 顾问页 | 1、3 |
| 5 | [失败、撤权、退出与回填](task-5-invalidate.md) | 顾问页、`app-shell.tsx` | 4 |
| 6 | [浏览器端到端迁移](task-6-e2e.md) | `business-query-recovery.spec.mjs` | 2、5 |

按序做：1 → 2 → 3 → 4 → 5 → 6。

## 本批已定（实施者不得重开）

| 决定 | 内容 | 出处 |
|---|---|---|
| 财务档缓存 | `access_level` 为 `full` 的轮次**永不写本地**；读取处仍按当前档位过滤一次 | 用户 2026-11-26 |
| 补差量 | **不改后端**。先显示缓存，再拉完整会话快照覆盖；进行中的轮次照旧从快照 `latest_seq` 续接 SSE | 用户 2026-11-26 |
| 权威 | 服务端是唯一真源；缓存只从服务端快照写入，从不回写 | 设计 §7.1 |
| 缓存范围 | 每个用户一份，只存最后一次读到的那个会话，只存终态轮次 | 本批决定 |
| 退出登录 | 清空本地缓存 | 本批决定 |
| 依赖 | 不新增 npm 依赖，直接用浏览器 IndexedDB | 本批决定 |
| 不改的名字 | 接口路径 `/business-query/*`、栏目键 `business-query`、页内 `business-query-*` testid、reducer 与信封 | 设计 §6.3 |
| 页面根 testid | `page-agent` | `testid-pages.test.ts` 的命名约定 |
| 注释 | 新写和搬动的代码不留散文注释（含搬到 `app/agent/` 的页面文件） | 设计 §7.2 |

## 命令（仓库根目录执行）

```bash
npm run typecheck
npm run test:unit --workspace=@dilee/web
```

基线（阶段 4 结束时）：web lib 460、web 组件 1439，全绿。

本批不搬 chat-demo 的文件，不需要 MIT 许可头。不要读取或复制任何 `.env`。
