/**
 * Phase 4.4: pure completion logic.
 *
 * The completion module owns three things and nothing else:
 *
 *   1. `completeLeafCheckpoint` — produce a new workflow with one leaf's
 *      checkpoint moved to its terminal state, never mutating the input.
 *   2. `classifyCompletionRisk` — turn an `IntegrateResult` into one of the
 *      three settled risk levels (`low` | `medium` | `high`). Higher risk
 *      means an independent review is more likely required.
 *   3. `renderCompletion` + `serializeWorkflowYaml` — produce the three
 *      exact bytes the adapter will hand to its atomic writer.
 *
 * Nothing here reads or writes the filesystem. The atomic write port and the
 * risk-based review hook live in `@arc/pi-workflow`; this module only hands
 * them inputs.
 */
import {
  CheckpointState,
  type Checkpoint,
  CHECKPOINT_STATES,
} from "../model/checkpoint.ts";
import type { Leaf, Workflow, WorkflowItem } from "../model/workflow.ts";
import { renderWorkflow } from "../render/drift.ts";
import type { RenderContext, RenderedWorkflow } from "../render/types.ts";
import { stringify as yamlStringify } from "yaml";
import type { IntegrateResult } from "./types.ts";

export type CompletionRiskLevel = "low" | "medium" | "high";

export const COMPLETION_RISK_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
] as const) satisfies readonly CompletionRiskLevel[];

export interface ClassifyRiskOptions {
  /**
   * Attempts at or above this threshold are classified `high`. Defaults to 2.
   * Must be a non-negative safe integer.
   */
  readonly highThreshold?: number;
  /**
   * Attempts at or above this threshold are classified `medium`. Defaults to
   * 1. Must be a non-negative safe integer strictly less than the
   * high threshold (or equal, in which case medium is collapsed into high).
   */
  readonly mediumThreshold?: number;
}

function requireSafeNonNegativeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Risk classification based on the integration result. A clean integration
 * (no conflict) is always `low`; one conflict counts as `medium`; two or
 * more is `high`. A leaf that hit `auto_resolve_disabled`,
 * `auto_resolve_exhausted`, or `checks_failed` is always `high` regardless
 * of attempt count, because the operator has already seen a red signal.
 *
 * The thresholds are configurable so callers can tune sensitivity, but the
 * default values match the conservative bound in §9 of the implementation
 * plan (`max automatic recovery attempts per item = 1` + escalation). The
 * function never throws on integration results it does not understand; an
 * unknown phase falls back to `high` because unknowns are a fail-closed
 * signal.
 */
export function classifyCompletionRisk(
  integrateResult: IntegrateResult,
  options: ClassifyRiskOptions = {},
): CompletionRiskLevel {
  const highThreshold = requireSafeNonNegativeInt(
    options.highThreshold ?? 2,
    "highThreshold",
  );
  const mediumThreshold = requireSafeNonNegativeInt(
    options.mediumThreshold ?? 1,
    "mediumThreshold",
  );
  if (mediumThreshold > highThreshold) {
    throw new RangeError(
      "mediumThreshold must be less than or equal to highThreshold",
    );
  }

  const failure = integrateResult.failure;
  if (failure !== undefined) {
    if (
      failure.phase === "auto_resolve" ||
      failure.phase === "verify_integration"
    ) {
      return "high";
    }
  }

  const conflict = integrateResult.conflict;
  if (conflict === undefined) return "low";
  const attempts = conflict.attempts;
  if (attempts >= highThreshold) return "high";
  if (attempts >= mediumThreshold) return "medium";
  return "low";
}

export interface CompleteLeafCheckpointOptions {
  readonly itemId: string;
  readonly nextState: CheckpointState;
  readonly updatedAt: string;
  /** Optional evidence reference (a journal id, never raw transcript text). */
  readonly evidenceRef?: string;
}

export interface CompleteLeafCheckpointResult {
  readonly workflow: Workflow;
  readonly item: Leaf;
  readonly previousState: CheckpointState;
}

function isCheckpointState(value: string): value is CheckpointState {
  return (CHECKPOINT_STATES as readonly string[]).includes(value);
}

