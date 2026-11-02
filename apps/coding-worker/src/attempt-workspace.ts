import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function assertPathSegment(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${name} must be a safe path segment`)
  }
}

export async function createCapabilityAttemptWorkspace(
  root: string,
  capabilityId: string,
  attemptId: string,
): Promise<string> {
  assertPathSegment(capabilityId, 'capabilityId')
  assertPathSegment(attemptId, 'attemptId')
  const resolvedRoot = resolve(root)
  const capabilityRoot = join(resolvedRoot, capabilityId)
  const attemptWorkspace = join(capabilityRoot, attemptId)
  await mkdir(capabilityRoot, { recursive: true })
  await mkdir(attemptWorkspace)
  return attemptWorkspace
}
