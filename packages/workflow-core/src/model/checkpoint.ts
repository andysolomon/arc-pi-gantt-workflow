/** The checkpoint states persisted by the workflow schema. */
export const CheckpointState = Object.freeze({
  planned: "planned",
  ready: "ready",
  completed: "completed",
  blocked: "blocked",
  cancelled: "cancelled",
  needsReplan: "needs-replan",
} as const);

/** The complete, ordered set of checkpoint state values. */
export const CHECKPOINT_STATES = Object.freeze([
  CheckpointState.planned,
  CheckpointState.ready,
  CheckpointState.completed,
  CheckpointState.blocked,
  CheckpointState.cancelled,
  CheckpointState.needsReplan,
] as const);

export type CheckpointState = (typeof CHECKPOINT_STATES)[number];

export interface Checkpoint {
  state: CheckpointState;
  updated_at: string;
  evidence_ref?: string;
}
