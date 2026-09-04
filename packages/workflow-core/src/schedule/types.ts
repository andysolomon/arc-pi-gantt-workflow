import type { EventGate } from "../events/types.ts";

export const WAIT_POLICIES = Object.freeze([
  "continue-independent-authorized-branches",
  "pause-all-authorized-branches",
] as const);

export type WaitPolicy = (typeof WAIT_POLICIES)[number];

export interface SchedulerConfig {
  readonly concurrency: number;
  readonly wait_policy: WaitPolicy;
}

export interface SchedulerOptions {
  readonly concurrency?: number;
  readonly wait_policy?: WaitPolicy;
}

export interface ConcurrencyOptions {
  readonly concurrency?: number;
  readonly active_count?: number;
}

export interface WaitPolicyState {
  /** Items whose current Implement work has already been authorized. */
  readonly authorized_item_ids: readonly string[];
  /** Items paused on an operator question. */
  readonly waiting_item_ids?: readonly string[];
}

/** Minimal queue metadata; question transport and answers belong to the broker. */
export interface QueuedQuestion {
  readonly question_id: string;
  readonly item_id: string;
  readonly gate: EventGate;
}

export interface QuestionQueueOptions {
  /** A current UI selection wins over every computed queue priority. */
  readonly ui_pick?: string;
  /** Override computed critical-path membership when the caller has fresher data. */
  readonly critical_path_item_ids?: readonly string[];
}
