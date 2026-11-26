import { createRequire } from "node:module";
import { generateText, jsonSchema, stepCountIs, tool as defineTool } from "ai";

import { buildGroup } from "./groups.mjs";

const require = createRequire(import.meta.url);
const dist = "../../../apps/api/dist/modules/business-query-agent";
const { TOOL_DESCRIPTIONS, domainInputSchema, CATALOG_TOOL_DESCRIPTION, catalogInputSchema } = require(`${dist}/deepseek-llm-provider.js`);
const { AGENT_TOOLS, CATALOG_TOOL } = require(`${dist}/tools/tool-registry.js`);
const { describeModule } = require(`${dist}/tools/tool-catalog.js`);

const GAP_TOOL = "report_gap";
export const MAX_STEPS = 8;

function stubRows(operation, stub) {
  if (operation === "search_documents") return [{ order_ref: "o_1", order_no: "MOCK-ORD-001" }];
  return stub === "empty" ? [] : [{ 示例字段: "示例值" }];
}

function toolsFor(group, stub) {
  const tools = {};
  for (const name of AGENT_TOOLS) {
    tools[name] = defineTool({
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: domainInputSchema(name),
      execute: async (input) => stubRows(input.operation, stub),
    });
  }
  tools[CATALOG_TOOL] = defineTool({
    description: CATALOG_TOOL_DESCRIPTION,
    inputSchema: catalogInputSchema(AGENT_TOOLS),
    execute: async (input) => describeModule(input.module, "full"),
  });
  tools[GAP_TOOL] = defineTool({
    description: group.gapTool.description,
    inputSchema: jsonSchema(group.gapTool.inputSchema),
    execute: async (input) => group.record(input),
  });
  return tools;
}

export async function runOne({ group: groupName, question, model, rep, abortSignal }) {
  const group = buildGroup(groupName);
  const result = await generateText({
    model,
    instructions: group.system,
    prompt: question.question,
    tools: toolsFor(group, question.stub),
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal,
  });
  const calls = result.steps.flatMap((step) => step.toolCalls);
  const isDomain = (call) => AGENT_TOOLS.includes(call.toolName);
  const gapIndex = calls.findIndex((call) => call.toolName === GAP_TOOL);
  const last = result.steps.at(-1);
  const capped = result.steps.length >= MAX_STEPS && last.toolCalls.length > 0;
  return {
    group: groupName,
    id: question.id,
    rep,
    gap: gapIndex < 0 ? null : calls[gapIndex].input,
    domainCallsBeforeGap: gapIndex < 0 ? null : calls.slice(0, gapIndex).filter(isDomain).length,
    domainCalls: calls.filter(isDomain).length,
    catalogCalls: calls.filter((call) => call.toolName === CATALOG_TOOL).length,
    capped,
    answered: !capped && last.text.trim().length > 0,
  };
}
