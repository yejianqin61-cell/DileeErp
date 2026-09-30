// 销售二级页：客户池。
//
// 为什么在 `/sales/customers` 之外还留着 `/customers`：两个路由属于**两个不同的表面栏目**
// （`sales` 与 `customers`，见 lib/surface-permission.ts）—— 只被授权「客户」的人进 `/customers`，
// 只被授权「客户与销售」的人进这一页。两处渲染同一个组件，口径只有一份。
import CustomerPool from "../../../components/sales/customer-pool";

export default function SalesCustomersPage() {
  return <CustomerPool testId="page-sales-customers" />;
}
