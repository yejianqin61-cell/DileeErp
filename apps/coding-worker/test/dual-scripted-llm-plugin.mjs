import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

const PROVIDER = 'dilee-dual-scripted'
const parentSessionId = process.env.DILEE_PARENT_SESSION_ID
const capabilities = ['employee-output', 'employee-inventory']
const hashes = new Map(capabilities.map((capabilityId, index) => [capabilityId, String(index + 1).repeat(64)]))
let phase = 0
let buildersCompleted = 0
let validatorsCompleted = 0

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(id, name, args) {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`dual scripted adapter timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await new Promise(resolve => setTimeout(resolve, 20))
}

class DualScriptedAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }

  async * stream(options) {
    const isParent = String(options.sessionId) === parentSessionId
    const toolNames = new Set((options.tools ?? []).map(tool => tool.name))
    if (!isParent && ['build_tool', 'validate_tool', 'subagent', 'subagent_fork'].some(name => toolNames.has(name))) {
      throw new Error(`child session received a delegation tool: ${[...toolNames].join(', ')}`)
    }
    let chunks
    let completed
    if (isParent && phase === 0) {
      phase = 1
      chunks = toolCallResponse('declare-both', 'declare_capabilities', { capability_ids: capabilities })
    } else if (isParent && phase === 1) {
      phase = 2
      chunks = toolCallResponse('build-output', 'build_tool', { capability_id: capabilities[0], description: 'Build employee output', prompt: 'Build the output tool.' })
    } else if (isParent && phase === 2) {
      phase = 3
      chunks = toolCallResponse('build-inventory', 'build_tool', { capability_id: capabilities[1], description: 'Build employee inventory', prompt: 'Build the inventory tool.' })
    } else if (isParent && phase === 3) {
      await waitFor(() => buildersCompleted === 2, 'both Builders')
      phase = 4
      chunks = toolCallResponse('validate-output', 'validate_tool', { capability_id: capabilities[0], code_hash: hashes.get(capabilities[0]), description: 'Validate employee output', prompt: 'Validate the output tool.' })
    } else if (isParent && phase === 4) {
      await waitFor(() => validatorsCompleted === 1, 'first Validator')
      phase = 5
      chunks = toolCallResponse('validate-inventory', 'validate_tool', { capability_id: capabilities[1], code_hash: hashes.get(capabilities[1]), description: 'Validate employee inventory', prompt: 'Validate the inventory tool.' })
    } else if (isParent && phase === 5) {
      await waitFor(() => validatorsCompleted === 2, 'both Validators')
      phase = 6
      chunks = toolCallResponse('approve-output', 'record_validation', { capability_id: capabilities[0], code_hash: hashes.get(capabilities[0]), decision: 'approved' })
    } else if (isParent && phase === 6) {
      phase = 7
      chunks = toolCallResponse('approve-inventory', 'record_validation', { capability_id: capabilities[1], code_hash: hashes.get(capabilities[1]), decision: 'approved' })
    } else if (isParent && phase === 7) {
      phase = 8
      chunks = toolCallResponse('submit-both', 'submit_candidate', {})
    } else if (isParent && phase === 8) {
      phase = 9
      chunks = textResponse('DUAL_ORCHESTRATOR_COMPLETE')
    } else if (!isParent && phase === 3) {
      await new Promise(resolve => setTimeout(resolve, 100))
      chunks = textResponse('BUILDER_COMPLETE')
      completed = 'builder'
    } else if (!isParent && (phase === 4 || phase === 5)) {
      chunks = textResponse('VALIDATOR_COMPLETE')
      completed = 'validator'
    } else {
      throw new Error(`unexpected dual scripted request for ${String(options.sessionId)} at phase ${phase}`)
    }
    for (const chunk of chunks) yield chunk
    if (completed === 'builder') buildersCompleted += 1
    if (completed === 'validator') validatorsCompleted += 1
  }
}

export const inject = ['llm']
export function apply(ctx) {
  if (!parentSessionId) throw new Error('DILEE_PARENT_SESSION_ID is required')
  ctx.llm.registerAdapter([PROVIDER], new DualScriptedAdapter())
  ctx.provide('dileeDualScriptedLlm', {})
}
