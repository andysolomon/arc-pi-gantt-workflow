import { CHECKPOINT_STATES } from "../model/checkpoint.ts";
import type {
  ActivationField,
  LeafReadiness,
  ValidateWorkflowOptions,
  ValidationBounds,
  ValidationDiagnosticCode,
  WorkflowValidationResult,
} from "./types.ts";

export const DEFAULT_VALIDATION_BOUNDS: Readonly<ValidationBounds> =
  Object.freeze({
    maxItems: 200,
    maxLeaves: 200,
    maxDepth: 6,
    maxDependenciesPerLeaf: 20,
  });

type MutableDiagnostic = {
  code: ValidationDiagnosticCode;
  path: string;
  message: string;
};

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addDiagnostic(
  diagnostics: MutableDiagnostic[],
  code: ValidationDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function resolveBounds(options: ValidateWorkflowOptions): ValidationBounds {
  const bounds = { ...DEFAULT_VALIDATION_BOUNDS, ...options };
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  return bounds;
}

/** Returns true when `value` is a dense, fully populated array of non-empty strings. */
function isDenseNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (entry === undefined) return false;
    if (!nonEmptyString(entry)) return false;
  }
  return true;
}

function missingActivationFields(item: ObjectValue): ActivationField[] {
  const missing: ActivationField[] = [];
  if (!nonEmptyString(item.outcome)) missing.push("outcome");
  if (!nonEmptyString(item.scope)) missing.push("scope");
  if (!isDenseNonEmptyStringArray(item.acceptance_criteria)) {
    missing.push("acceptance_criteria");
  }
  if (!isDenseNonEmptyStringArray(item.dependencies)) {
    missing.push("dependencies");
  }
  if (!nonEmptyString(item.preserved_behavior)) {
    missing.push("preserved_behavior");
  }
  return missing;
}

function validateTopLevel(
  workflow: ObjectValue,
  diagnostics: MutableDiagnostic[],
): void {
  if (workflow.schema_version !== "1") {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      "$.schema_version",
      'schema_version must be "1".',
    );
  }
  if (!nonEmptyString(workflow.slug)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      "$.slug",
      "slug must be a non-empty string.",
    );
  }
  if (!isObject(workflow.repository)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      "$.repository",
      "repository must be an object.",
    );
  } else {
    if (!nonEmptyString(workflow.repository.id)) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.repository.id",
        "repository.id must be a non-empty string.",
      );
    }
    if (!nonEmptyString(workflow.repository.path)) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.repository.path",
        "repository.path must be a non-empty string.",
      );
    }
  }
  if (
    workflow.multi_repo !== undefined &&
    (!Array.isArray(workflow.multi_repo) || workflow.multi_repo.length !== 0)
  ) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      "$.multi_repo",
      "multi_repo must be omitted or an empty array in v1.",
    );
  }
}

function validateCheckpoint(
  checkpoint: unknown,
  path: string,
  diagnostics: MutableDiagnostic[],
): void {
  if (!isObject(checkpoint)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      "checkpoint must be an object.",
    );
    return;
  }
  if (
    typeof checkpoint.state !== "string" ||
    !CHECKPOINT_STATES.some((state) => state === checkpoint.state)
  ) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.state`,
      "checkpoint.state is not a supported state.",
    );
  }
  if (!nonEmptyString(checkpoint.updated_at)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.updated_at`,
      "checkpoint.updated_at must be a non-empty string.",
    );
  }
  if (
    checkpoint.evidence_ref !== undefined &&
    !nonEmptyString(checkpoint.evidence_ref)
  ) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.evidence_ref`,
      "checkpoint.evidence_ref must be a non-empty string when present.",
    );
  }
}

function validateOptionalLeafFields(
  item: ObjectValue,
  path: string,
  diagnostics: MutableDiagnostic[],
): void {
  for (const field of ["outcome", "scope", "preserved_behavior"] as const) {
    if (item[field] !== undefined && typeof item[field] !== "string") {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        `${path}.${field}`,
        `${field} must be a string when present.`,
      );
    }
  }
  if (
    item.acceptance_criteria !== undefined &&
    (!Array.isArray(item.acceptance_criteria) ||
      item.acceptance_criteria.some((criterion) => typeof criterion !== "string"))
  ) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.acceptance_criteria`,
      "acceptance_criteria must contain only strings when present.",
    );
  }
}

