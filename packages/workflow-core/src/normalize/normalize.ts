/**
 * Phase 1.2 normalizer: a phased tree or a flat story list becomes one
 * canonical Workflow DAG.
 *
 * Contract (see `docs/IMPLEMENTATION_PLAN.md` §7, item 1.2):
 *
 *   - A node declared a group is emitted as a group; groups never become
 *     leaves.
 *   - Only `parent_id` and `nesting_depth` are derived. Titles, ids,
 *     dependencies, and the leaf activation fields are carried through as the
 *     source wrote them.
 *   - Output is deterministic: the same input yields the same document, byte
 *     for byte. The normalizer reads no clock, no environment, and no random
 *     source, which is why `updated_at` is supplied by the caller.
 *
 * This module normalizes only. It performs no parsing, no validation, no cycle
 * detection, and no activation gating (those are 1.3 and 1.4): it does not
 * check bounds, does not resolve or reject dangling dependency references, and
 * never promotes an item beyond `planned`.
 */

import type { Checkpoint } from "../model/checkpoint.ts";
import type { Group, Leaf, Workflow, WorkflowItem } from "../model/workflow.ts";
import type {
  LeafInput,
  NormalizeInput,
  NormalizeOptions,
  WorkItemInput,
} from "./types.ts";

/** Every emitted checkpoint starts here; readiness is decided downstream. */
export const INITIAL_CHECKPOINT_STATE = "planned" as const;

function initialCheckpoint(updatedAt: string): Checkpoint {
  return { state: INITIAL_CHECKPOINT_STATE, updated_at: updatedAt };
}

function toGroup(
  input: WorkItemInput,
  parentId: string | null,
  depth: number,
  updatedAt: string,
): Group {
  return {
    id: input.id,
    kind: "group",
    title: input.title,
    parent_id: parentId,
    nesting_depth: depth,
    dependencies: [...(input.dependencies ?? [])],
    checkpoint: initialCheckpoint(updatedAt),
  };
}

function toLeaf(
  input: LeafInput,
  parentId: string | null,
  depth: number,
  updatedAt: string,
): Leaf {
  return {
    id: input.id,
    kind: "leaf",
    title: input.title,
    parent_id: parentId,
    nesting_depth: depth,
    outcome: input.outcome,
    scope: input.scope,
    acceptance_criteria: [...input.acceptance_criteria],
    dependencies: [...(input.dependencies ?? [])],
    preserved_behavior: input.preserved_behavior,
    checkpoint: initialCheckpoint(updatedAt),
  };
}

/**
 * Flatten depth-first in document order: each node is emitted immediately
 * before its own subtree, and siblings keep source order.
 */
function flatten(
  nodes: readonly WorkItemInput[],
  parentId: string | null,
  depth: number,
  updatedAt: string,
  items: WorkflowItem[],
): void {
  for (const node of nodes) {
    if (node.kind === "group") {
      items.push(toGroup(node, parentId, depth, updatedAt));
      flatten(node.items, node.id, depth + 1, updatedAt, items);
      continue;
    }
    items.push(toLeaf(node, parentId, depth, updatedAt));
  }
}

/**
 * Normalize a phased tree or a flat story list into the canonical workflow
 * DAG.
 *
 * Phased input flattens depth-first with groups preserved as groups. Flat
 * input becomes root-level leaves in source order: no synthetic group is
 * introduced to hold them.
 */
export function normalize(
  input: NormalizeInput,
  options: NormalizeOptions,
): Workflow {
  const nodes = input.form === "phased" ? input.groups : input.stories;
  const items: WorkflowItem[] = [];
  flatten(nodes, null, 0, options.updated_at, items);

  return {
    schema_version: "1",
    slug: input.slug,
    repository: { id: input.repository.id, path: input.repository.path },
    items,
  };
}
