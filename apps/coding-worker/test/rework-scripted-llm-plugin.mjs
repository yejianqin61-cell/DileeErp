import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

const PROVIDER = 'dilee-rework-scripted'
const parentSessionId = process.env.DILEE_PARENT_SESSION_ID
const capabilityId = 'packaging-output'
const h1 = '1'.repeat(64)
const h2 = '2'.repeat(64)
let builderSessionId
let phase = 0

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId, name, args) {
  const id = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function waitForPhase(target) {
  const deadline = Date.now() + 10_000
  while (phase < target) {
    if (Date.now() >= deadline) throw new Error(`rework adapter timed out at phase ${phase}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await new Promise(resolve => setTimeout(resolve, 20))
}

class ReworkAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    const sessionId = String(options.sessionId)
    const isParent = sessionId === parentSessionId
    const toolNames = new Set((options.tools ?? []).map(tool => tool.name))
    if (!isParent && ['build_tool', 'validate_tool', 'subagent', 'subagent_fork']
      .some(name => toolNames.has(name))) {
      throw new Error(`rework child received a delegation tool: ${[...toolNames].join(', ')}`)
    }
    let chunks
    let completedPhase

    if (isParent && phase === 0) {
      phase = 1
      chunks = toolCallResponse('declare-capability', 'declare_capabilities', {
        capability_ids: [capabilityId],
      })
    } else if (isParent && phase === 1) {
      phase = 2
      chunks = toolCallResponse('build-h1', 'build_tool', {
        capability_id: capabilityId,
        description: 'Build packaging output h1',
        prompt: 'Build revision h1 and report BUILDER_REVISION_H1.',
      })
    } else if (!isParent && phase === 2) {
      builderSessionId = sessionId
      chunks = textResponse('BUILDER_REVISION_H1')
      completedPhase = 3
    } else if (isParent && phase <= 3) {
      await waitForPhase(3)
      phase = 4
      chunks = toolCallResponse('validate-h1', 'validate_tool', {
        capability_id: capabilityId,
        code_hash: h1,
        description: 'Validate packaging output h1',
        prompt: 'Reject h1 because the cross-order isolation test is missing.',
      })
    } else if (!isParent && phase === 4) {
      chunks = textResponse('VALIDATOR_REJECTED_H1')
      completedPhase = 5
    } else if (isParent && phase <= 5) {
      await waitForPhase(5)
      phase = 6
      chunks = toolCallResponse('record-rejection-h1', 'record_validation', {
        capability_id: capabilityId,
        code_hash: h1,
        decision: 'rejected',
      })
    } else if (isParent && phase === 6) {
      if (!builderSessionId) throw new Error('Builder Session was not captured')
      phase = 7
      chunks = toolCallResponse('revise-builder', 'revise_tool', {
        capability_id: capabilityId,
        message: 'Validator rejected h1. Add the cross-order isolation test and produce h2.',
      })
    } else if (!isParent && sessionId === builderSessionId && phase === 7) {
      chunks = textResponse('BUILDER_REVISION_H2')
      completedPhase = 8
    } else if (isParent && phase <= 8) {
      await waitForPhase(8)
      phase = 9
      chunks = toolCallResponse('validate-h2', 'validate_tool', {
        capability_id: capabilityId,
        code_hash: h2,
        description: 'Validate packaging output h2',
        prompt: 'Approve h2 after verifying the cross-order isolation test.',
      })
    } else if (!isParent && phase === 9) {
      chunks = textResponse('VALIDATOR_APPROVED_H2')
      completedPhase = 10
    } else if (isParent && phase <= 10) {
      await waitForPhase(10)
      phase = 11
      chunks = toolCallResponse('record-approval-h2', 'record_validation', {
        capability_id: capabilityId,
        code_hash: h2,
        decision: 'approved',
      })
    } else if (isParent && phase === 11) {
      phase = 12
      chunks = toolCallResponse('submit-candidate', 'submit_candidate', {})
    } else if (isParent && phase === 12) {
      phase = 13
      chunks = textResponse('ORCHESTRATOR_COMPLETE_H2')
    } else {
      throw new Error(`unexpected rework request for ${sessionId} at phase ${phase}`)
    }

    for (const chunk of chunks) yield chunk
    if (completedPhase !== undefined) phase = completedPhase
  }
}

export const inject = ['llm']

export function apply(ctx) {
  if (!parentSessionId) throw new Error('DILEE_PARENT_SESSION_ID is required')
  ctx.llm.registerAdapter([PROVIDER], new ReworkAdapter())
  ctx.provide('dileeScriptedLlm', {})
}

