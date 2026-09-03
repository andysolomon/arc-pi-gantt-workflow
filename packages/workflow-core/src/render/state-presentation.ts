import { CHECKPOINT_STATES, CheckpointState } from "../model/checkpoint.ts";
import type { CheckpointPresentation } from "./types.ts";

/**
 * Presentation for every checkpoint state. Symbols and tag sets are pairwise
 * distinct so a reader can recover the state from either projection.
 */
const PRESENTATION: Readonly<Record<CheckpointState, CheckpointPresentation>> =
  Object.freeze({
    [CheckpointState.planned]: {
      state: CheckpointState.planned,
      symbol: "[ ]",
      label: CheckpointState.planned,
      gantt_tags: Object.freeze([]),
    },
    [CheckpointState.ready]: {
      state: CheckpointState.ready,
      symbol: "[>]",
      label: CheckpointState.ready,
      gantt_tags: Object.freeze(["active"]),
    },
    [CheckpointState.completed]: {
      state: CheckpointState.completed,
      symbol: "[x]",
      label: CheckpointState.completed,
      gantt_tags: Object.freeze(["done"]),
    },
    [CheckpointState.blocked]: {
      state: CheckpointState.blocked,
      symbol: "[!]",
      label: CheckpointState.blocked,
      gantt_tags: Object.freeze(["crit"]),
    },
    [CheckpointState.cancelled]: {
      state: CheckpointState.cancelled,
      symbol: "[-]",
      label: CheckpointState.cancelled,
      gantt_tags: Object.freeze(["crit", "done"]),
    },
    [CheckpointState.needsReplan]: {
      state: CheckpointState.needsReplan,
      symbol: "[?]",
      label: CheckpointState.needsReplan,
      gantt_tags: Object.freeze(["crit", "active"]),
    },
  } satisfies Record<CheckpointState, CheckpointPresentation>);

function deepFreezePresentation<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (entry !== null && typeof entry === "object" && !Object.isFrozen(entry)) {
      deepFreezePresentation(entry);
    }
  }
  return value;
}

deepFreezePresentation(PRESENTATION);

/** Presentation for a single state. */
export function presentationFor(state: CheckpointState): CheckpointPresentation {
  return PRESENTATION[state];
}

/** Presentations in the canonical checkpoint-state order. */
export const CHECKPOINT_PRESENTATIONS: readonly CheckpointPresentation[] =
  Object.freeze(CHECKPOINT_STATES.map((state) => PRESENTATION[state]));

/** One-line legend covering all six states, in canonical order. */
export const CHECKPOINT_LEGEND = `Legend: ${CHECKPOINT_PRESENTATIONS.map(
  (entry) => `${entry.symbol} ${entry.label}`,
).join("  ")}`;
