import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

const PROVIDER = 'dilee-scripted'
const parentSessionId = process.env.DILEE_PARENT_SESSION_ID
const capabilityId = 'packaging-output'
const h1 = '1'.repeat(64)
let phase = 0
let builderProbeSent = false

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

function hasUnknownToolResult(messages, toolName) {
  return messages.some(message => message.role === 'tool'
    && JSON.stringify(message.content).includes(`unknown tool \\"${toolName}\\"`))
}

async function waitForPhase(target) {
  const deadline = Date.now() + 5_000
  while (phase < target) {
    if (Date.now() >= deadline) throw new Error(`scripted adapter timed out at phase ${phase}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  // Let the child activation publish its completion notice before the parent acts again.
  await new Promise(resolve => setTimeout(resolve, 20))
}

class ScriptedAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    const isParent = String(options.sessionId) === parentSessionId
    const toolNames = new Set((options.tools ?? []).map(tool => tool.name))
    if (!isParent && ['build_tool', 'validate_tool', 'subagent', 'subagent_fork']
      .some(name => toolNames.has(name))) {
      throw new Error(`child session received a delegation tool: ${[...toolNames].join(', ')}`)
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
      chunks = toolCallResponse('build-call', 'build_tool', {
        capability_id: capabilityId,
        description: 'Build packaging output tool',
        prompt: 'Implement the requested packaging-output query tool and report focused test evidence.',
      })
    } else if (isParent && phase <= 3) {
      await waitForPhase(3)
      phase = 4
      chunks = toolCallResponse('validate-call', 'validate_tool', {
        capability_id: capabilityId,
        code_hash: h1,
        description: 'Validate packaging output tool',
        prompt: 'Independently review the Builder result and verify adversarial permission isolation.',
      })
    } else if (isParent && phase <= 5) {
      await waitForPhase(5)
      phase = 6
      chunks = toolCallResponse('record-validation', 'record_validation', {
        capability_id: capabilityId,
        code_hash: h1,
        decision: 'approved',
      })
    } else if (isParent && phase === 6) {
      phase = 7
      chunks = toolCallResponse('submit-candidate', 'submit_candidate', {})
    } else if (isParent && phase === 7) {
      phase = 8
      chunks = textResponse('ORCHESTRATOR_COMPLETE')
    } else if (!isParent && phase === 2 && !builderProbeSent) {
      builderProbeSent = true
      chunks = toolCallResponse('forged-build-call', 'build_tool', {
        description: 'Unauthorized nested build',
        prompt: 'This call must be rejected by the child Agent tool boundary.',
      })
    } else if (!isParent && phase === 2) {
      if (!hasUnknownToolResult(options.messages, 'build_tool')) {
        throw new Error('forged child delegation did not return UNKNOWN_TOOL')
      }
      chunks = textResponse('BUILDER_COMPLETE')
      completedPhase = 3
    } else if (!isParent && phase === 4) {
      chunks = textResponse('VALIDATOR_APPROVED')
      completedPhase = 5
    } else {
      throw new Error(`unexpected scripted request for ${String(options.sessionId)} at phase ${phase}`)
    }

    for (const chunk of chunks) yield chunk
    if (completedPhase !== undefined) phase = completedPhase
  }
}

export const inject = ['llm']

export function apply(ctx) {
  if (!parentSessionId) throw new Error('DILEE_PARENT_SESSION_ID is required')
  ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())
  ctx.provide('dileeScriptedLlm', {})
}
