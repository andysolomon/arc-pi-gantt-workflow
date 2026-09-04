import { isMandatoryEventGate } from "../events/validate.ts";
import type { Leaf, Workflow, WorkflowItem } from "../model/workflow.ts";
import { validateWorkflow } from "../validate/validate.ts";
import {
  WAIT_POLICIES,
  type ConcurrencyOptions,
  type QueuedQuestion,
  type QuestionQueueOptions,
  type SchedulerConfig,
  type SchedulerOptions,
  type WaitPolicy,
  type WaitPolicyState,
} from "./types.ts";

export const DEFAULT_SCHEDULER_CONCURRENCY = 4;
export const MAX_SCHEDULER_CONCURRENCY = 200;
export const DEFAULT_WAIT_POLICY: WaitPolicy =
  "continue-independent-authorized-branches";

function isWaitPolicy(value: unknown): value is WaitPolicy {
  return (WAIT_POLICIES as readonly unknown[]).includes(value);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function resolveSchedulerConfig(
  options: SchedulerOptions = {},
): SchedulerConfig {
  const concurrency = options.concurrency ?? DEFAULT_SCHEDULER_CONCURRENCY;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_SCHEDULER_CONCURRENCY
  ) {
    throw new RangeError(
      `concurrency must be a safe integer between 1 and ${MAX_SCHEDULER_CONCURRENCY}`,
    );
  }

  const waitPolicy = options.wait_policy ?? DEFAULT_WAIT_POLICY;
  if (!isWaitPolicy(waitPolicy)) {
    throw new RangeError(`wait_policy must be one of: ${WAIT_POLICIES.join(", ")}`);
  }

  return { concurrency, wait_policy: waitPolicy };
}

/**
 * Computes runnable leaves without changing checkpoints. Invalid DAGs fail closed.
 * Completed, blocked, cancelled, and needs-replan leaves are never re-scheduled.
 */
export function computeReadySet(workflow: Workflow): readonly Leaf[] {
  const validation = validateWorkflow(workflow);
  if (!validation.structurally_valid) return [];

  const activated = new Set(
    validation.readiness
      .filter((readiness) => readiness.ready)
      .map((readiness) => readiness.leaf_id),
  );
  const itemsById = new Map(workflow.items.map((item) => [item.id, item]));

  return workflow.items.filter((item): item is Leaf => {
    if (item.kind !== "leaf" || !activated.has(item.id)) return false;
    if (item.checkpoint.state !== "planned" && item.checkpoint.state !== "ready") {
      return false;
    }
    return item.dependencies.every(
      (dependency) => itemsById.get(dependency)?.checkpoint.state === "completed",
    );
  });
}

/** Applies the configured cap in stable candidate order, accounting for live work. */
export function applyConcurrencyLimit<T>(
  candidates: readonly T[],
  options: ConcurrencyOptions = {},
): readonly T[] {
  const { concurrency } = resolveSchedulerConfig(
    options.concurrency === undefined ? {} : { concurrency: options.concurrency },
  );
  const activeCount = options.active_count ?? 0;
  assertNonNegativeSafeInteger(activeCount, "active_count");
  return candidates.slice(0, Math.max(0, concurrency - activeCount));
}

function remainingDependencies(
  workflow: Workflow,
): ReadonlyMap<string, ReadonlySet<string>> {
  const dependencies = new Map<string, Set<string>>();
  const itemsById = new Map(workflow.items.map((item) => [item.id, item]));
  for (const item of workflow.items) dependencies.set(item.id, new Set());
  for (const item of workflow.items) {
    for (const dependencyId of item.dependencies) {
      const dependencyItem = itemsById.get(dependencyId);
      if (
        item.checkpoint.state === "completed" ||
        item.checkpoint.state === "cancelled" ||
        dependencyItem?.checkpoint.state === "completed" ||
        dependencyItem?.checkpoint.state === "cancelled"
      ) {
        continue;
      }
      dependencies.get(item.id)?.add(dependencyId);
    }
  }
  return dependencies;
}

function reachesAnyDependency(
  start: string,
  targets: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (targets.has(start)) return true;
  const visited = new Set([start]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) continue;
    for (const dependency of dependencies.get(current) ?? []) {
      if (targets.has(dependency)) return true;
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      queue.push(dependency);
    }
  }
  return false;
}

