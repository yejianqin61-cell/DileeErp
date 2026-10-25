import { ForbiddenException } from "@nestjs/common";
import type { AgentAccessLevel } from "../access-level";
import type { AgentToolName, ToolCapability } from "./tool-registry";

/**
 * 工具层的档位闸门：按**有效档位**（创建时与当前的较低者）核对能力登记的 minAccess。
 * 它与 QueryPermissionGuard 的分工：守卫拦 API 请求，这里拦每一次工具执行 ——
 * 运行中降权不需要等下一次请求，下一次工具调用就会撞上这堵墙。
 */
export function assertOperationAllowed(accessLevel: AgentAccessLevel, tool: AgentToolName, capability: ToolCapability): void {
  if (capability.minAccess === "full" && accessLevel !== "full") {
    throw new ForbiddenException({ code: "AGENT_TOOL_FORBIDDEN", message: `当前档位不能使用 ${tool}/${capability.operation}（仅限财务档）`, details: [] });
  }
}