function validateItemShape(
  item: ObjectValue,
  index: number,
  diagnostics: MutableDiagnostic[],
): void {
  const path = `$.items[${index}]`;
  if (!nonEmptyString(item.id)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.id`,
      "id must be a non-empty string.",
    );
  }
  if (item.kind !== "group" && item.kind !== "leaf") {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.kind`,
      'kind must be "group" or "leaf".',
    );
  }
  if (!nonEmptyString(item.title)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.title`,
      "title must be a non-empty string.",
    );
  }
  if (item.parent_id !== null && !nonEmptyString(item.parent_id)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.parent_id`,
      "parent_id must be null or a non-empty string.",
    );
  }
  if (!Number.isSafeInteger(item.nesting_depth) || Number(item.nesting_depth) < 0) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.nesting_depth`,
      "nesting_depth must be a non-negative safe integer.",
    );
  }
  if (item.dependencies === undefined && item.kind === "leaf") {
    // An absent leaf dependency list is authoring incompleteness, not bad DAG shape.
  } else if (
    !Array.isArray(item.dependencies) ||
    item.dependencies.some((dependency) => !nonEmptyString(dependency))
  ) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.dependencies`,
      "dependencies must contain only non-empty strings.",
    );
  }
  validateCheckpoint(item.checkpoint, `${path}.checkpoint`, diagnostics);
  if (item.kind === "leaf") {
    validateOptionalLeafFields(item, path, diagnostics);
  }
}

function validateReferences(
  items: readonly unknown[],
  bounds: ValidationBounds,
  diagnostics: MutableDiagnostic[],
): void {
  const firstIndexById = new Map<string, number>();
  const firstItemById = new Map<string, ObjectValue>();

  for (const [index, value] of items.entries()) {
    if (!isObject(value) || !nonEmptyString(value.id)) continue;
    const firstIndex = firstIndexById.get(value.id);
    if (firstIndex !== undefined) {
      addDiagnostic(
        diagnostics,
        "duplicate_id",
        `$.items[${index}].id`,
        `Duplicate id "${value.id}"; first declared at $.items[${firstIndex}].id.`,
      );
      continue;
    }
    firstIndexById.set(value.id, index);
    firstItemById.set(value.id, value);
  }

  for (const [index, value] of items.entries()) {
    if (!isObject(value)) continue;
    const path = `$.items[${index}]`;
    if (
      Number.isSafeInteger(value.nesting_depth) &&
      Number(value.nesting_depth) > bounds.maxDepth
    ) {
      addDiagnostic(
        diagnostics,
        "depth_limit_exceeded",
        `${path}.nesting_depth`,
        `nesting_depth exceeds the maximum of ${bounds.maxDepth}.`,
      );
    }

    if (value.parent_id === null) {
      if (value.nesting_depth !== 0) {
        addDiagnostic(
          diagnostics,
          "parent_depth_mismatch",
          `${path}.nesting_depth`,
          "A root item must have nesting_depth 0.",
        );
      }
    } else if (nonEmptyString(value.parent_id)) {
      const parent = firstItemById.get(value.parent_id);
      if (!parent || parent.kind !== "group") {
        addDiagnostic(
          diagnostics,
          "invalid_parent",
          `${path}.parent_id`,
          `Parent "${value.parent_id}" must reference an existing group.`,
        );
      } else if (
        Number.isSafeInteger(parent.nesting_depth) &&
        Number.isSafeInteger(value.nesting_depth) &&
        Number(value.nesting_depth) !== Number(parent.nesting_depth) + 1
      ) {
        addDiagnostic(
          diagnostics,
          "parent_depth_mismatch",
          `${path}.nesting_depth`,
          `nesting_depth must be one greater than parent "${value.parent_id}".`,
        );
      }
    }

    if (!Array.isArray(value.dependencies)) continue;
    if (
      value.kind === "leaf" &&
      value.dependencies.length > bounds.maxDependenciesPerLeaf
    ) {
      addDiagnostic(
        diagnostics,
        "dependency_limit_exceeded",
        `${path}.dependencies`,
        `Leaf dependencies exceed the maximum of ${bounds.maxDependenciesPerLeaf}.`,
      );
    }
    const seenDependencies = new Set<string>();
    for (const [dependencyIndex, dependency] of value.dependencies.entries()) {
      if (!nonEmptyString(dependency)) continue;
      if (seenDependencies.has(dependency)) {
        addDiagnostic(
          diagnostics,
          "duplicate_dependency",
          `${path}.dependencies[${dependencyIndex}]`,
          `Dependency "${dependency}" is listed more than once.`,
        );
      } else {
        seenDependencies.add(dependency);
      }
      if (!firstItemById.has(dependency)) {
        addDiagnostic(
          diagnostics,
          "dangling_dependency",
          `${path}.dependencies[${dependencyIndex}]`,
          `Dependency "${dependency}" does not reference an existing item.`,
        );
      }
    }
  }

  validateDependencyCycles(firstItemById, firstIndexById, diagnostics);
}

