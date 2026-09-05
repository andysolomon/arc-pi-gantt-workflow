import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CheckpointState, CHECKPOINT_STATES } from "../src/model/checkpoint.ts";
import type { Leaf, Workflow, WorkflowItem } from "../src/model/workflow.ts";
import {
  COMPLETION_RISK_LEVELS,
  COMPLETION_TERMINAL_STATES,
  classifyCompletionRisk,
  completeLeafCheckpoint,
  renderCompletion,
  serializeWorkflowYaml,
  type CompletionRiskLevel,
} from "../src/integrate/complete.ts";
import {
  type IntegrateConflict,
  type IntegrateFailure,
  type IntegrateIntegrationVerified,
  type IntegrateResult,
} from "../src/integrate/types.ts";

const UPDATED_AT = "2026-09-03T00:00:00.000Z";
const CONTEXT = {
  generated_at: "2026-09-03T00:00:00.000Z",
  source: ".arc/workflows/complete-fixture/workflow.yaml",
} as const;

function group(id: string, title: string, parent: string | null): WorkflowItem {
  return {
    id,
    kind: "group",
    title,
    parent_id: parent,
    nesting_depth: parent === null ? 0 : 1,
    dependencies: [],
    checkpoint: { state: CheckpointState.planned, updated_at: UPDATED_AT },
  };
}

function leaf(
  id: string,
  title: string,
  parent: string | null,
  state: CheckpointState,
  overrides: Partial<Leaf> = {},
): Leaf {
  return {
    id,
    kind: "leaf",
    title,
    parent_id: parent,
    nesting_depth: parent === null ? 0 : 2,
    outcome: `outcome for ${id}`,
    scope: `packages/workflow-core/src/${id}`,
    acceptance_criteria: [`${id} is rendered`],
    dependencies: [],
    preserved_behavior: "Keep workflow-core independent of Pi.",
    checkpoint: { state, updated_at: UPDATED_AT },
    ...overrides,
  };
}

function fixture(overrides: Partial<Leaf> = {}): Workflow {
  return {
    schema_version: "1",
    slug: "complete-fixture",
    repository: { id: "local", path: "." },
    items: [
      group("1.0", "Phase 1", null),
      leaf("1.1", "DAG model", "1.0", CheckpointState.completed, overrides),
      leaf("1.2", "Normalizer", "1.0", CheckpointState.ready),
    ],
  };
}

function makeIntegrateResult(
  overrides: Partial<IntegrateResult> = {},
): IntegrateResult {
  const base: IntegrateResult = {
    ok: true,
    phase: "verify",
    verify: { ok: true, exit_code: 0 },
  };
  return { ...base, ...overrides };
}

function makeConflict(attempts: number): IntegrateConflict {
  return {
    conflictedFiles: ["src/a.ts"],
    strategy: "theirs",
    attempts,
    maxAttempts: 2,
  };
}

function makeVerified(
  overrides: Partial<IntegrateIntegrationVerified> = {},
): IntegrateIntegrationVerified {
  return { ok: true, exit_code: 0, reverted: false, ...overrides };
}

