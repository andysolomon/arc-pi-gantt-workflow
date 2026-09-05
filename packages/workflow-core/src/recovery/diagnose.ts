import { CheckpointState } from "../model/checkpoint.ts";
import type {
  RecoveryActionKind,
  RecoveryDiagnosis,
  RecoveryDiagnosticInput,
  RecoveryFinding,
  RecoveryFindingKind,
  RecoveryItemObservation,
  RecoveryProposedAction,
} from "./types.ts";

function actionFor(kind: RecoveryFindingKind): RecoveryActionKind {
  if (kind === "stuck") return "resume";
  if (kind === "needs-replan") return "replan";
  return "restore-evidence";
}

function messageFor(kind: RecoveryFindingKind): string {
  if (kind === "stuck") {
    return "Runtime work appears started but has no active session or expected worktree.";
  }
  if (kind === "needs-replan") {
    return "The persisted checkpoint requires a revised plan and new Implement approval.";
  }
  return "The completed checkpoint has no persisted evidence reference.";
}

function isStuck(
  checkpointState: string,
  observation: RecoveryItemObservation | undefined,
): boolean {
  if (observation === undefined) return false;
  if (observation.journalState !== "running") return false;
  if (checkpointState === CheckpointState.completed
    || checkpointState === CheckpointState.cancelled) return false;
  return observation.sessionActive === false
    || observation.worktreePresent === false;
}

/**
 * Diagnose recoverable workflow inconsistencies without mutating the workflow
 * or touching the journal. Results follow workflow item order and finding-kind
 * order, making repeated calls byte-stable for the same input.
 */
export function diagnoseRecovery(input: RecoveryDiagnosticInput): RecoveryDiagnosis {
  const observations = new Map<string, RecoveryItemObservation>();
  for (const observation of input.observations ?? []) {
    if (!observations.has(observation.itemId)) {
      observations.set(observation.itemId, observation);
    }
  }

  const findings: RecoveryFinding[] = [];
  for (const item of input.workflow.items) {
    if (item.kind !== "leaf") continue;
    const observation = observations.get(item.id);
    const kinds: RecoveryFindingKind[] = [];
    if (isStuck(item.checkpoint.state, observation)) kinds.push("stuck");
    if (item.checkpoint.state === CheckpointState.needsReplan) {
      kinds.push("needs-replan");
    }
    if (
      item.checkpoint.state === CheckpointState.completed
      && item.checkpoint.evidence_ref === undefined
      && observation?.evidenceRef === undefined
    ) {
      kinds.push("missing-evidence");
    }
    for (const kind of kinds) {
      findings.push({
        kind,
        itemId: item.id,
        checkpointState: item.checkpoint.state,
        message: messageFor(kind),
      });
    }
  }

  const proposedActions: RecoveryProposedAction[] = findings.map((finding) => ({
    kind: actionFor(finding.kind),
    itemId: finding.itemId,
    reason: finding.kind,
    requiresImplementApproval: true,
  }));
  return {
    findings,
    proposedActions,
    requiresImplementApproval: proposedActions.length > 0,
  };
}

/** Short alias for callers already operating in the recovery namespace. */
export const diagnose = diagnoseRecovery;
