import { CheckpointState, type Checkpoint } from "../model/checkpoint.ts";
import type { Workflow, WorkflowItem } from "../model/workflow.ts";
import type {
  RevalidateWorkflowEditOptions,
  WorkflowEditDiagnostic,
  WorkflowEditImpact,
  WorkflowEditResult,
  WorkflowValidationResult,
} from "./types.ts";
import { validateWorkflow } from "./validate.ts";

const TERMINAL_STATES = new Set<Checkpoint["state"]>([
  CheckpointState.completed,
  CheckpointState.blocked,
  CheckpointState.cancelled,
  CheckpointState.needsReplan,
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validationDiagnostics(
  source: "current" | "candidate",
  validation: WorkflowValidationResult,
): WorkflowEditDiagnostic[] {
  return validation.diagnostics.map((diagnostic) => ({
    source,
    ...diagnostic,
  }));
}

function cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    state: checkpoint.state,
    updated_at: checkpoint.updated_at,
    ...(checkpoint.evidence_ref === undefined
      ? {}
      : { evidence_ref: checkpoint.evidence_ref }),
  };
}

function cloneItem(item: WorkflowItem, checkpoint: Checkpoint): WorkflowItem {
  const base = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    parent_id: item.parent_id,
    nesting_depth: item.nesting_depth,
    dependencies: Array.isArray(item.dependencies) ? [...item.dependencies] : [],
    checkpoint: cloneCheckpoint(checkpoint),
  };
  if (item.kind === "group") return { ...base, kind: "group" };
  return {
    ...base,
    kind: "leaf",
    outcome: typeof item.outcome === "string" ? item.outcome : "",
    scope: typeof item.scope === "string" ? item.scope : "",
    acceptance_criteria: Array.isArray(item.acceptance_criteria)
      ? [...item.acceptance_criteria]
      : [],
    preserved_behavior:
      typeof item.preserved_behavior === "string" ? item.preserved_behavior : "",
  };
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
  orderMatters = true,
): boolean {
  if (left.length !== right.length) return false;
  if (orderMatters) return left.every((value, index) => value === right[index]);
  const sortedLeft = [...left].sort(compareText);
  const sortedRight = [...right].sort(compareText);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

/** Checkpoints and document position are runtime/presentation data, not item semantics. */
function semanticallyEqual(left: WorkflowItem, right: WorkflowItem): boolean {
  if (
    left.kind !== right.kind ||
    left.title !== right.title ||
    left.parent_id !== right.parent_id ||
    left.nesting_depth !== right.nesting_depth ||
    !sameStringArray(left.dependencies ?? [], right.dependencies ?? [], false)
  ) {
    return false;
  }
  if (left.kind === "group" || right.kind === "group") return true;
  return (
    left.outcome === right.outcome &&
    left.scope === right.scope &&
    sameStringArray(
      left.acceptance_criteria ?? [],
      right.acceptance_criteria ?? [],
    ) &&
    left.preserved_behavior === right.preserved_behavior
  );
}

function metadataEqual(left: Workflow, right: Workflow): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.slug === right.slug &&
    left.repository.id === right.repository.id &&
    left.repository.path === right.repository.path &&
    (left.multi_repo === undefined) === (right.multi_repo === undefined)
  );
}

function reverseDependencies(workflow: Workflow): Map<string, Set<string>> {
  const dependents = new Map<string, Set<string>>();
  for (const item of workflow.items) {
    for (const dependency of item.dependencies ?? []) {
      let values = dependents.get(dependency);
      if (values === undefined) {
        values = new Set<string>();
        dependents.set(dependency, values);
      }
      values.add(item.id);
    }
  }
  return dependents;
}

function reachDependents(
  reverse: ReadonlyMap<string, ReadonlySet<string>>,
  directlyAffected: ReadonlySet<string>,
): Set<string> {
  const visited = new Set(directlyAffected);
  const reached = new Set<string>();
  const queue = [...directlyAffected].sort(compareText);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined) continue;
    for (const dependent of [...(reverse.get(id) ?? [])].sort(compareText)) {
      reached.add(dependent);
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      queue.push(dependent);
    }
  }
  return reached;
}

function transitiveDependents(
  current: Workflow,
  candidate: Workflow,
  directlyAffected: ReadonlySet<string>,
): Set<string> {
  return new Set([
    ...reachDependents(reverseDependencies(current), directlyAffected),
    ...reachDependents(reverseDependencies(candidate), directlyAffected),
  ]);
}