describe("classifyCompletionRisk", () => {
  test("clean integration is low", () => {
    const result = makeIntegrateResult();
    assert.equal(classifyCompletionRisk(result), "low");
  });

  test("conflict with zero attempts is low", () => {
    const result = makeIntegrateResult({
      phase: "auto_resolve",
      conflict: makeConflict(0),
    });
    assert.equal(classifyCompletionRisk(result), "low");
  });

  test("one conflict attempt is medium by default", () => {
    const result = makeIntegrateResult({
      phase: "verify_integration",
      conflict: makeConflict(1),
      integrationVerified: makeVerified(),
    });
    assert.equal(classifyCompletionRisk(result), "medium");
  });

  test("two or more attempts is high by default", () => {
    const result = makeIntegrateResult({
      phase: "verify_integration",
      conflict: makeConflict(2),
      integrationVerified: makeVerified(),
    });
    assert.equal(classifyCompletionRisk(result), "high");
  });

  test("auto_resolve_disabled is always high regardless of attempts", () => {
    const failure: IntegrateFailure = {
      phase: "auto_resolve",
      reason: "auto_resolve_disabled",
    };
    const result = makeIntegrateResult({
      ok: false,
      phase: "auto_resolve",
      conflict: makeConflict(0),
      failure,
    });
    assert.equal(classifyCompletionRisk(result), "high");
  });

  test("auto_resolve_exhausted is always high regardless of attempts", () => {
    const failure: IntegrateFailure = {
      phase: "auto_resolve",
      reason: "auto_resolve_exhausted",
    };
    const result = makeIntegrateResult({
      ok: false,
      phase: "auto_resolve",
      conflict: makeConflict(0),
      failure,
    });
    assert.equal(classifyCompletionRisk(result), "high");
  });

  test("verify_integration checks_failed is always high", () => {
    const failure: IntegrateFailure = {
      phase: "verify_integration",
      reason: "checks_failed",
    };
    const result = makeIntegrateResult({
      ok: false,
      phase: "verify_integration",
      conflict: makeConflict(0),
      failure,
    });
    assert.equal(classifyCompletionRisk(result), "high");
  });

  test("thresholds are configurable", () => {
    const result = makeIntegrateResult({
      phase: "verify_integration",
      conflict: makeConflict(3),
      integrationVerified: makeVerified(),
    });
    assert.equal(
      classifyCompletionRisk(result, { mediumThreshold: 2, highThreshold: 5 }),
      "medium",
    );
    assert.equal(
      classifyCompletionRisk(result, { mediumThreshold: 1, highThreshold: 2 }),
      "high",
    );
  });

  test("rejects malformed thresholds", () => {
    const result = makeIntegrateResult();
    assert.throws(
      () => classifyCompletionRisk(result, { highThreshold: -1 }),
      /highThreshold/,
    );
    assert.throws(
      () => classifyCompletionRisk(result, { mediumThreshold: 1.5 }),
      /mediumThreshold/,
    );
    assert.throws(
      () =>
        classifyCompletionRisk(result, {
          mediumThreshold: 5,
          highThreshold: 2,
        }),
      /mediumThreshold/,
    );
  });

  test("risk vocabulary is closed under the three settled values", () => {
    assert.deepEqual([...COMPLETION_RISK_LEVELS].sort(), [
      "high",
      "low",
      "medium",
    ]);
    const allowed: readonly CompletionRiskLevel[] = COMPLETION_RISK_LEVELS;
    for (const sample of allowed) {
      assert.ok(COMPLETION_RISK_LEVELS.includes(sample));
    }
  });
});