function validateDependencyCycles(
  itemsById: ReadonlyMap<string, ObjectValue>,
  indexById: ReadonlyMap<string, number>,
  diagnostics: MutableDiagnostic[],
): void {
  const visited = new Set<string>();
  const active = new Set<string>();
  const pathStack: string[] = [];
  const reported = new Set<string>();

  // Iterative DFS frame so deep dependency chains cannot overflow the call stack.
  const frames: CycleFrame[] = [];

  for (const start of [...itemsById.keys()].sort(compareText)) {
    if (visited.has(start)) continue;
    visited.add(start);
    active.add(start);
    pathStack.push(start);
    frames.push({
      id: start,
      dependencies: collectCycleDependencies(itemsById.get(start)),
      cursor: 0,
    });

    while (frames.length > 0) {
      const frame: CycleFrame | undefined = frames[frames.length - 1];
      assertFrame(frame);
      if (frame.cursor >= frame.dependencies.length) {
        active.delete(frame.id);
        pathStack.pop();
        frames.pop();
        continue;
      }
      const dependency = frame.dependencies[frame.cursor];
      frame.cursor += 1;
      if (dependency === undefined || !itemsById.has(dependency)) continue;
      if (!visited.has(dependency)) {
        visited.add(dependency);
        active.add(dependency);
        pathStack.push(dependency);
        frames.push({
          id: dependency,
          dependencies: collectCycleDependencies(itemsById.get(dependency)),
          cursor: 0,
        });
        continue;
      }
      if (!active.has(dependency)) continue;
      const cycleStart = pathStack.indexOf(dependency);
      if (cycleStart < 0) continue;
      const cycle = [...pathStack.slice(cycleStart), dependency];
      const members = [...new Set(cycle)].sort(compareText);
      const key = members.join("\u0000");
      if (reported.has(key)) continue;
      reported.add(key);
      const index = indexById.get(frame.id);
      addDiagnostic(
        diagnostics,
        "dependency_cycle",
        index === undefined ? "$.items" : `$.items[${index}].dependencies`,
        `Dependency cycle detected: ${cycle.join(" -> ")}.`,
      );
    }
  }
}

function collectCycleDependencies(item: ObjectValue | undefined): readonly string[] {
  if (!item || !Array.isArray(item.dependencies)) return EMPTY_CYCLE_DEPS;
  const unique = new Set<string>();
  for (let i = 0; i < item.dependencies.length; i += 1) {
    const value = item.dependencies[i];
    if (nonEmptyString(value)) unique.add(value);
  }
  return unique.size === 0
    ? EMPTY_CYCLE_DEPS
    : [...unique].sort(compareText);
}

const EMPTY_CYCLE_DEPS: readonly string[] = Object.freeze([]);

type CycleFrame = { id: string; dependencies: readonly string[]; cursor: number };

function assertFrame(
  value: CycleFrame | undefined,
): asserts value is CycleFrame {
  if (value === undefined) {
    throw new Error("expected a frame on the DFS stack");
  }
}

/**
 * Validates an in-memory workflow without parsing, normalizing, scheduling, or
 * mutating it. Activation readiness is reported separately from DAG validity.
 */
export function validateWorkflow(
  input: unknown,
  options: ValidateWorkflowOptions = {},
): WorkflowValidationResult {
  const bounds = resolveBounds(options);
  const diagnostics: MutableDiagnostic[] = [];
  const readiness: LeafReadiness[] = [];

  if (!isObject(input)) {
    return {
      structurally_valid: false,
      diagnostics: [
        {
          code: "invalid_workflow",
          path: "$",
          message: "Workflow must be an object.",
        },
      ],
      readiness,
    };
  }

  validateTopLevel(input, diagnostics);
  if (!Array.isArray(input.items)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      "$.items",
      "items must be an array.",
    );
  } else {
    if (input.items.length === 0) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.items",
        "items must contain at least one item.",
      );
    }
    if (input.items.length > bounds.maxItems) {
      addDiagnostic(
        diagnostics,
        "item_limit_exceeded",
        "$.items",
        `Item count ${input.items.length} exceeds the maximum of ${bounds.maxItems}.`,
      );
    }
    let leafCount = 0;
    for (const [index, item] of input.items.entries()) {
      if (!isObject(item)) {
        addDiagnostic(
          diagnostics,
          "invalid_field",
          `$.items[${index}]`,
          "Item must be an object.",
        );
        continue;
      }
      validateItemShape(item, index, diagnostics);
      if (item.kind === "leaf") {
        leafCount += 1;
        const missingFields = missingActivationFields(item);
        readiness.push({
          leaf_id: typeof item.id === "string" ? item.id : "",
          item_index: index,
          ready: missingFields.length === 0,
          missing_fields: missingFields,
        });
      }
    }
    if (leafCount > bounds.maxLeaves) {
      addDiagnostic(
        diagnostics,
        "leaf_limit_exceeded",
        "$.items",
        `Leaf count ${leafCount} exceeds the maximum of ${bounds.maxLeaves}.`,
      );
    }
    validateReferences(input.items, bounds, diagnostics);
  }

  diagnostics.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );

  return {
    structurally_valid: diagnostics.length === 0,
    diagnostics,
    readiness,
  };
}
