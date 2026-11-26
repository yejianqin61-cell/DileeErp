import type { AgentSnapshotRun } from "./agent-chat";

export type CacheStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

export type CacheAccessLevel = "full" | "operational";

export type CachedSession = { session_id: string; runs: AgentSnapshotRun[] };

const VERSION = 1;
const FULL_ROLE_KEYS = ["laoban", "caiwu"];
const TERMINAL_STATES = ["completed", "cancelled", "failed"];

const keyOf = (userId: string) => `session:${userId}`;

export function cacheAccessLevel(roleKeys: readonly string[]): CacheAccessLevel {
  return roleKeys.some((key) => FULL_ROLE_KEYS.includes(key)) ? "full" : "operational";
}

export async function clearCachedSession(store: CacheStore, userId: string): Promise<void> {
  try {
    await store.delete(keyOf(userId));
  } catch {
    return;
  }
}

export async function writeCachedSession(store: CacheStore, userId: string, sessionId: string, runs: AgentSnapshotRun[]): Promise<void> {
  const kept = runs.filter((run) => run.access_level === "operational" && TERMINAL_STATES.includes(run.state));
  if (!kept.length) return clearCachedSession(store, userId);
  try {
    await store.set(keyOf(userId), { v: VERSION, session_id: sessionId, runs: kept });
  } catch {
    return;
  }
}

export async function readCachedSession(store: CacheStore, userId: string, level: CacheAccessLevel): Promise<CachedSession | null> {
  try {
    const value = await store.get(keyOf(userId));
    if (value === undefined || value === null) return null;
    if (!isStoredSession(value)) {
      await clearCachedSession(store, userId);
      return null;
    }
    const runs = level === "full" ? value.runs : value.runs.filter((run) => run.access_level === "operational");
    return runs.length ? { session_id: value.session_id, runs } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStoredRun(value: unknown): value is AgentSnapshotRun {
  return isRecord(value)
    && ["run_id", "state", "question", "answer", "access_level"].every((field) => typeof value[field] === "string")
    && typeof value.latest_seq === "number"
    && Array.isArray(value.sources)
    && value.sources.every(isRecord);
}

function isStoredSession(value: unknown): value is CachedSession & { v: number } {
  return isRecord(value) && value.v === VERSION && typeof value.session_id === "string" && Array.isArray(value.runs) && value.runs.every(isStoredRun);
}
