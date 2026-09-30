// 客户栏目（独立授权）的落地页：渲染与 `/sales/customers` 同一个客户池组件，
// 只是页面根 testid 用本路由自己的 `page-customers`（两页口径只有一份）。
import CustomerPool from "../../components/sales/customer-pool";

export default function CustomersPage() {
  return <CustomerPool testId="page-customers" />;
}
