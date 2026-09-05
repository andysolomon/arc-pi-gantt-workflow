import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeLiveWorkflowEdit } from "@arc/pi-workflow";
import type { Workflow } from "@arc/workflow-core";
import { stringify } from "yaml";

const current: Workflow = {
  schema_version: "1",
  slug: "adapter-live-edit",
  repository: { id: "repo", path: "." },
  items: [
    {
      id: "work",
      kind: "leaf",
      title: "Work",
      parent_id: null,
      nesting_depth: 0,
      outcome: "Deliver work",
      scope: "src/work",
      acceptance_criteria: ["Tests pass"],
      dependencies: [],
      preserved_behavior: "Preserve behavior",
      checkpoint: {
        state: "planned",
        updated_at: "2026-09-05T12:00:00.000Z",
      },
    },
  ],
};

test("adapter accepts edited YAML and an already parsed candidate", () => {
  const yamlResult = consumeLiveWorkflowEdit(current, stringify(current));
  const objectResult = consumeLiveWorkflowEdit(current, structuredClone(current));

  assert.equal(yamlResult.accepted, true);
  assert.deepEqual(objectResult, yamlResult);
});

test("malformed YAML fails closed with a bounded diagnostic result", () => {
  const result = consumeLiveWorkflowEdit(
    current,
    "slug: first\nslug: second\nitems: [",
  );

  assert.equal(result.accepted, false);
  if (!result.accepted) {
    assert.equal(result.reason, "malformed_yaml");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.source, "yaml");
  }
});

test("well-formed YAML with structurally invalid data is rejected by core", () => {
  const result = consumeLiveWorkflowEdit(
    current,
    stringify({ ...current, items: [{ ...current.items[0], dependencies: ["missing"] }] }),
  );

  assert.equal(result.accepted, false);
  if (!result.accepted) {
    assert.equal(result.reason, "invalid_candidate_workflow");
    assert.equal(result.diagnostics[0]?.source, "candidate");
  }
});
