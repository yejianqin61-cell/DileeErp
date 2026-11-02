import { defineTool } from '@deepseek-ai/dsh-tools'

import { CodingJobPolicy } from '../src/job-policy.ts'

export const inject = ['tools', 'subagents']

const builderPreset = 'tool-builder'
const validatorPreset = 'tool-validator'

function rootAgent(exec, parentSessionId) {
  if (!exec.agent || String(exec.agent.id) !== parentSessionId) {
    throw new Error('root-agent-required')
  }
  return exec.agent
}

function definition(name, description, parameters, execute) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // ponytail: R-4 serializes policy actions; R-7 may partition them by capability for parallel starts.
    isConcurrencySafe: () => false,
    execute,
  })
}

export function apply(ctx, config = {}) {
  const parentSessionId = process.env.DILEE_PARENT_SESSION_ID
  if (!parentSessionId) throw new Error('DILEE_PARENT_SESSION_ID is required')
  const policy = new CodingJobPolicy({ maxReworks: config.maxReworks ?? 1 })
  const activations = new Map()
  let pendingStart
  let lifecycleError

  const assertLifecycle = () => {
    if (lifecycleError) throw lifecycleError
  }

  ctx.on('subagent/start', (info) => {
    if (!pendingStart) return
    const activation = {
      ...pendingStart,
      childSessionId: String(info.id),
      runId: String(info.runId),
    }
    pendingStart.observed = activation
    activations.set(activation.runId, activation)
    ctx.emit('dilee/activation-meta', activation)
  })

  ctx.on('subagent/end', (info) => {
    const activation = activations.get(String(info.runId))
    if (!activation) return
    activations.delete(activation.runId)
    const stopReason = info.stopReason === 'completed'
      ? 'completed'
      : info.stopReason === 'aborted' ? 'aborted' : 'error'
    try {
      if (activation.role === 'builder') {
        policy.finishBuild(activation.capabilityId, String(info.id), stopReason)
      } else {
        policy.finishValidation(activation.capabilityId, String(info.id), stopReason)
      }
    } catch (error) {
      lifecycleError = error
    }
  })

  async function startChild(parent, capabilityId, role, description, prompt, signal) {
    pendingStart = { capabilityId, role }
    try {
      const started = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: description,
        request: {
          parent,
          agentPreset: role === 'builder' ? builderPreset : validatorPreset,
          prompt: [{ type: 'text', text: prompt }],
          maxDepth: 1,
        },
        signal,
        delivery: 'parent',
      })
      if (!pendingStart.observed
        || pendingStart.observed.childSessionId !== String(started.childId)) {
        throw new Error('subagent-start-not-observed')
      }
      return { kind: 'activation', subagentId: String(started.childId) }
    } finally {
      pendingStart = undefined
    }
  }

  ctx.tools.register(definition(
    'declare_capabilities',
    'Declare the complete tool capability set for this coding job before delegation.',
    {
      capability_ids: {
        type: 'array',
        required: true,
        items: { type: 'string' },
      },
    },
    async (args, exec) => {
      rootAgent(exec, parentSessionId)
      assertLifecycle()
      policy.declareCapabilities(args.capability_ids)
      return { capabilityIds: args.capability_ids }
    },
  ))

  ctx.tools.register(definition(
    'build_tool',
    'Start the fixed Tool Builder for one declared capability.',
    {
      capability_id: { type: 'string', required: true },
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    async (args, exec) => {
      const parent = rootAgent(exec, parentSessionId)
      assertLifecycle()
      policy.beginBuild(args.capability_id)
      return startChild(
        parent,
        args.capability_id,
        'builder',
        args.description,
        args.prompt,
        exec.signal,
      )
    },
  ))

  ctx.tools.register(definition(
    'validate_tool',
    'Start the fixed Tool Validator for the latest completed Builder revision.',
    {
      capability_id: { type: 'string', required: true },
      code_hash: { type: 'string', required: true },
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    async (args, exec) => {
      const parent = rootAgent(exec, parentSessionId)
      assertLifecycle()
      policy.beginValidation(args.capability_id, args.code_hash)
      return startChild(
        parent,
        args.capability_id,
        'validator',
        args.description,
        args.prompt,
        exec.signal,
      )
    },
  ))

  ctx.tools.register(definition(
    'record_validation',
    'Record the completed Validator decision for its exact capability and code hash.',
    {
      capability_id: { type: 'string', required: true },
      code_hash: { type: 'string', required: true },
      decision: { type: 'string', required: true, enum: ['approved', 'rejected'] },
    },
    async (args, exec) => {
      rootAgent(exec, parentSessionId)
      assertLifecycle()
      policy.recordValidation(args.capability_id, args.code_hash, args.decision)
      return {
        capabilityId: args.capability_id,
        codeHash: args.code_hash,
        decision: args.decision,
      }
    },
  ))

  ctx.tools.register(definition(
    'revise_tool',
    'Continue the original Builder after a recorded Validator rejection.',
    {
      capability_id: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
    async (args, exec) => {
      const parent = rootAgent(exec, parentSessionId)
      assertLifecycle()
      const builderSessionId = policy.beginRework(args.capability_id)
      pendingStart = { capabilityId: args.capability_id, role: 'builder' }
      try {
        const messageId = await ctx.subagents.sendMessage(
          parent,
          builderSessionId,
          [{ type: 'text', text: args.message }],
          { signal: exec.signal },
        )
        if (!pendingStart.observed
          || pendingStart.observed.childSessionId !== builderSessionId) {
          throw new Error('builder-rework-start-not-observed')
        }
        return { messageId: String(messageId), subagentId: builderSessionId }
      } finally {
        pendingStart = undefined
      }
    },
  ))

  ctx.tools.register(definition(
    'submit_candidate',
    'Request ERP gate review only when every declared capability has current approval.',
    {},
    async (_args, exec) => {
      rootAgent(exec, parentSessionId)
      assertLifecycle()
      return policy.submitCandidate()
    },
  ))

  ctx.provide('dileeCodingJobPolicy', {})
}
