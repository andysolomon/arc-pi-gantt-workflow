import {
  CHECKPOINT_STATES,
  COMPLETION_TERMINAL_STATES,
  EVENT_ENVELOPE_VERSION,
  renderWorkflow,
  serializeWorkflowYaml,
  validateWorkflow,
  type CheckpointState,
  type Leaf,
  type QuestionEventEnvelope,
  type RenderContext,
  type Workflow,
} from "@arc/workflow-core";
import {
  createQuestionBroker,
  type AskOperatorFn,
  type BrokerJournal,
  type BrokerResult,
  type QuestionBroker,
} from "../questions/index.ts";
import type {
  AtomicWorkflowWriter,
  AtomicWriteResult,
  WorkflowPaths,
} from "../complete/index.ts";

/** The retention choice made by the operator at the release gate. */
export type ArchiveRetention = "keep" | "delete";

export interface ArchiveSessionTarget {
  readonly workflowSlug: string;
  readonly leaf: string;
}

export interface ArchiveJournalTarget {
  readonly workflowSlug: string;
}

/**
 * Resource ports own the actual session/journal paths. The controller only
 * passes validated logical identities and never traverses or deletes paths.
 */
export interface ArchiveResourcePort<Target> {
  owns(target: Target): Promise<boolean> | boolean;
  archive(target: Target): Promise<void> | void;
  delete(target: Target): Promise<void> | void;
}

export interface ArchiveOptions {
  readonly workflow: Workflow;
  readonly sessionId: string;
  readonly paths: WorkflowPaths;
  readonly renderContext: RenderContext;
  readonly writer: AtomicWorkflowWriter;
  readonly ask: AskOperatorFn;
  /** Journal used by QuestionBroker for redacted answer provenance. */
  readonly journal: BrokerJournal;
  readonly sessions: ArchiveResourcePort<ArchiveSessionTarget>;
  readonly journalResource: ArchiveResourcePort<ArchiveJournalTarget>;
  readonly now?: () => Date;
  readonly createQuestionId?: () => string;
}

export type ArchiveFailureCode =
  | "invalid-workflow"
  | "unfinished-workflow"
  | "unowned-resource"
  | "broker-failure"
  | "invalid-answer"
  | "write-failed"
  | "resource-failed"
  | "already-running"
  | "already-archived";

export interface ArchiveFailure {
  readonly code: ArchiveFailureCode;
  readonly message: string;
  readonly journalId?: string;
  readonly write?: AtomicWriteResult;
}

export interface ArchiveSuccess {
  readonly ok: true;
  readonly workflow: Workflow;
  readonly retention: ArchiveRetention;
  readonly journalId: string;
  readonly write: AtomicWriteResult;
  readonly archivedSessionLeaves: readonly string[];
}

export interface ArchiveFailureResult {
  readonly ok: false;
  readonly workflow: Workflow;
  readonly failure: ArchiveFailure;
}

export type ArchiveResult = ArchiveSuccess | ArchiveFailureResult;

export interface ArchiveController {
  readonly broker: QuestionBroker;
  archive(): Promise<ArchiveResult>;
}

const TERMINAL_STATES: ReadonlySet<CheckpointState> = new Set(
  COMPLETION_TERMINAL_STATES,
);
const VALID_STATES: ReadonlySet<CheckpointState> = new Set(CHECKPOINT_STATES);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ARCHIVE_ITEM_ID = "archive";
const MAX_QUESTION_ID_LENGTH = 64;

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

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failure(
  workflow: Workflow,
  code: ArchiveFailureCode,
  message: string,
  extra: Omit<ArchiveFailure, "code" | "message"> = {},
): ArchiveFailureResult {
  return { ok: false, workflow, failure: { code, message, ...extra } };
}

function leafItems(workflow: Workflow): readonly Leaf[] {
  return workflow.items.filter((item): item is Leaf => item.kind === "leaf");
}

