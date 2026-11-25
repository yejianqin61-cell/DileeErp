import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildBaseSystemPrompt } = require("../../../apps/api/dist/modules/business-query-agent/tools/system-prompt.js");
const { TOOL_CAPABILITIES } = require("../../../apps/api/dist/modules/business-query-agent/tools/tool-registry.js");

export const GROUP_NAMES = ["A", "B", "C"];

const GAP_RULE = "只在确认现有工具都答不了用户的问题时调用；换个问法就能答、或查到 0 行，都不是缺口。";
const GAP_HINT = "如果现有工具确实答不了用户的问题，调用 report_gap 说明缺口，然后告诉用户目前无法回答；能答的就直接查。";
const NEAREST_HINT = "判断缺口时：先在上面的模块里找最接近用户问题的 operation，再说它差什么（分组、筛选、度量、时间序列，或现有工具都不以该对象为主体）。";
const AXIS_BLOCK = [
  "可用查询模块的轴声明：",
  "order_query 对象：单据；度量：定位、状态、进度、时间、数量；粒度：单张明细（需单据根）、跨单行集；时间：当前快照、区间；不支持：分组汇总、趋势、写操作",
  "sales_query 对象：单据、客户、物料；度量：定位、数量、状态；粒度：单张明细（需单据根）；时间：当前快照；不支持：分组汇总、趋势、金额",
  "procurement_query 对象：单据；度量：定位、数量、状态、时间；粒度：单张明细（需单据根）、跨单行集；时间：当前快照；不支持：分组汇总、趋势、金额",
  "production_query 对象：单据；度量：数量、进度、状态、时间；粒度：单张明细（需单据根）；时间：当前快照；不支持：员工与工价、分组汇总、趋势",
  "warehouse_query 对象：单据、物料；度量：数量、状态；粒度：单张明细（需单据根）、跨单行集、分组汇总（仅按物料）；时间：当前快照；不支持：金额、趋势、按仓库",
  "finance_query 对象：单据、客户、供应商、员工；度量：金额、状态、差异；粒度：单张明细（需单据根）；时间：当前快照；不支持：跨订单汇总、科目凭证、趋势",
].join("\n");

const pick = (values) => ({ type: "string", enum: values });
const objectSchema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });

const GROUPS = {
  A: {
    extra: null,
    sentence: "说明原因。",
    schema: () => objectSchema({ reason: { type: "string" } }),
  },
  B: {
    extra: AXIS_BLOCK,
    sentence: "按四轴给出这个缺口的坐标：对象、度量、粒度、时间基准。",
    schema: () => objectSchema({
      object: pick(["单据", "物料", "客户", "供应商", "员工", "科目"]),
      metric: pick(["定位", "数量", "金额", "状态", "进度", "时间", "差异"]),
      granularity: pick(["单张明细", "跨单行集", "分组汇总", "计数"]),
      time_basis: pick(["当前快照", "区间", "趋势"]),
    }),
  },
  C: {
    extra: NEAREST_HINT,
    sentence: "从现有 operation 里选最接近用户问题的一个，并说明它差什么。",
    schema: () => objectSchema({
      nearest_operation: pick(TOOL_CAPABILITIES.map((capability) => capability.operation)),
      missing: pick(["group_by", "filter", "metric", "time_series", "object"]),
      missing_detail: { type: "string", description: "缺口短语，不要照抄用户原话" },
      needed_fields: { type: "array", items: { type: "string" } },
    }, ["nearest_operation", "missing", "missing_detail"]),
  },
};

export function buildGroup(name, records = []) {
  const group = GROUPS[name];
  if (!group) throw new Error(`未知实验组：${name}`);
  return {
    system: [buildBaseSystemPrompt("full"), GAP_HINT, group.extra].filter(Boolean).join("\n\n"),
    gapTool: { description: `${GAP_RULE}${group.sentence}`, inputSchema: group.schema() },
    record(args) {
      records.push(args);
      return "已记录";
    },
  };
}
