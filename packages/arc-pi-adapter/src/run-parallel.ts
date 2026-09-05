/**
 * Phase 6.1: parallel Gantt runner.
 *
 * The runner keeps scheduling and state transitions in the controller while
 * allowing independent leaves to acquire sessions, create worktrees, and run
 * their worker step concurrently.  Integration and completion are serialized:
 * a leaf worktree is private, but the integration checkout and the three
 * generated documents are shared resources.  Serializing that boundary keeps
 * cherry-picks and atomic projections from racing while preserving the useful
 * parallel portion of leaf execution.
 *
 * Every leaf is supervised independently.  A worker, session, integration, or
 * completion failure is converted to a terminal `needs-replan` outcome for
 * that leaf; unrelated ready leaves in the same wave still run.
 */

import {
  CheckpointState,
  applyConcurrencyLimit,
  computeReadySet,
  resolveSchedulerConfig,
  resolveWaitPolicy,
  type IntegrationAutoResolveStrategy,
  type Leaf,
  type WaitPolicy,
  type Workflow,
  type WorktreeHandle,
  type WorktreeManager,
} from "@arc/workflow-core";

import {
  createIntegratorAdapter,
  type CreateIntegratorAdapterOptions,
  type ProcessInvoker,
} from "./integrate/index.ts";
import {
  executeCompletion,
  type AtomicWorkflowWriter,
  type CompletionDecision,
  type RiskReviewPort,
  type WorkflowPaths,
} from "./complete/index.ts";
import {
  createQuestionQueue,
  type AskOperatorFn,
  type BrokerJournal,
  type QuestionQueue,
} from "./questions/index.ts";
import type {
  AcquiredSession,
  ChildProfileId,
  SessionLifecycle,
} from "./sessions/index.ts";

/** Reuse the M1 path shape; parallel execution has the same document needs. */
export interface ParallelRunnerPaths {
  readonly workflowYaml: string;
  readonly progressText: string;
  readonly ganttText: string;
  readonly sessionDir: string;
  readonly worktreesRoot: string;
}

export type ParallelRunnerLeafStatus =
  | "completed"
  | "needs-replan"
  | "blocked"
  | "cancelled";

export type ParallelCompletionRiskLevel = "low" | "medium" | "high";

export interface ParallelRunnerLeafOutcome {
  readonly itemId: string;
  readonly status: ParallelRunnerLeafStatus;
  readonly risk: ParallelCompletionRiskLevel;
  readonly commit?: { readonly hash: string };
  readonly reason?: string;
  readonly worktreePath: string | null;
  readonly sessionPath: string;
}

export interface ParallelRunnerOutcome {
  readonly leaves: readonly ParallelRunnerLeafOutcome[];
  readonly workflow: Workflow;
}

/** The simulated/production worker boundary is intentionally the same as M1. */
export interface ParallelWorker {
  run(input: {
    readonly workflow: Workflow;
    readonly leaf: Leaf;
    readonly worktreePath: string;
    readonly sessionPath: string;
  }): Promise<void>;
}

export interface ParallelRunnerOptions<Session = unknown, SessionOptions = unknown> {
  readonly workflow: Workflow;
  readonly paths: ParallelRunnerPaths;
  readonly now: () => Date;
  readonly worker: ParallelWorker;
  readonly lifecycle: SessionLifecycle<Session, SessionOptions>;
  readonly worktreeManager: WorktreeManager;
  readonly writer: AtomicWorkflowWriter;
  readonly review: RiskReviewPort;
  readonly ask: AskOperatorFn;
  /** Optional shared queue for all leaf integration questions. */
  readonly questionQueue?: QuestionQueue;
  readonly journal: BrokerJournal;
  readonly integrationBranch: string;
  readonly repositoryRoot?: string;
  readonly invoker?: ProcessInvoker;
  readonly autoResolve?: {
    readonly strategy?: IntegrationAutoResolveStrategy;
    readonly maxAttempts?: number;
  };
  readonly verifyCommand?: readonly [string, ...string[]];
  readonly sessionCwd?: (leaf: Leaf, worktreePath: string) => string;
  /** Defaults to the settled scheduler cap of four. */
  readonly concurrency?: number;
  /** Defaults to continue-independent-authorized-branches. */
  readonly wait_policy?: WaitPolicy;
  /** Restrict which ready leaves this run is authorized to start. */
  readonly authorized_item_ids?: readonly string[];
  /** Runtime waiting items used by the core wait-policy calculation. */
  readonly waiting_item_ids?: readonly string[];
}

