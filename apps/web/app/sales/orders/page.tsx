// 销售二级页：销售单列表。
// ⚠️ 与 `/sales/orders/new`、`/sales/orders/[id]/edit` 是**同级**路由：静态段 `new` 不会被这一页吃掉
// （Next 的路由优先级里静态段高于本页，本页只处理 `/sales/orders` 本身）。
import SalesOrdersList from "../../../components/sales/sales-orders-list";

export default function SalesOrdersPage() {
  return <SalesOrdersList testId="page-sales-orders" />;
}
