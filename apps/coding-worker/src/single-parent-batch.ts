import { runCodingBatch, type CodingBatchResult, type CodingRuntimeConfig, type CodingRuntimeFactory } from './runtime-lifecycle.ts'

export interface SingleParentCapability {
  readonly capabilityId: string
  readonly prompt: string
}

export async function runSingleParentBatch(
  config: CodingRuntimeConfig,
  input: { batchId: string; parentSessionId: string; capabilities: readonly SingleParentCapability[]; deadlineMs?: number },
  factory?: CodingRuntimeFactory,
): Promise<CodingBatchResult> {
  if (input.capabilities.length !== 2) throw new TypeError('exactly two capabilities are required')
  const ids = new Set(input.capabilities.map(capability => capability.capabilityId))
  if (ids.size !== 2 || input.capabilities.some(capability => !/^[a-z][a-z0-9-]{0,79}$/u.test(capability.capabilityId) || !capability.prompt)) {
    throw new TypeError('capabilities must have distinct safe IDs and prompts')
  }
  return runCodingBatch({
    ...config,
    batchId: input.batchId,
    parentSessionId: input.parentSessionId,
    deadlineMs: input.deadlineMs,
    prompt: `You are the only parent Agent for this batch. Do not answer with prose or stop before submit_candidate succeeds. First call declare_capabilities with exactly these two IDs. Then call build_tool once for each ID before any validate_tool call. Wait for each Builder result, compute the exact SHA-256 manifest hash over sorted [{path:'tool.ts',sha256:fileSHA256},{path:'tool.test.ts',sha256:fileSHA256}] JSON, then call validate_tool for that same capability and hash. After each Validator finishes, call record_validation with its actual decision and a compact nonempty report that faithfully records that Validator's findings. If rejected, call revise_tool only for that capability, then revalidate its new hash. Call submit_candidate only after both current revisions are approved. ${input.capabilities.map(capability => `${capability.capabilityId}: ${capability.prompt}`).join('\n')}`,
  }, factory)
}
