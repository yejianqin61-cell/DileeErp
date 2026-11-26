/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
export type BranchState = { parents: Record<string, string | null>; selected: Record<string, string> };

export type MessageVersions = { ids: string[]; index: number };

export const EMPTY_BRANCHES: BranchState = { parents: {}, selected: {} };

export const MAX_CONTEXT = 200;

const ROOT = "";
const keyOf = (parent: string | null) => parent ?? ROOT;

export function parentOf(ids: readonly string[], state: BranchState, id: string): string | null {
  const position = ids.indexOf(id);
  const stored = Object.hasOwn(state.parents, id) ? state.parents[id] : undefined;
  if (stored === null) return null;
  if (stored !== undefined && ids.indexOf(stored) >= 0 && ids.indexOf(stored) < position) return stored;
  return ids[position - 1] ?? null;
}

const childrenOf = (ids: readonly string[], state: BranchState, parent: string | null) => ids.filter((id) => parentOf(ids, state, id) === parent);

export function visiblePath(ids: readonly string[], state: BranchState): string[] {
  const path: string[] = [];
  let parent: string | null = null;
  for (;;) {
    const children = childrenOf(ids, state, parent);
    if (!children.length) return path;
    const chosen: string = state.selected[keyOf(parent)];
    const next: string = children.includes(chosen) ? chosen : children[children.length - 1];
    path.push(next);
    parent = next;
  }
}

export function versionsOf(ids: readonly string[], state: BranchState, id: string): MessageVersions {
  const siblings = childrenOf(ids, state, parentOf(ids, state, id));
  return { ids: siblings, index: siblings.indexOf(id) };
}

export function addBranch(state: BranchState, id: string, parent: string | null): BranchState {
  return { parents: { ...state.parents, [id]: parent }, selected: { ...state.selected, [keyOf(parent)]: id } };
}

export function selectVersion(ids: readonly string[], state: BranchState, id: string): BranchState {
  return { ...state, selected: { ...state.selected, [keyOf(parentOf(ids, state, id))]: id } };
}

export function ancestryOf(ids: readonly string[], state: BranchState, id: string | null): string[] {
  const chain: string[] = [];
  for (let current = id; current !== null; current = parentOf(ids, state, current)) chain.unshift(current);
  return chain.slice(-MAX_CONTEXT);
}

export function revealing(ids: readonly string[], state: BranchState, id: string): BranchState {
  return ancestryOf(ids, state, id).reduce((next, step) => selectVersion(ids, next, step), state);
}

export function isBranchState(value: unknown): value is BranchState {
  const isRecord = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);
  return isRecord(value) && isRecord(value.parents) && isRecord(value.selected)
    && Object.values(value.parents).every((parent) => parent === null || typeof parent === "string")
    && Object.values(value.selected).every((child) => typeof child === "string");
}