function validateFinalWorkflow(workflow: Workflow): ArchiveFailureResult | undefined {
  if (
    workflow.schema_version !== "1" ||
    !nonEmpty(workflow.slug) ||
    !nonEmpty(workflow.repository?.id) ||
    !nonEmpty(workflow.repository?.path) ||
    !Array.isArray(workflow.items) ||
    workflow.items.length === 0
  ) {
    return failure(
      workflow,
      "invalid-workflow",
      "archive requires a non-empty v1 workflow with repository metadata and items",
    );
  }

  const structural = validateWorkflow(workflow);
  if (!structural.structurally_valid) {
    const firstDiagnostic = structural.diagnostics[0];
    return failure(
      workflow,
      "invalid-workflow",
      firstDiagnostic === undefined
        ? "workflow failed structural validation"
        : `${firstDiagnostic.path}: ${firstDiagnostic.message}`,
    );
  }

  const leaves = leafItems(workflow);
  if (leaves.length === 0) {
    return failure(
      workflow,
      "invalid-workflow",
      "archive requires at least one executable leaf",
    );
  }

  const invalidState = workflow.items.find(
    (item) => !VALID_STATES.has(item.checkpoint.state),
  );
  if (invalidState !== undefined) {
    return failure(
      workflow,
      "invalid-workflow",
      `unsupported checkpoint state for ${invalidState.id}`,
    );
  }

  const unfinished = leaves.filter((item) => !TERMINAL_STATES.has(item.checkpoint.state));
  if (unfinished.length > 0) {
    return failure(
      workflow,
      "unfinished-workflow",
      `cannot archive unfinished leaves: ${unfinished.map((item) => item.id).join(", ")}`,
    );
  }
  return undefined;
}

function archiveEnvelope(
  options: ArchiveOptions,
  timestamp: Date,
  questionId: string,
): QuestionEventEnvelope {
  return {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: eventIdFor(timestamp, 1),
    workflow_slug: options.workflow.slug,
    item_id: ARCHIVE_ITEM_ID,
    session_id: options.sessionId,
    emitted_at: timestamp.toISOString(),
    kind: "question",
    payload: {
      question_id: questionId,
      text: `Workflow ${options.workflow.slug} is ready for release archival. Keep or delete its sessions and journal?`,
      options: [
        {
          label: "keep",
          description: "Retain the archived sessions and journal for later inspection.",
        },
        {
          label: "delete",
          description: "Delete only the sessions and journal owned by this workflow.",
        },
      ],
      gate: "release",
    },
    provenance: { source: "archive-controller", broker: "arc-pi-adapter" },
  };
}

function questionIdFor(options: ArchiveOptions, timestamp: Date): string {
  const candidate = options.createQuestionId?.() ?? `archive-${timestamp.getTime().toString(36)}`;
  if (!nonEmpty(candidate) || candidate.length > MAX_QUESTION_ID_LENGTH) {
    throw new TypeError("archive question id must be 1..64 characters");
  }
  return candidate;
}

async function ownsAll(
  options: ArchiveOptions,
  leaves: readonly Leaf[],
): Promise<string | undefined> {
  for (const leaf of leaves) {
    const target: ArchiveSessionTarget = {
      workflowSlug: options.workflow.slug,
      leaf: leaf.id,
    };
    if (!(await options.sessions.owns(target))) {
      return `session for leaf ${leaf.id} is not owned by this workflow`;
    }
  }
  const journalTarget: ArchiveJournalTarget = { workflowSlug: options.workflow.slug };
  if (!(await options.journalResource.owns(journalTarget))) {
    return `journal for workflow ${options.workflow.slug} is not owned by this workflow`;
  }
  return undefined;
}

async function applyRetention(
  options: ArchiveOptions,
  leaves: readonly Leaf[],
  retention: ArchiveRetention,
): Promise<void> {
  const operation = retention === "keep" ? "archive" : "delete";
  for (const leaf of leaves) {
    await options.sessions[operation]({
      workflowSlug: options.workflow.slug,
      leaf: leaf.id,
    });
  }
  await options.journalResource[operation]({ workflowSlug: options.workflow.slug });
}

