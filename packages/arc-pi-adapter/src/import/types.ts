import type {
  ActivationField,
  ModelProposalHook,
  QuestionEventEnvelope,
  ValidateWorkflowOptions,
  ValidationDiagnostic,
  Workflow,
  WorkflowValidationResult,
} from "@arc/workflow-core";
import type { QuestionBroker } from "../questions/index.ts";

export const MODEL_PROPOSAL_CONFIRM_LABEL = "confirm" as const;
export const MODEL_PROPOSAL_REJECT_LABEL = "reject" as const;

export type ModelProposalConfirmationKind =
  | "dependencies"
  | "parallel_safety";

export type ModelProposalConfirmationStatus =
  | "confirmed"
  | "denied"
  | "unknown_answer"
  | "broker_failure"
  | "defaulted_answer"
  | "missing_evidence"
  | "not_asked";

export interface ModelProposalConfirmation {
  readonly kind: ModelProposalConfirmationKind;
  readonly status: ModelProposalConfirmationStatus;
  readonly envelope?: QuestionEventEnvelope;
  readonly answer?: string;
  readonly ledger_id?: string;
  readonly journal_id?: string;
  readonly broker_code?: string;
  readonly message?: string;
}

export interface ModelProposalLeafDecision {
  readonly leaf_id: string;
  readonly activation_complete: boolean;
  readonly missing_fields: readonly ActivationField[];
  readonly ready: boolean;
  readonly dependencies: ModelProposalConfirmation;
  readonly parallel_safety: ModelProposalConfirmation;
}

export interface ImportModelProposalOptions {
  /** Existing core hook. The adapter invokes it; workflow-core never does. */
  readonly hook: ModelProposalHook;
  /** The shipped question broker backed by the injected arc_ask_operator seam. */
  readonly broker: QuestionBroker;
  /** Controller session recorded on both confirmation envelopes. */
  readonly session_id: string;
  /** Explicit timestamp used by normalization and ready checkpoint promotion. */
  readonly updated_at: string;
  readonly validation?: ValidateWorkflowOptions;
  readonly now?: () => Date;
  readonly createQuestionId?: () => string;
  readonly createEventId?: () => string;
}

export type ModelProposalImportFailureStage =
  | "hook_invocation"
  | "hook_rejection"
  | "malformed_proposal"
  | "normalization"
  | "validation";

export interface ModelProposalImportFailure {
  readonly ok: false;
  readonly stage: ModelProposalImportFailureStage;
  readonly message: string;
  readonly diagnostics?: readonly ValidationDiagnostic[];
}

export interface ModelProposalImportSuccess {
  readonly ok: true;
  readonly workflow: Workflow;
  readonly validation: WorkflowValidationResult;
  readonly leaves: readonly ModelProposalLeafDecision[];
}

export type ModelProposalImportResult =
  | ModelProposalImportFailure
  | ModelProposalImportSuccess;

export interface ModelProposalImporter {
  import(markdown: string): Promise<ModelProposalImportResult>;
}