function requireCheckpointState(value: string, field: string): CheckpointState {
  if (!isCheckpointState(value)) {
    throw new RangeError(
      `${field} must be one of ${CHECKPOINT_STATES.join(", ")}, received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireUpdatedAt(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Produce a new workflow with one leaf's checkpoint updated. The input is
 * never mutated. The leaf must exist, must be a leaf (not a group), and the
 * target state must be one of the six settled checkpoint states.
 *
 * The returned `item` is the new leaf after the transition, so callers can
 * build an `evidence_ref` or `updated_at` provenance payload without
 * re-traversing the workflow.
 */
export function completeLeafCheckpoint(
  workflow: Workflow,
  options: CompleteLeafCheckpointOptions,
): CompleteLeafCheckpointResult {
  const nextState = requireCheckpointState(options.nextState, "nextState");
  requireUpdatedAt(options.updatedAt, "updatedAt");

  const index = workflow.items.findIndex(
    (candidate) => candidate.id === options.itemId,
  );
  if (index < 0) {
    throw new Error(
      `completeLeafCheckpoint: no workflow item with id ${JSON.stringify(options.itemId)}`,
    );
  }
  const current = workflow.items[index];
  if (current === undefined) {
    throw new Error(
      `completeLeafCheckpoint: workflow items index ${index} is out of range`,
    );
  }
  if (current.kind !== "leaf") {
    throw new Error(
      `completeLeafCheckpoint: item ${JSON.stringify(current.id)} is a group, only leaves carry checkpoints that transition`,
    );
  }

  const previousState = current.checkpoint.state;
  const checkpoint: Checkpoint =
    options.evidenceRef === undefined
      ? { state: nextState, updated_at: options.updatedAt }
      : {
          state: nextState,
          updated_at: options.updatedAt,
          evidence_ref: options.evidenceRef,
        };

  const newItem: Leaf = { ...current, checkpoint };
  const newItems: WorkflowItem[] = workflow.items.slice();
  newItems[index] = newItem;
  const newWorkflow: Workflow = { ...workflow, items: newItems };

  return { workflow: newWorkflow, item: newItem, previousState };
}

/** Terminal completion states the controller may write after a successful integration. */
export const COMPLETION_TERMINAL_STATES = Object.freeze([
  CheckpointState.completed,
  CheckpointState.blocked,
  CheckpointState.cancelled,
  CheckpointState.needsReplan,
] as const) satisfies readonly CheckpointState[];

export interface RenderCompletionResult {
  readonly workflow: Workflow;
  readonly rendered: RenderedWorkflow;
  readonly yaml: string;
}

/**
 * Render the three exact documents the adapter's atomic writer will persist.
 * The YAML serialisation is stable for a given workflow so a no-op completion
 * produces byte-identical output; the rendered progress.txt and Gantt have
 * provenance headers and are byte-stable for the same workflow plus
 * `context.generated_at`.
 *
 * The `workflow` returned is the same object that was passed in; callers
 * compose this with `completeLeafCheckpoint` to obtain the final
 * `RenderCompletionResult`.
 */
export function renderCompletion(
  workflow: Workflow,
  context: RenderContext,
): RenderCompletionResult {
  const rendered = renderWorkflow(workflow, context);
  const yaml = serializeWorkflowYaml(workflow);
  return { workflow, rendered, yaml };
}

/**
 * Serialise a workflow to a YAML string suitable for the atomic writer.
 * The shape is the v1 schema: `schema_version`, `slug`, `repository`, and
 * `items`. The serializer omits `multi_repo` (reserved for later) and
 * preserves the order keys appear in the in-memory model.
 */
export function serializeWorkflowYaml(workflow: Workflow): string {
  const replacer = (_key: string, value: unknown): unknown => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      // Strip undefined entries so the serialised shape is deterministic.
      const filtered: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (entryValue !== undefined) filtered[entryKey] = entryValue;
      }
      return filtered;
    }
    return value;
  };
  // The in-memory model is already JSON-safe; a plain `JSON.stringify` is
  // enough before handing it to the YAML emitter. `yaml.stringify` walks
  // the structure and emits the most readable form per node.
  const json = JSON.stringify(workflow, replacer);
  if (json === undefined) {
    throw new Error("serializeWorkflowYaml: workflow is not JSON-safe");
  }
  return yamlStringify(JSON.parse(json));
}