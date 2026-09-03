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
