# 2026-11-12 采购治理 R1：选不到 BOM / 改一行要退一整单 / 规则不可见

## 改了什么

三条现场问题对应两组补丁，四个阶段：

| 阶段 | 落点 | 关键提交 |
| --- | --- | --- |
| Phase 1 | 候选可解释 + closed 单可建计划 | `feat(procurement): 候选分类抽成纯函数并配原因码`、`feat(procurement): 候选接口返回可建与被拦两半` |
| Phase 2 | 行级退回 | `feat(procurement): 行级退回 —— 只退一行，不必整批回退`、`feat(procurement): 行级退回的 HTTP 入口` |
| Phase 3 | 界面上的入口与提示 | `feat(web): 采购单详情页每行加「退回这一行」`、`feat(web): 完成态计划在标题提示补料往哪加一行` |
| Phase 4 | 口径与文档收口 | 本节所在的提交 |

口径变更记在设计文档 `docs/design/purchase-plan-and-supplier-collapse-2026-09-27.md` §11。

## 为什么是这样改

审计（`docs/audit/procurement-audit-2026-11-12.md`）把三条问题追到了四处实现：

1. `candidates()` 把三层过滤写进 `where` —— 不可建的 BOM 从结果里**消失**，界面上只剩空下拉。
   这就是"业务规则不明确"的结构性成因：不是文案问题，是接口不返回原因。
2. `remove()` 在有已下单行时拒绝删计划，而 `purchase_plans_bom_id_active_key`（`bom_id WHERE deleted_at IS NULL`）
   一直占着 —— 两者相乘把这张 BOM 锁进**永久不可选**的闭环。"有时候选不到"的真正解释。
3. `loadBom()` 与 `candidates()` 各写了一遍 `status: "confirmed"`；而 `loadBomForRevert()` 早已明确
   "不看销售单状态"。同一件事两份口径，close 掉销售单之后候选里没有、保存时会 404。
4. 退回只有整张单一个粒度，且要求**整单零到货** —— "这 100 个只要 80"没有任何出口。

## 没有改的

- **口径 7**（数量/单价的唯一编辑点是计划）一字未动。行级退回的落点仍是计划行。
- `PATCH /purchase-orders/:id` 的明细只读黑名单没动（老客户端仍拿到那句人话）。
- `loadBomForRevert()` 的宽松口径没动。
- 已完成的计划**仍然删不掉** —— 这是有意的（删计划=抹掉采购线入口），现在的出口是"在这份计划里加一行"，
  而且界面会说出来。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（三 workspace） | 绿 |
| 采购相关 API 单测（9 个文件） | 246/246 |
| `apps/api/test/unit/purchase-plans-service.test.cjs` | 102/102 |
| web 全量单测 | 76 文件 / 1322 条全绿 |
| 真实数据库 / e2e | 未跑（本地无库） |

## 已知欠缺

- 行级退回没有行锁（与既有整单退回一致）；两人同时退同一行只靠自然幂等。
- 部分到货的单：其余行有到货时重新下单会**新建**一张（`findMergeTarget` 要求整单零到货），单号会变。
- 计划页的被拦原因最多摆三条，没有"查看全部"。
- BOM 工作台改 BOM 之后对已下单明细的影响仍只有摊回逻辑兜底，界面无提示。
