# T10 导航 tab 与表面权限栏目

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §四.1
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

无。可与 [T01](./01-sales-order-item-no-schema.md)、[T07](./07-reorder-articles-api.md) 并行；
[T11](./11-reorder-page.md) 依赖它（页面要进得去）。

## 目标

左侧导航出现 **「返单与总结」→ `/reorder`**，并且**谁能看到它**由表面权限决定（老板/财务/其他能看，人事看不到）。

## 关联决策

- 设计文档 §四.1：**单开一个表面栏目 `reorder`**，而不是塞进 `/sales`。
  理由：它是跨模块只读页（采购+生产+QC+仓库+财务都出现），归到"客户与销售"名下会让
  「其他」角色以为它只是客户的附属页；而栏目表是**代码里的表**，加一节零迁移成本。
- 人事范围（`hr`）**不加** `reorder`：人事的规则是"只能访问人事页面及其下属页面"。

## 范围与非范围

**范围**

- 后端 `surface-scope.ts`：`SURFACE_SECTIONS` 加 `reorder` + `SECTIONS_BY_SCOPE.general` 显式加。
- 前端 `surface-permission.ts`：四处表同步。
- `app-shell.tsx`：导航项。
- 两侧测试同步。

**非范围**

- 不动数据库（表面权限是纯代码表，`surface_sections` 由 `/auth/me` 现算下发）。
- 不动角色与模块权限（`ModulePermissionGuard`、迁移 `20260919160000` 那套"所有角色等同管理员"不变）。
- 不做页面内容（[T11](./11-reorder-page.md)）。本任务落地后 `/reorder` 还是 404，
  这是**故意的**：先让导航与权限对齐，页面随后进；若要避免出现"点了没东西"的空窗，
  可以把 T10 与 T11 放在同一个提交里。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/platform/authorization/surface-scope.ts` | `SURFACE_SECTIONS` 在 `"sales"` 之后插 `"reorder"`；`SECTIONS_BY_SCOPE.general` 加 `"reorder"` |
| `apps/web/lib/surface-permission.ts` | `SURFACE_SECTIONS`（**顺序必须与后端一致**）、`SECTION_LABELS`（`返单与总结`）、`SECTION_PATHS`（`/reorder`）、`SECTION_BY_PREFIX`（`["/reorder", "reorder"]`，放在 `/sales` 之后、`/customers` 之前即可，前缀不重叠） |
| `apps/web/components/layout/app-shell.tsx` | `navigation` 数组在「客户与销售」之后加 `["返单与总结", "/reorder", History]`（图标从 `lucide-react` 取 `History`） |
| `apps/api/test/unit/surface-scope.test.cjs` | 增补 |
| `apps/web/test/app-shell.test.tsx` | 导航清单同步 |
| `apps/web/test/account-center.test.tsx` | 按需同步（权限范围文案里会出现新栏目名） |

## 实施要点

- **顺序即渲染顺序**：`SURFACE_SECTIONS` 在两个 workspace 里各有一份，
  两边的顺序决定「账号中心」里那句话的栏目罗列顺序。放错位置不会报错，只会让两句话不一致——
  既有注释（`surface-permission.ts` 顶部）已经写明"顺序也一致"，照它做。
- `SECTIONS_BY_SCOPE.full = SURFACE_SECTIONS`（自动包含），**只有 `general` 要显式加**；
  `hr` 不要加。加错到 `hr` 会让"只能看人事"的角色看到全公司的采购/生产/QC 汇总——
  这是权限面最容易犯的错，改完请**手工看一眼** `surface-scope.ts` 的三行。
- `surfaceScopeOf()` 的判定只看 `finance` / `hr` 两个键，**不受**新增栏目影响，不要顺手改它。
- 导航项用 `data-testid` 的既有规则自动生成（`nav-link-` + 去掉斜杠的路径），
  所以新项的 testid 是 `nav-link-reorder`，**不用手写 testid**。
- `app-shell.test.tsx` 里那份 `NAV_ITEMS` 清单是**逐项写死**的（约 `:24-33`），
  新项要插在「客户与销售」与「报表与告警」之间；同时检查该文件里"按权限过滤后可见项"的用例
  （老板/财务/其他 应该看到 10 项，人事看到 2 项——数量会变，按真实行为同步）。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 老板/财务（`full`）能看到 `reorder` 栏目 | `unit/surface-scope.test.cjs` |
| 2 | 其他（`general`）能看到 | 同上 |
| 3 | **人事（`hr`）看不到** | 同上 |
| 4 | 栏目顺序：`reorder` 在 `sales` 之后 | 同上（两端各一条，顺序一致） |
| 5 | `/reorder` 与 `/reorder/articles/x` 都归到 `reorder` 栏目 | `apps/web` 侧 `sectionOfPath` 用例（`/sales-xxx` 不能误判成 `reorder`，反之亦然） |
| 6 | 导航渲染出新项、`href="/reorder"`、testid 为 `nav-link-reorder` | `app-shell.test.tsx` |
| 7 | 人事登录后菜单里没有这一项 | 同上（按现有"权限过滤"用例形状） |

命令：`npm run typecheck` → `npm run test:unit:api` → `cd apps/web; npm run test:unit`。

## 决策记录

- **单开栏目而不是挂 `/sales`**：见「关联决策」。
- 若用户改主意要挂到 `/sales/reorder`：只需去掉栏目表那四处改动、把导航项路径改掉，
  本任务其余产物（测试同步）都要跟着回退——**这是一个一次性选择，定了就别来回改**。

## 完成记录

（认领后填写。）
