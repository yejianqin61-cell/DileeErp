// 工资管理（/finance/salary）：只提供「工资台账」与「工资付款」两个功能入口。
//
// 功能全部在二级页面里（/finance/salary/ledger、/finance/salary/payments）：
// 工资管理页自己不再拉任何数据，因此打开即秒开，也不会因为「进错页」而触发按月导入写库。
import Link from "next/link";
import { PageHeader } from "../../../components/layout/app-shell";
import { SALARY_SECTIONS } from "../../../lib/finance-sections";

export default function FinanceSalaryPage() {
  return <div className="page-root finance-page" data-testid="page-finance-salary">
    <PageHeader title="工资管理" />
    <div className="board-grid" data-testid="salary-section-grid">
      {SALARY_SECTIONS.map((section) => <Link key={section.key} href={section.href} className="board-card" data-testid={`salary-section-${section.key}`}>
        <h2>{section.title}</h2>
        <span className="board-enter">进入 →</span>
      </Link>)}
    </div>
  </div>;
}
