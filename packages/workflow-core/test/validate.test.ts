import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VALIDATION_BOUNDS,
  validateWorkflow,
  type Group,
  type Leaf,
  type Workflow,
} from "@arc/workflow-core";

const UPDATED_AT = "2026-09-03T00:00:00.000Z";
const PLANNED = { state: "planned", updated_at: UPDATED_AT } as const;

function group(
  id: string,
  parent_id: string | null = null,
  nesting_depth = parent_id === null ? 0 : 1,
): Group {
  return {
    id,
    kind: "group",
    title: id,
    parent_id,
    nesting_depth,
    dependencies: [],
    checkpoint: PLANNED,
  };
}

function leaf(
  id: string,
  dependencies: string[] = ["foundation"],
  parent_id: string | null = null,
  nesting_depth = parent_id === null ? 0 : 1,
): Leaf {
  return {
    id,
    kind: "leaf",
    title: id,
    parent_id,
    nesting_depth,
    outcome: `Deliver ${id}.`,
    scope: `packages/workflow-core/src/${id}`,
    acceptance_criteria: [`${id} is verified.`],
    dependencies,
    preserved_behavior: "Keep workflow-core independent from Pi.",
    checkpoint: PLANNED,
  };
}

function workflow(
  items: Workflow["items"] = [group("foundation"), leaf("work")],
): Workflow {
  return {
    schema_version: "1",
    slug: "validator-fixture",
    repository: { id: "local", path: "." },
    items,
  };
}

function diagnosticCodes(input: unknown): string[] {
  return validateWorkflow(input).diagnostics.map((diagnostic) => diagnostic.code);
}

test("a complete DAG is structurally valid and reports leaf readiness without promotion", () => {
  const input = workflow();
  const before = structuredClone(input);

  assert.deepEqual(validateWorkflow(input), {
    structurally_valid: true,
    diagnostics: [],
    readiness: [
      {
        leaf_id: "work",
        item_index: 1,
        ready: true,
        missing_fields: [],
      },
    ],
  });
  assert.deepEqual(input, before, "validation must not mutate its input");
  assert.equal(input.items[1]?.checkpoint.state, "planned");
});

test("missing or empty activation fields stay planned and are never reported ready", () => {
  const cases: [string, (item: Record<string, unknown>) => void][] = [
    ["outcome", (item) => delete item.outcome],
    ["outcome", (item) => (item.outcome = "  ")],
    ["scope", (item) => delete item.scope],
    ["scope", (item) => (item.scope = "")],
    ["acceptance_criteria", (item) => delete item.acceptance_criteria],
    ["acceptance_criteria", (item) => (item.acceptance_criteria = [])],
    ["dependencies", (item) => delete item.dependencies],
    ["dependencies", (item) => (item.dependencies = [])],
    ["preserved_behavior", (item) => delete item.preserved_behavior],
    ["preserved_behavior", (item) => (item.preserved_behavior = "\t")],
  ];

  for (const [field, makeIncomplete] of cases) {
    const input = workflow();
    const candidate = input.items[1] as unknown as Record<string, unknown>;
    makeIncomplete(candidate);
    const result = validateWorkflow(input);

    assert.equal(result.structurally_valid, true, field);
    assert.equal(result.readiness[0]?.ready, false, field);
    assert.deepEqual(result.readiness[0]?.missing_fields, [field], field);
    assert.equal(input.items[1]?.checkpoint.state, "planned", field);
  }
});

test("malformed runtime model data produces diagnostics instead of throwing", () => {
  assert.deepEqual(validateWorkflow(null), {
    structurally_valid: false,
    diagnostics: [
      {
        code: "invalid_workflow",
        path: "$",
        message: "Workflow must be an object.",
      },
    ],
    readiness: [],
  });

  const malformed = {
    schema_version: 1,
    slug: "",
    repository: null,
    items: [null, { ...group("bad"), kind: "task", nesting_depth: -1 }],
  };
  const result = validateWorkflow(malformed);
  assert.equal(result.structurally_valid, false);
  assert.ok(result.diagnostics.length >= 6);
  assert.deepEqual(result.readiness, []);
});

test("duplicate IDs, invalid parents, depth mismatches, and dangling dependencies fail", () => {
  const input = workflow([
    group("foundation"),
    group("foundation"),
    leaf("child", ["missing"], "foundation", 2),
    leaf("orphan", ["foundation"], "not-a-group", 1),
    leaf("leaf-parent", ["foundation"]),
    leaf("bad-child", ["foundation"], "leaf-parent", 1),
  ]);
  const codes = diagnosticCodes(input);

  assert.ok(codes.includes("duplicate_id"));
  assert.ok(codes.includes("parent_depth_mismatch"));
  assert.ok(codes.includes("invalid_parent"));
  assert.ok(codes.includes("dangling_dependency"));
});

