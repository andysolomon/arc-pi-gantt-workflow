import {
  CheckpointState,
  EVENT_ENVELOPE_VERSION,
  completeLeafCheckpoint,
  safeJournalMetadata,
  type CancelWorktreeDecision,
  type Checkpoint,
  type QuestionEventEnvelope,
  type Workflow,
} from "@arc/workflow-core";
import type { SessionLifecycle } from "../sessions/index.ts";
import {
  createQuestionBroker,
  type AskOperatorFn,
  type BrokerJournal,
  type QuestionBroker,
} from "../questions/index.ts";
import type { RestartCheckpointPort } from "./restart.ts";

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

export interface CancellationWorktreePort {
  cancel(input: {
    readonly workflowSlug?: string;
    readonly itemId: string;
    readonly decision: CancelWorktreeDecision;
  }): Promise<void>;
}

export interface CancellationSessionPort {
  archive(input: { readonly workflowSlug: string; readonly leaf: string }): Promise<void>;
}

export interface CancelOptions {
  readonly workflow: Workflow;
  readonly itemId: string;
  readonly sessionId: string;
  readonly ask: AskOperatorFn;
  readonly journal: BrokerJournal;
  readonly worktrees: CancellationWorktreePort;
  readonly sessions: CancellationSessionPort | Pick<SessionLifecycle, "archive">;
  readonly checkpoints?: RestartCheckpointPort;
  readonly now?: () => Date;
  readonly createQuestionId?: () => string;
}

export interface CancelResult {
  readonly ok: boolean;
  readonly workflow: Workflow;
  readonly intentJournalId: string;
  readonly decision?: CancelWorktreeDecision;
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface CancellationController {
  readonly broker: QuestionBroker;
  cancel(): Promise<CancelResult>;
}

function cancelEnvelope(
  options: CancelOptions,
  questionId: string,
  timestamp: Date,
): QuestionEventEnvelope {
  return {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: `${encodeBase32(BigInt(timestamp.getTime()), 10)}${encodeBase32(1n, 16)}`,
    workflow_slug: options.workflow.slug,
    item_id: options.itemId,
    session_id: options.sessionId,
    emitted_at: timestamp.toISOString(),
    kind: "question",
    payload: {
      question_id: questionId,
      text: `Cancellation has started for ${options.itemId}. What should happen to its worktree?`,
      options: [
        { label: "preserve", description: "Retain the worktree for inspection." },
        { label: "delete", description: "Delete the owned worktree." },
      ],
      gate: "implement",
    },
    provenance: { source: "cancellation-controller", broker: "arc-pi-adapter" },
  };
}

/**
 * Record stop intent before any prompt, then honor the explicit preservation
 * answer. Session archival is retain-only and happens after worktree handling.
 */
export function createCancellationController(options: CancelOptions): CancellationController {
  const item = options.workflow.items.find((candidate) => candidate.id === options.itemId);
  if (item?.kind !== "leaf") throw new Error("cancel requires an existing workflow leaf");
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  const now = options.now ?? (() => new Date());
  let questionSequence = 0;
  const createQuestionId = options.createQuestionId
    ?? (() => `cancel-${now().getTime().toString(36)}-${++questionSequence}`);
  const broker = createQuestionBroker({
    ask: options.ask,
    journal: options.journal,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    broker,
    async cancel(): Promise<CancelResult> {
      // This append is intentionally the first awaited side effect. It records
      // stop intent without copying any operator answer or rationale.
      const intent = await options.journal.append({
        kind: "cancellation-started",
        itemId: options.itemId,
        sessionId: options.sessionId,
        data: { intent: safeJournalMetadata("stop") },
      });
      const timestamp = now();
      const answered = await broker.ask(
        cancelEnvelope(options, createQuestionId(), timestamp),
      );
      if (!answered.ok) {
        return {
          ok: false,
          workflow: options.workflow,
          intentJournalId: intent.id,
          failure: {
            code: answered.reason.code,
            message: answered.reason.message,
          },
        };
      }
      const answer = answered.resolution.answer.answer;
      if (answer !== "preserve" && answer !== "delete") {
        return {
          ok: false,
          workflow: options.workflow,
          intentJournalId: intent.id,
          failure: { code: "invalid-answer", message: "cancel answer must be preserve or delete" },
        };
      }
      await options.worktrees.cancel({
        workflowSlug: options.workflow.slug,
        itemId: options.itemId,
        decision: answer,
      });
      await options.sessions.archive({
        workflowSlug: options.workflow.slug,
        leaf: options.itemId,
      });
      const checkpoint: Checkpoint = {
        state: CheckpointState.cancelled,
        updated_at: timestamp.toISOString(),
        evidence_ref: intent.id,
      };
      const workflow = completeLeafCheckpoint(options.workflow, {
        itemId: options.itemId,
        nextState: checkpoint.state,
        updatedAt: checkpoint.updated_at,
        evidenceRef: intent.id,
      }).workflow;
      await options.checkpoints?.apply({
        workflowSlug: workflow.slug,
        itemId: options.itemId,
        checkpoint,
      });
      return {
        ok: true,
        workflow,
        intentJournalId: intent.id,
        decision: answer,
      };
    },
  };
}

export const createCancelController = createCancellationController;
