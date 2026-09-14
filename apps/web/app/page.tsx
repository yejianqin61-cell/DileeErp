// S6：页面根节点需要稳定的 E2E 定位钩子；这里不再直接 re-export，
// 而是用一层 .page-root 包装保留本页的 page-dashboard 钩子（视觉间距由 globals.css 的 .page-root 规则补齐）。
import WorkbenchPage from "./workbench";

export default function DashboardPage() {
  return (
    <div className="page-root" data-testid="page-dashboard">
      <WorkbenchPage />
    </div>
  );
}
