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

export type CatalogReconciliation = {
  missingOperationSpecs: string[];
  orphanOperationSpecs: string[];
  missingModuleSpecs: string[];
  orphanModuleSpecs: string[];
};

export function reconcileCatalog(
  capabilities: readonly ToolCapability[],
  operationSpecs: Record<string, OperationSpec>,
  moduleSpecs: readonly ModuleSpec[],
): CatalogReconciliation {
  const capabilityKeys = capabilities.map((capability) => specKey(capability.tool, capability.operation));
  const specKeys = Object.keys(operationSpecs);
  const moduleTools: string[] = moduleSpecs.map((spec) => spec.tool);
  return {
    missingOperationSpecs: capabilityKeys.filter((key) => !specKeys.includes(key)),
    orphanOperationSpecs: specKeys.filter((key) => !capabilityKeys.includes(key)),
    missingModuleSpecs: AGENT_TOOLS.filter((tool) => !moduleTools.includes(tool)),
    orphanModuleSpecs: moduleTools.filter((tool) => !(AGENT_TOOLS as readonly string[]).includes(tool)),
  };
}

export function buildCatalog(
  capabilities: readonly ToolCapability[] = TOOL_CAPABILITIES,
  operationSpecs: Record<string, OperationSpec> = OPERATION_SPECS,
  moduleSpecs: readonly ModuleSpec[] = MODULE_SPECS,
): Catalog {
  const result = reconcileCatalog(capabilities, operationSpecs, moduleSpecs);
  if (Object.values(result).some((list) => list.length > 0)) {
    throw new Error(`目录与能力表不一致：${JSON.stringify(result)}`);
  }
  const entries: CatalogEntry[] = capabilities.map((capability) => ({
    ...operationSpecs[specKey(capability.tool, capability.operation)],
    tool: capability.tool,
    operation: capability.operation,
    minAccess: capability.minAccess,
  }));
  const modules = AGENT_TOOLS.map((tool) => moduleSpecs.find((item) => item.tool === tool) as ModuleSpec);
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
