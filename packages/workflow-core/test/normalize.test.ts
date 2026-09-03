import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalize,
  type FlatInput,
  type LeafInput,
  type PhasedInput,
  type Repository,
  type Workflow,
} from "@arc/workflow-core";

const UPDATED_AT = "2026-09-03T00:00:00.000Z";
const OPTIONS = { updated_at: UPDATED_AT } as const;
const REPOSITORY: Repository = { id: "local", path: "." };
const PLANNED = { state: "planned", updated_at: UPDATED_AT } as const;

const modelLeaf = {
  kind: "leaf",
  id: "dag-model",
  title: "DAG model",
  outcome: "Expose the normalized workflow model.",
  scope: "packages/workflow-core/src/model",
  acceptance_criteria: ["Model shapes are strict and discriminated."],
  preserved_behavior: "Keep the core package independent from Pi.",
} satisfies LeafInput;

const normalizerLeaf = {
  kind: "leaf",
  id: "normalizer",
  title: "Normalizer",
  outcome: "Turn a phased tree and flat stories into one DAG.",
  scope: "packages/workflow-core/src/normalize",
  acceptance_criteria: ["Groups never become leaves."],
  preserved_behavior: "Normalization performs no validation.",
  dependencies: ["dag-model"],
} satisfies LeafInput;

const phasedInput: PhasedInput = {
  form: "phased",
  slug: "example-workflow",
  repository: REPOSITORY,
  groups: [
    {
      kind: "group",
      id: "phase-1",
      title: "Phase 1",
      items: [modelLeaf, normalizerLeaf],
    },
  ],
};

const flatInput: FlatInput = {
  form: "flat",
  slug: "example-workflow",
  repository: REPOSITORY,
  stories: [modelLeaf, normalizerLeaf],
};

test("a phased tree flattens depth-first into the canonical DAG", () => {
  const expected: Workflow = {
    schema_version: "1",
    slug: "example-workflow",
    repository: { id: "local", path: "." },
    items: [
      {
        id: "phase-1",
        kind: "group",
        title: "Phase 1",
        parent_id: null,
        nesting_depth: 0,
        dependencies: [],
        checkpoint: PLANNED,
      },
      {
        id: "dag-model",
        kind: "leaf",
        title: "DAG model",
        parent_id: "phase-1",
        nesting_depth: 1,
        outcome: modelLeaf.outcome,
        scope: modelLeaf.scope,
        acceptance_criteria: [...modelLeaf.acceptance_criteria],
        dependencies: [],
        preserved_behavior: modelLeaf.preserved_behavior,
        checkpoint: PLANNED,
      },
      {
        id: "normalizer",
        kind: "leaf",
        title: "Normalizer",
        parent_id: "phase-1",
        nesting_depth: 1,
        outcome: normalizerLeaf.outcome,
        scope: normalizerLeaf.scope,
        acceptance_criteria: [...normalizerLeaf.acceptance_criteria],
        dependencies: ["dag-model"],
        preserved_behavior: normalizerLeaf.preserved_behavior,
        checkpoint: PLANNED,
      },
    ],
  };

  assert.deepEqual(normalize(phasedInput, OPTIONS), expected);
});

test("flat stories become root-level leaves in source order", () => {
  const workflow = normalize(flatInput, OPTIONS);

  assert.deepEqual(
    workflow.items.map((item) => [
      item.id,
      item.kind,
      item.parent_id,
      item.nesting_depth,
    ]),
    [
      ["dag-model", "leaf", null, 0],
      ["normalizer", "leaf", null, 0],
    ],
  );
  assert.equal(
    workflow.items.some((item) => item.kind === "group"),
    false,
    "no synthetic group is introduced",
  );
});