export interface ParallelRunner {
  run(): Promise<ParallelRunnerOutcome>;
}

export const DEFAULT_PARALLEL_RUNNER_CONCURRENCY = 4 as const;

interface RunnerInternals {
  workflow: Workflow;
  readonly outcomes: ParallelRunnerLeafOutcome[];
  readonly scheduled: Set<string>;
}

/** A small FIFO async mutex for shared integration and projection resources. */
class SerialGate {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function renderContextFromNow(now: () => Date): { readonly generated_at: string } {
  return { generated_at: now().toISOString() };
}

function updateLeaf(
  workflow: Workflow,
  itemId: string,
  status: ParallelRunnerLeafStatus,
): Workflow {
  const nextState =
    status === "completed"
      ? CheckpointState.completed
      : status === "needs-replan"
        ? CheckpointState.needsReplan
        : status === "cancelled"
          ? CheckpointState.cancelled
          : CheckpointState.blocked;

  return {
    ...workflow,
    items: workflow.items.map((item) =>
      item.kind === "leaf" && item.id === itemId
        ? { ...item, checkpoint: { ...item.checkpoint, state: nextState } }
        : item,
    ),
  };
}

function terminalIds(workflow: Workflow): Set<string> {
  const terminal = new Set<string>();
  for (const item of workflow.items) {
    if (
      item.checkpoint.state === CheckpointState.completed ||
      item.checkpoint.state === CheckpointState.blocked ||
      item.checkpoint.state === CheckpointState.cancelled ||
      item.checkpoint.state === CheckpointState.needsReplan
    ) {
      terminal.add(item.id);
    }
  }
  return terminal;
}

function outcome(
  leaf: Leaf,
  status: ParallelRunnerLeafStatus,
  risk: ParallelCompletionRiskLevel,
  worktreePath: string | null,
  sessionPath: string,
  reason?: string,
  commit?: { readonly hash: string },
): ParallelRunnerLeafOutcome {
  return {
    itemId: leaf.id,
    status,
    risk,
    ...(reason === undefined ? {} : { reason }),
    ...(commit === undefined ? {} : { commit }),
    worktreePath,
    sessionPath,
  };
}

function decisionStatus(decision: CompletionDecision): ParallelRunnerLeafStatus {
  return decision.decision === "complete" ? "completed" : "needs-replan";
}

async function markFailure(
  internals: RunnerInternals,
  gate: SerialGate,
  leaf: Leaf,
  status: ParallelRunnerLeafStatus,
  risk: ParallelCompletionRiskLevel,
  worktreePath: string | null,
  sessionPath: string,
  reason: string,
): Promise<ParallelRunnerLeafOutcome> {
  return gate.run(async () => {
    internals.workflow = updateLeaf(internals.workflow, leaf.id, status);
    return outcome(leaf, status, risk, worktreePath, sessionPath, reason);
  });
}

async function runOneLeaf<Session, SessionOptions>(
  options: ParallelRunnerOptions<Session, SessionOptions>,
  internals: RunnerInternals,
  gate: SerialGate,
  workflowSnapshot: Workflow,
  leaf: Leaf,
  questionQueue: QuestionQueue,
  createQuestionId: () => string,
): Promise<ParallelRunnerLeafOutcome> {
  let worktree: WorktreeHandle;
  try {
    worktree = await options.worktreeManager.acquire(leaf.id, options.workflow.slug);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markFailure(
      internals,
      gate,
      leaf,
      "needs-replan",
      "low",
      null,
      "",
      `worktree_failed: ${message}`,
    );
  }

  if (worktree.path === null) {
    return markFailure(
      internals,
      gate,
      leaf,
      "needs-replan",
      "low",
      null,
      "",
      "worktree_acquire_returned_null_path",
    );
  }

  const sessionCwd = options.sessionCwd
    ? options.sessionCwd(leaf, worktree.path)
    : worktree.path;
  let session: AcquiredSession<Session>;
  try {
    const input = {
      workflowSlug: options.workflow.slug,
      leaf: leaf.id,
      cwd: sessionCwd,
      profileId: "implement" as ChildProfileId,
    };
    session = await options.lifecycle.acquire(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markFailure(
      internals,
      gate,
      leaf,
      "needs-replan",
      "low",
      worktree.path,
      "",
      `session_failed: ${message}`,
    );
  }

  try {
    await options.worker.run({
      workflow: workflowSnapshot,
      leaf,
      worktreePath: worktree.path,
      sessionPath: session.record.sessionPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markFailure(
      internals,
      gate,
      leaf,
      "needs-replan",
      "low",
      worktree.path,
      session.record.sessionPath,
      `worker_threw: ${message}`,
    );
  }

  // The integration checkout and generated documents are shared by all leaves.
  // Keep this boundary serial even though worker execution above is parallel.
  return gate.run(async () => {
    const adapterOptions: CreateIntegratorAdapterOptions = {
      workflowSlug: options.workflow.slug,
      itemId: leaf.id,
      sessionId: `${options.workflow.slug}:${leaf.id}`,
      worktreePath: worktree.path!,
      repositoryRoot: options.repositoryRoot ?? worktree.path!,
      integrationBranch: options.integrationBranch,
      commitSubject: `arc(wf:${options.workflow.slug}): ${leaf.id} ${leaf.title}`.slice(0, 200),
      ask: questionQueue.ask.bind(questionQueue),
      journal: options.journal,
      createQuestionId,
      ...(options.invoker === undefined ? {} : { invoker: options.invoker }),
      ...(options.verifyCommand === undefined ? {} : { verifyCommand: options.verifyCommand }),
      ...(options.autoResolve === undefined
        ? {}
        : {
            integration: {
              question: `Cherry-pick commit for ${leaf.id} into ${options.integrationBranch}?`,
              cherryPickDescription: `Apply the local commit onto ${options.integrationBranch}.`,
              skipDescription: `Leave the local commit in the worktree and mark ${leaf.id} blocked from integration.`,
              auto_resolve: options.autoResolve,
            },
          }),
    };

    let integrateResult;
    try {
      const { integrator } = createIntegratorAdapter(adapterOptions);
      integrateResult = await integrator.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      internals.workflow = updateLeaf(internals.workflow, leaf.id, "needs-replan");
      return outcome(
        leaf,
        "needs-replan",
        "high",
        worktree.path,
        session.record.sessionPath,
        `integrate_threw: ${message}`,
      );
    }

    if (!integrateResult.ok) {
      internals.workflow = updateLeaf(internals.workflow, leaf.id, "needs-replan");
      return outcome(
        leaf,
        "needs-replan",
        "high",
        worktree.path,
        session.record.sessionPath,
        `integrate_failed: phase=${integrateResult.phase}`,
      );
    }

    // An answered-but-negative integration gate is a terminal blocked outcome,
    // not a successful completion. Missing integration evidence also fails
    // closed so a malformed adapter result can never mark a leaf completed.
    if (integrateResult.integration?.approved !== true) {
      const status: ParallelRunnerLeafStatus = integrateResult.integration === undefined
        ? "needs-replan"
        : "blocked";
      internals.workflow = updateLeaf(internals.workflow, leaf.id, status);
      return outcome(
        leaf,
        status,
        "low",
        worktree.path,
        session.record.sessionPath,
        integrateResult.integration === undefined
          ? "integration_evidence_missing"
          : "integration_denied",
        integrateResult.commit,
      );
    }

    try {
      const completionPaths: WorkflowPaths = {
        workflowYaml: options.paths.workflowYaml,
        progressText: options.paths.progressText,
        ganttText: options.paths.ganttText,
      };
      const decision = await executeCompletion(
        internals.workflow,
        integrateResult,
        {
          itemId: leaf.id,
          paths: completionPaths,
          renderContext: renderContextFromNow(options.now),
          writer: options.writer,
          review: options.review,
          now: options.now,
        },
      );
      const status = decisionStatus(decision);
      if (decision.decision === "complete") {
        internals.workflow = decision.workflow;
        return outcome(
          leaf,
          status,
          decision.risk,
          worktree.path,
          session.record.sessionPath,
          undefined,
          integrateResult.commit,
        );
      }
      internals.workflow = updateLeaf(internals.workflow, leaf.id, status);
      return outcome(
        leaf,
        status,
        decision.risk,
        worktree.path,
        session.record.sessionPath,
        decision.reason,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      internals.workflow = updateLeaf(internals.workflow, leaf.id, "needs-replan");
      return outcome(
        leaf,
        "needs-replan",
        "high",
        worktree.path,
        session.record.sessionPath,
        `completion_threw: ${message}`,
      );
    }
  });
}

/**
 * Build a parallel runner. Calls to `run()` are single-flight and repeated
 * calls return the same settled outcome rather than scheduling a leaf twice.
 */
export function createParallelRunner<Session = unknown, SessionOptions = unknown>(
  options: ParallelRunnerOptions<Session, SessionOptions>,
): ParallelRunner {
  const config = resolveSchedulerConfig({
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.wait_policy === undefined ? {} : { wait_policy: options.wait_policy }),
  });
  const internals: RunnerInternals = {
    workflow: options.workflow,
    outcomes: [],
    scheduled: new Set<string>(),
  };
  const gate = new SerialGate();
  const questionQueue = options.questionQueue ?? createQuestionQueue({
    workflow: () => internals.workflow,
    ask: options.ask,
  });
  let questionSequence = 0;
  const createQuestionId = (): string => {
    questionSequence += 1;
    return `parallel-q-${questionSequence.toString(36)}`;
  };
  let runPromise: Promise<ParallelRunnerOutcome> | undefined;

  async function runOnce(): Promise<ParallelRunnerOutcome> {
    const terminal = terminalIds(internals.workflow);
    const authorized = options.authorized_item_ids === undefined
      ? undefined
      : new Set(options.authorized_item_ids);

    while (true) {
      const ready = computeReadySet(internals.workflow).filter(
        (leaf) => !terminal.has(leaf.id) && !internals.scheduled.has(leaf.id),
      );
      if (ready.length === 0) break;

      const authorizedIds = authorized === undefined
        ? ready.map((leaf) => leaf.id)
        : [...authorized];
      const eligible = resolveWaitPolicy(
        internals.workflow,
        ready,
        {
          authorized_item_ids: authorizedIds,
          ...(options.waiting_item_ids === undefined
            ? {}
            : { waiting_item_ids: options.waiting_item_ids }),
        },
        config.wait_policy,
      );
      const selected = applyConcurrencyLimit(eligible, {
        concurrency: config.concurrency,
        active_count: 0,
      });
      if (selected.length === 0) break;

      for (const leaf of selected) internals.scheduled.add(leaf.id);
      const workflowSnapshot = internals.workflow;
      const settled = await Promise.all(
        selected.map(async (leaf) => {
          try {
            return await runOneLeaf(
              options,
              internals,
              gate,
              workflowSnapshot,
              leaf,
              questionQueue,
              createQuestionId,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return markFailure(
              internals,
              gate,
              leaf,
              "needs-replan",
              "high",
              null,
              "",
              `supervision_failed: ${message}`,
            );
          }
        }),
      );

      for (const leafOutcome of settled) {
        internals.outcomes.push(leafOutcome);
        terminal.add(leafOutcome.itemId);
      }
    }

    return { leaves: internals.outcomes, workflow: internals.workflow };
  }

  return {
    run(): Promise<ParallelRunnerOutcome> {
      runPromise ??= runOnce();
      return runPromise;
    },
  };
}