describe("completeLeafCheckpoint", () => {
  test("returns a new workflow with the leaf checkpoint changed", () => {
    const workflow = fixture();
    const result = completeLeafCheckpoint(workflow, {
      itemId: "1.1",
      nextState: CheckpointState.completed,
      updatedAt: "2026-09-04T10:00:00.000Z",
      evidenceRef: "jrnl-1",
    });
    assert.notEqual(result.workflow, workflow);
    // The fixture starts "1.1" at completed, so this transition records the
    // previous state as completed and reaffirms it.
    assert.equal(result.previousState, CheckpointState.completed);
    assert.equal(result.item.id, "1.1");
    assert.equal(result.item.checkpoint.state, CheckpointState.completed);
    assert.equal(result.item.checkpoint.evidence_ref, "jrnl-1");
    assert.equal(result.item.checkpoint.updated_at, "2026-09-04T10:00:00.000Z");
    // Input is unchanged.
    const originalLeaf = workflow.items.find((item) => item.id === "1.1");
    assert.ok(originalLeaf);
    assert.equal(originalLeaf.checkpoint.state, CheckpointState.completed);
    assert.equal(originalLeaf.checkpoint.evidence_ref, undefined);
  });

  test("omitting evidence_ref clears any previous evidence", () => {
    const workflow = fixture({ checkpoint: { state: CheckpointState.planned, updated_at: UPDATED_AT, evidence_ref: "jrnl-old" } });
    const result = completeLeafCheckpoint(workflow, {
      itemId: "1.1",
      nextState: CheckpointState.completed,
      updatedAt: "2026-09-04T10:00:00.000Z",
    });
    assert.equal(result.item.checkpoint.evidence_ref, undefined);
  });

  test("other items are not modified", () => {
    const workflow = fixture();
    const before = workflow.items.slice();
    const result = completeLeafCheckpoint(workflow, {
      itemId: "1.1",
      nextState: CheckpointState.completed,
      updatedAt: "2026-09-04T10:00:00.000Z",
    });
    assert.equal(result.workflow.items.length, before.length);
    for (let index = 0; index < before.length; index += 1) {
      if (before[index]!.id === "1.1") continue;
      assert.equal(result.workflow.items[index], before[index]);
    }
  });

  test("throws for unknown item id", () => {
    const workflow = fixture();
    assert.throws(
      () =>
        completeLeafCheckpoint(workflow, {
          itemId: "9.9",
          nextState: CheckpointState.completed,
          updatedAt: "2026-09-04T10:00:00.000Z",
        }),
      /no workflow item/,
    );
  });

  test("throws for a group item id", () => {
    const workflow = fixture();
    assert.throws(
      () =>
        completeLeafCheckpoint(workflow, {
          itemId: "1.0",
          nextState: CheckpointState.completed,
          updatedAt: "2026-09-04T10:00:00.000Z",
        }),
      /only leaves/,
    );
  });

  test("rejects unknown checkpoint states", () => {
    const workflow = fixture();
    assert.throws(
      () =>
        completeLeafCheckpoint(workflow, {
          itemId: "1.1",
          // The cast goes through `unknown` to bypass the type system and
          // exercise the runtime guard the same way a misconfigured caller
          // would.
          nextState: "abandoned" as unknown as CheckpointState,
          updatedAt: "2026-09-04T10:00:00.000Z",
        }),
      /must be one of/,
    );
  });

  test("rejects an empty updatedAt", () => {
    const workflow = fixture();
    assert.throws(
      () =>
        completeLeafCheckpoint(workflow, {
          itemId: "1.1",
          nextState: CheckpointState.completed,
          updatedAt: "",
        }),
      /updatedAt/,
    );
  });

  test("terminal states include the four completion outcomes", () => {
    const values: readonly CheckpointState[] = [...COMPLETION_TERMINAL_STATES];
    assert.ok(values.includes(CheckpointState.completed));
    assert.ok(values.includes(CheckpointState.blocked));
    assert.ok(values.includes(CheckpointState.cancelled));
    assert.ok(values.includes(CheckpointState.needsReplan));
    assert.equal(values.length, 4);
    // planned and ready are never completion outcomes.
    assert.equal(values.includes(CheckpointState.planned), false);
    assert.equal(values.includes(CheckpointState.ready), false);
  });

  test("works for every checkpoint state", () => {
    for (const state of CHECKPOINT_STATES) {
      const workflow = fixture();
      const result = completeLeafCheckpoint(workflow, {
        itemId: "1.1",
        nextState: state,
        updatedAt: "2026-09-04T10:00:00.000Z",
      });
      assert.equal(result.item.checkpoint.state, state);
    }
  });
});

describe("renderCompletion", () => {
  test("produces three documents keyed by render kind", () => {
    const workflow = fixture();
    const result = renderCompletion(workflow, CONTEXT);
    assert.equal(result.workflow, workflow);
    assert.equal(result.rendered.progress.kind, "progress");
    assert.equal(result.rendered.gantt.kind, "gantt");
    assert.match(result.rendered.progress.text, /arc-render: progress/);
    assert.match(result.rendered.gantt.text, /arc-render: gantt/);
    assert.match(result.yaml, /schema_version: "1"/);
    assert.match(result.yaml, /slug: complete-fixture/);
  });

  test("yaml serialisation is byte-stable across runs", () => {
    const workflow = fixture();
    const first = renderCompletion(workflow, CONTEXT).yaml;
    const second = renderCompletion(workflow, CONTEXT).yaml;
    assert.equal(first, second);
  });

  test("yaml serialisation omits the reserved multi_repo field", () => {
    const workflow: Workflow = {
      schema_version: "1",
      slug: "no-multi",
      repository: { id: "local", path: "." },
      items: [leaf("1.1", "Leaf", null, CheckpointState.planned)],
    };
    const yaml = serializeWorkflowYaml(workflow);
    assert.equal(yaml.includes("multi_repo"), false);
  });

  test("reflects a checkpoint transition in both rendered documents", () => {
    const original = renderCompletion(fixture(), CONTEXT);
    const transitioned = completeLeafCheckpoint(fixture(), {
      itemId: "1.1",
      nextState: CheckpointState.completed,
      updatedAt: "2026-09-04T10:00:00.000Z",
    });
    const rendered = renderCompletion(transitioned.workflow, CONTEXT);
    assert.notEqual(
      rendered.rendered.progress.text,
      original.rendered.progress.text,
    );
    assert.notEqual(
      rendered.rendered.gantt.text,
      original.rendered.gantt.text,
    );
    assert.notEqual(rendered.yaml, original.yaml);
    // The new yaml reflects the new checkpoint state.
    assert.match(rendered.yaml, /state: completed/);
  });
});