import {
  CheckpointState,
  EVENT_ENVELOPE_VERSION,
  completeLeafCheckpoint,
  type Checkpoint,
  type QuestionEventEnvelope,
  type Workflow,
} from "@arc/workflow-core";
import {
  createQuestionBroker,
  type AskOperatorFn,
  type BrokerJournal,
  type QuestionBroker,
} from "../questions/index.ts";

export interface RestartJournalCheckpoint {
  readonly itemId: string;
  readonly checkpoint: Checkpoint;
}

export interface RestartWorktree {
  readonly itemId: string;
  readonly exists: boolean;
}

export type RestartDiscrepancyKind =
  | "checkpoint-mismatch"
  | "missing-worktree"
  | "orphan-worktree";

export interface RestartDiscrepancy {
  readonly kind: RestartDiscrepancyKind;
  readonly itemId: string;
  readonly yamlCheckpoint?: Checkpoint;
  readonly journalCheckpoint?: Checkpoint;
}

export interface RestartCheckpointPort {
  apply(input: {
    readonly workflowSlug: string;
    readonly itemId: string;
    readonly checkpoint: Checkpoint;
  }): Promise<void> | void;
}

export interface RestartOptions {
  readonly workflow: Workflow;
  readonly journalCheckpoints: readonly RestartJournalCheckpoint[];
  readonly worktrees: readonly RestartWorktree[];
  readonly sessionId: string;
  readonly ask: AskOperatorFn;
  readonly journal: BrokerJournal;
  readonly checkpoints?: RestartCheckpointPort;
  readonly now?: () => Date;
  readonly createQuestionId?: () => string;
}

export interface RestartResolution {
  readonly discrepancy: RestartDiscrepancy;
  readonly answer: string;
  readonly appliedCheckpoint?: Checkpoint;
}

export interface RestartFailure {
  readonly discrepancy: RestartDiscrepancy;
  readonly code: string;
  readonly message: string;
}

export interface RestartResult {
  readonly workflow: Workflow;
  readonly discrepancies: readonly RestartDiscrepancy[];
  readonly resolutions: readonly RestartResolution[];
  readonly failures: readonly RestartFailure[];
}

export interface RestartReconciler {
  readonly broker: QuestionBroker;
  restart(): Promise<RestartResult>;
}

function checkpointsEqual(left: Checkpoint, right: Checkpoint): boolean {
  return left.state === right.state
    && left.updated_at === right.updated_at
    && left.evidence_ref === right.evidence_ref;
}

/** Compare the complete journal/YAML/worktree snapshots without performing I/O. */
export function findRestartDiscrepancies(
  workflow: Workflow,
  journalCheckpoints: readonly RestartJournalCheckpoint[],
  worktrees: readonly RestartWorktree[],
): readonly RestartDiscrepancy[] {
  const journalByItem = new Map(journalCheckpoints.map((entry) => [entry.itemId, entry.checkpoint]));
  const worktreeByItem = new Map(worktrees.map((entry) => [entry.itemId, entry.exists]));
  const discrepancies: RestartDiscrepancy[] = [];
  const workflowIds = new Set(workflow.items.map((item) => item.id));
  for (const item of workflow.items) {
    if (item.kind !== "leaf") continue;
    const journalCheckpoint = journalByItem.get(item.id);
    if (journalCheckpoint !== undefined && !checkpointsEqual(item.checkpoint, journalCheckpoint)) {
      discrepancies.push({
        kind: "checkpoint-mismatch",
        itemId: item.id,
        yamlCheckpoint: item.checkpoint,
        journalCheckpoint,
      });
    }
    if (
      item.checkpoint.state === CheckpointState.ready
      && worktreeByItem.get(item.id) === false
    ) {
      discrepancies.push({
        kind: "missing-worktree",
        itemId: item.id,
        yamlCheckpoint: item.checkpoint,
      });
    }
  }
  for (const worktree of worktrees) {
    if (worktree.exists && !workflowIds.has(worktree.itemId)) {
      discrepancies.push({ kind: "orphan-worktree", itemId: worktree.itemId });
    }
  }
  return discrepancies;
}

