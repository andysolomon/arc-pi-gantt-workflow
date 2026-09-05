import type { CheckpointState } from "../model/checkpoint.ts";
import type { Workflow } from "../model/workflow.ts";

/** Runtime facts that are deliberately kept outside the workflow YAML. */
export interface RecoveryItemObservation {
  readonly itemId: string;
  /** The last checkpoint-like state recorded by the private journal. */
  readonly journalState?: CheckpointState | "running";
  /** Whether a child session is currently known to be running. */
  readonly sessionActive?: boolean;
  /** Whether the expected worktree is present. Omit for non-writing items. */
  readonly worktreePresent?: boolean;
  /** Evidence known by the runtime but not necessarily copied into YAML. */
  readonly evidenceRef?: string;
}

export interface RecoveryDiagnosticInput {
  readonly workflow: Workflow;
  readonly observations?: readonly RecoveryItemObservation[];
}

export type RecoveryFindingKind =
  | "stuck"
  | "needs-replan"
  | "missing-evidence";

export interface RecoveryFinding {
  readonly kind: RecoveryFindingKind;
  readonly itemId: string;
  readonly checkpointState: CheckpointState;
  readonly message: string;
}

export type RecoveryActionKind =
  | "resume"
  | "replan"
  | "restore-evidence";

export interface RecoveryProposedAction {
  readonly kind: RecoveryActionKind;
  readonly itemId: string;
  readonly reason: RecoveryFindingKind;
  /** Recovery never authorizes itself; every proposal returns to Implement. */
  readonly requiresImplementApproval: true;
}

/** A pure diagnosis. Producing it performs no asks, writes, or other I/O. */
export interface RecoveryDiagnosis {
  readonly findings: readonly RecoveryFinding[];
  readonly proposedActions: readonly RecoveryProposedAction[];
  readonly requiresImplementApproval: boolean;
}
