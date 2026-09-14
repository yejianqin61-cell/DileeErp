// S6：/customers 复用销售页实现；这里不再直接 re-export，
// 而是用一层 .page-root 包装补上本路由自己的 page-customers 钩子。
import SalesPage from "../sales/page";

export default function CustomersPage() {
  return (
    <div className="page-root" data-testid="page-customers">
      <SalesPage />
    </div>
  );
}
