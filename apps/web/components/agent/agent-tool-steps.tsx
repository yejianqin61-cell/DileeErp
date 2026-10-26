"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ToolStepView } from "../../lib/business-query-state";
import { AGENT_TOOL_LABELS, normalizeToolStatus, toolErrorReason, toolOperationLabel, toolStepStatusLabel, toolStepSummary } from "../../lib/agent-tool-labels";

/**
 * 工具调用（执行步骤）折叠卡。
 *
 * 默认只显示一行摘要（「正在查询销售订单」「已查询销售订单」），展开后才显示
 * **安全的执行详情**：数据域、查询项、状态、失败原因。
 * 后端 tool_status 事件本身只发 tool/operation/status/code，不发参数、SQL 或结果行，
 * 所以这里也不存在「要不要脱敏」的问题 —— 展开面板里根本没有原始参数可展示。
 */
export function AgentToolSteps({ steps }: { steps: ToolStepView[] }) {
  if (steps.length === 0) return null;
  return <div className="agent-tools" data-testid="agent-tool-steps" aria-label="执行步骤">
    {steps.map((step, index) => <AgentToolStep key={`${step.tool}:${step.operation}:${index}`} step={step} />)}
  </div>;
}

function AgentToolStep({ step }: { step: ToolStepView }) {
  const [expanded, setExpanded] = useState(false);
  const status = normalizeToolStatus(step.status);
  const domain = AGENT_TOOL_LABELS[step.tool] ?? "业务数据";
  const operation = toolOperationLabel(step.tool, step.operation);
  return <div className="agent-tool" data-testid="agent-tool-step" data-status={status}>
    <button type="button" className="agent-tool-head" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)} data-testid="agent-tool-step-toggle">
      <span className="agent-tool-dot" data-status={status} aria-hidden="true" />
      <span className="agent-tool-label">{toolStepSummary(step.tool, step.operation, step.status)}</span>
      <ChevronDown size={13} className="agent-tool-chevron" aria-hidden="true" />
    </button>
    {expanded && <div className="agent-tool-body" data-testid="agent-tool-step-detail">
      <p>数据域：<strong>{domain}</strong></p>
      <p>查询项：<strong>{operation}</strong></p>
      <p>状态：<strong>{toolStepStatusLabel(step.status)}</strong></p>
      {status === "error" && <p>原因：<strong>{toolErrorReason(step.code)}</strong></p>}
      <p className="agent-tool-safe">执行详情只含查询名称与状态，不展示内部参数、SQL 或原始数据。</p>
    </div>}
  </div>;
}
