import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CheckpointState,
  diagnoseRecovery,
  type Leaf,
  type RecoveryItemObservation,
  type Workflow,
} from "../src/index.ts";

const UPDATED_AT = "2026-09-05T12:00:00.000Z";

function leaf(id: string, state: CheckpointState, evidence_ref?: string): Leaf {
  return {
    id,
    kind: "leaf",
    title: id,
    parent_id: null,
    nesting_depth: 0,
    dependencies: [],
    outcome: "done",
    scope: "src",
    acceptance_criteria: ["verified"],
    preserved_behavior: "none",
    checkpoint: { state, updated_at: UPDATED_AT, ...(evidence_ref === undefined ? {} : { evidence_ref }) },
  };
}

function workflow(): Workflow {
  return {
    schema_version: "1",
    slug: "recovery-test",
    repository: { id: "local", path: "." },
    items: [
      leaf("stuck", CheckpointState.ready),
      leaf("replan", CheckpointState.needsReplan),
      leaf("missing", CheckpointState.completed),
      leaf("healthy", CheckpointState.completed, "journal-4"),
    ],
  };
}

describe("diagnoseRecovery", () => {
  test("reports stuck, needs-replan, and missing-evidence with approval-bound proposals", () => {
    const source = workflow();
    const observations: RecoveryItemObservation[] = [{
      itemId: "stuck",
      journalState: "running",
      sessionActive: false,
      worktreePresent: true,
    }];
    const before = JSON.stringify(source);
    const diagnosis = diagnoseRecovery({ workflow: source, observations });
    assert.deepEqual(diagnosis.findings.map((finding) => finding.kind), [
      "stuck",
      "needs-replan",
      "missing-evidence",
    ]);
    assert.deepEqual(diagnosis.proposedActions.map((action) => action.kind), [
      "resume",
      "replan",
      "restore-evidence",
    ]);
    assert.equal(diagnosis.requiresImplementApproval, true);
    assert.ok(diagnosis.proposedActions.every((action) => action.requiresImplementApproval));
    assert.equal(JSON.stringify(source), before);
  });

  test("returns an empty, approval-free diagnosis for healthy leaves", () => {
    const source = workflow();
    source.items = [leaf("healthy", CheckpointState.completed, "journal-1")];
    assert.deepEqual(diagnoseRecovery({ workflow: source }), {
      findings: [],
      proposedActions: [],
      requiresImplementApproval: false,
    });
  });
});