function defaultQuestionId(now: () => Date): () => string {
  let sequence = 0;
  return () => `restart-${now().getTime().toString(36)}-${++sequence}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = `${CROCKFORD[Number(remaining & 31n)]}${encoded}`;
    remaining >>= 5n;
  }
  return encoded;
}

function eventIdFor(timestamp: Date, sequence: number): string {
  return `${encodeBase32(BigInt(timestamp.getTime()), 10)}${encodeBase32(BigInt(sequence), 16)}`;
}

function envelopeFor(
  options: RestartOptions,
  discrepancy: RestartDiscrepancy,
  questionId: string,
  now: () => Date,
  eventSequence: number,
): QuestionEventEnvelope {
  const checkpointMismatch = discrepancy.kind === "checkpoint-mismatch";
  const optionsForQuestion = checkpointMismatch
    ? [
        { label: "use-journal", description: "Apply the journal checkpoint to YAML." },
        { label: "use-yaml", description: "Keep the YAML checkpoint." },
      ]
    : [
        { label: "mark-needs-replan", description: "Move the workflow item to needs-replan." },
        { label: "keep-yaml", description: "Keep the current YAML checkpoint." },
      ];
  const timestamp = now();
  return {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: eventIdFor(timestamp, eventSequence),
    workflow_slug: options.workflow.slug,
    item_id: discrepancy.itemId,
    session_id: options.sessionId,
    emitted_at: timestamp.toISOString(),
    kind: "question",
    payload: {
      question_id: questionId,
      text: `Restart found ${discrepancy.kind} for ${discrepancy.itemId}. Which checkpoint should be kept?`,
      options: optionsForQuestion,
      gate: "implement",
    },
    provenance: { source: "restart-reconciler", broker: "arc-pi-adapter" },
  };
}

function checkpointSelected(
  discrepancy: RestartDiscrepancy,
  answer: string,
  updatedAt: string,
): Checkpoint | undefined {
  if (answer === "use-journal") return discrepancy.journalCheckpoint;
  if (answer === "use-yaml" || answer === "keep-yaml") return discrepancy.yamlCheckpoint;
  if (answer === "mark-needs-replan" && discrepancy.yamlCheckpoint !== undefined) {
    return { state: CheckpointState.needsReplan, updated_at: updatedAt };
  }
  return undefined;
}

function replaceCheckpoint(workflow: Workflow, itemId: string, checkpoint: Checkpoint): Workflow {
  return completeLeafCheckpoint(workflow, {
    itemId,
    nextState: checkpoint.state,
    updatedAt: checkpoint.updated_at,
    ...(checkpoint.evidence_ref === undefined ? {} : { evidenceRef: checkpoint.evidence_ref }),
  }).workflow;
}

/**
 * Reconcile a restart one discrepancy at a time. Every decision goes through
 * a mandatory Implement question created by the sole question broker.
 */
export function createRestartReconciler(options: RestartOptions): RestartReconciler {
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  const now = options.now ?? (() => new Date());
  const createQuestionId = options.createQuestionId ?? defaultQuestionId(now);
  const broker = createQuestionBroker({
    ask: options.ask,
    journal: options.journal,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    broker,
    async restart(): Promise<RestartResult> {
      const discrepancies = findRestartDiscrepancies(
        options.workflow,
        options.journalCheckpoints,
        options.worktrees,
      );
      let workflow = options.workflow;
      const resolutions: RestartResolution[] = [];
      const failures: RestartFailure[] = [];
      let eventSequence = 0;
      for (const discrepancy of discrepancies) {
        const result = await broker.ask(
          envelopeFor(options, discrepancy, createQuestionId(), now, ++eventSequence),
        );
        if (!result.ok) {
          failures.push({
            discrepancy,
            code: result.reason.code,
            message: result.reason.message,
          });
          continue;
        }
        const answer = result.resolution.answer.answer;
        const checkpoint = checkpointSelected(discrepancy, answer, now().toISOString());
        if (checkpoint !== undefined && discrepancy.kind !== "orphan-worktree") {
          workflow = replaceCheckpoint(workflow, discrepancy.itemId, checkpoint);
          await options.checkpoints?.apply({
            workflowSlug: workflow.slug,
            itemId: discrepancy.itemId,
            checkpoint,
          });
        }
        resolutions.push({
          discrepancy,
          answer,
          ...(checkpoint === undefined ? {} : { appliedCheckpoint: checkpoint }),
        });
      }
      return { workflow, discrepancies, resolutions, failures };
    },
  };
}

export const createRestartRecovery = createRestartReconciler;
