import type { ReactNode } from "react";
import { Badge } from "../ui/badge";

/**
 * 「孤立」标记（2026-11-03，用户：「采购单及其后续绑定的单据不删，而是显示孤立单据」）。
 *
 * 销售单被软删后，它下游的采购单 / 生产单 / 成品出库单 / 应收来源…**一张都不删、也不解绑**，
 * 只是父单没了。用户要在这些列表里一眼看出「这张单据的销售单已经不在了」，
 * 否则会把它当成一张正常在途的单据继续跟。
 *
 * 判定只有一处来源：后端每一行的 `orphaned` 布尔字段（= 父销售单 `deleted_at` 非空）。
 * **不要**在前端按「单号还查不查得到」推断 —— 删除后同一单号可以被新单重新使用，
 * 那种推断会把旧下游单据错误地挂到新单上（设计文档 §2 的边缘情况）。
 *
 * 视觉复用全站既有的 `.ui-badge` + `.status-warning`（与其它状态徽章同一套配色），
 * 不为它另起一套样式。
 */
export function OrphanBadge() {
  return <Badge className="status-warning orphan-badge" title="所属销售单已被删除：这张单据原样保留，成为孤立单据" data-testid="orphan-badge">孤立</Badge>;
}

/**
 * 单号 + 可能跟在后面的「孤立」标记。
 *
 * 各列表的单号列共用这一个组件，而不是每处各写一遍 `<span>{no}</span>{orphaned && <OrphanBadge/>}` ——
 * 文案、间距与判定口径都只有一份，将来改文案不会漏掉某个列表。
 */
export function OrderNoWithOrphan({ orderNo, orphaned }: { orderNo: ReactNode; orphaned?: boolean }) {
  return <span className="order-no-with-orphan"><span className="order-no-with-orphan-text">{orderNo}</span>{orphaned ? <OrphanBadge /> : null}</span>;
}