function dependencyRelated(
  candidate: string,
  waiting: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (reachesAnyDependency(candidate, waiting, dependencies)) return true;
  const candidateTarget = new Set([candidate]);
  for (const waitingItem of waiting) {
    if (reachesAnyDependency(waitingItem, candidateTarget, dependencies)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves waiting behavior over a precomputed ready-set. The default continues
 * only authorized leaves whose dependency branch is unrelated to waiting work.
 */
export function resolveWaitPolicy(
  workflow: Workflow,
  ready: readonly Leaf[],
  state: WaitPolicyState,
  policy: WaitPolicy = DEFAULT_WAIT_POLICY,
): readonly Leaf[] {
  if (!isWaitPolicy(policy)) {
    throw new RangeError(`wait_policy must be one of: ${WAIT_POLICIES.join(", ")}`);
  }

  const authorized = new Set(state.authorized_item_ids);
  const waiting = new Set(state.waiting_item_ids ?? []);
  const candidates = ready.filter((leaf) => authorized.has(leaf.id));
  if (waiting.size === 0) return candidates;
  if (policy === "pause-all-authorized-branches") return [];

  const dependencies = remainingDependencies(workflow);
  return candidates.filter(
    (leaf) => !dependencyRelated(leaf.id, waiting, dependencies),
  );
}

function remainingItems(workflow: Workflow): WorkflowItem[] {
  return workflow.items.filter(
    (item) =>
      item.checkpoint.state !== "completed" &&
      item.checkpoint.state !== "cancelled",
  );
}

/** Returns one deterministic longest path through the remaining DAG. */
export function computeCriticalPath(workflow: Workflow): readonly string[] {
  const items = remainingItems(workflow);
  if (items.length === 0) return [];

  const sourceIndex = new Map(
    workflow.items.map((item, index) => [item.id, index]),
  );
  const remainingIds = new Set(items.map((item) => item.id));
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const item of items) {
    dependents.set(item.id, []);
    indegree.set(item.id, 0);
  }
  for (const item of items) {
    for (const dependency of item.dependencies) {
      if (!remainingIds.has(dependency)) continue;
      dependents.get(dependency)?.push(item.id);
      indegree.set(item.id, (indegree.get(item.id) ?? 0) + 1);
    }
  }

  const bySourceOrder = (left: string, right: string): number =>
    (sourceIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (sourceIndex.get(right) ?? Number.MAX_SAFE_INTEGER);
  for (const values of dependents.values()) values.sort(bySourceOrder);

  const queue = items
    .filter((item) => indegree.get(item.id) === 0)
    .map((item) => item.id);
  const order: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined) continue;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  // Scheduling only accepts valid DAGs, but a direct caller still gets a safe result.
  if (order.length !== items.length) return [];

  const distance = new Map<string, number>();
  const nextItem = new Map<string, string>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index];
    if (id === undefined) continue;
    let bestDistance = 1;
    let bestNext: string | undefined;
    for (const dependent of dependents.get(id) ?? []) {
      const candidateDistance = 1 + (distance.get(dependent) ?? 1);
      if (candidateDistance > bestDistance) {
        bestDistance = candidateDistance;
        bestNext = dependent;
      }
    }
    distance.set(id, bestDistance);
    if (bestNext !== undefined) nextItem.set(id, bestNext);
  }

  let start = items[0]?.id;
  for (const item of items) {
    if ((distance.get(item.id) ?? 1) > (distance.get(start ?? "") ?? 0)) {
      start = item.id;
    }
  }
  if (start === undefined) return [];

  const path: string[] = [];
  for (let current: string | undefined = start; current !== undefined; ) {
    path.push(current);
    current = nextItem.get(current);
  }
  return path;
}

/**
 * Orders queue metadata only: UI pick, then mandatory gates, then questions on
 * the current critical path, then stable FIFO order.
 */
export function prioritizeQuestionQueue<T extends QueuedQuestion>(
  workflow: Workflow,
  questions: readonly T[],
  options: QuestionQueueOptions = {},
): readonly T[] {
  const critical = new Set(
    options.critical_path_item_ids ?? computeCriticalPath(workflow),
  );
  const uiPick = options.ui_pick;

  return questions
    .map((question, fifo) => ({ question, fifo }))
    .sort((left, right) => {
      const leftPicked = left.question.question_id === uiPick ? 0 : 1;
      const rightPicked = right.question.question_id === uiPick ? 0 : 1;
      if (leftPicked !== rightPicked) return leftPicked - rightPicked;

      const priority = (question: QueuedQuestion): number => {
        if (isMandatoryEventGate(question.gate)) return 0;
        return critical.has(question.item_id) ? 1 : 2;
      };
      return priority(left.question) - priority(right.question) || left.fifo - right.fifo;
    })
    .map(({ question }) => question);
}
