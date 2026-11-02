export interface TimedActivation {
  readonly capabilityId: string
  readonly role: 'builder' | 'validator'
  readonly runId: string
  readonly startedAt: number
  readonly endedAt: number
}

export function timedActivationsFromTrace(records: readonly ({ readonly event: string; readonly runId: string; readonly at?: number; readonly capabilityId?: string; readonly role?: string })[]): TimedActivation[] {
  const values = new Map<string, { capabilityId?: string; role?: 'builder' | 'validator'; startedAt?: number; endedAt?: number }>()
  for (const record of records) {
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
  if (builders.length !== 2 || validators.length !== 2) throw new Error('SINGLE_PARENT_ACTIVATION_COUNT_INVALID')
  if (new Set(builders.map(record => record.capabilityId)).size !== 2) throw new Error('SINGLE_PARENT_BUILDER_CAPABILITY_INVALID')
  for (const record of records) if (record.startedAt >= record.endedAt) throw new Error('SINGLE_PARENT_ACTIVATION_INTERVAL_INVALID')
  const [left, right] = builders
  if (!left || !right || Math.max(left.startedAt, right.startedAt) >= Math.min(left.endedAt, right.endedAt)) {
    throw new Error('SINGLE_PARENT_BUILDERS_NOT_OVERLAPPED')
  }
  for (const validator of validators) {
    const builder = builders.find(item => item.capabilityId === validator.capabilityId)
    if (!builder || validator.startedAt < builder.endedAt) throw new Error('SINGLE_PARENT_VALIDATOR_ORDER_INVALID')
  }
}
