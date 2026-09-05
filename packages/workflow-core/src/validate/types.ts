export const ACTIVATION_FIELDS = Object.freeze([
  "outcome",
  "scope",
  "acceptance_criteria",
  "dependencies",
  "preserved_behavior",
] as const);

export type ActivationField = (typeof ACTIVATION_FIELDS)[number];

export interface ValidationBounds {
  readonly maxItems: number;
  readonly maxLeaves: number;
  readonly maxDepth: number;
  readonly maxDependenciesPerLeaf: number;
}

export type ValidateWorkflowOptions = Partial<ValidationBounds>;

export type ValidationDiagnosticCode =
  | "dependency_cycle"
  | "dependency_limit_exceeded"
  | "dangling_dependency"
  | "depth_limit_exceeded"
  | "duplicate_dependency"
  | "duplicate_id"
  | "invalid_field"
  | "invalid_parent"
  | "invalid_workflow"
  | "item_limit_exceeded"
  | "leaf_limit_exceeded"
  | "parent_depth_mismatch";

export interface ValidationDiagnostic {
  readonly code: ValidationDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface LeafReadiness {
  readonly leaf_id: string;
  readonly item_index: number;
  readonly ready: boolean;
  readonly missing_fields: readonly ActivationField[];
}

export interface WorkflowValidationResult {
  /** Whether the DAG shape and references are safe for downstream use. */
  readonly structurally_valid: boolean;
  /** Structural diagnostics only; authoring incompleteness is in readiness. */
  readonly diagnostics: readonly ValidationDiagnostic[];
  /** Activation readiness in source order. This does not update checkpoints. */
  readonly readiness: readonly LeafReadiness[];
}

export type WorkflowEditFailureReason =
  | "invalid_current_workflow"
  | "invalid_candidate_workflow"
  | "malformed_yaml";

export interface WorkflowEditDiagnostic {
  readonly source: "current" | "candidate" | "yaml";
  readonly code: ValidationDiagnosticCode | "malformed_yaml";
  readonly path: string;
  readonly message: string;
}

export interface RevalidateWorkflowEditOptions extends ValidateWorkflowOptions {
  /** Live state is private runtime data and is therefore supplied by the adapter. */
  readonly active_item_ids?: readonly string[];
}

/** Stable, source-ordered impact summary for an accepted workflow edit. */
export interface WorkflowEditImpact {
  readonly workflow_metadata_changed: boolean;
  readonly added_item_ids: readonly string[];
  readonly removed_item_ids: readonly string[];
  readonly semantically_changed_item_ids: readonly string[];
  readonly transitive_dependent_item_ids: readonly string[];
  readonly affected_item_ids: readonly string[];
  readonly active_item_ids: readonly string[];
  readonly terminal_item_ids: readonly string[];
  readonly completed_item_ids: readonly string[];
  readonly affects_active_work: boolean;
  readonly affects_terminal_work: boolean;
}

export interface AcceptedWorkflowEdit {
  readonly accepted: true;
  /** A detached candidate with checkpoints restored for unchanged items. */
  readonly workflow: import("../model/workflow.ts").Workflow;
  readonly impact: WorkflowEditImpact;
  readonly validation: WorkflowValidationResult;
}

export interface RejectedWorkflowEdit {
  readonly accepted: false;
  readonly reason: WorkflowEditFailureReason;
  readonly diagnostics: readonly WorkflowEditDiagnostic[];
}

export type WorkflowEditResult = AcceptedWorkflowEdit | RejectedWorkflowEdit;
