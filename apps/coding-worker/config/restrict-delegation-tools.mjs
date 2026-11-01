const childPresets = new Set(['tool-builder', 'tool-validator'])
const delegationTools = [
  'declare_capabilities',
  'build_tool',
  'validate_tool',
  'record_validation',
  'revise_tool',
  'submit_candidate',
]

export const inject = ['agentPresets', 'tools']

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    if (childPresets.has(ctx.agentPresets.composedPreset(agent.ctx))) {
      agent.ctx.tools.restrict({ deny: delegationTools })
    }
  })
}

