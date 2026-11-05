import { readFile } from 'node:fs/promises'

interface ActivationTraceBase {
  readonly seq: number
  readonly runId: string
  readonly childSessionId: string
  readonly provider: string
  readonly local: boolean
  readonly at?: number
}

export type ActivationTraceRecord =
  | ActivationTraceBase & { readonly event: 'start' }
  | ActivationTraceBase & { readonly event: 'end'; readonly stopReason: string }
  | { readonly seq: number; readonly event: 'meta'; readonly runId: string; readonly capabilityId: string; readonly role: 'builder' | 'validator' }
  | { readonly seq: number; readonly event: 'submission'; readonly capabilities: readonly { readonly capabilityId: string; readonly codeHash: string }[] }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseRecord(value: unknown, line: number): ActivationTraceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid Activation trace record at line ${line}`)
  }
  const record = value as Record<string, unknown>
  if (record.event === 'submission') {
    if (record.seq !== line || !Array.isArray(record.capabilities) || record.capabilities.length === 0
      || record.capabilities.some(capability => typeof capability !== 'object' || capability === null
        || !isNonEmptyString((capability as Record<string, unknown>).capabilityId)
        || !/^[a-f0-9]{64}$/u.test(String((capability as Record<string, unknown>).codeHash)))) {
      throw new Error(`invalid Activation trace record at line ${line}`)
    }
    return record as unknown as ActivationTraceRecord
  }
  if (record.event === 'meta') {
    if (record.seq !== line || !isNonEmptyString(record.runId) || !isNonEmptyString(record.capabilityId)
      || (record.role !== 'builder' && record.role !== 'validator')) throw new Error(`invalid Activation trace record at line ${line}`)
    return record as unknown as ActivationTraceRecord
  }
  const validBase = record.seq === line
    && isNonEmptyString(record.runId)
    && isNonEmptyString(record.childSessionId)
    && isNonEmptyString(record.provider)
    && typeof record.local === 'boolean'
    && (record.at === undefined || (typeof record.at === 'number' && Number.isFinite(record.at)))
  if (!validBase || (record.event !== 'start' && record.event !== 'end')) {
    throw new Error(`invalid Activation trace record at line ${line}`)
  }
  if (record.event === 'end' && !isNonEmptyString(record.stopReason)) {
    throw new Error(`invalid Activation trace record at line ${line}`)
  }
  return record as unknown as ActivationTraceRecord
}

export async function readActivationTrace(path: string): Promise<ActivationTraceRecord[]> {
  const text = await readFile(path, 'utf8')
  const lines = text.split(/\r?\n/u).filter(line => line.length > 0)
  return lines.map((line, index) => {
    try {
      return parseRecord(JSON.parse(line) as unknown, index + 1)
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`invalid Activation trace JSON at line ${index + 1}`, { cause: error })
      }
      throw error
    }
  })
}

