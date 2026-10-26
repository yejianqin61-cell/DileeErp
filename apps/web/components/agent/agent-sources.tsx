import { FileText } from "lucide-react";
import type { QuerySourceView } from "../../lib/business-query-state";
import { sourceLabel, sourceTypeLabel, uniqueSources } from "../../lib/agent-sources";

/**
 * 回答来源（单据引用）。来源是后端从工具结果生成的，不是模型自报；
 * 这里只做去重与展示，点不动（还没有单据深链接口，不做好像能跳的假按钮）。
 */
export function AgentSources({ sources }: { sources: QuerySourceView[] }) {
  const visible = uniqueSources(sources);
  if (visible.length === 0) return null;
  return <div className="agent-sources" data-testid="business-query-sources" aria-label="回答来源">
    <span className="agent-sources-label">来源</span>
    {visible.map((source, index) => <span className="agent-source" key={`${source.business_type}:${source.business_no}:${index}`} title={`${sourceTypeLabel(source.business_type)}：${source.business_no}`}>
      <FileText size={11} aria-hidden="true" />{sourceLabel(source)}
    </span>)}
  </div>;
}