function finalDocuments(
  workflow: Workflow,
  context: RenderContext,
): {
  readonly workflowYaml: string;
  readonly progressText: string;
  readonly ganttText: string;
} {
  const rendered = renderWorkflow(workflow, context);
  return {
    workflowYaml: serializeWorkflowYaml(workflow),
    progressText: rendered.progress.text,
    ganttText: rendered.gantt.text,
  };
}

function brokerErrorMessage(result: BrokerResult): string {
  return result.ok
    ? ""
    : `${result.reason.code}: ${result.reason.message}`;
}

/**
 * Create the release handoff controller. The controller preflights ownership,
 * asks one mandatory release question, persists final projections, then calls
 * the selected resource operation. Calls are single-flight and terminal.
 */
export function createArchiveController(options: ArchiveOptions): ArchiveController {
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    throw new TypeError("ArchiveOptions.sessionId must be a non-empty string");
  }
  if (typeof options.ask !== "function") {
    throw new TypeError("ArchiveOptions.ask must be a function");
  }
  const now = options.now ?? (() => new Date());
  const broker = createQuestionBroker({
    ask: options.ask,
    journal: options.journal,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let state: "idle" | "running" | "archived" = "idle";

  return {
    broker,
    async archive(): Promise<ArchiveResult> {
      if (state === "running") {
        return failure(options.workflow, "already-running", "archive is already in progress");
      }
      if (state === "archived") {
        return failure(options.workflow, "already-archived", "workflow has already been archived");
      }
      state = "running";

      const validation = validateFinalWorkflow(options.workflow);
      if (validation !== undefined) {
        state = "idle";
        return validation;
      }
      const leaves = leafItems(options.workflow);
      let ownershipError: string | undefined;
      try {
        ownershipError = await ownsAll(options, leaves);
      } catch (error) {
        state = "idle";
        return failure(
          options.workflow,
          "resource-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (ownershipError !== undefined) {
        state = "idle";
        return failure(options.workflow, "unowned-resource", ownershipError);
      }

      const timestamp = now();
      let questionId: string;
      try {
        questionId = questionIdFor(options, timestamp);
      } catch (error) {
        state = "idle";
        return failure(
          options.workflow,
          "broker-failure",
          error instanceof Error ? error.message : String(error),
        );
      }

      let answer: BrokerResult;
      try {
        answer = await broker.ask(archiveEnvelope(options, timestamp, questionId));
      } catch (error) {
        state = "idle";
        return failure(
          options.workflow,
          "broker-failure",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!answer.ok) {
        state = "idle";
        return failure(options.workflow, "broker-failure", brokerErrorMessage(answer));
      }

      const retention = answer.resolution.answer.answer;
      if (retention !== "keep" && retention !== "delete") {
        state = "idle";
        return failure(
          options.workflow,
          "invalid-answer",
          "archive answer must be keep or delete",
          { journalId: answer.resolution.journal_id },
        );
      }

      let write: AtomicWriteResult;
      try {
        write = await options.writer.writeAtomic(
          finalDocuments(options.workflow, options.renderContext),
          options.paths,
        );
      } catch (error) {
        state = "idle";
        return failure(
          options.workflow,
          "write-failed",
          error instanceof Error ? error.message : String(error),
          { journalId: answer.resolution.journal_id },
        );
      }
      if (!write.wrote) {
        state = "idle";
        return failure(
          options.workflow,
          "write-failed",
          write.reason ?? "final workflow write failed",
          { journalId: answer.resolution.journal_id, write },
        );
      }

      try {
        await applyRetention(options, leaves, retention);
      } catch (error) {
        state = "idle";
        return failure(
          options.workflow,
          "resource-failed",
          error instanceof Error ? error.message : String(error),
          { journalId: answer.resolution.journal_id, write },
        );
      }

      state = "archived";
      return {
        ok: true,
        workflow: options.workflow,
        retention,
        journalId: answer.resolution.journal_id,
        write,
        archivedSessionLeaves: Object.freeze(leaves.map((leaf) => leaf.id)),
      };
    },
  };
}

export const createArchive = createArchiveController;

export { CHECKPOINT_STATES, COMPLETION_TERMINAL_STATES };
export type { AtomicWorkflowWriter, AtomicWriteResult, WorkflowPaths };
