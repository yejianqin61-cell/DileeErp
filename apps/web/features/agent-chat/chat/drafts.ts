import type { CacheAccessLevel, CacheStore } from "../../../lib/agent-cache";

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export type DraftContext = { userId: string; level: CacheAccessLevel; store: CacheStore; session: SessionStore | null };

const PREFIX = "drafts:";
const KEPT_PREFIX = "branches:";

const keyOf = (userId: string, sessionId: string | null) => `${PREFIX}${userId}:${sessionId ?? "new"}`;

export function browserSessionStore(): SessionStore | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export async function loadDraft(context: DraftContext, sessionId: string | null): Promise<string> {
  const key = keyOf(context.userId, sessionId);
  try {
    const value = context.level === "full" ? context.session?.getItem(key) : await context.store.get(key);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export async function saveDraft(context: DraftContext, sessionId: string | null, text: string): Promise<void> {
  const key = keyOf(context.userId, sessionId);
  try {
    if (context.level === "full") {
      if (text) context.session?.setItem(key, text);
      else context.session?.removeItem(key);
    } else if (text) await context.store.set(key, text);
    else await context.store.delete(key);
  } catch {
    return;
  }
}

function removeDrafts(session: SessionStore): void {
  try {
    const keys = Array.from({ length: session.length }, (_, index) => session.key(index));
    for (const key of keys) if (key?.startsWith(PREFIX)) session.removeItem(key);
  } catch {
    return;
  }
}

export async function clearPrivateData(store: CacheStore | null, session: SessionStore | null): Promise<void> {
  if (session) removeDrafts(session);
  if (!store) return;
  try {
    const keys = await store.keys();
    await Promise.all(keys.filter((key) => !key.startsWith(KEPT_PREFIX)).map((key) => store.delete(key)));
  } catch {
    return;
  }
}
