import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

const provider = 'dilee-policy-adversarial'
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

function hasToolError(messages, code) {
  return messages.some(message => message.role === 'tool'
    && JSON.stringify(message.content).includes(code))
}

async function waitForPhase(target) {
  const deadline = Date.now() + 10_000
  while (phase < target) {
    if (Date.now() >= deadline) throw new Error(`policy adapter timed out at phase ${phase}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await new Promise(resolve => setTimeout(resolve, 20))
}

class PolicyAdversarialAdapter extends LlmAdapter {
  resolveModel(selectedProvider, model) {
    return Promise.resolve({ provider: selectedProvider, id: model, name: model })
  }

  async * stream(options) {
    const sessionId = String(options.sessionId)
    const isParent = sessionId === parentSessionId
    let chunks
    let completedPhase

    if (isParent && phase === 0) {
      phase = 1
      chunks = toolCallResponse('validate-before-declare', 'validate_tool', {
        capability_id: capabilityId,
        code_hash: h1,
        description: 'Illegal early validation',
        prompt: 'This activation must not start.',
      })
    } else if (isParent && phase === 1) {
      if (!hasToolError(options.messages, 'capabilities-not-declared')) {
        throw new Error('missing capabilities-not-declared denial')
      }
      phase = 2
      chunks = toolCallResponse('declare-capability', 'declare_capabilities', {
        capability_ids: [capabilityId],
      })
    } else if (isParent && phase === 2) {
      phase = 3
      chunks = toolCallResponse('submit-before-validation', 'submit_candidate', {})
    } else if (isParent && phase === 3) {
      if (!hasToolError(options.messages, 'capability-not-approved')) {
        throw new Error('missing capability-not-approved denial')
      }
      phase = 4
      chunks = toolCallResponse('build-h1', 'build_tool', {
        capability_id: capabilityId,
        description: 'Build policy h1',
        prompt: 'Build revision h1.',
      })
    } else if (!isParent && phase === 4) {
      builderSessionId = sessionId
      chunks = textResponse('BUILDER_POLICY_H1')
      completedPhase = 5
    } else if (isParent && phase <= 5) {
      await waitForPhase(5)
      phase = 6
      chunks = toolCallResponse('validate-h1', 'validate_tool', {
        capability_id: capabilityId,
        code_hash: h1,
        description: 'Validate policy h1',
        prompt: 'Reject revision h1.',
      })
    } else if (!isParent && phase === 6) {
      chunks = textResponse('VALIDATOR_POLICY_REJECTED_H1')
      completedPhase = 7
    } else if (isParent && phase <= 7) {
      await waitForPhase(7)
      phase = 8
      chunks = toolCallResponse('record-h1-rejection', 'record_validation', {
        capability_id: capabilityId,
        code_hash: h1,
        decision: 'rejected',
      })
    } else if (isParent && phase === 8) {
      if (!builderSessionId) throw new Error('Builder Session was not captured')
      phase = 9
      chunks = toolCallResponse('revise-h1', 'revise_tool', {
        capability_id: capabilityId,
        message: 'Produce h2.',
      })
    } else if (!isParent && sessionId === builderSessionId && phase === 9) {
      chunks = textResponse('BUILDER_POLICY_H2')
      completedPhase = 10
    } else if (isParent && phase <= 10) {
      await waitForPhase(10)
      phase = 11
      chunks = toolCallResponse('revalidate-stale-h1', 'validate_tool', {
        capability_id: capabilityId,
        code_hash: h1,
        description: 'Illegal stale validation',
        prompt: 'This activation must not start.',
      })
    } else if (isParent && phase === 11) {
      if (!hasToolError(options.messages, 'revision-not-advanced')) {
        throw new Error('missing revision-not-advanced denial')
      }
      phase = 12
      chunks = toolCallResponse('validate-h2', 'validate_tool', {
        capability_id: capabilityId,
        code_hash: h2,
        description: 'Validate policy h2',
        prompt: 'Reject revision h2 to exercise the budget.',
      })
    } else if (!isParent && phase === 12) {
      chunks = textResponse('VALIDATOR_POLICY_REJECTED_H2')
      completedPhase = 13
    } else if (isParent && phase <= 13) {
      await waitForPhase(13)
      phase = 14
      chunks = toolCallResponse('record-h2-rejection', 'record_validation', {
        capability_id: capabilityId,
        code_hash: h2,
        decision: 'rejected',
      })
    } else if (isParent && phase === 14) {
      phase = 15
      chunks = toolCallResponse('revise-over-budget', 'revise_tool', {
        capability_id: capabilityId,
        message: 'This second rework must be denied.',
      })
    } else if (isParent && phase === 15) {
      if (!hasToolError(options.messages, 'rework-budget-exhausted')) {
        throw new Error('missing rework-budget-exhausted denial')
      }
      phase = 16
      chunks = textResponse('POLICY_DENIALS_CONFIRMED')
    } else {
      throw new Error(`unexpected policy request for ${sessionId} at phase ${phase}`)
    }

    for (const chunk of chunks) yield chunk
    if (completedPhase !== undefined) phase = completedPhase
  }
}

export const inject = ['llm']

export function apply(ctx) {
  if (!parentSessionId) throw new Error('DILEE_PARENT_SESSION_ID is required')
  ctx.llm.registerAdapter([provider], new PolicyAdversarialAdapter())
  ctx.provide('dileePolicyAdversarialLlm', {})
}

