// 销售一级页：3 个板块入口（成品出库总览 / 客户池 / 销售单）。
// 实现放在 components/sales/sales-board-index.tsx，这里只做路由装配。
import SalesBoardIndex from "../../components/sales/sales-board-index";

export default function SalesPage() {
  return <SalesBoardIndex testId="page-sales" />;
}
