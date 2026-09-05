import assert from "node:assert/strict";
import { test } from "node:test";
import {
  revalidateWorkflowEdit,
  type Checkpoint,
  type Leaf,
  type Workflow,
} from "@arc/workflow-core";

const AT = "2026-09-05T12:00:00.000Z";

function checkpoint(state: Checkpoint["state"] = "planned"): Checkpoint {
  return { state, updated_at: AT };
}

function leaf(
  id: string,
  dependencies: string[] = [],
  state: Checkpoint["state"] = "planned",
): Leaf {
  return {
    id,
    kind: "leaf",
    title: id,
    parent_id: null,
    nesting_depth: 0,
    outcome: `Deliver ${id}`,
    scope: `src/${id}`,
    acceptance_criteria: [`Verify ${id}`],
    dependencies,
    preserved_behavior: "Preserve existing behavior.",
    checkpoint: checkpoint(state),
  };
}

function workflow(items: Workflow["items"]): Workflow {
  return {
    schema_version: "1",
    slug: "live-edit",
    repository: { id: "repo", path: "." },
    items,
  };
}

test("invalid current or candidate data fails closed without throwing", () => {
  const valid = workflow([leaf("one")]);
  const invalidCurrent = revalidateWorkflowEdit(null, valid);
  assert.equal(invalidCurrent.accepted, false);
  if (!invalidCurrent.accepted) {
    assert.equal(invalidCurrent.reason, "invalid_current_workflow");
    assert.equal(invalidCurrent.diagnostics[0]?.source, "current");
  }

  const invalidCandidate = revalidateWorkflowEdit(valid, {
    ...valid,
    items: [leaf("one", ["missing"])],
  });
  assert.equal(invalidCandidate.accepted, false);
  if (!invalidCandidate.accepted) {
    assert.equal(invalidCandidate.reason, "invalid_candidate_workflow");
    assert.ok(
      invalidCandidate.diagnostics.some(
        (diagnostic) => diagnostic.code === "dangling_dependency",
      ),
    );
  }
});

test("unchanged edits preserve checkpoints and never promote readiness", () => {
  const current = workflow([
    leaf("dependency", [], "completed"),
    leaf("work", ["dependency"], "planned"),
  ]);
  const candidate = structuredClone(current);
  const candidateWork = candidate.items[1];
  assert.ok(candidateWork);
  candidateWork.checkpoint = checkpoint("ready");
  const currentBefore = structuredClone(current);
  const candidateBefore = structuredClone(candidate);

  const result = revalidateWorkflowEdit(current, candidate);

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.impact, {
    workflow_metadata_changed: false,
    added_item_ids: [],
    removed_item_ids: [],
    semantically_changed_item_ids: [],
    transitive_dependent_item_ids: [],
    affected_item_ids: [],
    active_item_ids: [],
    terminal_item_ids: [],
    completed_item_ids: [],
    affects_active_work: false,
    affects_terminal_work: false,
  });
  assert.equal(result.validation.readiness[1]?.ready, true);
  assert.equal(result.workflow.items[1]?.checkpoint.state, "planned");
  assert.notEqual(result.workflow, candidate);
  assert.notEqual(result.workflow.items[1], candidate.items[1]);
  assert.deepEqual(current, currentBefore);
  assert.deepEqual(candidate, candidateBefore);
});

test("impact is source-stable across added, removed, changed, and dependent items", () => {
  const current = workflow([
    leaf("root", [], "completed"),
    leaf("obsolete", [], "cancelled"),
    leaf("middle", ["root", "obsolete"]),
    leaf("tail", ["middle"], "blocked"),
    leaf("unrelated"),
  ]);
  const changedMiddle = leaf("middle", ["root"]);
  const changedRoot = { ...leaf("root", [], "completed"), scope: "src/new-root" };
  const candidate = workflow([
    { ...leaf("tail", ["middle"], "ready") },
    changedMiddle,
    changedRoot,
    leaf("added"),
    leaf("unrelated", [], "ready"),
  ]);
  const first = revalidateWorkflowEdit(current, candidate, {
    active_item_ids: ["tail", "unrelated", "tail"],
  });
  const second = revalidateWorkflowEdit(current, structuredClone(candidate), {
    active_item_ids: ["tail", "unrelated", "tail"],
  });

  assert.equal(first.accepted, true);
  assert.deepEqual(second, first);
  if (!first.accepted) return;
  assert.deepEqual(first.impact, {
    workflow_metadata_changed: false,
    added_item_ids: ["added"],
    removed_item_ids: ["obsolete"],
    semantically_changed_item_ids: ["middle", "root"],
    transitive_dependent_item_ids: ["tail", "middle"],
    affected_item_ids: ["tail", "middle", "root", "added", "obsolete"],
    active_item_ids: ["tail"],
    terminal_item_ids: ["tail", "root", "obsolete"],
    completed_item_ids: ["root"],
    affects_active_work: true,
    affects_terminal_work: true,
  });
  assert.equal(first.workflow.items[0]?.checkpoint.state, "blocked");
  assert.equal(first.workflow.items[4]?.checkpoint.state, "planned");
});

test("dependency ordering alone is not a semantic edit", () => {
  const current = workflow([
    leaf("a"),
    leaf("b"),
    leaf("work", ["a", "b"], "completed"),
  ]);
  const candidate = workflow([
    leaf("a"),
    leaf("b"),
    leaf("work", ["b", "a"], "planned"),
  ]);

  const result = revalidateWorkflowEdit(current, candidate);
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.impact.semantically_changed_item_ids, []);
  assert.equal(result.workflow.items[2]?.checkpoint.state, "completed");
});

test("checkpoint-only and metadata edits are distinguished from item semantics", () => {
  const current = workflow([leaf("work", [], "blocked")]);
  const candidate = {
    ...workflow([leaf("work", [], "ready")]),
    repository: { id: "repo", path: "./moved" },
  };
  const result = revalidateWorkflowEdit(current, candidate);

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.impact.workflow_metadata_changed, true);
  assert.deepEqual(result.impact.affected_item_ids, []);
  assert.equal(result.workflow.items[0]?.checkpoint.state, "blocked");
});