test("dependency cycles, including self cycles, fail deterministically", () => {
  const input = workflow([
    leaf("b", ["a"]),
    leaf("a", ["b"]),
    leaf("self", ["self"]),
  ]);
  const first = validateWorkflow(input);
  const second = validateWorkflow(input);

  assert.deepEqual(second, first);
  assert.equal(
    first.diagnostics.filter((diagnostic) => diagnostic.code === "dependency_cycle")
      .length,
    2,
  );
});

test("default item, leaf, depth, and dependency bounds are conservative", () => {
  assert.deepEqual(DEFAULT_VALIDATION_BOUNDS, {
    maxItems: 200,
    maxLeaves: 200,
    maxDepth: 6,
    maxDependenciesPerLeaf: 20,
  });

  const tooManyGroups = workflow(
    Array.from({ length: 201 }, (_, index) => group(`group-${index}`)),
  );
  assert.ok(diagnosticCodes(tooManyGroups).includes("item_limit_exceeded"));

  const tooManyLeaves = workflow(
    Array.from({ length: 201 }, (_, index) => leaf(`leaf-${index}`, ["leaf-0"])),
  );
  assert.ok(diagnosticCodes(tooManyLeaves).includes("leaf_limit_exceeded"));

  const deep = workflow([group("deep", null, 7)]);
  assert.ok(diagnosticCodes(deep).includes("depth_limit_exceeded"));

  const dependencyHeavy = workflow([
    ...Array.from({ length: 21 }, (_, index) => group(`dependency-${index}`)),
    leaf(
      "heavy",
      Array.from({ length: 21 }, (_, index) => `dependency-${index}`),
    ),
  ]);
  assert.ok(
    diagnosticCodes(dependencyHeavy).includes("dependency_limit_exceeded"),
  );
});

test("bounds are configurable independently", () => {
  const input = workflow([
    group("root"),
    leaf("one", ["root"], "root", 1),
    leaf("two", ["root"], "root", 1),
  ]);
  const strict = validateWorkflow(input, {
    maxItems: 2,
    maxLeaves: 1,
    maxDepth: 0,
    maxDependenciesPerLeaf: 0,
  });
  assert.deepEqual(
    [...new Set(strict.diagnostics.map((diagnostic) => diagnostic.code))].sort(),
    [
      "dependency_limit_exceeded",
      "depth_limit_exceeded",
      "item_limit_exceeded",
      "leaf_limit_exceeded",
    ],
  );

  assert.equal(
    validateWorkflow(input, {
      maxItems: 3,
      maxLeaves: 2,
      maxDepth: 1,
      maxDependenciesPerLeaf: 1,
    }).structurally_valid,
    true,
  );
  assert.throws(
    () => validateWorkflow(input, { maxItems: -1 }),
    /non-negative safe integer/,
  );
});

test("diagnostic ordering is byte-stable across repeated calls", () => {
  const input = workflow([
    group("duplicate", null, 7),
    group("duplicate"),
    leaf("cycle-a", ["cycle-b"], "missing", 4),
    leaf("cycle-b", ["cycle-a", "cycle-a"]),
  ]);
  const first = JSON.stringify(validateWorkflow(input));
  const second = JSON.stringify(validateWorkflow(input));

  assert.equal(second, first);
});

test("sparse activation/dependency arrays stay planned and are never reported ready", () => {
  const baseLeaf: Leaf = leaf("work");
  const sparseAcceptance = new Array<string>(1);
  const sparseDependencies = new Array<string>(1);
  const input: Workflow = {
    ...workflow(),
    items: [
      baseLeaf,
      {
        ...baseLeaf,
        kind: "leaf",
        id: "sparse",
        acceptance_criteria: sparseAcceptance,
        dependencies: sparseDependencies,
      } as Leaf,
    ],
  };

  const result = validateWorkflow(input);

  assert.equal(result.readiness.find((r) => r.leaf_id === "sparse")?.ready, false);
  assert.deepEqual(
    result.readiness.find((r) => r.leaf_id === "sparse")?.missing_fields,
    ["acceptance_criteria", "dependencies"],
  );
  assert.deepEqual(
    result.readiness.find((r) => r.leaf_id === "work")?.missing_fields,
    [],
  );
});

test("dependency cycle detection handles long chains without stack overflow", () => {
  const depth = 20_000;
  const items: Workflow["items"] = [];
  for (let i = 0; i < depth; i += 1) {
    items.push({
      id: `n${i}`,
      kind: "leaf",
      title: `n${i}`,
      parent_id: null,
      nesting_depth: 0,
      outcome: "o",
      scope: "s",
      acceptance_criteria: [`c${i}`],
      dependencies: i === 0 ? [] : [`n${i - 1}`],
      preserved_behavior: "p",
      checkpoint: PLANNED,
    });
  }

  const result = validateWorkflow({
    schema_version: "1",
    slug: "deep",
    repository: { id: "local", path: "." },
    items,
  });

  assert.ok(Array.isArray(result.diagnostics));
  assert.ok(
    result.diagnostics.some((d) => d.code === "item_limit_exceeded") ||
      result.diagnostics.some((d) => d.code === "leaf_limit_exceeded"),
  );
});
