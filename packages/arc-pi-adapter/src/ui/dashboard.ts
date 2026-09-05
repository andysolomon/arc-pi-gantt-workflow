import {
  DEFAULT_SCHEDULER_CONCURRENCY,
  resolveSchedulerConfig,
  type CheckpointState,
  type WorkflowItem,
} from "@arc/workflow-core";
import {
  renderDashboardTui,
  renderPassiveWidget,
} from "./render.ts";
import type {
  DashboardCounts,
  DashboardItem,
  DashboardRuntimeState,
  DashboardSnapshot,
  QuestionQueueLike,
  WorkflowDashboard,
  WorkflowDashboardOptions,
  WorkflowSource,
} from "./types.ts";

const CHECKPOINT_KEYS: readonly CheckpointState[] = Object.freeze([
  "planned",
  "ready",
  "completed",
  "blocked",
  "cancelled",
  "needs-replan",
]);
const MAX_LIVE_PROGRESS_LENGTH = 160;

function boundedProgress(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_LIVE_PROGRESS_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_LIVE_PROGRESS_LENGTH - 1)}…`;
}

function workflowFrom(source: WorkflowSource) {
  return typeof source === "function" ? source() : source;
}

function ids(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(values ?? []);
}

function questionCountByItem(
  questions: readonly DashboardSnapshot["questions"][number][],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const question of questions) {
    counts.set(question.item_id, (counts.get(question.item_id) ?? 0) + 1);
  }
  return counts;
}

function buildCounts(
  items: readonly WorkflowItem[],
  active: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
  questionTotal: number,
): DashboardCounts {
  const counts: Record<CheckpointState, number> = {
    planned: 0,
    ready: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
    "needs-replan": 0,
  };
  let groups = 0;
  let leaves = 0;
  let activeLeaves = 0;
  let waitingLeaves = 0;
  for (const item of items) {
    counts[item.checkpoint.state] += 1;
    if (item.kind === "group") {
      groups += 1;
      continue;
    }
    leaves += 1;
    if (active.has(item.id)) activeLeaves += 1;
    if (waiting.has(item.id)) waitingLeaves += 1;
  }
  return Object.freeze({
    total: items.length,
    groups,
    leaves,
    planned: counts.planned,
    ready: counts.ready,
    completed: counts.completed,
    blocked: counts.blocked,
    cancelled: counts.cancelled,
    needs_replan: counts["needs-replan"],
    active: activeLeaves,
    waiting: waitingLeaves,
    questions: questionTotal,
  });
}

function freezeQuestions(
  questions: readonly DashboardSnapshot["questions"][number][],
): readonly DashboardSnapshot["questions"][number][] {
  return Object.freeze(questions.map((question) => Object.freeze({ ...question })));
}

function makeSnapshot(
  source: WorkflowSource,
  runtime: DashboardRuntimeState,
  queue: QuestionQueueLike | undefined,
  configuredConcurrency: number | undefined,
  uiPick: string | undefined,
  now: () => Date,
): DashboardSnapshot {
  const workflow = workflowFrom(source);
  const concurrency = runtime.concurrency ?? configuredConcurrency ?? DEFAULT_SCHEDULER_CONCURRENCY;
  const config = resolveSchedulerConfig({ concurrency });
  const questions = freezeQuestions(
    queue === undefined
      ? runtime.questions ?? []
      : queue.snapshot(),
  );
  const active = ids(runtime.active_item_ids);
  const waiting = ids(runtime.waiting_item_ids);
  const questionCounts = questionCountByItem(questions);
  const items: DashboardItem[] = workflow.items.map((item) => {
    const progress = runtime.progress_by_item_id?.[item.id];
    return Object.freeze({
      id: item.id,
      title: item.title,
      kind: item.kind,
      state: item.checkpoint.state,
      parent_id: item.parent_id,
      nesting_depth: item.nesting_depth,
      active: item.kind === "leaf" && active.has(item.id),
      waiting: item.kind === "leaf" && waiting.has(item.id),
      ...(progress === undefined || boundedProgress(progress).length === 0
        ? {}
        : { progress: boundedProgress(progress) }),
      question_count: questionCounts.get(item.id) ?? 0,
    });
  });
  const counts = buildCounts(workflow.items, active, waiting, questions.length);
  return Object.freeze({
    workflow_slug: workflow.slug,
    repository_id: workflow.repository.id,
    generated_at: now().toISOString(),
    concurrency_limit: config.concurrency,
    available_slots: Math.max(0, config.concurrency - counts.active),
    counts,
    items: Object.freeze(items),
    questions,
    ...(uiPick === undefined ? {} : { ui_pick: uiPick }),
  });
}

/** Build the stateful, adapter-neutral dashboard controller. */
export function createWorkflowDashboard(
  options: WorkflowDashboardOptions,
): WorkflowDashboard {
  if (
    options.workflow === undefined ||
    options.workflow === null ||
    (typeof options.workflow !== "function" && typeof options.workflow !== "object")
  ) {
    throw new TypeError("WorkflowDashboardOptions.workflow is required");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("WorkflowDashboardOptions.now must be a function");
  }
  // Resolve once at construction so invalid static configuration fails before
  // the dashboard is registered with a host.
  if (options.concurrency !== undefined) {
    resolveSchedulerConfig({ concurrency: options.concurrency });
  }
  const now = options.now ?? (() => new Date());
  const source = options.workflow;
  const queue = options.queue;
  let runtime: DashboardRuntimeState = { ...(options.runtime ?? {}) };
  let uiPick: string | undefined;
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();

  function snapshot(): DashboardSnapshot {
    return makeSnapshot(source, runtime, queue, options.concurrency, uiPick, now);
  }

  function notify(): void {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        // A passive observer must not prevent the controller from notifying
        // the remaining observers or updating its own state.
      }
    }
  }

  return {
    snapshot,

    update(nextRuntime: DashboardRuntimeState): void {
      runtime = { ...runtime, ...nextRuntime };
      notify();
    },

    subscribe(listener: (current: DashboardSnapshot) => void): () => void {
      if (typeof listener !== "function") {
        throw new TypeError("dashboard listener must be a function");
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    pickQuestion(questionId: string): DashboardSnapshot {
      if (typeof questionId !== "string" || questionId.length === 0) {
        throw new TypeError("questionId must be non-empty");
      }
      const current = snapshot();
      const question = current.questions.find((entry) => entry.question_id === questionId);
      if (question === undefined || question.status !== "pending") {
        throw new Error(`unknown pending question: ${questionId}`);
      }
      // Let the queue validate and record the selection before exposing it in
      // the dashboard, so a rejected queue update cannot leave stale UI state.
      queue?.setUiPick(questionId);
      uiPick = questionId;
      notify();
      return snapshot();
    },

    renderTui(): string {
      return renderDashboardTui(snapshot());
    },

    renderWidget(): string {
      return renderPassiveWidget(snapshot());
    },
  };
}

/** Keep the item type referenced in generated declarations for host adapters. */
export type { DashboardItem };

/** The canonical checkpoint key order used by the dashboard projections. */
export { CHECKPOINT_KEYS };
