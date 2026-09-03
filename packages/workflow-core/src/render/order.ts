import type { WorkflowItem } from "../model/workflow.ts";

/** An item placed in canonical render order, with its tree position resolved. */
export interface OrderedItem {
  item: WorkflowItem;
  /** Depth derived from the parent chain, not from the declared field. */
  depth: number;
  /** Nearest ancestor of kind `group`, or null for ungrouped items. */
  group: WorkflowItem | null;
}

const CHUNKS = /\d+|\D+/g;

/**
 * Natural, locale-independent id comparison so `1.2` sorts before `1.10`.
 * Falls back to code-unit order, which makes the result a total order.
 */
export function compareIds(left: string, right: string): number {
  const a = left.match(CHUNKS) ?? [];
  const b = right.match(CHUNKS) ?? [];
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const chunkA = a[index];
    const chunkB = b[index];
    if (chunkA === undefined) return -1;
    if (chunkB === undefined) return 1;
    if (chunkA === chunkB) continue;

    const numericA = /^\d+$/.test(chunkA);
    const numericB = /^\d+$/.test(chunkB);
    if (numericA && numericB) {
      const difference = Number(chunkA) - Number(chunkB);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    return chunkA < chunkB ? -1 : 1;
  }

  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSiblings(left: WorkflowItem, right: WorkflowItem): number {
  const byId = compareIds(left.id, right.id);
  if (byId !== 0) return byId;
  if (left.kind !== right.kind) return left.kind === "group" ? -1 : 1;
  if (left.title === right.title) return 0;
  return left.title < right.title ? -1 : 1;
}

/**
 * Depth-first order: roots first, each parent immediately followed by its
 * subtree, siblings sorted naturally by id. The result depends only on the set
 * of items, never on their order in `workflow.items`.
 *
 * Items whose `parent_id` names a missing item are treated as roots, and items
 * trapped in a parent cycle are appended in id order, so nothing is dropped.
 */
export function canonicalOrder(items: readonly WorkflowItem[]): OrderedItem[] {
  const byId = new Map<string, WorkflowItem>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  const roots: WorkflowItem[] = [];
  const children = new Map<string, WorkflowItem[]>();
  for (const item of items) {
    const parentId = item.parent_id;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (parent === undefined || parent === item) {
      roots.push(item);
      continue;
    }
    const bucket = children.get(parent.id);
    if (bucket === undefined) children.set(parent.id, [item]);
    else bucket.push(item);
  }

  const ordered: OrderedItem[] = [];
  const visited = new Set<WorkflowItem>();

  const walk = (item: WorkflowItem, depth: number, group: WorkflowItem | null): void => {
    if (visited.has(item)) return;
    visited.add(item);
    ordered.push({ item, depth, group });
    const nextGroup = item.kind === "group" ? item : group;
    const bucket = children.get(item.id) ?? [];
    for (const child of [...bucket].sort(compareSiblings)) {
      walk(child, depth + 1, nextGroup);
    }
  };

  for (const root of [...roots].sort(compareSiblings)) walk(root, 0, null);

  const stranded = items.filter((item) => !visited.has(item));
  for (const item of [...stranded].sort(compareSiblings)) walk(item, 0, null);

  return ordered;
}
