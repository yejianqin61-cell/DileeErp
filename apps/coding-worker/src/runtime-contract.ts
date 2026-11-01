import { readFileSync } from 'node:fs'

export const MINIMUM_NODE_VERSION = '24.9.0'
export const DSH_VERSION = '0.2.2-alpha.2'

export interface RuntimeContract {
  nodeVersion: string
  dshVersion: string
}

function versionTuple(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!match) throw new Error(`Invalid Node version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isBefore(version: string, minimum: string): boolean {
  const current = versionTuple(version)
  const required = versionTuple(minimum)
  return current.some((part, index) => part !== required[index]
    && current.slice(0, index).every((value, prefix) => value === required[prefix])
    && part < required[index])
}

export function assertRuntimeContract(
  nodeVersion: string,
  sdkVersion: string,
  cliVersion: string,
): RuntimeContract {
  if (isBefore(nodeVersion, MINIMUM_NODE_VERSION)) {
    throw new Error(`Node ${MINIMUM_NODE_VERSION} or newer is required, got ${nodeVersion}`)
  }
  if (sdkVersion !== DSH_VERSION || cliVersion !== DSH_VERSION) {
    throw new Error(`DSH SDK and CLI must both be ${DSH_VERSION}, got ${sdkVersion} and ${cliVersion}`)
  }
  return { nodeVersion, dshVersion: DSH_VERSION }
}

function installedVersion(packageName: string): string {
  const manifest = JSON.parse(
    readFileSync(new URL(import.meta.resolve(`${packageName}/package.json`)), 'utf8'),
  ) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`${packageName} has no version`)
  return manifest.version
}

export function assertInstalledRuntimeContract(): RuntimeContract {
  return assertRuntimeContract(
    process.versions.node,
    installedVersion('@deepseek-ai/dsh-sdk-client'),
    installedVersion('@deepseek-ai/dsh'),
  )
}
