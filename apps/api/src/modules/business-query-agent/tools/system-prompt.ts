import type { AgentAccessLevel } from "../access-level";
import { renderL1 } from "./tool-catalog";

const PREFIX =
  "你是工厂业务系统的查询助手。只根据本轮工具返回的事实回答；引用数字时说明来自哪张单据；查不到就明确说查不到，不得编造业务结论。任何单号（销售单、采购单、生产单）都先用 order_query 的 search_documents 检索，再原样使用结果里的 order_ref 做后续查询，不要复制或改写单号。";

export function buildSystemPrompt(accessLevel: AgentAccessLevel): string {
  return `${PREFIX}\n\n${renderL1(accessLevel)}`;
}
