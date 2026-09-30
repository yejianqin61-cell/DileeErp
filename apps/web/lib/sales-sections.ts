// 销售一级页的板块清单（纯数据模块，**不要**加 "use client"）。
//
// 为什么把清单单独放一个文件：与 `lib/finance-sections.ts` 同一条理由 —— 一级页（卡片入口）
// 与二级页（页面标题/面包屑/门禁）都要知道「有哪几个板块、各自叫什么」，
// 在组件里再抄一份的下场是「卡片上叫一个名字、页面标题叫另一个」。
//
// 与财务那套的差别：这里的板块是**三个各自独立的数据页面**（成品总览 / 客户池 / 销售单），
// 没有财务那种「同一页面里再分标签」的第三层，所以只需要一张清单，不需要 TAB 表。

/** 销售二级页的板块键（= 路径最后一段，`/sales/<key>`）。 */
export type SalesBoardKey = "finished-goods" | "customers" | "orders";

export type SalesBoard = {
  key: SalesBoardKey;
  title: string;
  /** 卡片上一句话说明这个板块回答什么问题。 */
  description: string;
};

export const SALES_BOARDS: readonly SalesBoard[] = [
  { key: "finished-goods", title: "成品出库总览", description: "全部成品数 / 已出库数 / 未出库数，按产品与单位分行（不同单位不做合计）。" },
  { key: "customers", title: "客户池", description: "客户主数据与联系人：搜索、新建、编辑、停用、删除。" },
  { key: "orders", title: "销售单", description: "销售单列表：确认与回退、导出工艺单（可勾选带物料图片）、通知仓库出库。" },
];

/** 板块 → 二级页路径。`/customers` 是另一个路由壳（客户栏目单独授权），不在这张表里。 */
export function salesBoardPath(key: SalesBoardKey): string {
  return `/sales/${key}`;
}