function stableItemOrder(current: Workflow, candidate: Workflow): string[] {
  const result = candidate.items.map((item) => item.id);
  const seen = new Set(result);
  for (const item of current.items) {
    if (!seen.has(item.id)) result.push(item.id);
  }
  return result;
}

function impactFor(
  current: Workflow,
  candidate: Workflow,
  activeItemIds: readonly string[],
): WorkflowEditImpact {
  const currentById = new Map(current.items.map((item) => [item.id, item]));
  const candidateById = new Map(candidate.items.map((item) => [item.id, item]));
  const added = candidate.items
    .filter((item) => !currentById.has(item.id))
    .map((item) => item.id);
  const removed = current.items
    .filter((item) => !candidateById.has(item.id))
    .map((item) => item.id);
  const changed = candidate.items
    .filter((item) => {
      const previous = currentById.get(item.id);
      return previous !== undefined && !semanticallyEqual(previous, item);
    })
    .map((item) => item.id);
  const directlyAffected = new Set([...added, ...removed, ...changed]);
  const dependents = transitiveDependents(current, candidate, directlyAffected);
  const affected = new Set([...directlyAffected, ...dependents]);
  const stableOrder = stableItemOrder(current, candidate);
  const inStableOrder = (ids: ReadonlySet<string>): string[] =>
    stableOrder.filter((id) => ids.has(id));
  const affectedIds = inStableOrder(affected);
  const activeSet = new Set(activeItemIds);
  const active = affectedIds.filter((id) => activeSet.has(id));
  const checkpointFor = (id: string): Checkpoint | undefined =>
    currentById.get(id)?.checkpoint ?? candidateById.get(id)?.checkpoint;
  const terminal = affectedIds.filter((id) => {
    const checkpoint = checkpointFor(id);
    return checkpoint !== undefined && TERMINAL_STATES.has(checkpoint.state);
  });
  const completed = affectedIds.filter(
    (id) => checkpointFor(id)?.state === CheckpointState.completed,
  );

  return {
    workflow_metadata_changed: !metadataEqual(current, candidate),
    added_item_ids: added,
    removed_item_ids: removed,
    semantically_changed_item_ids: changed,
    transitive_dependent_item_ids: inStableOrder(dependents),
    affected_item_ids: affectedIds,
    active_item_ids: active,
    terminal_item_ids: terminal,
    completed_item_ids: completed,
    affects_active_work: active.length > 0,
    affects_terminal_work: terminal.length > 0,
  };
}

function detachedCandidate(
  current: Workflow,
  candidate: Workflow,
): Workflow {
  const currentById = new Map(current.items.map((item) => [item.id, item]));
  const items = candidate.items.map((item) => {
    const previous = currentById.get(item.id);
    const checkpoint =
      previous !== undefined && semanticallyEqual(previous, item)
        ? previous.checkpoint
        : item.checkpoint;
    return cloneItem(item, checkpoint);
  });
  return {
    schema_version: candidate.schema_version,
    slug: candidate.slug,
    repository: { ...candidate.repository },
    ...(candidate.multi_repo === undefined ? {} : { multi_repo: [] }),
    items,
  };
}

/**
 * Validates and analyzes an in-memory live edit. Invalid inputs fail closed;
 * accepted results are detached and never infer or promote checkpoint state.
 */
export function revalidateWorkflowEdit(
  currentInput: unknown,
  candidateInput: unknown,
  options: RevalidateWorkflowEditOptions = {},
): WorkflowEditResult {
  const { active_item_ids: activeItemIds = [], ...validationOptions } = options;
  const currentValidation = validateWorkflow(currentInput, validationOptions);
  if (!currentValidation.structurally_valid) {
    return {
      accepted: false,
      reason: "invalid_current_workflow",
      diagnostics: validationDiagnostics("current", currentValidation),
    };
  }
  const candidateValidation = validateWorkflow(candidateInput, validationOptions);
  if (!candidateValidation.structurally_valid) {
    return {
      accepted: false,
      reason: "invalid_candidate_workflow",
      diagnostics: validationDiagnostics("candidate", candidateValidation),
    };
  }

  const current = currentInput as Workflow;
  const candidate = candidateInput as Workflow;
  return {
    accepted: true,
    workflow: detachedCandidate(current, candidate),
    impact: impactFor(current, candidate, activeItemIds),
    validation: candidateValidation,
  };
}
