/**
 * Phase 5.2: sequential runner.
 *
 * The sequential runner is the production wiring for Phase 5 (M1 vertical
 * slice). It composes:
 *
 *   - a scheduler with concurrency forced to 1 (`computeReadySet` plus
 *     `resolveSchedulerConfig`),
 *   - the worktree manager,
 *   - the persisted child session lifecycle,
 *   - the integrator (verify, commit, ask, cherry-pick, auto-resolve,
 *     reset, integration verify),
 *   - the completion orchestrator (atomic YAML/progress/Gantt write plus
 *     optional risk-based review),
 *
 * and drives them leaf by leaf against an in-memory workflow. The runner
 * exposes a single `run` call so the integration test (Phase 5.3) and any
 * future TUI command can drive it with the same surface.
 *
 * Failure model:
 *
 *   - any leaf that fails verification, fails the broker ask, fails the
 *     cherry-pick or auto-resolve loop, fails the integration verify, fails
 *     the atomic write, or fails the risk review surfaces as
 *     `SequentialRunnerLeafStatus` `needs-replan` for that leaf, and the
 *     runner keeps going to drain the ready set;
 *   - a leaf that runs end-to-end without errors is marked `completed`
 *     and the runner advances;
 *   - the runner returns once the ready set is empty AND every leaf that
 *     ever entered the ready set has reached a terminal state
 *     (`completed`, `blocked`, `cancelled`, or `needs-replan`). Terminal
 *     leaves are not re-scheduled.
 *
 * No remote push, GitHub mutation, or deploy is ever performed.
 */

import {
  CheckpointState,
  computeReadySet,
  resolveSchedulerConfig,
  type Leaf,
  type Workflow,
  type WorkflowItem,
  type WorktreeHandle,
  type WorktreeManager,
  type IntegrationAutoResolveStrategy,
} from "@arc/workflow-core";

import {
  createIntegratorAdapter,
  type CreateIntegratorAdapterOptions,
  type ProcessInvoker,
} from "./integrate/index.ts";

import { executeCompletion } from "./complete/index.ts";
import type {
  AtomicWorkflowWriter,
  CompletionDecision,
  RiskReviewPort,
  WorkflowPaths,
} from "./complete/index.ts";

import type { AskOperatorFn, BrokerJournal } from "./questions/index.ts";

import {
  type AcquiredSession,
  type ChildProfileId,
  type SessionLifecycle,
} from "./sessions/index.ts";

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

export type CompletionRiskLevel = "low" | "medium" | "high";

export type SequentialRunnerLeafStatus =
  | "completed"
  | "needs-replan"
  | "blocked"
  | "cancelled";

export interface SequentialRunnerLeafOutcome {
  readonly itemId: string;
  readonly status: SequentialRunnerLeafStatus;
  readonly risk: CompletionRiskLevel;
  readonly commit?: { readonly hash: string };
  readonly reason?: string;
  readonly worktreePath: string | null;
  readonly sessionPath: string;
}

export interface SequentialRunnerOutcome {
  readonly leaves: readonly SequentialRunnerLeafOutcome[];
  readonly workflow: Workflow;
}

// ---------------------------------------------------------------------------
// Worker port
// ---------------------------------------------------------------------------

/**
 * The simulated worker step. In production the controller hands the
 * worktree path and leaf contract to the orchestrator bridge; in the M1
 * fixture the runner injects a worker that deterministically writes the
 * expected `greeting.ts` so the vertical slice stays self-contained.
 *
 * Returning an `Integrator`-compatible failure surface keeps the runner
 * honest: a worker that throws fails the leaf with `needs-replan` exactly
 * the same way a real orchestrator failure would.
 */
