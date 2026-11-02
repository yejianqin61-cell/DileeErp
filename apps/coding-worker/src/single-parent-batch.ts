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
    prompt: `Declare exactly these two capabilities, start both Builders before either Validator, then validate each frozen revision independently. ${input.capabilities.map(capability => `${capability.capabilityId}: ${capability.prompt}`).join('\n')}`,
  }, factory)
}
