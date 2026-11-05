import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CodingJobPolicy } from '../src/job-policy.ts'

export const inject = ['tools', 'subagents']

const builderPreset = 'tool-builder'
const validatorPreset = 'tool-validator'

function candidateHash(capabilityId) {
  const root = join(process.env.DILEE_CANDIDATE_WORKSPACE ?? process.cwd(), capabilityId)
  const files = ['tool.ts', 'tool.test.ts'].map(path => {
    const file = join(root, path)
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
      throw new Error(`candidate-revision-file-required:${capabilityId}/${path}`)
    }
    return { path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
  })
  return createHash('sha256').update(JSON.stringify(files.sort((a, b) => a.path.localeCompare(b.path, 'en')))).digest('hex')
}

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
  const restarting = new Map()
  const sessionRoles = new Map()
  let pendingStart
  let lifecycleError

  const assertLifecycle = () => {
    if (lifecycleError) throw lifecycleError
  }

  ctx.on('subagent/start', (info) => {
    const restart = restarting.get(String(info.id))
    const known = sessionRoles.get(String(info.id))
    if (!pendingStart && !restart && !known) return
    const activation = {
      ...(pendingStart ?? restart ?? known),
      childSessionId: String(info.id),
      runId: String(info.runId),
      managed: Boolean(pendingStart ?? restart),
    }
    if (pendingStart) pendingStart.observed = activation
    restarting.delete(activation.childSessionId)
    sessionRoles.set(activation.childSessionId, {
      capabilityId: activation.capabilityId,
      role: activation.role,
    })
    activations.set(activation.runId, activation)
    ctx.emit('dilee/activation-meta', activation)
  })

  ctx.on('subagent/end', (info) => {
    const activation = activations.get(String(info.runId))
    if (!activation) return
    activations.delete(activation.runId)
    if (!activation.managed) return
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
      const codeHash = process.env.DILEE_VERIFY_CANDIDATE_HASHES === 'true'
        ? candidateHash(args.capability_id)
        : args.code_hash
      policy.beginValidation(args.capability_id, codeHash)
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
      report: { type: 'string' },
    },
    async (args, exec) => {
      rootAgent(exec, parentSessionId)
      assertLifecycle()
      const codeHash = process.env.DILEE_VERIFY_CANDIDATE_HASHES === 'true'
        ? candidateHash(args.capability_id)
        : args.code_hash
      policy.recordValidation(args.capability_id, codeHash, args.decision)
      if (typeof args.report === 'string' && args.report.length > 0) {
        ctx.emit('dilee/validation-recorded', { capabilityId: args.capability_id, codeHash, decision: args.decision, report: args.report })
      }
      return {
        capabilityId: args.capability_id,
        codeHash,
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
      restarting.set(builderSessionId, { capabilityId: args.capability_id, role: 'builder' })
      try {
        const messageId = await ctx.subagents.sendMessage(
          parent,
          builderSessionId,
          [{ type: 'text', text: args.message }],
          { signal: exec.signal },
        )
        return { messageId: String(messageId), subagentId: builderSessionId }
      } finally {
        // ponytail: resumed child start is asynchronous; its session-keyed entry remains until observed.
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
      const submission = policy.submitCandidate()
      ctx.emit('dilee/candidate-submitted', submission)
      return submission
    },
  ))

  ctx.provide('dileeCodingJobPolicy', {})
}
