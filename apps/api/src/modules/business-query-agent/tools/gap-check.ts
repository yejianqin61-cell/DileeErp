import type { AgentAccessLevel } from "../access-level";
import { splitNeededFields } from "./gap-fields";
import type { GapDeclaration } from "./report-gap";
import { candidateOperations, describeModule } from "./tool-catalog";

export type ExecutedOperation = { operation: string; rows: number };

export type AcceptedGap = GapDeclaration & { unverified_fields: string[] };

export type GapCheckResult = { accepted: true; gap: AcceptedGap } | { accepted: false; code: string; message: string };

const reject = (code: string, message: string): GapCheckResult => ({ accepted: false, code, message });

const MONEY_TERMS = /金额|单价|价格|多少钱|应收|应付|收款|付款|回款|对账|利润|毛利|成本|工资|薪|工价|人工费|费用|科目|凭证|财务/;

export function checkGap(declaration: GapDeclaration, context: { accessLevel: AgentAccessLevel; executed: readonly ExecutedOperation[]; question?: string }): GapCheckResult {
  const { nearest_operation: nearest, missing_param: param } = declaration;
  if (context.accessLevel !== "full" && [context.question ?? "", declaration.missing_detail].some((text) => MONEY_TERMS.test(text))) {
    return reject("AGENT_GAP_PERMISSION", "这属于金额或财务数据，系统里有，但当前账号没有权限查看，不是缺工具。直接告诉用户需要财务权限的账号才能查询。");
  }
  const candidates = candidateOperations("", context.accessLevel);
  const entry = candidates.find((candidate) => candidate.operation === nearest);
  if (!entry) {
    return reject("AGENT_GAP_OPERATION_UNKNOWN", `nearest_operation 不是可用的 operation。可用：${candidates.map((candidate) => candidate.operation).join("、")}`);
  }
  if (param && entry.accepts.includes(param)) {
    const described = describeModule(entry.tool, context.accessLevel).operations.find((operation) => operation.operation === nearest);
    return reject("AGENT_GAP_PARAM_SUPPORTED", `${nearest} 本来就接受参数 ${param}，直接用它查询。条目：${JSON.stringify(described)}`);
  }
  const runs = context.executed.filter((item) => item.operation === nearest);
  if (runs.length > 0 && runs.every((item) => item.rows === 0)) {
    return reject("AGENT_GAP_NO_DATA", `${nearest} 本轮查到 0 行，这是缺数据，不是缺工具。直接告诉用户没有查到记录。`);
  }
  const { verified, unverified } = splitNeededFields(declaration.needed_fields);
  return { accepted: true, gap: { ...declaration, needed_fields: verified, unverified_fields: unverified } };
}
