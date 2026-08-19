import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "../layout/app-shell";
import { DemoNotice, EmptyState } from "../feedback/states";
import { Button } from "../ui/button";
import { getModulePlaceholder } from "../../lib/adapters/module-adapter";

export async function ModulePlaceholder({ name }: { name: string }) {
  const module = await getModulePlaceholder(name);
  if (!module) return <EmptyState title="模块不存在" />;
  return <><PageHeader title={module.name} description={module.responsibility}><Button variant="secondary">主操作占位 <ArrowRight size={15} /></Button></PageHeader><DemoNotice /><section className="module-placeholder-grid"><section className="panel"><div className="panel-heading"><h2>建议首屏</h2><span className="panel-note">待负责人确认</span></div><div className="panel-body"><EmptyState title={`${module.name}列表占位`} description="列表字段、筛选条件和主操作将在模块访谈后确认。" /></div></section><section className="panel"><div className="panel-heading"><h2>访谈重点</h2></div><div className="panel-body"><p>{module.focus}</p><p className="module-note">当前页面只用于讨论信息层级，不代表最终业务规则。</p></div></section></section><Link className="back-workbench" href="/">返回工作台</Link></>;
}
