import type { AgentAccessLevel } from "../access-level";
import { MODULE_SPECS, OPERATION_SPECS, type ModuleSpec, type OperationSpec } from "./tool-catalog-specs";
import { AGENT_TOOLS, TOOL_CAPABILITIES, type AgentToolName, type ToolCapability } from "./tool-registry";

export type CatalogEntry = OperationSpec & {
  tool: AgentToolName;
  operation: string;
  minAccess: AgentAccessLevel;
};

export type CatalogModule = ModuleSpec;

export type Catalog = {
  modules: CatalogModule[];
  entries: CatalogEntry[];
};

const specKey = (tool: string, operation: string) => `${tool}:${operation}`;

export function buildCatalog(
  capabilities: readonly ToolCapability[] = TOOL_CAPABILITIES,
  operationSpecs: Record<string, OperationSpec> = OPERATION_SPECS,
  moduleSpecs: readonly ModuleSpec[] = MODULE_SPECS,
): Catalog {
  const entries: CatalogEntry[] = capabilities.map((capability) => {
    const spec = operationSpecs[specKey(capability.tool, capability.operation)];
    if (!spec) throw new Error(`目录缺少 operation 规格：${specKey(capability.tool, capability.operation)}`);
    return { ...spec, tool: capability.tool, operation: capability.operation, minAccess: capability.minAccess };
  });
  const modules = AGENT_TOOLS.map((tool) => {
    const spec = moduleSpecs.find((item) => item.tool === tool);
    if (!spec) throw new Error(`目录缺少模块声明：${tool}`);
    return spec;
  });
  return { modules, entries };
}

const visibleTo = (entry: CatalogEntry, accessLevel: AgentAccessLevel) => accessLevel === "full" || entry.minAccess !== "full";

export function candidateOperations(_question: string, accessLevel: AgentAccessLevel, catalog: Catalog = buildCatalog()): CatalogEntry[] {
  return catalog.entries.filter((entry) => visibleTo(entry, accessLevel));
}

export function renderL1(accessLevel: AgentAccessLevel, catalog: Catalog = buildCatalog()): string {
  const visible = candidateOperations("", accessLevel, catalog);
  const lines = catalog.modules
    .map((module) => ({ module, count: visible.filter((entry) => entry.tool === module.tool).length }))
    .filter(({ count }) => count > 0)
    .map(({ module, count }) => `- ${module.tool} ${module.title} ${count} 个：${module.scope}。不支持：${module.negatives.join("、")}`);
  return ["可用查询模块：", ...lines].join("\n");
}
