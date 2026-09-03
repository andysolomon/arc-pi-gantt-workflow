import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECKPOINT_STATES,
  CheckpointState,
  type Group,
  type Leaf,
  type CheckpointState as CheckpointStateType,
  type Workflow,
  type WorkflowItem,
} from "@arc/workflow-core";

const checkpointStates = [
  "planned",
  "ready",
  "completed",
  "blocked",
  "cancelled",
  "needs-replan",
] as const;

test("checkpoint state representation contains exactly the settled values", () => {
  assert.deepEqual(Object.values(CheckpointState), checkpointStates);
  assert.deepEqual(CHECKPOINT_STATES, checkpointStates);

  const state: CheckpointStateType = "needs-replan";
  assert.equal(state, CheckpointState.needsReplan);
});

test("workflow model represents a flat discriminated DAG", () => {
  const group = {
    id: "phase-1",
    kind: "group",
    title: "Phase 1",
    parent_id: null,
    nesting_depth: 0,
    dependencies: [],
    checkpoint: {
      state: CheckpointState.planned,
      updated_at: "2026-09-03T00:00:00.000Z",
    },
  } satisfies Group;

  const leaf = {
    id: "phase-1-model",
    kind: "leaf",
    title: "DAG model",
    parent_id: group.id,
    nesting_depth: 1,
    outcome: "Expose the normalized workflow model.",
    scope: "packages/workflow-core/src/model",
    acceptance_criteria: ["Model shapes are strict and discriminated."],
    dependencies: [],
    preserved_behavior: "Keep the core package independent from Pi.",
    checkpoint: {
      state: CheckpointState.ready,
      updated_at: "2026-09-03T00:00:00.000Z",
      evidence_ref: "jrnl-example",
    },
  } satisfies Leaf;

  const workflow = {
    schema_version: "1",
    slug: "example-workflow",
    repository: { id: "local", path: "." },
    items: [group, leaf],
  } satisfies Workflow;

  const items: WorkflowItem[] = workflow.items;
  assert.equal(items[0]?.kind, "group");
  assert.equal(items[1]?.kind, "leaf");
  if (items[1]?.kind === "leaf") {
    assert.equal(items[1].outcome, "Expose the normalized workflow model.");
  }
});
