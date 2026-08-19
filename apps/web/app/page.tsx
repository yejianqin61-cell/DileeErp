import { Badge } from "../components/ui/badge";
import { DemoNotice, EmptyState } from "../components/feedback/states";

export default function HomePage() {
  return <><div><Badge>演示环境</Badge><h1>迪礼 ERP</h1><p style={{ color: "var(--text-muted)" }}>厂内业务系统框架已就绪。</p></div><DemoNotice /><section className="panel"><EmptyState title="工作台即将搭建" description="订单推进、生产进度和应收应付将在后续任务中加入。" /></section></>;
}