export interface SequentialWorker {
  /**
   * Run the worker step for one leaf inside its worktree. The leaf is
   * ready to be integrated when this resolves. Returning void signals
   * success; throwing signals a worker failure.
   */
  run(input: {
    readonly workflow: Workflow;
    readonly leaf: Leaf;
    readonly worktreePath: string;
    readonly sessionPath: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runner construction
// ---------------------------------------------------------------------------

export interface SequentialRunnerPaths {
  readonly workflowYaml: string;
  readonly progressText: string;
  readonly ganttText: string;
  readonly sessionDir: string;
  readonly worktreesRoot: string;
}

export interface SequentialRunnerOptions<Session = unknown, Options = unknown> {
  readonly workflow: Workflow;
  readonly paths: SequentialRunnerPaths;
  readonly now: () => Date;
  readonly worker: SequentialWorker;
  readonly lifecycle: SessionLifecycle<Session, Options>;
  readonly worktreeManager: WorktreeManager;
  readonly writer: AtomicWorkflowWriter;
  readonly review: RiskReviewPort;
  readonly ask: AskOperatorFn;
  readonly journal: BrokerJournal;
  readonly integrationBranch: string;
  /**
   * Absolute path to the integration checkout (the original repo on
   * `integrationBranch`). The cherry-pick port applies commits here, not
   * into the leaf worktree. Defaults to the worktreesRoot parent.
   */
  readonly repositoryRoot?: string;
  readonly invoker?: ProcessInvoker;
  readonly autoResolve?: {
    readonly strategy?: IntegrationAutoResolveStrategy;
    readonly maxAttempts?: number;
  };
  readonly verifyCommand?: readonly [string, ...string[]];
  /** Override the worktree session cwd (defaults to the worktree path). */
  readonly sessionCwd?: (leaf: Leaf, worktreePath: string) => string;
}

interface RunnerInternals {
  workflow: Workflow;
  outcomes: SequentialRunnerLeafOutcome[];
}

function renderContextFromNow(now: () => Date) {
  return { generated_at: now().toISOString() };
}

function isTerminal(state: string): boolean {
  return (
    state === CheckpointState.completed ||
    state === CheckpointState.blocked ||
    state === CheckpointState.cancelled ||
    state === CheckpointState.needsReplan
  );
}

function terminalSeen(workflow: Workflow): Set<string> {
  const seen = new Set<string>();
  for (const item of workflow.items) {
    if (isTerminal(item.checkpoint.state)) seen.add(item.id);
  }
  return seen;
}

async function runOneLeaf<Session, Options>(
  options: SequentialRunnerOptions<Session, Options>,
  internals: RunnerInternals,
  leaf: Leaf,
): Promise<SequentialRunnerLeafOutcome> {
  const sessionProfileId: ChildProfileId = "implement";

  // 1) Acquire the worktree.
  const worktree: WorktreeHandle = await options.worktreeManager.acquire(
    leaf.id,
    options.workflow.slug,
  );
  if (worktree.path === null) {
    return {
      itemId: leaf.id,
      status: "needs-replan",
      risk: "low",
      reason: "worktree_acquire_returned_null_path",
      worktreePath: null,
      sessionPath: "",
    };
  }

  // 2) Acquire the persisted child session.
  const sessionCwd = options.sessionCwd
    ? options.sessionCwd(leaf, worktree.path)
    : worktree.path;

  let session: AcquiredSession<Session>;
  try {
    session = await options.lifecycle.acquire({
      workflowSlug: options.workflow.slug,
      leaf: leaf.id,
      cwd: sessionCwd,
      profileId: sessionProfileId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      itemId: leaf.id,
      status: "needs-replan",
      risk: "low",
      reason: `session_failed: ${message}`,
      worktreePath: worktree.path,
      sessionPath: "",
    };
  }

  // 3) Run the worker (orchestrator-equivalent step).
  try {
    await options.worker.run({
      workflow: internals.workflow,
      leaf,
      worktreePath: worktree.path,
      sessionPath: session.record.sessionPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      itemId: leaf.id,
      status: "needs-replan",
      risk: "low",
      reason: `worker_threw: ${message}`,
      worktreePath: worktree.path,
      sessionPath: session.record.sessionPath,
    };
  }

  // 4) Run the integrator (verify, commit, ask, cherry-pick).
  const adapterOptions: CreateIntegratorAdapterOptions = {
    workflowSlug: options.workflow.slug,
    itemId: leaf.id,
    // Use the leaf id as the session id so the broker can record it as
    // safe journal metadata (absolute paths fail the metadata pattern).
    sessionId: `${options.workflow.slug}:${leaf.id}`,
    worktreePath: worktree.path,
    repositoryRoot: options.repositoryRoot ?? worktree.path,
    integrationBranch: options.integrationBranch,
    commitSubject: `arc(wf:${options.workflow.slug}): ${leaf.id} ${leaf.title}`.slice(0, 200),
    ask: options.ask,
    journal: options.journal,
    ...(options.invoker !== undefined ? { invoker: options.invoker } : {}),
    ...(options.verifyCommand !== undefined ? { verifyCommand: options.verifyCommand } : {}),
    ...(options.autoResolve !== undefined
      ? {
          integration: {
            question: `Cherry-pick commit for ${leaf.id} into ${options.integrationBranch}?`,
            cherryPickDescription: `Apply the local commit onto ${options.integrationBranch}.`,
            skipDescription: `Leave the local commit in the worktree and mark ${leaf.id} blocked from integration.`,
            auto_resolve: options.autoResolve,
          },
        }
      : {}),
  };
  const { integrator } = createIntegratorAdapter(adapterOptions);
  const integrateResult = await integrator.run();
  if (!integrateResult.ok) {
    return {
      itemId: leaf.id,
      status: "needs-replan",
      risk: "high",
      reason: `integrate_failed: phase=${integrateResult.phase}`,
      worktreePath: worktree.path,
      sessionPath: session.record.sessionPath,
    };
  }

  // 5) Run completion (atomic write + optional risk review).
  const completionPaths: WorkflowPaths = {
    workflowYaml: options.paths.workflowYaml,
    progressText: options.paths.progressText,
    ganttText: options.paths.ganttText,
  };
  const decision: CompletionDecision = await executeCompletion(
    internals.workflow,
    integrateResult,
    {
      paths: completionPaths,
      renderContext: renderContextFromNow(options.now),
      writer: options.writer,
      review: options.review,
      now: options.now,
    },
  );
  if (decision.decision !== "complete") {
    const status: SequentialRunnerLeafStatus =
      decision.decision === "needs-replan" ? "needs-replan" : "blocked";
    return {
      itemId: leaf.id,
      status,
      risk: decision.risk,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      worktreePath: worktree.path,
      sessionPath: session.record.sessionPath,
    };
  }

  // Persist the new workflow into internals so the next iteration sees the
  // updated checkpoint.
  internals.workflow = decision.workflow;
  return {
    itemId: leaf.id,
    status: "completed",
    risk: decision.risk,
    ...(integrateResult.commit ? { commit: integrateResult.commit } : {}),
    worktreePath: worktree.path,
    sessionPath: session.record.sessionPath,
  };
}

function updateLeaf(
  workflow: Workflow,
  itemId: string,
  status: SequentialRunnerLeafStatus,
): Workflow {
  const newItems: WorkflowItem[] = workflow.items.map((item) => {
    if (item.id !== itemId) return item;
    if (item.kind !== "leaf") return item;
    const nextState =
      status === "completed"
        ? CheckpointState.completed
        : status === "needs-replan"
          ? CheckpointState.needsReplan
          : status === "cancelled"
            ? CheckpointState.cancelled
            : CheckpointState.blocked;
    return {
      ...item,
      checkpoint: { ...item.checkpoint, state: nextState },
    };
  });
  return { ...workflow, items: newItems };
}

/**
 * Build a sequential runner. The runner is single-shot per workflow: each
 * `run()` represents one full M1 vertical slice attempt.
 */
export function createSequentialRunner<Session = unknown, Options = unknown>(
  options: SequentialRunnerOptions<Session, Options>,
): { run(): Promise<SequentialRunnerOutcome> } {
  // The M1 gate contract: concurrency is forced to 1. We resolve the
  // scheduler config eagerly so a caller that accidentally sets concurrency
  // > 1 fails closed instead of silently racing.
  const config = resolveSchedulerConfig({ concurrency: 1 });
  if (config.concurrency !== 1) {
    throw new RangeError(
      "createSequentialRunner requires concurrency=1; the scheduler default is forced",
    );
  }

  const internals: RunnerInternals = {
    workflow: options.workflow,
    outcomes: [],
  };

  async function run(): Promise<SequentialRunnerOutcome> {
    const seen = terminalSeen(internals.workflow);
    while (true) {
      const ready = computeReadySet(internals.workflow).filter(
        (leaf) => !seen.has(leaf.id),
      );
      if (ready.length === 0) break;
      // Concurrency is 1; pick the first ready leaf in scheduler order.
      const leaf = ready[0];
      if (leaf === undefined) break;
      const outcome = await runOneLeaf(options, internals, leaf);
      internals.outcomes.push(outcome);
      internals.workflow = updateLeaf(internals.workflow, leaf.id, outcome.status);
      seen.add(leaf.id);
    }
    return { leaves: internals.outcomes, workflow: internals.workflow };
  }

  return { run };
}

// ---------------------------------------------------------------------------
// Public re-exports so callers using the runner do not have to chase the
// individual module paths. Keep the surface narrow.
// ---------------------------------------------------------------------------

export {
  createIntegratorAdapter,
  type CreateIntegratorAdapterOptions,
  type ProcessInvoker,
} from "./integrate/index.ts";

export {
  createFsAtomicWorkflowWriter,
  executeCompletion,
  noRiskReview,
  type AtomicWorkflowWriter,
  type CompletionDecision,
  type CompletionFileSystem,
  type RiskReviewPort,
  type WorkflowPaths,
} from "./complete/index.ts";

export {
  createQuestionBroker,
  type AskOperatorFn,
  type BrokerAnswer,
  type BrokerJournal,
  type QuestionBroker,
  type QuestionEventEnvelope,
} from "./questions/index.ts";

export {
  createSessionLifecycle,
  getChildProfile,
  type AcquiredSession,
  type ChildProfileId,
  type ChildProfile,
  type PersistedPiSession,
  type PiSessionFactory,
  type SessionLifecycle,
  type SessionMetadataStore,
  type SessionRecord,
} from "./sessions/index.ts";

export type { WorktreeHandle, WorktreeManager, Integrator, IntegrationAutoResolveStrategy } from "@arc/workflow-core";