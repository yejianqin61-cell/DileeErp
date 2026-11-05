export interface TimedActivation {
  readonly capabilityId: string
  readonly role: 'builder' | 'validator'
  readonly runId: string
  readonly startedAt: number
  readonly endedAt: number
}

export function timedActivationsFromTrace(records: readonly ({ readonly event: string; readonly runId?: string; readonly at?: number; readonly capabilityId?: string; readonly role?: string })[]): TimedActivation[] {
  const values = new Map<string, { capabilityId?: string; role?: 'builder' | 'validator'; startedAt?: number; endedAt?: number }>()
  for (const record of records) {
    if (record.event === 'submission' || record.event === 'validation') continue
    if (!record.runId) throw new Error('SINGLE_PARENT_TRACE_INCOMPLETE')
    const value = values.get(record.runId) ?? {}; values.set(record.runId, value)
    if (record.event === 'meta') { value.capabilityId = record.capabilityId; value.role = record.role === 'builder' || record.role === 'validator' ? record.role : undefined }
    if (record.event === 'start') value.startedAt = record.at
    if (record.event === 'end') value.endedAt = record.at
  }
  return [...values.entries()].map(([runId, value]) => {
    if (!value.capabilityId || !value.role || value.startedAt === undefined || value.endedAt === undefined) throw new Error('SINGLE_PARENT_TRACE_INCOMPLETE')
    return { runId, capabilityId: value.capabilityId, role: value.role, startedAt: value.startedAt, endedAt: value.endedAt }
  })
}

export function verifySingleParentActivations(records: readonly TimedActivation[]): void {
  const builders = records.filter(record => record.role === 'builder')
  const validators = records.filter(record => record.role === 'validator')
  const builderCapabilities = new Set(builders.map(record => record.capabilityId))
  const validatorCapabilities = new Set(validators.map(record => record.capabilityId))
  if (builders.length < 2 || validators.length < 2) throw new Error('SINGLE_PARENT_ACTIVATION_COUNT_INVALID')
  if (builderCapabilities.size !== 2 || validatorCapabilities.size !== 2
    || [...validatorCapabilities].some(capabilityId => !builderCapabilities.has(capabilityId))) {
    throw new Error('SINGLE_PARENT_BUILDER_CAPABILITY_INVALID')
  }
  for (const record of records) if (record.startedAt >= record.endedAt) throw new Error('SINGLE_PARENT_ACTIVATION_INTERVAL_INVALID')
  const overlappingBuilders = builders.some((left, index) => builders.slice(index + 1).some(right =>
    left.capabilityId !== right.capabilityId
      && Math.max(left.startedAt, right.startedAt) < Math.min(left.endedAt, right.endedAt)))
  if (!overlappingBuilders) {
    throw new Error('SINGLE_PARENT_BUILDERS_NOT_OVERLAPPED')
  }
  for (const validator of validators) {
    const completedBuilder = builders.some(builder => builder.capabilityId === validator.capabilityId
      && builder.endedAt <= validator.startedAt)
    if (!completedBuilder) throw new Error('SINGLE_PARENT_VALIDATOR_ORDER_INVALID')
  }
}
