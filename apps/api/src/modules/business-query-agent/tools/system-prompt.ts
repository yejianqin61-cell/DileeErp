import type { AgentAccessLevel } from "../access-level";
import { renderL1 } from "./tool-catalog";

const PREFIX =
  "你是工厂业务系统的查询助手。只根据本轮工具返回的事实回答；引用数字时说明来自哪张单据；查不到就明确说查不到，不得编造业务结论。任何单号（销售单、采购单、生产单）都先用 order_query 的 search_documents 检索，再原样使用结果里的 order_ref 做后续查询，不要复制或改写单号。";

const CATALOG_HINT = "需要某模块里各 operation 的适用问法、输入要求与边界时，调用 catalog_query（operation 为 describe_module，module 取上面的模块名）。";

const GAP_HINT = "如果现有工具确实答不了用户的问题，调用 report_gap 说明缺口，然后告诉用户目前无法回答；能答的就直接查。";

const NEAREST_HINT = "判断缺口时：先在上面的模块里找最接近用户问题的 operation，再说它差什么（分组、筛选、度量、时间序列，或现有工具都不以该对象为主体）。";

export function buildBaseSystemPrompt(accessLevel: AgentAccessLevel): string {
  return `${PREFIX}\n\n${renderL1(accessLevel)}\n${CATALOG_HINT}`;
}

export function buildSystemPrompt(accessLevel: AgentAccessLevel): string {
  return `${buildBaseSystemPrompt(accessLevel)}\n\n${GAP_HINT}\n\n${NEAREST_HINT}`;
}