test("nesting derives parent_id and depth at every level", () => {
  const workflow = normalize(
    {
      form: "phased",
      slug: "nesting",
      repository: REPOSITORY,
      groups: [
        {
          kind: "group",
          id: "phase-1",
          title: "Phase 1",
          items: [
            {
              kind: "group",
              id: "phase-1-a",
              title: "Phase 1a",
              items: [{ ...modelLeaf, id: "deep" }],
            },
            { ...normalizerLeaf, id: "shallow", dependencies: [] },
          ],
        },
        { kind: "group", id: "phase-2", title: "Phase 2", items: [] },
      ],
    },
    OPTIONS,
  );

  assert.deepEqual(
    workflow.items.map((item) => [item.id, item.parent_id, item.nesting_depth]),
    [
      ["phase-1", null, 0],
      ["phase-1-a", "phase-1", 1],
      ["deep", "phase-1-a", 2],
      ["shallow", "phase-1", 1],
      ["phase-2", null, 0],
    ],
  );
});

test("declared groups stay groups, including childless ones", () => {
  const workflow = normalize(
    {
      form: "phased",
      slug: "discrimination",
      repository: REPOSITORY,
      groups: [
        { kind: "group", id: "empty-phase", title: "Empty phase", items: [] },
        {
          kind: "group",
          id: "owning-phase",
          title: "Owning phase",
          items: [modelLeaf],
        },
      ],
    },
    OPTIONS,
  );

  assert.deepEqual(
    workflow.items.map((item) => [item.id, item.kind]),
    [
      ["empty-phase", "group"],
      ["owning-phase", "group"],
      ["dag-model", "leaf"],
    ],
  );

  const empty = workflow.items[0];
  assert.ok(empty);
  assert.equal(empty.kind, "group");
  assert.equal("outcome" in empty, false);
  assert.equal("acceptance_criteria" in empty, false);
});

test("dependencies and leaf activation fields are preserved verbatim", () => {
  const leaf = {
    kind: "leaf",
    id: "activated",
    title: "Fully specified leaf",
    outcome: "Every activation field survives normalization.",
    scope: "packages/workflow-core/src/normalize",
    acceptance_criteria: ["First criterion", "Second criterion"],
    preserved_behavior: "The Pi-free boundary holds.",
    dependencies: ["b-dependency", "a-dependency"],
  } satisfies LeafInput;

  const workflow = normalize(
    {
      form: "phased",
      slug: "preservation",
      repository: REPOSITORY,
      groups: [
        {
          kind: "group",
          id: "phase-1",
          title: "Phase 1",
          dependencies: ["a-dependency"],
          items: [leaf],
        },
      ],
    },
    OPTIONS,
  );

  const [group, emitted] = workflow.items;
  assert.ok(group && group.kind === "group");
  assert.deepEqual(group.dependencies, ["a-dependency"]);

  assert.ok(emitted && emitted.kind === "leaf");
  assert.deepEqual(
    {
      outcome: emitted.outcome,
      scope: emitted.scope,
      acceptance_criteria: emitted.acceptance_criteria,
      preserved_behavior: emitted.preserved_behavior,
      dependencies: emitted.dependencies,
    },
    {
      outcome: leaf.outcome,
      scope: leaf.scope,
      acceptance_criteria: ["First criterion", "Second criterion"],
      preserved_behavior: leaf.preserved_behavior,
      dependencies: ["b-dependency", "a-dependency"],
    },
    "input order is kept and nothing is resolved or reordered",
  );
  assert.notEqual(
    emitted.acceptance_criteria,
    leaf.acceptance_criteria,
    "arrays are copied, not aliased to the input",
  );
});

test("every emitted checkpoint is planned at the supplied timestamp", () => {
  const workflow = normalize(phasedInput, OPTIONS);

  assert.deepEqual(
    workflow.items.map((item) => item.checkpoint),
    [PLANNED, PLANNED, PLANNED],
  );
  assert.equal(
    workflow.items.some((item) => item.checkpoint.state !== "planned"),
    false,
  );

  const other = normalize(phasedInput, { updated_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual(
    other.items.map((item) => item.checkpoint.updated_at),
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
  );
});

test("normalization is deterministic across repeated calls", () => {
  const first = normalize(phasedInput, OPTIONS);
  const second = normalize(phasedInput, OPTIONS);
  const flatFirst = normalize(flatInput, OPTIONS);
  const flatSecond = normalize(flatInput, OPTIONS);

  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(JSON.stringify(flatSecond), JSON.stringify(flatFirst));
});
